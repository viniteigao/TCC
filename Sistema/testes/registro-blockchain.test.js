// Testes da política de registro na blockchain (diagramas de atividades e de
// estados do TCC): reenvio com o mesmo nonce e taxa ajustada em falhas
// transitórias, até 3 tentativas; Falha em erros determinísticos ou com as
// tentativas esgotadas; consulta prévia ao contrato (idempotência).
// Usam uma rede simulada em memória, sem acesso à internet, e o banco de teste.
// Uso: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

process.env.DB_NAME = 'assinatura_eletronica_teste';
process.env.PASTA_UPLOADS = path.join(os.tmpdir(), 'assinatura-eletronica-teste-uploads');

const { pool } = await import('../src/db.js');
const { recriarBanco } = await import('../src/manutencao.js');
const { processarRegistro } = await import('../src/blockchain/registro.js');

// Silencia as notificações simuladas (e-mails exibidos no console).
console.log = () => {};

const ZERO = `0x${'0'.repeat(64)}`;
const sha256 = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const hashDaTentativa = (numero) => `0x${String(numero).padStart(64, '0')}`;

// Rede simulada: imita o contrato e a inclusão das transações em blocos.
// "roteiro" diz o que acontece em cada envio, na ordem:
//   confirma        -> a transação é incluída em um bloco
//   pendente        -> não é incluída no prazo (rede congestionada)
//   rpc             -> o provedor RPC está fora do ar
//   reverte         -> o contrato reverte (carteira não é a dona)
//   sem-saldo       -> saldo insuficiente para pagar o gas
//   inclui-anterior -> a tentativa anterior (mesmo nonce) acaba incluída
function redeSimulada(roteiro = []) {
  const registros = new Map();
  const transacoes = new Map();
  const envios = [];
  let nonce = 7;
  let bloco = 1000;

  function incluir(tx) {
    bloco += 1;
    nonce += 1;
    registros.set(tx.hashDocumento, { hashEvidencias: tx.hashEvidencias, numeroBloco: bloco });
    tx.recibo = { hash: tx.hash, status: 1, numeroBloco: bloco, gasUsado: 69_000n, precoGas: 2_000_000_000n };
  }

  return {
    envios,
    registros,
    async consultar(hashDocumento) {
      const registro = registros.get(hashDocumento);
      return registro ? { registrado: true, ...registro } : { registrado: false, hashEvidencias: ZERO, numeroBloco: 0 };
    },
    async proximoNonce() {
      return nonce;
    },
    async transacao(hash) {
      return transacoes.get(hash) ?? null;
    },
    async taxas() {
      return { maxFeePerGas: 30n, maxPriorityFeePerGas: 2n };
    },
    async enviar(hashDocumento, hashEvidencias, opcoes) {
      const acao = roteiro[envios.length] ?? 'confirma';
      envios.push({ acao, ...opcoes });
      if (acao === 'rpc') throw { tipo: 'transitoria', mensagem: 'Provedor RPC indisponível.' };
      if (acao === 'reverte') throw { tipo: 'deterministica', mensagem: 'A carteira configurada não é a dona do contrato.' };
      if (acao === 'sem-saldo') throw { tipo: 'deterministica', mensagem: 'Saldo insuficiente na carteira da plataforma para pagar o gas.' };

      const tx = { hash: hashDaTentativa(envios.length), hashDocumento, hashEvidencias, ...opcoes, recibo: null };
      transacoes.set(tx.hash, tx);
      if (acao === 'confirma') incluir(tx);
      if (acao === 'inclui-anterior') incluir([...transacoes.values()].find((t) => t !== tx && t.nonce === tx.nonce));
      return { hash: tx.hash };
    },
    async recibo(hash) {
      return transacoes.get(hash)?.recibo ?? null;
    },
    async reciboDoRegistro(hashDocumento) {
      return [...transacoes.values()].find((t) => t.recibo && t.hashDocumento === hashDocumento)?.recibo ?? null;
    },
  };
}

// Prazo de espera curto para os testes não demorarem.
const opcoes = (rede) => ({ cliente: rede, esperaMs: 20, intervaloMs: 2, pausaMs: 0 });

// Cria, direto no banco, uma assinatura aguardando registro.
let sequencia = 0;
async function criarAssinatura() {
  sequencia += 1;
  const hashDocumento = sha256(`documento ${sequencia}`);
  const hashEvidencias = sha256(`evidencias ${sequencia}`);
  const [solicitante] = await pool.execute(
    "INSERT INTO usuario (tipo, nome, email, senha_hash) VALUES ('solicitante', 'Solicitante', ?, 'x')",
    [`solicitante${sequencia}@exemplo.com`],
  );
  const [signatario] = await pool.execute(
    "INSERT INTO usuario (tipo, nome, email, cpf, data_nascimento) VALUES ('signatario', 'Maria', 'maria@exemplo.com', '52998224725', '1990-05-10')",
  );
  const [documento] = await pool.execute(
    "INSERT INTO documento (solicitante_id, nome_arquivo, caminho_arquivo, tamanho_bytes, hash_documento) VALUES (?, 'contrato.pdf', 'x.pdf', 100, ?)",
    [solicitante.insertId, hashDocumento],
  );
  const [link] = await pool.execute(
    `INSERT INTO link_assinatura (documento_id, signatario_id, token_hash, token_cifrado, status, data_expiracao)
     VALUES (?, ?, ?, 'x', 'assinado', NOW() + INTERVAL 1 DAY)`,
    [documento.insertId, signatario.insertId, sha256(`token ${sequencia}`)],
  );
  const [assinatura] = await pool.execute(
    `INSERT INTO assinatura (link_id, signatario_id, data_assinatura, hash_documento, identidade_confirmada,
                             endereco_ip, navegador, aceite_explicito, evidencias, hash_evidencias)
     VALUES (?, ?, NOW(3), ?, 1, '::1', 'teste', 1, '{}', ?)`,
    [link.insertId, signatario.insertId, hashDocumento, hashEvidencias],
  );
  return {
    id: assinatura.insertId,
    documentoId: documento.insertId,
    hashDocumento: `0x${hashDocumento}`,
    hashEvidencias: `0x${hashEvidencias}`,
  };
}

async function situacao(assinaturaId) {
  const [[linha]] = await pool.execute(
    `SELECT status_blockchain AS status, tentativas_envio AS tentativas, tx_hash AS txHash,
            numero_bloco AS numeroBloco, gas_usado AS gasUsado, custo_wei AS custoWei,
            data_envio_tx AS dataEnvio, data_confirmacao AS dataConfirmacao, erro_blockchain AS erro
       FROM assinatura WHERE id = ?`,
    [assinaturaId],
  );
  return linha;
}

before(async () => {
  assert.match(process.env.DB_NAME, /_teste$/, 'os testes só podem rodar no banco de teste');
  await recriarBanco();
});

after(async () => {
  await pool.end();
});

test('confirma na primeira tentativa e grava transação, bloco, gas e custo', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['confirma']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'confirmada');
  assert.equal(s.tentativas, 1);
  assert.equal(s.txHash, hashDaTentativa(1));
  assert.equal(s.numeroBloco, 1001);
  assert.equal(Number(s.gasUsado), 69_000);
  assert.equal(s.custoWei, String(69_000n * 2_000_000_000n));
  assert.ok(s.dataEnvio && s.dataConfirmacao, 'datas de envio e confirmação (métrica de tempo)');

  const [[{ eventos }]] = await pool.execute(
    "SELECT COUNT(*) AS eventos FROM log_auditoria WHERE documento_id = ? AND evento = 'registro_blockchain_confirmado'",
    [assinatura.documentoId],
  );
  assert.equal(eventos, 1);
});

test('sem inclusão no prazo: reenvia com o mesmo nonce e taxa ajustada', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['pendente', 'confirma']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'confirmada');
  assert.equal(s.tentativas, 2);
  assert.equal(s.txHash, hashDaTentativa(2));
  const [primeiro, segundo] = rede.envios;
  assert.equal(segundo.nonce, primeiro.nonce, 'o reenvio substitui a transação anterior (mesmo nonce)');
  assert.ok(segundo.maxFeePerGas >= (primeiro.maxFeePerGas * 13n) / 10n, 'taxa máxima 30% maior');
  assert.ok(segundo.maxPriorityFeePerGas >= (primeiro.maxPriorityFeePerGas * 13n) / 10n, 'gorjeta 30% maior');
});

test('três tentativas sem inclusão levam ao estado Falha', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['pendente', 'pendente', 'pendente']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'falha');
  assert.equal(s.tentativas, 3);
  assert.equal(rede.envios.length, 3, 'não pode haver uma quarta tentativa');
  assert.match(s.erro, /3 tentativas/);
  assert.ok(rede.envios.every((envio) => envio.nonce === rede.envios[0].nonce));
});

test('provedor RPC indisponível é falha transitória e gera nova tentativa', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['rpc', 'confirma']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'confirmada');
  assert.equal(s.tentativas, 2);
});

test('reversão pelo contrato é falha determinística, sem reenvio', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['reverte']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'falha');
  assert.equal(rede.envios.length, 1);
  assert.match(s.erro, /não é a dona/);
});

test('saldo insuficiente é falha determinística, sem reenvio', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['sem-saldo']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'falha');
  assert.equal(rede.envios.length, 1);
  assert.match(s.erro, /Saldo insuficiente/);
});

test('se a tentativa anterior acabar incluída, o registro é confirmado com ela', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['pendente', 'inclui-anterior']);
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'confirmada');
  assert.equal(s.txHash, hashDaTentativa(1), 'vale a transação que de fato entrou no bloco');
  assert.equal(rede.registros.size, 1, 'um único registro no contrato');
});

test('consulta prévia: hash já registrado com as mesmas evidências confirma sem nova transação', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada();
  rede.registros.set(assinatura.hashDocumento, { hashEvidencias: assinatura.hashEvidencias, numeroBloco: 500 });
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'confirmada');
  assert.equal(s.numeroBloco, 500);
  assert.equal(rede.envios.length, 0, 'nenhuma transação nova (idempotência)');
});

test('hash já registrado com outras evidências leva ao estado Falha', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada();
  rede.registros.set(assinatura.hashDocumento, { hashEvidencias: `0x${sha256('outras evidencias')}`, numeroBloco: 500 });
  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'falha');
  assert.equal(rede.envios.length, 0);
  assert.match(s.erro, /outras evidências/);
});

test('retomada após reinício do servidor continua com o mesmo nonce', async () => {
  const assinatura = await criarAssinatura();
  const rede = redeSimulada(['pendente', 'confirma']);
  // Simula um servidor que enviou a 1ª tentativa e caiu antes da confirmação.
  const { hash } = await rede.enviar(assinatura.hashDocumento, assinatura.hashEvidencias, {
    nonce: await rede.proximoNonce(),
    ...(await rede.taxas()),
  });
  await pool.execute('UPDATE assinatura SET tentativas_envio = 1, tx_hash = ? WHERE id = ?', [hash, assinatura.id]);

  await processarRegistro(assinatura.id, opcoes(rede));

  const s = await situacao(assinatura.id);
  assert.equal(s.status, 'confirmada');
  assert.equal(s.tentativas, 2, 'a tentativa feita antes do reinício também conta');
  assert.equal(rede.envios[1].nonce, rede.envios[0].nonce);
});

test('assinatura já confirmada não é processada de novo', async () => {
  const assinatura = await criarAssinatura();
  await processarRegistro(assinatura.id, opcoes(redeSimulada(['confirma'])));
  const outraRede = redeSimulada();
  await processarRegistro(assinatura.id, opcoes(outraRede));
  assert.equal(outraRede.envios.length, 0);
});
