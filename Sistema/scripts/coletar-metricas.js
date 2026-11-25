// Coleta das métricas do Capítulo 3.4 do TCC: tempo de resposta do backend,
// tempo de confirmação das transações, tentativas de envio, taxa de erro e
// custo (gas), com um signatário por vez e com vários ao mesmo tempo.
//
// O script sobe o próprio sistema (src/server.js) em outra porta, com um
// banco separado (assinatura_eletronica_metricas) e uma pasta de uploads
// própria, e percorre o fluxo completo pela API, como o navegador faz:
//   solicitante: envia o PDF com a caixa de assinatura posicionada;
//   signatário:  abre o link, se identifica, abre o PDF e assina;
//   sistema:     registra na blockchain (fila), acompanhado pelo banco.
// Cada amostra usa um PDF diferente, porque o contrato registra cada
// documento uma única vez.
//
// ATENÇÃO: envia registros reais para a rede configurada no .env. O servidor
// principal (npm run dev) deve estar desligado, aqui e em qualquer outro
// computador com a mesma carteira, para não haver conflito de nonce.
//
// Uso: npm run metricas -- [--sequencial 20] [--simultaneos 5,10,25]
//                          [--porta 3100] [--saida pasta]
// Resultados em Testes/metricas/<data e hora>/: resumo.txt, resumo.json,
// requisicoes.csv, assinaturas.csv e servidor.log.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { ethers } from 'ethers';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const raiz = path.join(import.meta.dirname, '..');
const { values: opcoes } = parseArgs({
  options: {
    sequencial: { type: 'string', default: '20' },
    simultaneos: { type: 'string', default: '5,10,25' },
    porta: { type: 'string', default: '3100' },
    saida: { type: 'string', default: path.join(raiz, '..', 'Testes', 'metricas') },
  },
});
const quantidadeSequencial = Number(opcoes.sequencial);
const niveisSimultaneos = opcoes.simultaneos.split(',').filter(Boolean).map(Number);
if (!Number.isInteger(quantidadeSequencial) || quantidadeSequencial < 0 ||
    !niveisSimultaneos.every((n) => Number.isInteger(n) && n > 0)) {
  console.error('Uso: npm run metricas -- --sequencial 20 --simultaneos 5,10,25');
  process.exit(1);
}

// Banco e pasta de uploads da coleta, definidos antes de carregar a configuração.
const portaPrincipal = Number(process.env.PORTA ?? 3000);
process.env.DB_NAME = 'assinatura_eletronica_metricas';
process.env.PASTA_UPLOADS = path.join(raiz, 'uploads-metricas');
const { config } = await import('../src/config.js');
const { recriarBanco } = await import('../src/manutencao.js');

const base = `http://localhost:${opcoes.porta}`;
const pool = mysql.createPool(config.db);
const pastaSaida = path.join(opcoes.saida, carimboDeTempo(new Date()));

const NASCIMENTO = '1990-05-10';
const AGENTE = 'Mozilla/5.0 (coletor de métricas do TCC; Node.js)';
const SOLICITANTE = { nome: 'Coleta de Métricas', email: 'metricas@tcc.local', senha: 'metricas-tcc-2026' };
// Pior caso de um registro: 3 tentativas de 90 s, mais a folga da fila.
const ESPERA_POR_REGISTRO_MS = 5 * 60 * 1000;
const ETAPAS = {
  envio_documento: 'Envio do documento',
  situacao_link: 'Abertura do link',
  identificacao: 'Identificação',
  abrir_documento: 'Abertura do PDF',
  assinar: 'Assinatura',
  listar_documentos: 'Painel do solicitante',
};

const requisicoes = [];
const fluxos = [];
const lotes = [];
const solicitante = novoCliente();
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (dados) => crypto.createHash('sha256').update(dados).digest('hex');

try {
  await principal();
} catch (erro) {
  console.error(`\nColeta interrompida: ${erro.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}

async function principal() {
  if (Number(opcoes.porta) === portaPrincipal) {
    throw new Error(`Use uma porta diferente da do servidor principal (${portaPrincipal}).`);
  }
  await conferirServidorPrincipalDesligado();
  await prepararBanco();
  await fs.mkdir(pastaSaida, { recursive: true });

  const servidor = await iniciarServidor();
  process.once('SIGINT', () => {
    servidor.kill();
    process.exit(130);
  });
  try {
    const saude = await aguardarServidor(servidor);
    const { rede, carteira, saldoEth } = saude.blockchain;
    console.log(`Servidor da coleta em ${base} (banco ${config.db.database}), rede ${rede}, carteira ${carteira}, saldo ${saldoEth} ETH.`);
    await aguardarPendentesAnteriores();
    await entrarComoSolicitante();

    const inicio = new Date();
    if (quantidadeSequencial > 0) await cenarioSequencial(quantidadeSequencial);
    for (const quantidade of niveisSimultaneos) await cenarioSimultaneo(quantidade);
    const fim = new Date();

    const assinaturas = await lerAssinaturas();
    const ambiente = await descreverAmbiente(saude);
    const resumo = montarResumo({ inicio, fim, ambiente, assinaturas });
    await gravarResultados(resumo, assinaturas);
  } finally {
    servidor.kill();
  }
}

// ---------------------------------------------------------------------
// Preparação: servidor principal desligado, banco e servidor da coleta
// ---------------------------------------------------------------------

async function conferirServidorPrincipalDesligado() {
  const ligado = await fetch(`http://localhost:${portaPrincipal}/api/saude`, { signal: AbortSignal.timeout(2000) })
    .then(() => true, () => false);
  if (ligado) {
    throw new Error(`O servidor principal está ligado na porta ${portaPrincipal}. Desligue-o (Ctrl+C no npm run dev): os dois usariam a mesma carteira.`);
  }
}

// Cria o banco da coleta na primeira execução; nas seguintes, os dados são
// mantidos e cada coleta considera apenas os documentos que ela mesma enviou.
async function prepararBanco() {
  const { database, ...semBanco } = config.db;
  const conexao = await mysql.createConnection(semBanco);
  try {
    const [[{ total }]] = await conexao.query(
      'SELECT COUNT(*) AS total FROM information_schema.schemata WHERE schema_name = ?',
      [database],
    );
    if (total === 0) {
      await recriarBanco();
      console.log(`Banco "${database}" criado.`);
    }
  } finally {
    await conexao.end();
  }
}

// O sistema roda em outro processo, como em produção: os tempos medidos
// incluem a rede local e não disputam a CPU com o cliente da coleta.
async function iniciarServidor() {
  const log = await fs.open(path.join(pastaSaida, 'servidor.log'), 'w');
  const filho = spawn(process.execPath, ['src/server.js'], {
    cwd: raiz,
    env: { ...process.env, PORTA: opcoes.porta, BASE_URL: base },
    stdio: ['ignore', log.fd, log.fd],
  });
  filho.on('exit', () => log.close());
  return filho;
}

async function aguardarServidor(filho) {
  const limite = Date.now() + 60_000;
  while (Date.now() < limite) {
    if (filho.exitCode !== null) throw new Error('O servidor da coleta encerrou ao iniciar; veja servidor.log.');
    const saude = await fetch(`${base}/api/saude`).then((r) => r.json(), () => null);
    if (saude?.blockchain?.ativo) return saude;
    const motivo = saude?.blockchain?.motivo;
    if (motivo && !motivo.includes('ainda não iniciada')) {
      throw new Error(`Blockchain desativada no servidor da coleta: ${motivo}`);
    }
    await dormir(500);
  }
  throw new Error('O servidor da coleta não respondeu em 60 s; veja servidor.log.');
}

// Registros que ficaram pendentes numa coleta interrompida são retomados pelo
// servidor ao iniciar; a medição só começa com a fila vazia.
async function aguardarPendentesAnteriores() {
  const limite = Date.now() + 10 * 60 * 1000;
  for (;;) {
    const [[{ total }]] = await pool.query(
      "SELECT COUNT(*) AS total FROM assinatura WHERE status_blockchain = 'aguardando_registro'",
    );
    if (total === 0) return;
    if (Date.now() > limite) throw new Error(`${total} registro(s) de uma coleta anterior continuam pendentes.`);
    console.log(`Aguardando ${total} registro(s) pendente(s) de uma coleta anterior...`);
    await dormir(5000);
  }
}

// ---------------------------------------------------------------------
// Fluxo de uma assinatura pela API
// ---------------------------------------------------------------------

// Cliente HTTP com cookie de sessão próprio (cada ator usa o seu).
function novoCliente() {
  let cookie = '';
  return async function requisitar(caminho, { metodo = 'GET', json, form } = {}) {
    const headers = { 'User-Agent': AGENTE };
    if (cookie) headers.cookie = cookie;
    let body = form;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const resposta = await fetch(base + caminho, { method: metodo, headers, body });
    const novoCookie = resposta.headers.get('set-cookie');
    if (novoCookie) cookie = novoCookie.split(';')[0];
    const tipo = resposta.headers.get('content-type') ?? '';
    const corpo = tipo.includes('application/json')
      ? await resposta.json()
      : Buffer.from(await resposta.arrayBuffer());
    return { status: resposta.status, corpo };
  };
}

async function entrarComoSolicitante() {
  const cadastro = await solicitante('/api/auth/cadastro', { metodo: 'POST', json: SOLICITANTE });
  if (cadastro.status === 201) return;
  const login = await solicitante('/api/auth/login', { metodo: 'POST', json: SOLICITANTE });
  if (login.status !== 200) throw new Error(`Falha no login do solicitante da coleta: ${login.corpo?.erro}`);
}

// Executa uma etapa e guarda o tempo de resposta (requisição até o fim do
// corpo). Devolve o corpo, ou null com o erro anotado no fluxo.
async function etapa(fluxo, nome, cliente, caminho, opcoesRequisicao, statusEsperado) {
  const inicio = new Date();
  const t0 = performance.now();
  let resposta = null;
  let falha = null;
  try {
    resposta = await cliente(caminho, opcoesRequisicao);
  } catch (erro) {
    falha = erro.message;
  }
  const duracaoMs = performance.now() - t0;
  if (!falha && resposta.status !== statusEsperado) falha = resposta.corpo?.erro ?? `HTTP ${resposta.status}`;
  requisicoes.push({
    cenario: fluxo.cenario, fluxo: fluxo.numero, etapa: nome, inicio, duracaoMs, status: resposta?.status ?? 0, erro: falha,
  });
  if (falha) {
    fluxo.erro = `${nome}: ${falha}`;
    return null;
  }
  return resposta.corpo;
}

async function executarFluxo(fluxo) {
  const envio = await etapa(fluxo, 'envio_documento', solicitante, '/api/documentos',
    { metodo: 'POST', form: formularioDocumento(fluxo) }, 201);
  if (!envio) return;
  fluxo.documentoId = envio.documentoId;

  const signatario = novoCliente();
  const api = `/api/assinatura/${envio.link.split('/assinar/')[1]}`;
  if (!await etapa(fluxo, 'situacao_link', signatario, api, {}, 200)) return;
  const identificacao = { cpf: fluxo.cpf, dataNascimento: NASCIMENTO };
  if (!await etapa(fluxo, 'identificacao', signatario, `${api}/identificacao`, { metodo: 'POST', json: identificacao }, 200)) return;
  const documento = await etapa(fluxo, 'abrir_documento', signatario, `${api}/documento`, {}, 200);
  if (!documento) return;
  if (sha256(documento) !== sha256(fluxo.pdf)) {
    fluxo.erro = 'abrir_documento: o PDF recebido difere do enviado';
    return;
  }
  if (!await etapa(fluxo, 'assinar', signatario, `${api}/assinar`, { metodo: 'POST', json: { aceite: true } }, 201)) return;
  await etapa(fluxo, 'listar_documentos', solicitante, '/api/documentos', {}, 200);
}

function formularioDocumento(fluxo) {
  const form = new FormData();
  form.append('arquivo', new Blob([fluxo.pdf], { type: 'application/pdf' }), `DFD ${fluxo.cenario} ${fluxo.numero}.pdf`);
  const campos = {
    nomeSignatario: `Signatário ${fluxo.numero} (${fluxo.cenario})`,
    emailSignatario: `signatario${fluxo.numero}@metricas.tcc.local`,
    cpfSignatario: fluxo.cpf,
    dataNascimentoSignatario: NASCIMENTO,
    // Caixa de assinatura no fim da 2ª página.
    campoPagina: '2',
    campoX: '0.55',
    campoY: '0.8',
    campoLargura: '0.38',
    campoAltura: '0.1',
  };
  for (const [nome, valor] of Object.entries(campos)) form.append(nome, valor);
  return form;
}

// Fluxo com PDF e CPF próprios, preparados antes de começar a medição.
async function novoFluxo(cenario, numero) {
  const pdf = await gerarPdf(`${cenario}, amostra ${numero}`);
  const fluxo = { cenario, numero, pdf, tamanhoPdf: pdf.length, cpf: gerarCpf(), documentoId: null, erro: null };
  fluxos.push(fluxo);
  return fluxo;
}

// Acompanha pelo banco os registros na blockchain até Confirmada ou Falha.
async function aguardarRegistros(lote) {
  const ids = lote.filter((f) => !f.erro).map((f) => f.documentoId);
  if (ids.length === 0) return;
  const limite = Date.now() + ESPERA_POR_REGISTRO_MS * ids.length;
  let anterior = null;
  for (;;) {
    const [linhas] = await pool.query(
      `SELECT a.status_blockchain AS status
         FROM documento d
         JOIN link_assinatura l ON l.documento_id = d.id
         JOIN assinatura a ON a.link_id = l.id
        WHERE d.id IN (?)`,
      [ids],
    );
    const pendentes = linhas.filter((l) => l.status === 'aguardando_registro').length;
    if (pendentes === 0) return;
    if (ids.length > 1 && pendentes !== anterior) {
      console.log(`  registros na blockchain: ${ids.length - pendentes}/${ids.length} concluídos`);
      anterior = pendentes;
    }
    if (Date.now() > limite) {
      console.warn(`  ${pendentes} registro(s) sem conclusão no prazo; ficam como aguardando.`);
      return;
    }
    await dormir(1000);
  }
}

// ---------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------

// Um signatário por vez; cada amostra espera o próprio registro, então o
// tempo de confirmação não inclui espera na fila.
async function cenarioSequencial(quantidade) {
  console.log(`\nCenário sequencial: ${quantidade} assinatura(s), uma por vez.`);
  const lote = [];
  for (let i = 1; i <= quantidade; i++) lote.push(await novoFluxo('sequencial', i));
  const inicio = performance.now();
  let duracaoHttpMs = 0;
  for (const fluxo of lote) {
    const t0 = performance.now();
    await executarFluxo(fluxo);
    duracaoHttpMs += performance.now() - t0;
    await aguardarRegistros([fluxo]);
    console.log(`  ${fluxo.numero}/${quantidade} ${fluxo.erro ? `ERRO em ${fluxo.erro}` : 'assinada e registro concluído'}`);
  }
  lotes.push({ cenario: 'sequencial', assinaturas: quantidade, duracaoHttpMs, duracaoTotalMs: performance.now() - inicio });
}

// Vários signatários ao mesmo tempo (cenário de carga concorrente do 3.4).
async function cenarioSimultaneo(quantidade) {
  const cenario = `simultaneos_${quantidade}`;
  console.log(`\nCenário com ${quantidade} signatários ao mesmo tempo.`);
  const lote = [];
  for (let i = 1; i <= quantidade; i++) lote.push(await novoFluxo(cenario, i));
  const inicio = performance.now();
  await Promise.all(lote.map(executarFluxo));
  const duracaoHttpMs = performance.now() - inicio;
  const erros = lote.filter((f) => f.erro);
  console.log(`  fluxos concluídos em ${numero(duracaoHttpMs / 1000)} s, ${erros.length} com erro`);
  for (const f of erros) console.log(`  amostra ${f.numero}: ERRO em ${f.erro}`);
  await aguardarRegistros(lote);
  lotes.push({ cenario, assinaturas: quantidade, duracaoHttpMs, duracaoTotalMs: performance.now() - inicio });
}

// ---------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------

async function lerAssinaturas() {
  const ids = fluxos.filter((f) => f.documentoId).map((f) => f.documentoId);
  const [linhas] = ids.length === 0 ? [[]] : await pool.query(
    `SELECT d.id AS documentoId, a.id AS assinaturaId, a.data_assinatura AS dataAssinatura,
            a.status_blockchain AS statusBlockchain, a.tentativas_envio AS tentativas,
            a.tx_hash AS txHash, a.numero_bloco AS numeroBloco, a.gas_usado AS gasUsado,
            a.custo_wei AS custoWei, a.data_envio_tx AS dataEnvio, a.data_confirmacao AS dataConfirmacao,
            a.erro_blockchain AS erroBlockchain
       FROM documento d
       JOIN link_assinatura l ON l.documento_id = d.id
       LEFT JOIN assinatura a ON a.link_id = l.id
      WHERE d.id IN (?)`,
    [ids],
  );
  const porDocumento = new Map(linhas.map((l) => [l.documentoId, l]));

  // Horário do bloco: separa o tempo até a inclusão do intervalo de
  // consulta do sistema (o recibo é verificado a cada 2 s).
  const provedor = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
  const numerosBlocos = [...new Set(linhas.map((l) => l.numeroBloco).filter(Boolean))];
  const horarioBloco = new Map();
  for (let i = 0; i < numerosBlocos.length; i += 10) {
    const parte = numerosBlocos.slice(i, i + 10);
    const blocos = await Promise.all(parte.map((n) => provedor.getBlock(Number(n))));
    blocos.forEach((bloco, j) => horarioBloco.set(parte[j], bloco ? new Date(bloco.timestamp * 1000) : null));
  }
  provedor.destroy();

  const segundos = (de, ate) => (de && ate ? (ate - de) / 1000 : null);
  return fluxos.map((f) => {
    const a = porDocumento.get(f.documentoId) ?? {};
    return {
      cenario: f.cenario,
      fluxo: f.numero,
      documentoId: f.documentoId,
      assinaturaId: a.assinaturaId ?? null,
      tamanhoPdf: f.tamanhoPdf,
      statusBlockchain: a.statusBlockchain ?? null,
      tentativas: a.tentativas ?? null,
      txHash: a.txHash ?? null,
      numeroBloco: a.numeroBloco ?? null,
      gasUsado: a.gasUsado != null ? Number(a.gasUsado) : null,
      custoEth: a.custoWei != null ? Number(ethers.formatEther(BigInt(a.custoWei))) : null,
      dataAssinatura: a.dataAssinatura ?? null,
      dataEnvio: a.dataEnvio ?? null,
      dataBloco: horarioBloco.get(a.numeroBloco) ?? null,
      dataConfirmacao: a.dataConfirmacao ?? null,
      esperaFilaS: segundos(a.dataAssinatura, a.dataEnvio),
      inclusaoBlocoS: segundos(a.dataEnvio, horarioBloco.get(a.numeroBloco)),
      confirmacaoS: segundos(a.dataEnvio, a.dataConfirmacao),
      totalS: segundos(a.dataAssinatura, a.dataConfirmacao),
      erro: f.erro ?? a.erroBlockchain ?? null,
    };
  });
}

async function descreverAmbiente(saude) {
  const [[{ versao }]] = await pool.query('SELECT VERSION() AS versao');
  const provedor = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
  const saldoFinal = await provedor.getBalance(saude.blockchain.carteira).catch(() => null);
  provedor.destroy();
  const cpus = os.cpus();
  return {
    sistemaOperacional: `${os.version()} (${os.release()})`,
    processador: cpus[0]?.model.trim(),
    nucleos: cpus.length,
    memoriaGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    mysql: versao,
    banco: config.db.database,
    rede: saude.blockchain.rede,
    chainId: saude.blockchain.chainId,
    contrato: saude.blockchain.contrato,
    carteira: saude.blockchain.carteira,
    saldoInicialEth: saude.blockchain.saldoEth,
    saldoFinalEth: saldoFinal === null ? null : ethers.formatEther(saldoFinal),
    esperaPorTentativaS: config.blockchain.esperaSegundos,
    confirmacoes: config.blockchain.confirmacoes,
    pdf: { paginas: 2, tamanhoMedioBytes: Math.round(media(fluxos.map((f) => f.tamanhoPdf))) },
  };
}

function montarResumo({ inicio, fim, ambiente, assinaturas }) {
  const cenarios = [...new Set(fluxos.map((f) => f.cenario))];

  const respostaBackend = {};
  for (const cenario of cenarios) {
    respostaBackend[cenario] = {};
    for (const nome of Object.keys(ETAPAS)) {
      const grupo = requisicoes.filter((r) => r.cenario === cenario && r.etapa === nome);
      if (grupo.length === 0) continue;
      respostaBackend[cenario][nome] = {
        requisicoes: grupo.length,
        erros: grupo.filter((r) => r.erro).length,
        ms: estatisticas(grupo.filter((r) => !r.erro).map((r) => r.duracaoMs)),
      };
    }
  }

  const blockchain = {};
  for (const cenario of [...cenarios, 'todos']) {
    const grupo = assinaturas.filter((a) => a.assinaturaId && (cenario === 'todos' || a.cenario === cenario));
    const confirmadas = grupo.filter((a) => a.statusBlockchain === 'confirmada');
    const falhas = grupo.filter((a) => a.statusBlockchain === 'falha').length;
    const semConclusao = grupo.filter((a) => a.statusBlockchain === 'aguardando_registro').length;
    const tentativas = {};
    for (const a of grupo) if (a.statusBlockchain !== 'aguardando_registro') tentativas[a.tentativas] = (tentativas[a.tentativas] ?? 0) + 1;
    blockchain[cenario] = {
      assinaturas: grupo.length,
      confirmadas: confirmadas.length,
      falhas,
      semConclusao,
      taxaErro: grupo.length ? (falhas + semConclusao) / grupo.length : null,
      tentativas,
      esperaFilaS: estatisticas(confirmadas.map((a) => a.esperaFilaS)),
      inclusaoBlocoS: estatisticas(confirmadas.map((a) => a.inclusaoBlocoS)),
      confirmacaoS: estatisticas(confirmadas.map((a) => a.confirmacaoS)),
      totalS: estatisticas(confirmadas.map((a) => a.totalS)),
      gas: estatisticas(confirmadas.map((a) => a.gasUsado)),
      custoEth: estatisticas(confirmadas.map((a) => a.custoEth)),
    };
  }

  return {
    inicio,
    fim,
    parametros: { sequencial: quantidadeSequencial, simultaneos: niveisSimultaneos },
    ambiente,
    fluxos: { total: fluxos.length, comErro: fluxos.filter((f) => f.erro).length },
    requisicoes: { total: requisicoes.length, comErro: requisicoes.filter((r) => r.erro).length },
    lotes,
    respostaBackend,
    blockchain,
  };
}

async function gravarResultados(resumo, assinaturas) {
  const arredondar = (v, casas) => (v == null ? null : Number(v.toFixed(casas)));
  await fs.writeFile(path.join(pastaSaida, 'requisicoes.csv'), csv(
    requisicoes.map((r) => ({ ...r, duracaoMs: arredondar(r.duracaoMs, 1) })),
    ['cenario', 'fluxo', 'etapa', 'inicio', 'duracaoMs', 'status', 'erro'],
  ));
  await fs.writeFile(path.join(pastaSaida, 'assinaturas.csv'), csv(
    assinaturas.map((a) => ({
      ...a,
      esperaFilaS: arredondar(a.esperaFilaS, 3),
      inclusaoBlocoS: arredondar(a.inclusaoBlocoS, 3),
      confirmacaoS: arredondar(a.confirmacaoS, 3),
      totalS: arredondar(a.totalS, 3),
    })),
    ['cenario', 'fluxo', 'documentoId', 'assinaturaId', 'tamanhoPdf', 'statusBlockchain', 'tentativas', 'txHash',
      'numeroBloco', 'gasUsado', 'custoEth', 'dataAssinatura', 'dataEnvio', 'dataBloco', 'dataConfirmacao',
      'esperaFilaS', 'inclusaoBlocoS', 'confirmacaoS', 'totalS', 'erro'],
  ));
  await fs.writeFile(path.join(pastaSaida, 'resumo.json'), JSON.stringify(resumo, null, 2));
  const texto = textoResumo(resumo);
  await fs.writeFile(path.join(pastaSaida, 'resumo.txt'), texto);
  console.log(`\n${texto}\nResultados gravados em ${pastaSaida}`);
}

function textoResumo(r) {
  const a = r.ambiente;
  const duracaoMin = (r.fim - r.inicio) / 60000;
  const linhas = [
    'COLETA DE MÉTRICAS - SISTEMA DE ASSINATURA ELETRÔNICA',
    '',
    `Período: ${dataLocal(r.inicio)} a ${dataLocal(r.fim)} (${numero(duracaoMin)} min)`,
    `Máquina: ${a.sistemaOperacional}, ${a.processador}, ${a.nucleos} núcleos lógicos, ${a.memoriaGb} GB de RAM`,
    `Software: Node.js ${a.node}, MySQL ${a.mysql} (banco ${a.banco})`,
    `Blockchain: rede ${a.rede} (chainId ${a.chainId}), contrato ${a.contrato}, carteira ${a.carteira}`,
    `Saldo da carteira: ${a.saldoInicialEth} ETH no início, ${a.saldoFinalEth ?? '?'} ETH no fim`,
    `Política de envio: até 3 tentativas, ${a.esperaPorTentativaS} s de espera cada, ${a.confirmacoes} confirmação(ões)`,
    `Documento: PDF de ${a.pdf.paginas} páginas, ${numero(a.pdf.tamanhoMedioBytes / 1024)} KB em média, caixa de assinatura na 2ª página`,
    `Fluxos: ${r.fluxos.total} (${r.fluxos.comErro} com erro); requisições: ${r.requisicoes.total} (${r.requisicoes.comErro} com erro)`,
    '',
    '1. TEMPO DE RESPOSTA DO BACKEND (ms, requisições sem erro)',
    '',
    tabela(
      ['Cenário', 'Etapa', 'n', 'Média', 'Mediana', 'P95', 'Mín.', 'Máx.', 'Erros'],
      Object.entries(r.respostaBackend).flatMap(([cenario, etapas]) => Object.entries(etapas).map(([nome, e]) => [
        cenario, ETAPAS[nome], e.ms?.n ?? 0, numero(e.ms?.media), numero(e.ms?.mediana), numero(e.ms?.p95),
        numero(e.ms?.minimo), numero(e.ms?.maximo), e.erros,
      ])),
      2,
    ),
    '',
    '2. DURAÇÃO DOS CENÁRIOS (s)',
    '',
    tabela(
      ['Cenário', 'Assinaturas', 'Fluxos HTTP', 'Até o último registro'],
      r.lotes.map((l) => [l.cenario, l.assinaturas, numero(l.duracaoHttpMs / 1000), numero(l.duracaoTotalMs / 1000)]),
    ),
    '',
    '3. REGISTRO NA BLOCKCHAIN',
    '',
    tabela(
      ['Cenário', 'Assinaturas', 'Confirmadas', 'Falhas', 'Sem conclusão', 'Taxa de erro', 'Tentativas (qtd.)'],
      Object.entries(r.blockchain).map(([cenario, b]) => [
        cenario, b.assinaturas, b.confirmadas, b.falhas, b.semConclusao,
        b.taxaErro == null ? '-' : `${numero(b.taxaErro * 100)}%`,
        Object.entries(b.tentativas).map(([t, n]) => `${t}: ${n}`).join(', ') || '-',
      ]),
    ),
    '',
    'Tempos das transações confirmadas (s):',
    '  espera na fila = da assinatura ao envio da transação',
    '  inclusão em bloco = do envio ao horário do bloco',
    '  confirmação = do envio até o sistema obter o recibo (consulta a cada 2 s)',
    '  total = da assinatura à confirmação',
    '',
    tabela(
      ['Cenário', 'Medida', 'n', 'Média', 'Mediana', 'P95', 'Mín.', 'Máx.', 'Desvio'],
      Object.entries(r.blockchain).flatMap(([cenario, b]) => [
        ['esperaFilaS', 'Espera na fila'], ['inclusaoBlocoS', 'Inclusão em bloco'],
        ['confirmacaoS', 'Confirmação'], ['totalS', 'Total'],
      ].map(([chave, rotulo]) => {
        const e = b[chave];
        return [cenario, rotulo, e?.n ?? 0, numero(e?.media), numero(e?.mediana), numero(e?.p95),
          numero(e?.minimo), numero(e?.maximo), numero(e?.desvioPadrao)];
      })),
      2,
    ),
    '',
    `Gas por registro (todas as confirmadas): média ${numero(r.blockchain.todos.gas?.media, 0)}, ` +
      `mín. ${numero(r.blockchain.todos.gas?.minimo, 0)}, máx. ${numero(r.blockchain.todos.gas?.maximo, 0)}`,
    `Custo por registro: média ${r.blockchain.todos.custoEth?.media?.toExponential(3) ?? '-'} ETH de teste`,
    '',
  ];
  return linhas.join('\n');
}

// ---------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------

// PDF de 2 páginas com texto de exemplo e identificador único (hash único).
async function gerarPdf(identificacao) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Documento para coleta de métricas (${identificacao})`);
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const paragrafo = 'A unidade requisitante formaliza a demanda descrita neste documento, com a justificativa ' +
    'da necessidade, a quantidade estimada, a previsão de data para o atendimento e a indicação do servidor ' +
    'responsável, em conformidade com o planejamento anual das contratações do órgão.';
  for (let numeroPagina = 1; numeroPagina <= 2; numeroPagina++) {
    const pagina = pdf.addPage([595.28, 841.89]);
    let y = 780;
    const escrever = (texto, { tamanho = 11, fonteTexto = fonte, espaco = 16 } = {}) => {
      for (const linha of quebrarTexto(texto, fonteTexto, tamanho, 483)) {
        pagina.drawText(linha, { x: 56, y, size: tamanho, font: fonteTexto });
        y -= espaco;
      }
    };
    if (numeroPagina === 1) {
      escrever('Documento de Formalização da Demanda', { tamanho: 16, fonteTexto: negrito, espaco: 26 });
      escrever(`Documento gerado para a coleta de métricas (${identificacao}).`);
      escrever(`Identificador: ${crypto.randomUUID()}`, { espaco: 26 });
    }
    for (let i = 0; i < (numeroPagina === 1 ? 6 : 3); i++) {
      escrever(paragrafo);
      y -= 10;
    }
    if (numeroPagina === 2) escrever('Assinatura do responsável pela demanda:');
  }
  return Buffer.from(await pdf.save());
}

function quebrarTexto(texto, fonte, tamanho, largura) {
  const linhas = [];
  let atual = '';
  for (const palavra of texto.split(' ')) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (fonte.widthOfTextAtSize(tentativa, tamanho) > largura && atual) {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = tentativa;
    }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

// CPF aleatório com dígitos verificadores válidos.
function gerarCpf() {
  const digito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  let base;
  do {
    base = Array.from({ length: 9 }, () => crypto.randomInt(10)).join('');
  } while (/^(\d)\1{8}$/.test(base));
  const comPrimeiro = base + digito(base);
  return comPrimeiro + digito(comPrimeiro);
}

function media(valores) {
  return valores.reduce((soma, v) => soma + v, 0) / (valores.length || 1);
}

function estatisticas(valores) {
  const v = valores.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const n = v.length;
  const m = media(v);
  return {
    n,
    media: m,
    mediana: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2,
    // Percentil 95 pelo método do posto mais próximo.
    p95: v[Math.ceil(0.95 * n) - 1],
    minimo: v[0],
    maximo: v[n - 1],
    desvioPadrao: n > 1 ? Math.sqrt(v.reduce((soma, x) => soma + (x - m) ** 2, 0) / (n - 1)) : 0,
  };
}

function numero(valor, casas = 1) {
  if (valor == null || !Number.isFinite(valor)) return '-';
  return valor.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

function tabela(cabecalho, linhas, colunasTexto = 1) {
  const larguras = cabecalho.map((c, i) => Math.max(c.length, ...linhas.map((l) => String(l[i]).length)));
  const formatar = (linha) => linha
    .map((v, i) => (i < colunasTexto ? String(v).padEnd(larguras[i]) : String(v).padStart(larguras[i])))
    .join('  ');
  return [formatar(cabecalho), larguras.map((w) => '-'.repeat(w)).join('  '), ...linhas.map(formatar)].join('\n');
}

// CSV no padrão do Excel em português: separador ";" e vírgula decimal.
function csv(linhas, colunas) {
  const celula = (v) => {
    if (v == null) return '';
    if (v instanceof Date) return dataLocal(v);
    if (typeof v === 'number') return String(v).replace('.', ',');
    const texto = String(v);
    return /[;"\r\n]/.test(texto) ? `"${texto.replaceAll('"', '""')}"` : texto;
  };
  const corpo = [colunas.join(';'), ...linhas.map((l) => colunas.map((c) => celula(l[c])).join(';'))];
  return `﻿${corpo.join('\r\n')}\r\n`;
}

// Data e hora locais (horário de Brasília no computador do autor), com milissegundos.
function dataLocal(data) {
  const d = (n, t = 2) => String(n).padStart(t, '0');
  return `${data.getFullYear()}-${d(data.getMonth() + 1)}-${d(data.getDate())} ` +
    `${d(data.getHours())}:${d(data.getMinutes())}:${d(data.getSeconds())}.${d(data.getMilliseconds(), 3)}`;
}

function carimboDeTempo(data) {
  return dataLocal(data).slice(0, 19).replace(' ', '_').replaceAll(':', '-');
}
