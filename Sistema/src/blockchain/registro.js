// Registro das assinaturas na blockchain, com a política de reenvio do TCC
// (diagramas de atividades e de estados):
//   - antes de cada envio, consulta o contrato (idempotência): se o hash do
//     documento já consta com as mesmas evidências, o registro é confirmado
//     sem nova transação;
//   - falha transitória (sem inclusão em bloco no prazo, provedor RPC
//     indisponível): reenvia com o mesmo nonce e taxa ajustada, até 3
//     tentativas de envio no total;
//   - falha determinística (reversão pelo contrato, saldo insuficiente) ou
//     tentativas esgotadas: estado final Falha.
// Os registros são processados um por vez (fila), porque saem todos da
// mesma carteira e cada transação depende do nonce da anterior.

import { ethers } from 'ethers';
import { config } from '../config.js';
import { pool } from '../db.js';
import { registrarEvento } from '../auditoria.js';
import { notificarSolicitante } from '../servicos/notificacao.js';
import { criarClienteEthers } from './cliente.js';

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cliente = null;
let situacao = { ativo: false, motivo: 'Blockchain ainda não iniciada.' };
let fila = Promise.resolve();
const naFila = new Set();

export function situacaoBlockchain() {
  return situacao;
}

export function urlTransacao(txHash) {
  return txHash ? `${config.blockchain.explorador}/tx/${txHash}` : null;
}

// Conecta à rede, confere a configuração e retoma registros pendentes.
export async function iniciarBlockchain() {
  const { rpcUrl, chavePrivada, contrato } = config.blockchain;
  if (!rpcUrl || !chavePrivada || !contrato) {
    situacao = {
      ativo: false,
      motivo: 'Blockchain não configurada: preencha BLOCKCHAIN_RPC_URL, BLOCKCHAIN_CHAVE_PRIVADA e BLOCKCHAIN_CONTRATO no .env.',
    };
    console.warn(`Aviso: ${situacao.motivo} As assinaturas ficarão aguardando registro.`);
    return situacao;
  }

  try {
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(chavePrivada)) {
      throw new Error('BLOCKCHAIN_CHAVE_PRIVADA deve ter 64 caracteres hexadecimais.');
    }
    if (!ethers.isAddress(contrato)) {
      throw new Error('BLOCKCHAIN_CONTRATO não é um endereço válido (0x seguido de 40 caracteres).');
    }
    const novoCliente = await criarClienteEthers(config.blockchain);
    const info = await novoCliente.verificar();
    if (!info.temCodigo) {
      throw new Error(`Não há contrato no endereço ${info.contrato} na rede ${info.rede}. Confira o endereço copiado do Remix.`);
    }
    if (info.dono?.toLowerCase() !== info.carteira.toLowerCase()) {
      throw new Error(`A carteira do .env (${info.carteira}) não é a dona do contrato (${info.dono}). Faça o deploy no Remix com essa mesma conta.`);
    }
    cliente = novoCliente;
    situacao = {
      ativo: true,
      rede: info.rede,
      chainId: info.chainId,
      carteira: info.carteira,
      saldoEth: ethers.formatEther(info.saldoWei),
      contrato: info.contrato,
      explorador: config.blockchain.explorador,
    };
    console.log(`Blockchain ativa: rede ${info.rede}, carteira ${info.carteira} (saldo ${situacao.saldoEth} ETH), contrato ${info.contrato}.`);
  } catch (erro) {
    situacao = { ativo: false, motivo: erro.message };
    console.error(`Blockchain desativada: ${erro.message}`);
    return situacao;
  }

  // Retoma registros que ficaram pendentes (ex.: servidor reiniciado durante a espera).
  const [pendentes] = await pool.execute(
    "SELECT id FROM assinatura WHERE status_blockchain = 'aguardando_registro' ORDER BY id",
  );
  for (const { id } of pendentes) enfileirarRegistro(id);
  if (pendentes.length > 0) console.log(`Retomando ${pendentes.length} registro(s) pendente(s).`);
  return situacao;
}

export function enfileirarRegistro(assinaturaId) {
  if (!cliente || naFila.has(assinaturaId)) return;
  naFila.add(assinaturaId);
  fila = fila
    .then(() => processarRegistro(assinaturaId, { cliente }))
    .catch((erro) => console.error(`Erro no registro da assinatura ${assinaturaId}:`, erro))
    .finally(() => naFila.delete(assinaturaId));
}

// Executa a política de registro de uma assinatura até Confirmada ou Falha.
export async function processarRegistro(assinaturaId, {
  cliente: rede,
  maximoTentativas = config.blockchain.maximoTentativas,
  esperaMs = config.blockchain.esperaSegundos * 1000,
  intervaloMs = 2000,
  pausaMs = 5000,
}) {
  const registro = await carregar(assinaturaId);
  if (!registro || registro.status !== 'aguardando_registro') return;

  const hashDocumento = `0x${registro.hashDocumento}`;
  const hashEvidencias = `0x${registro.hashEvidencias}`;
  const enviadas = registro.txHash ? [registro.txHash] : [];
  let tentativas = registro.tentativas;

  for (;;) {
    // Consulta prévia ao contrato (idempotência).
    const noContrato = await consultarContrato(rede, hashDocumento, hashEvidencias);
    if (noContrato.situacao === 'confirmado') return confirmar(registro, noContrato, enviadas, tentativas);
    if (noContrato.situacao === 'conflito') {
      return falhar(registro, 'O documento já está registrado no contrato com outras evidências.');
    }
    if (tentativas >= maximoTentativas) {
      return falhar(registro, `Registro não confirmado após ${maximoTentativas} tentativas de envio.`);
    }

    tentativas += 1;
    await pool.execute('UPDATE assinatura SET tentativas_envio = ? WHERE id = ?', [tentativas, registro.id]);

    try {
      // Reenvio usa o mesmo nonce da transação anterior (se ela ainda existir
      // na rede), para substituí-la em vez de criar um segundo registro.
      const anterior = enviadas.length > 0 ? await rede.transacao(enviadas.at(-1)) : null;
      const nonce = anterior?.nonce ?? (await rede.proximoNonce());
      const taxas = ajustarTaxas(await rede.taxas(), anterior);
      const { hash } = await rede.enviar(hashDocumento, hashEvidencias, { nonce, ...taxas });
      enviadas.push(hash);
      await pool.execute(
        'UPDATE assinatura SET tx_hash = ?, data_envio_tx = COALESCE(data_envio_tx, NOW(3)) WHERE id = ?',
        [hash, registro.id],
      );
      await evento(registro, 'registro_blockchain_enviado', {
        tentativa: tentativas,
        txHash: hash,
        nonce,
        maxFeePerGas: taxas.maxFeePerGas.toString(),
      });
    } catch (erro) {
      const tipo = erro?.tipo ?? 'transitoria';
      const motivo = erro?.mensagem ?? String(erro?.message ?? erro);
      if (tipo === 'deterministica') return falhar(registro, motivo);
      // Transitória ou já registrado: a próxima volta consulta o contrato de novo.
      await evento(registro, 'registro_blockchain_erro_envio', { tentativa: tentativas, motivo });
      await dormir(pausaMs);
      continue;
    }

    const recibo = await aguardarInclusao(rede, enviadas, esperaMs, intervaloMs);
    if (recibo?.status === 1) return confirmar(registro, { recibo }, enviadas, tentativas);
    if (recibo) {
      // Revertida na rede: só é sucesso se uma tentativa anterior já gravou o hash.
      const depois = await consultarContrato(rede, hashDocumento, hashEvidencias);
      if (depois.situacao === 'confirmado') return confirmar(registro, depois, enviadas, tentativas);
      return falhar(registro, 'A transação foi revertida pelo contrato.');
    }
    // Sem inclusão em bloco no prazo: falha transitória, nova tentativa.
    await evento(registro, 'registro_blockchain_sem_confirmacao', { tentativa: tentativas, esperaSegundos: esperaMs / 1000 });
  }
}

async function carregar(assinaturaId) {
  const [[registro]] = await pool.execute(
    `SELECT a.id, a.hash_documento AS hashDocumento, a.hash_evidencias AS hashEvidencias,
            a.status_blockchain AS status, a.tentativas_envio AS tentativas, a.tx_hash AS txHash,
            d.id AS documentoId, d.nome_arquivo AS nomeArquivo,
            s.nome AS signatarioNome, so.nome AS solicitanteNome, so.email AS solicitanteEmail
       FROM assinatura a
       JOIN link_assinatura l ON l.id = a.link_id
       JOIN documento d ON d.id = l.documento_id
       JOIN usuario s ON s.id = a.signatario_id
       JOIN usuario so ON so.id = d.solicitante_id
      WHERE a.id = ?`,
    [assinaturaId],
  );
  return registro ?? null;
}

async function consultarContrato(rede, hashDocumento, hashEvidencias) {
  let registro;
  try {
    registro = await rede.consultar(hashDocumento);
  } catch {
    return { situacao: 'indisponivel' };
  }
  if (!registro.registrado) return { situacao: 'ausente' };
  if (registro.hashEvidencias.toLowerCase() !== hashEvidencias.toLowerCase()) return { situacao: 'conflito' };
  const recibo = await rede.reciboDoRegistro(hashDocumento, registro.numeroBloco).catch(() => null);
  return { situacao: 'confirmado', recibo, numeroBloco: registro.numeroBloco };
}

// Acompanha todas as transações já enviadas para este registro: com o mesmo
// nonce, qualquer uma delas pode ser a incluída no bloco.
async function aguardarInclusao(rede, hashes, esperaMs, intervaloMs) {
  const limite = Date.now() + esperaMs;
  do {
    for (const hash of hashes) {
      const recibo = await rede.recibo(hash).catch(() => null);
      if (recibo) return recibo;
    }
    await dormir(intervaloMs);
  } while (Date.now() < limite);
  return null;
}

// Para substituir uma transação pendente (mesmo nonce), a rede exige taxas
// maiores: usa a taxa atual da rede ou 30% acima da anterior, a que for maior.
function ajustarTaxas(atuais, anterior) {
  if (!anterior) {
    return { maxFeePerGas: atuais.maxFeePerGas, maxPriorityFeePerGas: atuais.maxPriorityFeePerGas };
  }
  const maior = (a, b) => (a > b ? a : b);
  const prioridade = maior(atuais.maxPriorityFeePerGas, (anterior.maxPriorityFeePerGas * 13n) / 10n);
  const maximo = maior(maior(atuais.maxFeePerGas, (anterior.maxFeePerGas * 13n) / 10n), prioridade);
  return { maxFeePerGas: maximo, maxPriorityFeePerGas: prioridade };
}

async function confirmar(registro, { recibo, numeroBloco }, enviadas, tentativas) {
  const txHash = recibo?.hash ?? enviadas.at(-1) ?? null;
  const bloco = recibo?.numeroBloco ?? numeroBloco ?? null;
  const gasUsado = recibo?.gasUsado ?? null;
  const custoWei = gasUsado !== null && recibo?.precoGas != null ? gasUsado * recibo.precoGas : null;

  const [resultado] = await pool.execute(
    `UPDATE assinatura
        SET status_blockchain = 'confirmada', tx_hash = ?, numero_bloco = ?, gas_usado = ?,
            custo_wei = ?, data_confirmacao = NOW(3), erro_blockchain = NULL
      WHERE id = ? AND status_blockchain = 'aguardando_registro'`,
    [txHash, bloco, gasUsado?.toString() ?? null, custoWei?.toString() ?? null, registro.id],
  );
  if (resultado.affectedRows === 0) return;

  await evento(registro, 'registro_blockchain_confirmado', {
    txHash,
    numeroBloco: bloco,
    gasUsado: gasUsado?.toString() ?? null,
    tentativas,
  });
  await notificarSolicitante({
    nome: registro.solicitanteNome,
    email: registro.solicitanteEmail,
    assunto: 'Assinatura concluída',
    texto: `${registro.signatarioNome} assinou o documento "${registro.nomeArquivo}". ` +
      `Registro na blockchain confirmado no bloco ${bloco}: ${urlTransacao(txHash)}`,
  });
}

async function falhar(registro, motivo) {
  const [resultado] = await pool.execute(
    "UPDATE assinatura SET status_blockchain = 'falha', erro_blockchain = ? WHERE id = ? AND status_blockchain = 'aguardando_registro'",
    [motivo, registro.id],
  );
  if (resultado.affectedRows === 0) return;

  await evento(registro, 'registro_blockchain_falha', { motivo });
  await notificarSolicitante({
    nome: registro.solicitanteNome,
    email: registro.solicitanteEmail,
    assunto: 'Falha no registro da assinatura na blockchain',
    texto: `A assinatura do documento "${registro.nomeArquivo}" foi feita, mas o registro na blockchain falhou: ${motivo}`,
  });
}

function evento(registro, nome, detalhes) {
  return registrarEvento(pool, { evento: nome, documentoId: registro.documentoId, detalhes });
}
