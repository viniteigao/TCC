// Rotas públicas do signatário (sem login): acesso pelo token do link.
//
// Fluxo (diagrama de atividades):
//   1. GET    /:token                -> situação do link
//   2. POST   /:token/identificacao  -> CPF + data de nascimento (até 3 tentativas)
//   3. GET    /:token/documento      -> PDF (somente após a identificação)
//      GET    /:token/documento-assinado -> cópia com a caixa preenchida
//   4. POST   /:token/assinar        -> aceite, conferência do hash, evidências
//      POST   /:token/recusar        -> recusa explícita
//   5. GET    /:token/registro       -> situação do registro na blockchain
//
// O progresso do signatário (identidade confirmada, documento visualizado)
// fica na sessão, em req.session.links[idDoLink], e só vale para a versão
// dos dados em que foi obtido: se o solicitante editar os dados, o
// signatário precisa se identificar de novo.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { pool, emTransacao } from '../db.js';
import { registrarEvento } from '../auditoria.js';
import { sha256 } from '../util/hash.js';
import { normalizarCpf } from '../util/cpf.js';
import { expirarLinksVencidos } from '../servicos/links.js';
import { notificarSolicitante } from '../servicos/notificacao.js';
import { enviarPdf } from '../servicos/arquivos.js';
import {
  campoDoBanco, codigoVerificacao, dataHoraBrasilia, gerarPdfComCaixa, nomeDaCopia,
} from '../servicos/carimbo.js';
import { enfileirarRegistro, urlTransacao } from '../blockchain/registro.js';

export const rotasAssinatura = Router();

const MAXIMO_TENTATIVAS = 3;
const TOKEN_VALIDO = /^[A-Za-z0-9_-]{43}$/;

const MENSAGENS_STATUS = {
  criado: 'Este link ainda não está disponível.',
  assinado: 'Este documento já foi assinado.',
  recusado: 'A assinatura deste documento foi recusada.',
  expirado: 'Este link expirou. Solicite um novo envio ao remetente.',
  bloqueado: 'Este link foi bloqueado após 3 tentativas de identificação sem sucesso.',
};

// Busca o link pelo hash do token. Com "bloquear", trava a linha do link
// até o fim da transação (evita duas requisições simultâneas burlarem o
// limite de tentativas ou assinarem duas vezes).
async function buscarLinkPorToken(executor, token, { bloquear = false } = {}) {
  if (!TOKEN_VALIDO.test(token)) return null;
  const [[link]] = await executor.execute(
    `SELECT l.id, l.status, l.tentativas_identificacao AS tentativas, l.data_expiracao AS dataExpiracao,
            l.token_hash AS tokenHash, l.signatario_id AS signatarioId, l.versao_dados AS versaoDados,
            d.id AS documentoId, d.nome_arquivo AS nomeArquivo, d.caminho_arquivo AS caminhoArquivo,
            d.hash_documento AS hashDocumento,
            d.campo_pagina AS campoPagina, d.campo_x AS campoX, d.campo_y AS campoY,
            d.campo_largura AS campoLargura, d.campo_altura AS campoAltura,
            s.nome AS signatarioNome, s.cpf, DATE_FORMAT(s.data_nascimento, '%Y-%m-%d') AS dataNascimento,
            so.nome AS solicitanteNome, so.email AS solicitanteEmail
       FROM link_assinatura l
       JOIN documento d ON d.id = l.documento_id
       JOIN usuario s ON s.id = l.signatario_id
       JOIN usuario so ON so.id = d.solicitante_id
      WHERE l.token_hash = ?
      ${bloquear ? 'FOR UPDATE OF l' : ''}`,
    [sha256(token)],
  );
  return link ? { ...link, campo: campoDoBanco(link) } : null;
}

function progresso(req, link) {
  const sessao = req.session.links?.[link.id];
  return sessao && sessao.versaoDados === link.versaoDados ? sessao : null;
}

function salvarProgresso(req, linkId, dados) {
  req.session.links = { ...req.session.links, [linkId]: { ...req.session.links?.[linkId], ...dados } };
}

function dadosDocumento(link) {
  return {
    nomeArquivo: link.nomeArquivo,
    solicitante: link.solicitanteNome,
    signatario: link.signatarioNome,
    paginaAssinatura: link.campo?.pagina ?? null,
  };
}

function respostaStatusInvalido(link) {
  return { http: 409, corpo: { erro: MENSAGENS_STATUS[link.status], status: link.status } };
}

// Comprovante da assinatura, com a situação do registro na blockchain.
async function buscarAssinatura(linkId) {
  const [[assinatura]] = await pool.execute(
    `SELECT data_assinatura AS dataAssinatura, hash_documento AS hashDocumento,
            hash_evidencias AS hashEvidencias, status_blockchain AS statusBlockchain,
            tx_hash AS txHash, numero_bloco AS numeroBloco,
            arquivo_assinado IS NOT NULL AS temDocumentoAssinado
       FROM assinatura WHERE link_id = ?`,
    [linkId],
  );
  if (!assinatura) return null;
  const confirmada = assinatura.statusBlockchain === 'confirmada';
  return {
    ...assinatura,
    temDocumentoAssinado: Boolean(assinatura.temDocumentoAssinado),
    urlTransacao: confirmada ? urlTransacao(assinatura.txHash) : null,
  };
}

// 1. Situação do link. Dados do documento só aparecem após a identificação.
rotasAssinatura.get('/:token', async (req, res) => {
  await expirarLinksVencidos();
  const link = await buscarLinkPorToken(pool, req.params.token);
  if (!link) {
    return res.status(404).json({ erro: 'Link inválido ou inexistente.' });
  }
  await registrarEvento(pool, { evento: 'acesso_link', documentoId: link.documentoId, ip: req.ip });

  const sessao = progresso(req, link);
  const identidadeConfirmada = Boolean(sessao?.identidadeConfirmadaEm);
  const corpo = {
    status: link.status,
    mensagem: MENSAGENS_STATUS[link.status] ?? null,
    tentativasRestantes: MAXIMO_TENTATIVAS - link.tentativas,
    dataExpiracao: link.dataExpiracao,
    identidadeConfirmada: identidadeConfirmada && link.status === 'pendente',
  };
  if (corpo.identidadeConfirmada) {
    corpo.documento = dadosDocumento(link);
  }
  // Quem assinou nesta sessão vê o comprovante.
  if (link.status === 'assinado' && identidadeConfirmada) {
    corpo.documento = dadosDocumento(link);
    corpo.assinatura = await buscarAssinatura(link.id);
  }
  res.json(corpo);
});

// 5. Situação do registro na blockchain, consultada pela página do
// signatário enquanto aguarda a confirmação (não grava acesso no log).
rotasAssinatura.get('/:token/registro', async (req, res) => {
  const link = await buscarLinkPorToken(pool, req.params.token);
  if (!link) return res.status(404).json({ erro: 'Link inválido ou inexistente.' });
  if (link.status !== 'assinado' || !progresso(req, link)?.identidadeConfirmadaEm) {
    return res.status(403).json({ erro: 'Comprovante indisponível.' });
  }
  res.json(await buscarAssinatura(link.id));
});

// 2. Verificação de identidade: CPF e data de nascimento, até 3 tentativas.
rotasAssinatura.post('/:token/identificacao', async (req, res) => {
  const cpf = normalizarCpf(req.body.cpf);
  const dataNascimento = String(req.body.dataNascimento ?? '');

  const resultado = await emTransacao(async (conexao) => {
    const link = await buscarLinkPorToken(conexao, req.params.token, { bloquear: true });
    if (!link) return { http: 404, corpo: { erro: 'Link inválido ou inexistente.' } };
    if (link.status !== 'pendente') return respostaStatusInvalido(link);

    if (cpf === link.cpf && dataNascimento === link.dataNascimento) {
      await conexao.execute('UPDATE link_assinatura SET identidade_confirmada_em = NOW() WHERE id = ?', [link.id]);
      await registrarEvento(conexao, { evento: 'identidade_confirmada', documentoId: link.documentoId, usuarioId: link.signatarioId, ip: req.ip });
      return {
        http: 200,
        corpo: { identidadeConfirmada: true, documento: dadosDocumento(link) },
        progresso: {
          linkId: link.id,
          versaoDados: link.versaoDados,
          identidadeConfirmadaEm: new Date().toISOString(),
          documentoVisualizado: false,
        },
      };
    }

    // Dados não conferem: conta a tentativa; na terceira, bloqueia o link.
    const tentativas = link.tentativas + 1;
    const bloqueou = tentativas >= MAXIMO_TENTATIVAS;
    await conexao.execute(
      `UPDATE link_assinatura
          SET tentativas_identificacao = ?,
              status = IF(?, 'bloqueado', status),
              data_decisao = IF(?, NOW(), data_decisao)
        WHERE id = ?`,
      [tentativas, bloqueou, bloqueou, link.id],
    );
    await registrarEvento(conexao, {
      evento: 'falha_identificacao',
      documentoId: link.documentoId,
      detalhes: { tentativa: tentativas },
      ip: req.ip,
    });

    if (!bloqueou) {
      const restantes = MAXIMO_TENTATIVAS - tentativas;
      return {
        http: 401,
        corpo: { erro: `CPF ou data de nascimento não conferem. Restam ${restantes} tentativa(s).`, tentativasRestantes: restantes },
      };
    }
    await registrarEvento(conexao, { evento: 'bloqueio_link', documentoId: link.documentoId, ip: req.ip });
    return {
      http: 403,
      corpo: { erro: MENSAGENS_STATUS.bloqueado + ' O solicitante foi notificado.', status: 'bloqueado' },
      notificacao: {
        nome: link.solicitanteNome,
        email: link.solicitanteEmail,
        assunto: 'Link de assinatura bloqueado',
        texto: `O link do documento "${link.nomeArquivo}" foi bloqueado após 3 tentativas de identificação sem sucesso.`,
      },
    };
  });

  // A sessão só registra a identidade confirmada depois do commit no banco.
  if (resultado.progresso) {
    const { linkId, ...dados } = resultado.progresso;
    salvarProgresso(req, linkId, dados);
  }
  if (resultado.notificacao) await notificarSolicitante(resultado.notificacao);
  res.status(resultado.http).json(resultado.corpo);
});

// 3. Exibição do PDF, liberada somente após a identificação: enquanto o link
// está pendente (para o signatário decidir) e, depois da assinatura, para a
// sessão que se identificou (o comprovante oferece "Ver documento assinado").
const STATUS_COM_DOCUMENTO = ['pendente', 'assinado'];

rotasAssinatura.get('/:token/documento', async (req, res) => {
  const link = await buscarLinkPorToken(pool, req.params.token);
  if (!link) return res.status(404).json({ erro: 'Link inválido ou inexistente.' });
  if (!STATUS_COM_DOCUMENTO.includes(link.status)) {
    return res.status(409).json({ erro: MENSAGENS_STATUS[link.status] });
  }
  const sessao = progresso(req, link);
  if (!sessao?.identidadeConfirmadaEm) {
    return res.status(403).json({ erro: 'Confirme sua identidade para abrir o documento.' });
  }

  if (!sessao.documentoVisualizado) {
    salvarProgresso(req, link.id, { documentoVisualizado: true });
    await registrarEvento(pool, { evento: 'visualizacao_documento', documentoId: link.documentoId, usuarioId: link.signatarioId, ip: req.ip });
  }
  enviarPdf(res, link.caminhoArquivo, link.nomeArquivo);
});

// Cópia com a caixa de assinatura preenchida, para a sessão que se identificou.
rotasAssinatura.get('/:token/documento-assinado', async (req, res) => {
  const link = await buscarLinkPorToken(pool, req.params.token);
  if (!link) return res.status(404).json({ erro: 'Link inválido ou inexistente.' });
  if (link.status !== 'assinado' || !progresso(req, link)?.identidadeConfirmadaEm) {
    return res.status(403).json({ erro: 'Documento assinado indisponível.' });
  }
  const [[assinatura]] = await pool.execute('SELECT arquivo_assinado AS arquivo FROM assinatura WHERE link_id = ?', [link.id]);
  if (!assinatura?.arquivo) {
    return res.status(404).json({ erro: 'Este documento não tem cópia com a caixa de assinatura.' });
  }
  enviarPdf(res, assinatura.arquivo, nomeDaCopia(link.nomeArquivo, 'assinado'));
});

// 4a. Assinatura: aceite explícito, conferência do hash e coleta das evidências.
rotasAssinatura.post('/:token/assinar', async (req, res) => {
  if (req.body.aceite !== true) {
    return res.status(400).json({ erro: 'É necessário declarar o aceite para assinar o documento.' });
  }

  // Cópia assinada gravada em disco; é apagada se a transação for desfeita.
  let copiaGravada = null;
  const resultado = await emTransacao(async (conexao) => {
    const link = await buscarLinkPorToken(conexao, req.params.token, { bloquear: true });
    if (!link) return { http: 404, corpo: { erro: 'Link inválido ou inexistente.' } };
    if (link.status !== 'pendente') return respostaStatusInvalido(link);
    const sessao = progresso(req, link);
    if (!sessao?.identidadeConfirmadaEm) {
      return { http: 403, corpo: { erro: 'Confirme sua identidade antes de assinar.' } };
    }
    if (!sessao.documentoVisualizado) {
      return { http: 409, corpo: { erro: 'Abra o documento antes de assiná-lo.' } };
    }

    // Recalcula o SHA-256 do arquivo e compara com o hash do upload.
    const conteudo = await fs.readFile(path.join(config.pastaUploads, link.caminhoArquivo)).catch(() => null);
    const hashAtual = conteudo ? sha256(conteudo) : null;
    if (hashAtual !== link.hashDocumento) {
      await registrarEvento(conexao, {
        evento: 'integridade_violada',
        documentoId: link.documentoId,
        detalhes: { hashEsperado: link.hashDocumento, hashAtual },
        ip: req.ip,
      });
      return {
        http: 409,
        corpo: {
          erro: 'O documento foi alterado após o envio e a assinatura foi bloqueada. O solicitante foi notificado.',
          integridadeViolada: true,
        },
        notificacao: {
          nome: link.solicitanteNome,
          email: link.solicitanteEmail,
          assunto: 'Divergência de integridade no documento',
          texto: `O hash do documento "${link.nomeArquivo}" não confere com o registrado no envio. A assinatura foi bloqueada.`,
        },
      };
    }

    const dataAssinatura = new Date();
    const enderecoIp = req.ip;
    const navegador = (req.get('user-agent') ?? 'desconhecido').slice(0, 500);

    // Cópia do PDF com a caixa preenchida (nome, data e hora e código de
    // verificação). O original não muda; o hash da cópia entra nas evidências.
    let copia = null;
    if (link.campo) {
      const conteudoCopia = await gerarPdfComCaixa(conteudo, link.campo, {
        nome: link.signatarioNome,
        dataHora: dataHoraBrasilia(dataAssinatura),
        codigo: codigoVerificacao(link.hashDocumento),
      });
      copia = { arquivo: link.caminhoArquivo.replace(/\.pdf$/i, '-assinado.pdf'), hash: sha256(conteudoCopia) };
      await fs.writeFile(path.join(config.pastaUploads, copia.arquivo), conteudoCopia);
      copiaGravada = copia.arquivo;
    }

    // Evidências da assinatura. O texto serializado é guardado exatamente
    // como foi usado no hash, para permitir a verificação posterior.
    const evidencias = JSON.stringify({
      versao: 2,
      documento: { id: link.documentoId, hashSha256: link.hashDocumento },
      documentoAssinado: copia && { hashSha256: copia.hash },
      link: { id: link.id, tokenHash: link.tokenHash },
      signatario: {
        nome: link.signatarioNome,
        cpf: link.cpf,
        dataNascimento: link.dataNascimento,
        identidadeConfirmada: true,
        identidadeConfirmadaEm: sessao.identidadeConfirmadaEm,
      },
      assinatura: {
        dataHora: dataAssinatura.toISOString(),
        enderecoIp,
        navegador,
        aceiteExplicito: true,
      },
    });
    const hashEvidencias = sha256(evidencias);

    const [assinatura] = await conexao.execute(
      `INSERT INTO assinatura
         (link_id, signatario_id, data_assinatura, hash_documento, identidade_confirmada,
          endereco_ip, navegador, aceite_explicito, evidencias, hash_evidencias,
          arquivo_assinado, hash_arquivo_assinado)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?)`,
      [link.id, link.signatarioId, dataAssinatura, link.hashDocumento, enderecoIp, navegador,
        evidencias, hashEvidencias, copia?.arquivo ?? null, copia?.hash ?? null],
    );
    await conexao.execute(
      "UPDATE link_assinatura SET status = 'assinado', data_decisao = NOW() WHERE id = ?",
      [link.id],
    );
    await registrarEvento(conexao, {
      evento: 'assinatura',
      documentoId: link.documentoId,
      usuarioId: link.signatarioId,
      detalhes: { hashDocumento: link.hashDocumento, hashEvidencias },
      ip: enderecoIp,
    });

    return {
      http: 201,
      corpo: {
        status: 'assinado',
        assinatura: {
          dataAssinatura,
          hashDocumento: link.hashDocumento,
          hashEvidencias,
          statusBlockchain: 'aguardando_registro',
          txHash: null,
          numeroBloco: null,
          urlTransacao: null,
          temDocumentoAssinado: Boolean(copia),
        },
      },
      assinaturaId: assinatura.insertId,
    };
  }).catch(async (erro) => {
    if (copiaGravada) await fs.rm(path.join(config.pastaUploads, copiaGravada), { force: true });
    throw erro;
  });

  if (resultado.notificacao) await notificarSolicitante(resultado.notificacao);
  // Registro do hash do documento e do hash das evidências no contrato,
  // feito em segundo plano; a página do signatário acompanha a confirmação.
  if (resultado.assinaturaId) enfileirarRegistro(resultado.assinaturaId);
  res.status(resultado.http).json(resultado.corpo);
});

// 4b. Recusa explícita: estado final Recusado, sem transação on-chain.
rotasAssinatura.post('/:token/recusar', async (req, res) => {
  const resultado = await emTransacao(async (conexao) => {
    const link = await buscarLinkPorToken(conexao, req.params.token, { bloquear: true });
    if (!link) return { http: 404, corpo: { erro: 'Link inválido ou inexistente.' } };
    if (link.status !== 'pendente') return respostaStatusInvalido(link);
    if (!progresso(req, link)?.identidadeConfirmadaEm) {
      return { http: 403, corpo: { erro: 'Confirme sua identidade antes de recusar.' } };
    }

    await conexao.execute(
      "UPDATE link_assinatura SET status = 'recusado', data_decisao = NOW() WHERE id = ?",
      [link.id],
    );
    await registrarEvento(conexao, { evento: 'recusa', documentoId: link.documentoId, usuarioId: link.signatarioId, ip: req.ip });
    return {
      http: 200,
      corpo: { status: 'recusado' },
      notificacao: {
        nome: link.solicitanteNome,
        email: link.solicitanteEmail,
        assunto: 'Assinatura recusada',
        texto: `${link.signatarioNome} recusou a assinatura do documento "${link.nomeArquivo}".`,
      },
    };
  });

  if (resultado.notificacao) await notificarSolicitante(resultado.notificacao);
  res.status(resultado.http).json(resultado.corpo);
});
