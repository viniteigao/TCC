// Envio de documentos para assinatura e acompanhamento do status (solicitante).
//
//   POST /                 -> envia PDF e dados do signatário, gera o link
//   GET  /                 -> lista os documentos do solicitante
//   GET  /:id              -> dados de um documento (formulário de edição)
//   PUT  /:id              -> corrige os dados do signatário ou a validade
//   GET  /:id/link         -> devolve o link para copiar novamente
//   GET  /:id/arquivo      -> abre o PDF original (antes ou depois da assinatura)
//   GET  /:id/arquivo-assinado -> PDF com a caixa de assinatura (prévia ou assinado)
//
// Cada documento tem um único link, que não muda. Edição e cópia do link só
// são permitidas enquanto ele estiver pendente: os estados finais
// (assinado, recusado, expirado, bloqueado) não mudam.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { pool, emTransacao } from '../db.js';
import { registrarEvento } from '../auditoria.js';
import { exigirSolicitante } from '../middlewares/autenticacao.js';
import { sha256, gerarToken } from '../util/hash.js';
import { cifrar, decifrar } from '../util/cifra.js';
import { normalizarCpf, cpfValido } from '../util/cpf.js';
import { expirarLinksVencidos } from '../servicos/links.js';
import { enviarLinkAoSignatario } from '../servicos/notificacao.js';
import { enviarPdf, enviarPdfGerado } from '../servicos/arquivos.js';
import {
  contarPaginas, lerCampo, campoDoBanco, codigoVerificacao, gerarPdfComCaixa, nomeDaCopia,
} from '../servicos/carimbo.js';
import { urlTransacao } from '../blockchain/registro.js';

export const rotasDocumentos = Router();

// O arquivo fica em memória até o hash ser calculado e os dados validados.
// defParamCharset: lê o nome do arquivo em UTF-8 (acentos corretos).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.tamanhoMaximoPdf, files: 1 },
  defParamCharset: 'utf8',
});

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUS_EDITAVEIS = ['criado', 'pendente'];
const NAO_ENCONTRADO = { http: 404, corpo: { erro: 'Documento não encontrado.' } };
const NAO_EDITAVEL = { http: 409, corpo: { erro: 'Só é possível alterar documentos com o link pendente.' } };

// Data no formato aaaa-mm-dd, existente (rejeita 31/02), no passado e a partir de 1900.
function dataNascimentoValida(texto) {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (!partes) return false;
  const [ano, mes, dia] = partes.slice(1).map(Number);
  const data = new Date(ano, mes - 1, dia);
  const existe = data.getFullYear() === ano && data.getMonth() === mes - 1 && data.getDate() === dia;
  return existe && data < new Date() && ano >= 1900;
}

// Valida os dados do signatário (envio e edição). Validade vazia usa
// "padraoValidade": 7 dias no envio; na edição, null mantém a atual.
function validarDadosSignatario(corpo, padraoValidade) {
  const dados = {
    nome: String(corpo.nomeSignatario ?? '').trim(),
    email: String(corpo.emailSignatario ?? '').trim().toLowerCase(),
    cpf: normalizarCpf(corpo.cpfSignatario),
    dataNascimento: String(corpo.dataNascimentoSignatario ?? ''),
    validadeDias: padraoValidade,
  };
  if (!dados.nome || !EMAIL_VALIDO.test(dados.email)) {
    return { erro: 'Informe nome e e-mail válidos do signatário.' };
  }
  if (!cpfValido(dados.cpf)) {
    return { erro: 'CPF do signatário inválido.' };
  }
  if (!dataNascimentoValida(dados.dataNascimento)) {
    return { erro: 'Data de nascimento do signatário inválida.' };
  }
  const validade = String(corpo.validadeDias ?? '').trim();
  if (validade !== '') {
    dados.validadeDias = Number(validade);
    if (!Number.isInteger(dados.validadeDias) || dados.validadeDias < 1 || dados.validadeDias > 30) {
      return { erro: 'A validade do link deve ser de 1 a 30 dias.' };
    }
  }
  return { dados };
}

function montarLink(token) {
  return `${config.baseUrl}/assinar/${token}`;
}

// Token novo: o valor vai na URL; no banco ficam o hash e a cópia cifrada.
function novoToken() {
  const token = gerarToken();
  return { token, hash: sha256(token), cifrado: cifrar(token) };
}

function idDocumento(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Documento do solicitante logado, com o link e o signatário. Com
// "bloquear", trava a linha do link até o fim da transação.
async function buscarDocumento(executor, documentoId, solicitanteId, { bloquear = false } = {}) {
  if (!documentoId) return null;
  const [[documento]] = await executor.execute(
    `SELECT d.id, d.nome_arquivo AS nomeArquivo, d.hash_documento AS hashDocumento,
            d.caminho_arquivo AS caminhoArquivo,
            d.campo_pagina AS campoPagina, d.campo_x AS campoX, d.campo_y AS campoY,
            d.campo_largura AS campoLargura, d.campo_altura AS campoAltura,
            l.id AS linkId, l.status, l.token_cifrado AS tokenCifrado,
            l.data_expiracao AS dataExpiracao, l.tentativas_identificacao AS tentativasIdentificacao,
            s.id AS signatarioId, s.nome AS signatarioNome, s.email AS signatarioEmail, s.cpf,
            DATE_FORMAT(s.data_nascimento, '%Y-%m-%d') AS dataNascimento,
            a.arquivo_assinado AS arquivoAssinado
       FROM documento d
       JOIN link_assinatura l ON l.documento_id = d.id
       JOIN usuario s ON s.id = l.signatario_id
       LEFT JOIN assinatura a ON a.link_id = l.id
      WHERE d.id = ? AND d.solicitante_id = ?
      ${bloquear ? 'FOR UPDATE OF l' : ''}`,
    [documentoId, solicitanteId],
  );
  return documento ? { ...documento, campo: campoDoBanco(documento) } : null;
}

// Envia o link ao signatário (Criado -> Pendente) e registra o evento.
async function enviarLink({ linkId, documentoId, token, solicitanteId, ip }) {
  const [[destino]] = await pool.execute(
    `SELECT s.nome, s.email, l.data_expiracao AS dataExpiracao
       FROM link_assinatura l JOIN usuario s ON s.id = l.signatario_id
      WHERE l.id = ?`,
    [linkId],
  );
  const url = montarLink(token);
  await enviarLinkAoSignatario({ nome: destino.nome, email: destino.email, url, dataExpiracao: destino.dataExpiracao });
  await pool.execute("UPDATE link_assinatura SET status = 'pendente' WHERE id = ? AND status = 'criado'", [linkId]);
  await registrarEvento(pool, {
    evento: 'envio_link',
    documentoId,
    usuarioId: solicitanteId,
    detalhes: { emailSignatario: destino.email },
    ip,
  });
  return { url, dataExpiracao: destino.dataExpiracao };
}

rotasDocumentos.post('/', exigirSolicitante, upload.single('arquivo'), async (req, res) => {
  const arquivo = req.file;
  if (!arquivo) {
    return res.status(400).json({ erro: 'Selecione o arquivo PDF.' });
  }
  // Confere a assinatura binária do PDF, e não apenas a extensão.
  if (arquivo.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ erro: 'O arquivo precisa ser um PDF.' });
  }
  const { erro, dados } = validarDadosSignatario(req.body, 7);
  if (erro) {
    return res.status(400).json({ erro });
  }
  const totalPaginas = await contarPaginas(arquivo.buffer);
  if (!totalPaginas) {
    return res.status(400).json({ erro: 'Não foi possível ler o PDF. Verifique se ele não está protegido por senha ou corrompido.' });
  }
  const { erro: erroCampo, campo } = lerCampo(req.body, totalPaginas);
  if (erroCampo) {
    return res.status(400).json({ erro: erroCampo });
  }

  // Hash SHA-256 do documento original, armazenado para conferência na assinatura.
  const hashDocumento = sha256(arquivo.buffer);

  // O contrato aceita um único registro por documento: um PDF idêntico a
  // outro que ainda está (ou já foi) para a blockchain não pode ser enviado.
  const [[duplicado]] = await pool.execute(
    `SELECT d.id FROM documento d JOIN link_assinatura l ON l.documento_id = d.id
      WHERE d.hash_documento = ? AND l.status IN ('criado', 'pendente', 'assinado')
      LIMIT 1`,
    [hashDocumento],
  );
  if (duplicado) {
    return res.status(409).json({
      erro: 'Este arquivo já está em outro processo de assinatura. Como cada documento é registrado ' +
        'uma única vez na blockchain, envie um PDF próprio para cada signatário (por exemplo, com o nome dele no documento).',
    });
  }

  const nomeArquivo = arquivo.originalname;
  const nomeArmazenado = `${crypto.randomUUID()}.pdf`;
  const caminhoCompleto = path.join(config.pastaUploads, nomeArmazenado);
  await fs.mkdir(config.pastaUploads, { recursive: true });
  await fs.writeFile(caminhoCompleto, arquivo.buffer);

  const token = novoToken();
  const solicitanteId = req.session.solicitanteId;
  let ids;
  try {
    ids = await emTransacao(async (conexao) => {
      const [signatario] = await conexao.execute(
        "INSERT INTO usuario (tipo, nome, email, cpf, data_nascimento) VALUES ('signatario', ?, ?, ?, ?)",
        [dados.nome, dados.email, dados.cpf, dados.dataNascimento],
      );
      const [documento] = await conexao.execute(
        `INSERT INTO documento (solicitante_id, nome_arquivo, caminho_arquivo, tamanho_bytes, hash_documento,
                                campo_pagina, campo_x, campo_y, campo_largura, campo_altura)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [solicitanteId, nomeArquivo, nomeArmazenado, arquivo.size, hashDocumento,
          campo.pagina, campo.x, campo.y, campo.largura, campo.altura],
      );
      const [link] = await conexao.execute(
        `INSERT INTO link_assinatura (documento_id, signatario_id, token_hash, token_cifrado, data_expiracao)
         VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
        [documento.insertId, signatario.insertId, token.hash, token.cifrado, dados.validadeDias],
      );
      await registrarEvento(conexao, {
        evento: 'upload',
        documentoId: documento.insertId,
        usuarioId: solicitanteId,
        detalhes: { nomeArquivo, hashDocumento, tamanhoBytes: arquivo.size },
        ip: req.ip,
      });
      return { documentoId: documento.insertId, linkId: link.insertId };
    });
  } catch (erroGravacao) {
    await fs.rm(caminhoCompleto, { force: true });
    throw erroGravacao;
  }

  const { url, dataExpiracao } = await enviarLink({ ...ids, token: token.token, solicitanteId, ip: req.ip });
  res.status(201).json({ documentoId: ids.documentoId, hashDocumento, link: url, dataExpiracao });
});

rotasDocumentos.get('/', exigirSolicitante, async (req, res) => {
  await expirarLinksVencidos();
  const [documentos] = await pool.execute(
    `SELECT d.id, d.nome_arquivo AS nomeArquivo, d.hash_documento AS hashDocumento,
            d.data_upload AS dataUpload, l.status, l.data_expiracao AS dataExpiracao,
            l.tentativas_identificacao AS tentativasIdentificacao,
            s.nome AS signatarioNome, s.email AS signatarioEmail,
            a.status_blockchain AS statusBlockchain, a.tx_hash AS txHash,
            a.numero_bloco AS numeroBloco, a.tentativas_envio AS tentativasEnvio,
            d.campo_pagina IS NOT NULL AS temCaixa, a.arquivo_assinado IS NOT NULL AS temDocumentoAssinado
       FROM documento d
       JOIN link_assinatura l ON l.documento_id = d.id
       JOIN usuario s ON s.id = l.signatario_id
       LEFT JOIN assinatura a ON a.link_id = l.id
      WHERE d.solicitante_id = ?
      ORDER BY d.data_upload DESC, d.id DESC`,
    [req.session.solicitanteId],
  );
  res.json(documentos.map((doc) => ({
    ...doc,
    temCaixa: Boolean(doc.temCaixa),
    temDocumentoAssinado: Boolean(doc.temDocumentoAssinado),
    urlTransacao: doc.statusBlockchain === 'confirmada' ? urlTransacao(doc.txHash) : null,
  })));
});

rotasDocumentos.get('/:id', exigirSolicitante, async (req, res) => {
  await expirarLinksVencidos();
  const doc = await buscarDocumento(pool, idDocumento(req), req.session.solicitanteId);
  if (!doc) return res.status(404).json(NAO_ENCONTRADO.corpo);
  res.json({
    id: doc.id,
    nomeArquivo: doc.nomeArquivo,
    status: doc.status,
    dataExpiracao: doc.dataExpiracao,
    tentativasIdentificacao: doc.tentativasIdentificacao,
    signatario: { nome: doc.signatarioNome, email: doc.signatarioEmail, cpf: doc.cpf, dataNascimento: doc.dataNascimento },
  });
});

rotasDocumentos.put('/:id', exigirSolicitante, async (req, res) => {
  const { erro, dados } = validarDadosSignatario(req.body, null);
  if (erro) return res.status(400).json({ erro });
  const solicitanteId = req.session.solicitanteId;
  await expirarLinksVencidos();

  const resultado = await emTransacao(async (conexao) => {
    const doc = await buscarDocumento(conexao, idDocumento(req), solicitanteId, { bloquear: true });
    if (!doc) return NAO_ENCONTRADO;
    if (!STATUS_EDITAVEIS.includes(doc.status)) return NAO_EDITAVEL;

    const alterados = [];
    if (dados.nome !== doc.signatarioNome) alterados.push('nome');
    if (dados.email !== doc.signatarioEmail) alterados.push('email');
    if (dados.cpf !== doc.cpf) alterados.push('cpf');
    if (dados.dataNascimento !== doc.dataNascimento) alterados.push('dataNascimento');
    if (dados.validadeDias !== null) alterados.push('validade');
    if (alterados.length === 0) return { http: 200, corpo: { alterados } };

    const identidadeMudou = alterados.includes('cpf') || alterados.includes('dataNascimento');
    const emailMudou = alterados.includes('email');

    await conexao.execute(
      'UPDATE usuario SET nome = ?, email = ?, cpf = ?, data_nascimento = ? WHERE id = ?',
      [dados.nome, dados.email, dados.cpf, dados.dataNascimento, doc.signatarioId],
    );
    // Toda edição exige nova identificação do signatário (versao_dados).
    // Se o CPF ou a data mudaram, as tentativas erradas provavelmente se
    // deviam ao dado incorreto: o contador volta a zero.
    await conexao.execute(
      `UPDATE link_assinatura
          SET versao_dados = versao_dados + 1,
              tentativas_identificacao = IF(?, 0, tentativas_identificacao)
        WHERE id = ?`,
      [identidadeMudou, doc.linkId],
    );
    if (dados.validadeDias !== null) {
      await conexao.execute(
        'UPDATE link_assinatura SET data_expiracao = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = ?',
        [dados.validadeDias, doc.linkId],
      );
    }
    await registrarEvento(conexao, {
      evento: 'edicao_dados',
      documentoId: doc.id,
      usuarioId: solicitanteId,
      detalhes: { alterados, tentativasZeradas: identidadeMudou, linkReenviado: emailMudou },
      ip: req.ip,
    });
    return {
      http: 200,
      corpo: { alterados, tentativasZeradas: identidadeMudou, linkReenviado: emailMudou },
      // E-mail corrigido: o mesmo link é reenviado ao novo endereço. Se ele
      // chegou antes à pessoa errada, ela não abre o documento sem o CPF e a
      // data de nascimento do signatário.
      reenvio: emailMudou && { linkId: doc.linkId, documentoId: doc.id, token: decifrar(doc.tokenCifrado) },
    };
  });

  if (resultado.reenvio) {
    await enviarLink({ ...resultado.reenvio, solicitanteId, ip: req.ip });
  }
  res.status(resultado.http).json(resultado.corpo);
});

rotasDocumentos.get('/:id/link', exigirSolicitante, async (req, res) => {
  await expirarLinksVencidos();
  const doc = await buscarDocumento(pool, idDocumento(req), req.session.solicitanteId);
  if (!doc) return res.status(404).json(NAO_ENCONTRADO.corpo);
  if (!STATUS_EDITAVEIS.includes(doc.status)) {
    return res.status(409).json({ erro: 'O link só fica disponível enquanto a assinatura estiver pendente.' });
  }
  res.json({ link: montarLink(decifrar(doc.tokenCifrado)) });
});

rotasDocumentos.get('/:id/arquivo', exigirSolicitante, async (req, res) => {
  const doc = await buscarDocumento(pool, idDocumento(req), req.session.solicitanteId);
  if (!doc) return res.status(404).json(NAO_ENCONTRADO.corpo);
  enviarPdf(res, doc.caminhoArquivo, doc.nomeArquivo);
});

// PDF com a caixa de assinatura: a cópia gerada na assinatura ou, enquanto o
// link está pendente, uma prévia com a caixa vazia para conferir a posição.
rotasDocumentos.get('/:id/arquivo-assinado', exigirSolicitante, async (req, res) => {
  const doc = await buscarDocumento(pool, idDocumento(req), req.session.solicitanteId);
  if (!doc) return res.status(404).json(NAO_ENCONTRADO.corpo);
  if (doc.arquivoAssinado) {
    return enviarPdf(res, doc.arquivoAssinado, nomeDaCopia(doc.nomeArquivo, 'assinado'));
  }
  if (!doc.campo || !STATUS_EDITAVEIS.includes(doc.status)) {
    return res.status(404).json({ erro: 'Este documento não tem versão com a caixa de assinatura.' });
  }
  const original = await fs.readFile(path.join(config.pastaUploads, doc.caminhoArquivo));
  const previa = await gerarPdfComCaixa(original, doc.campo, {
    nome: doc.signatarioNome,
    codigo: codigoVerificacao(doc.hashDocumento),
    previa: true,
  });
  enviarPdfGerado(res, previa, nomeDaCopia(doc.nomeArquivo, 'prévia da assinatura'));
});
