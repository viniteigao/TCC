// Testes funcionais do fluxo de assinatura (cenários do Capítulo 3.4 do TCC).
// Rodam em um banco separado (assinatura_eletronica_teste) e em uma pasta
// de uploads temporária: os dados do banco principal não são tocados.
// Uso: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DB_NAME = 'assinatura_eletronica_teste';
process.env.PASTA_UPLOADS = path.join(os.tmpdir(), 'assinatura-eletronica-teste-uploads');

const { app } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { recriarBanco } = await import('../src/manutencao.js');

// Silencia as notificações simuladas (e-mails exibidos no console).
console.log = () => {};

// Cada envio usa um PDF diferente, porque o sistema recusa um arquivo
// idêntico a outro em processo (o contrato registra cada documento uma vez).
let contadorPdf = 0;
function novoPdf() {
  contadorPdf += 1;
  return Buffer.from(
    `%PDF-1.4\n% documento de teste ${contadorPdf}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n` +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
  );
}
const CPF = '529.982.247-25';
const NASCIMENTO = '1990-05-10';
const sha256 = (dados) => crypto.createHash('sha256').update(dados).digest('hex');

let servidor;
let base;

// Cliente HTTP com cookie de sessão próprio (cada ator usa o seu).
function novoCliente() {
  let cookie = '';
  return async function requisitar(caminho, { metodo = 'GET', json, form } = {}) {
    const headers = cookie ? { cookie } : {};
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
    return { status: resposta.status, corpo, tipo };
  };
}

const solicitante = novoCliente();

function formularioDocumento(alteracoes = {}) {
  const campos = {
    nomeSignatario: 'Maria José',
    emailSignatario: 'maria@exemplo.com',
    cpfSignatario: CPF,
    dataNascimentoSignatario: NASCIMENTO,
    // Caixa de assinatura no canto inferior direito da 1ª página.
    campoPagina: '1',
    campoX: '0.6',
    campoY: '0.86',
    campoLargura: '0.34',
    campoAltura: '0.09',
    ...alteracoes,
  };
  const form = new FormData();
  form.append('arquivo', new Blob([campos.conteudo ?? novoPdf()], { type: 'application/pdf' }), 'Contrato de Prestação.pdf');
  // Campos com valor undefined não são enviados (para testar a ausência).
  for (const [nome, valor] of Object.entries(campos)) {
    if (nome !== 'conteudo' && valor !== undefined) form.append(nome, valor);
  }
  return form;
}

async function enviarDocumento(pdf = novoPdf()) {
  const r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ conteudo: pdf }) });
  assert.equal(r.status, 201);
  return { ...r.corpo, pdf, api: `/api/assinatura/${r.corpo.link.split('/').pop()}` };
}

function identificar(cliente, api, cpf = CPF, dataNascimento = NASCIMENTO) {
  return cliente(`${api}/identificacao`, { metodo: 'POST', json: { cpf, dataNascimento } });
}

before(async () => {
  assert.match(process.env.DB_NAME, /_teste$/, 'os testes só podem rodar no banco de teste');
  await recriarBanco();
  servidor = app.listen(0);
  await new Promise((resolve) => servidor.once('listening', resolve));
  base = `http://localhost:${servidor.address().port}`;

  const r = await solicitante('/api/auth/cadastro', {
    metodo: 'POST',
    json: { nome: 'Solicitante Teste', email: 'solicitante@exemplo.com', senha: 'senha12345' },
  });
  assert.equal(r.status, 201);
});

after(async () => {
  servidor?.close();
  await pool.end();
});

test('upload valida login, arquivo PDF, CPF e data de nascimento', async () => {
  let r = await novoCliente()('/api/documentos', { metodo: 'POST', form: formularioDocumento() });
  assert.equal(r.status, 401);

  r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ conteudo: 'não é PDF' }) });
  assert.equal(r.status, 400);

  r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ cpfSignatario: '111.111.111-11' }) });
  assert.equal(r.status, 400);

  r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ dataNascimentoSignatario: '2000-02-31' }) });
  assert.equal(r.status, 400);
});

test('upload calcula o SHA-256 do documento e gera link pendente', async () => {
  const doc = await enviarDocumento();
  assert.equal(doc.hashDocumento, sha256(doc.pdf));
  const [[link]] = await pool.execute('SELECT status FROM link_assinatura WHERE documento_id = ?', [doc.documentoId]);
  assert.equal(link.status, 'pendente');
});

test('identificação: três tentativas erradas bloqueiam o link (RF6)', async () => {
  const doc = await enviarDocumento();
  const signatario = novoCliente();

  let r = await signatario(doc.api);
  assert.equal(r.corpo.status, 'pendente');
  assert.equal(r.corpo.tentativasRestantes, 3);
  assert.equal(r.corpo.documento, undefined, 'dados do documento não podem aparecer antes da identificação');

  r = await signatario(`${doc.api}/documento`);
  assert.equal(r.status, 403, 'o PDF não pode abrir antes da identificação');

  r = await identificar(signatario, doc.api, '111.444.777-35');
  assert.equal(r.status, 401);
  assert.equal(r.corpo.tentativasRestantes, 2);

  r = await identificar(signatario, doc.api, CPF, '1990-05-11');
  assert.equal(r.status, 401);
  assert.equal(r.corpo.tentativasRestantes, 1);

  r = await identificar(signatario, doc.api, '111.444.777-35', '1990-05-11');
  assert.equal(r.status, 403);
  assert.equal(r.corpo.status, 'bloqueado');

  r = await identificar(signatario, doc.api);
  assert.equal(r.status, 409, 'link bloqueado não aceita nem os dados corretos');
  assert.equal(r.corpo.status, 'bloqueado');
});

test('assinatura: identidade, visualização, aceite, hash e evidências', async () => {
  const doc = await enviarDocumento();
  const signatario = novoCliente();

  let r = await identificar(signatario, doc.api);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.documento.nomeArquivo, 'Contrato de Prestação.pdf');

  r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  assert.equal(r.status, 409, 'deve exigir a abertura do documento antes da assinatura');

  r = await signatario(`${doc.api}/documento`);
  assert.equal(r.status, 200);
  assert.match(r.tipo, /application\/pdf/);
  assert.deepEqual(r.corpo, doc.pdf);

  r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: false } });
  assert.equal(r.status, 400, 'deve exigir o aceite explícito');

  r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.assinatura.hashDocumento, sha256(doc.pdf));
  assert.equal(r.corpo.assinatura.statusBlockchain, 'aguardando_registro');

  // O hash das evidências corresponde ao texto guardado no banco.
  const [[linha]] = await pool.execute(
    `SELECT a.evidencias, a.hash_evidencias AS hashEvidencias
       FROM assinatura a JOIN link_assinatura l ON l.id = a.link_id
      WHERE l.documento_id = ?`,
    [doc.documentoId],
  );
  assert.equal(sha256(linha.evidencias), linha.hashEvidencias);
  assert.equal(linha.hashEvidencias, r.corpo.assinatura.hashEvidencias);
  const evidencias = JSON.parse(linha.evidencias);
  assert.equal(evidencias.signatario.identidadeConfirmada, true);
  assert.equal(evidencias.assinatura.aceiteExplicito, true);
  assert.ok(evidencias.assinatura.enderecoIp);
  assert.ok(evidencias.assinatura.navegador);

  r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  assert.equal(r.status, 409, 'link de uso único');
  assert.equal(r.corpo.status, 'assinado');

  r = await novoCliente()(doc.api);
  assert.equal(r.corpo.status, 'assinado');
  assert.equal(r.corpo.assinatura, undefined, 'outra pessoa com o link não vê o comprovante');

  // Depois de assinar, o signatário ainda abre o documento (intacto) pelo comprovante.
  r = await signatario(`${doc.api}/documento`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, doc.pdf);
  r = await novoCliente()(`${doc.api}/documento`);
  assert.equal(r.status, 403, 'quem não se identificou não abre o documento assinado');
});

test('recusa explícita leva ao estado Recusado', async () => {
  const doc = await enviarDocumento();
  const signatario = novoCliente();

  let r = await signatario(`${doc.api}/recusar`, { metodo: 'POST', json: {} });
  assert.equal(r.status, 403, 'recusa exige identidade confirmada');

  await identificar(signatario, doc.api);
  r = await signatario(`${doc.api}/recusar`, { metodo: 'POST', json: {} });
  assert.equal(r.status, 200);

  r = await signatario(doc.api);
  assert.equal(r.corpo.status, 'recusado');

  r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  assert.equal(r.status, 409);

  r = await signatario(`${doc.api}/documento`);
  assert.equal(r.status, 409, 'depois da recusa o documento não é mais exibido pelo link');
});

test('documento alterado após o envio bloqueia a assinatura (integridade)', async () => {
  const doc = await enviarDocumento();
  const signatario = novoCliente();
  await identificar(signatario, doc.api);
  await signatario(`${doc.api}/documento`);

  // Simula a adulteração do arquivo armazenado.
  const [[{ caminho }]] = await pool.execute(
    'SELECT caminho_arquivo AS caminho FROM documento WHERE id = ?',
    [doc.documentoId],
  );
  await fs.appendFile(path.join(process.env.PASTA_UPLOADS, caminho), 'adulteracao');

  let r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.integridadeViolada, true);

  const [[{ total }]] = await pool.execute(
    'SELECT COUNT(*) AS total FROM assinatura a JOIN link_assinatura l ON l.id = a.link_id WHERE l.documento_id = ?',
    [doc.documentoId],
  );
  assert.equal(total, 0, 'nenhuma assinatura pode ser gravada');

  const [[{ eventos }]] = await pool.execute(
    "SELECT COUNT(*) AS eventos FROM log_auditoria WHERE documento_id = ? AND evento = 'integridade_violada'",
    [doc.documentoId],
  );
  assert.equal(eventos, 1);

  r = await signatario(doc.api);
  assert.equal(r.corpo.status, 'pendente');
});

test('prazo vencido leva ao estado Expirado', async () => {
  const doc = await enviarDocumento();
  await pool.execute(
    'UPDATE link_assinatura SET data_expiracao = NOW() - INTERVAL 1 MINUTE WHERE documento_id = ?',
    [doc.documentoId],
  );
  const signatario = novoCliente();

  let r = await signatario(doc.api);
  assert.equal(r.corpo.status, 'expirado');

  r = await identificar(signatario, doc.api);
  assert.equal(r.status, 409);
});

test('token inexistente ou malformado é rejeitado', async () => {
  const cliente = novoCliente();
  let r = await cliente(`/api/assinatura/${'A'.repeat(43)}`);
  assert.equal(r.status, 404);
  r = await cliente('/api/assinatura/abc');
  assert.equal(r.status, 404);
});

test('painel do solicitante mostra o status de cada documento', async () => {
  const r = await solicitante('/api/documentos');
  assert.equal(r.status, 200);
  const status = r.corpo.map((d) => d.status).sort();
  assert.deepEqual(status, ['assinado', 'bloqueado', 'expirado', 'pendente', 'pendente', 'recusado']);
  const assinado = r.corpo.find((d) => d.status === 'assinado');
  assert.equal(assinado.statusBlockchain, 'aguardando_registro');
});

// ---------------------------------------------------------------------
// Gestão do link pelo solicitante: copiar, editar dados e gerar novo link.
// ---------------------------------------------------------------------

function editar(documentoId, alteracoes = {}) {
  return solicitante(`/api/documentos/${documentoId}`, {
    metodo: 'PUT',
    json: {
      nomeSignatario: 'Maria José',
      emailSignatario: 'maria@exemplo.com',
      cpfSignatario: CPF,
      dataNascimentoSignatario: NASCIMENTO,
      ...alteracoes,
    },
  });
}

test('solicitante copia o link novamente (token guardado cifrado)', async () => {
  const doc = await enviarDocumento();
  const r = await solicitante(`/api/documentos/${doc.documentoId}/link`);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.link, doc.link);

  const token = doc.link.split('/').pop();
  const [[linha]] = await pool.execute('SELECT token_cifrado AS cifrado FROM link_assinatura WHERE documento_id = ?', [doc.documentoId]);
  assert.ok(!linha.cifrado.includes(token), 'o token não pode ficar em texto puro no banco');
});

test('edição do CPF zera as tentativas e exige nova identificação', async () => {
  const doc = await enviarDocumento();
  const CPF_REAL = '111.444.777-35';
  const signatario = novoCliente();
  const outraSessao = novoCliente();

  // O signatário verdadeiro erra duas vezes porque o CPF cadastrado está errado.
  await identificar(signatario, doc.api, CPF_REAL);
  let r = await identificar(signatario, doc.api, CPF_REAL);
  assert.equal(r.corpo.tentativasRestantes, 1);

  // Uma sessão que se identificou com os dados antigos...
  await identificar(outraSessao, doc.api);
  r = await outraSessao(`${doc.api}/documento`);
  assert.equal(r.status, 200);

  r = await editar(doc.documentoId, { cpfSignatario: CPF_REAL });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.alterados, ['cpf']);
  assert.equal(r.corpo.tentativasZeradas, true);
  assert.equal(r.corpo.linkReenviado, false);

  // ...perde o acesso após a edição.
  r = await outraSessao(`${doc.api}/documento`);
  assert.equal(r.status, 403);

  r = await signatario(doc.api);
  assert.equal(r.corpo.tentativasRestantes, 3);
  r = await identificar(signatario, doc.api);
  assert.equal(r.status, 401, 'o CPF antigo deixa de valer');
  r = await identificar(signatario, doc.api, CPF_REAL);
  assert.equal(r.status, 200);
});

test('edição do e-mail mantém o mesmo link e o reenvia', async () => {
  const doc = await enviarDocumento();
  let r = await editar(doc.documentoId, { emailSignatario: 'correto@exemplo.com' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.alterados, ['email']);
  assert.equal(r.corpo.linkReenviado, true);

  r = await solicitante(`/api/documentos/${doc.documentoId}/link`);
  assert.equal(r.corpo.link, doc.link, 'o link do documento não muda');
  r = await novoCliente()(doc.api);
  assert.equal(r.corpo.status, 'pendente');

  const [[{ envios }]] = await pool.execute(
    "SELECT COUNT(*) AS envios FROM log_auditoria WHERE documento_id = ? AND evento = 'envio_link'",
    [doc.documentoId],
  );
  assert.equal(envios, 2, 'envio inicial e reenvio ao e-mail corrigido');
});

test('edição valida os dados e aceita prorrogar a validade', async () => {
  const doc = await enviarDocumento();
  let r = await editar(doc.documentoId);
  assert.deepEqual(r.corpo.alterados, [], 'sem mudanças, nada é alterado');

  r = await editar(doc.documentoId, { cpfSignatario: '123.456.789-00' });
  assert.equal(r.status, 400);
  r = await editar(doc.documentoId, { validadeDias: 0 });
  assert.equal(r.status, 400);

  r = await editar(doc.documentoId, { validadeDias: 20 });
  assert.deepEqual(r.corpo.alterados, ['validade']);
  const [[{ dias }]] = await pool.execute(
    'SELECT TIMESTAMPDIFF(DAY, NOW(), data_expiracao) AS dias FROM link_assinatura WHERE documento_id = ?',
    [doc.documentoId],
  );
  assert.ok(dias >= 19 && dias <= 20);
});

test('documento em estado final não pode ser editado nem ter o link copiado', async () => {
  const doc = await enviarDocumento();
  const signatario = novoCliente();
  await identificar(signatario, doc.api);
  await signatario(`${doc.api}/recusar`, { metodo: 'POST', json: {} });

  let r = await editar(doc.documentoId, { nomeSignatario: 'Outro Nome' });
  assert.equal(r.status, 409);
  r = await solicitante(`/api/documentos/${doc.documentoId}/link`);
  assert.equal(r.status, 409);
});

test('outro solicitante não acessa documentos alheios', async () => {
  const doc = await enviarDocumento();
  const outro = novoCliente();
  await outro('/api/auth/cadastro', {
    metodo: 'POST',
    json: { nome: 'Outro Solicitante', email: 'outro@exemplo.com', senha: 'senha12345' },
  });
  let r = await outro(`/api/documentos/${doc.documentoId}`);
  assert.equal(r.status, 404);
  r = await outro(`/api/documentos/${doc.documentoId}/link`);
  assert.equal(r.status, 404);
  r = await outro(`/api/documentos/${doc.documentoId}`, {
    metodo: 'PUT',
    json: {
      nomeSignatario: 'Invasor',
      emailSignatario: 'invasor@exemplo.com',
      cpfSignatario: CPF,
      dataNascimentoSignatario: NASCIMENTO,
    },
  });
  assert.equal(r.status, 404);
});

test('PDF idêntico a outro em processo é recusado no upload', async () => {
  const pdf = novoPdf();
  const primeiro = await enviarDocumento(pdf);

  let r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ conteudo: pdf }) });
  assert.equal(r.status, 409, 'o contrato só aceita um registro por documento');

  // Depois que o primeiro processo termina sem assinatura, o arquivo pode ser reenviado.
  const signatario = novoCliente();
  await identificar(signatario, primeiro.api);
  await signatario(`${primeiro.api}/recusar`, { metodo: 'POST', json: {} });
  r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ conteudo: pdf }) });
  assert.equal(r.status, 201);
});

test('solicitante abre o PDF original dos próprios documentos, antes e depois da assinatura', async () => {
  const doc = await enviarDocumento();
  let r = await solicitante(`/api/documentos/${doc.documentoId}/arquivo`);
  assert.equal(r.status, 200);
  assert.match(r.tipo, /application\/pdf/);
  assert.deepEqual(r.corpo, doc.pdf);

  const signatario = novoCliente();
  await identificar(signatario, doc.api);
  await signatario(`${doc.api}/documento`);
  await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  r = await solicitante(`/api/documentos/${doc.documentoId}/arquivo`);
  assert.equal(r.status, 200);
  assert.equal(sha256(r.corpo), doc.hashDocumento, 'o arquivo entregue é o mesmo cujo hash foi registrado');

  r = await novoCliente()(`/api/documentos/${doc.documentoId}/arquivo`);
  assert.equal(r.status, 401);
  const outro = novoCliente();
  await outro('/api/auth/cadastro', {
    metodo: 'POST',
    json: { nome: 'Terceiro', email: 'terceiro@exemplo.com', senha: 'senha12345' },
  });
  r = await outro(`/api/documentos/${doc.documentoId}/arquivo`);
  assert.equal(r.status, 404);
});

// ---------------------------------------------------------------------
// Caixa de assinatura: posição escolhida no envio, prévia e cópia assinada.
// ---------------------------------------------------------------------

test('upload exige a caixa de assinatura dentro de uma página existente', async () => {
  let r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ campoPagina: undefined }) });
  assert.equal(r.status, 400);
  assert.match(r.corpo.erro, /caixa de assinatura/);

  r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ campoPagina: '2' }) });
  assert.equal(r.status, 400, 'o PDF de teste tem uma única página');

  r = await solicitante('/api/documentos', { metodo: 'POST', form: formularioDocumento({ campoX: '0.8', campoLargura: '0.34' }) });
  assert.equal(r.status, 400, 'a caixa não pode sair da página');
});

test('prévia mostra a caixa antes da assinatura; depois, a cópia assinada entra nas evidências', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await enviarDocumento();

  let r = await solicitante(`/api/documentos/${doc.documentoId}/arquivo-assinado`);
  assert.equal(r.status, 200, 'prévia disponível com o link pendente');
  assert.match(r.tipo, /application\/pdf/);
  assert.notDeepEqual(r.corpo, doc.pdf, 'a prévia é uma cópia com a caixa');
  assert.equal((await PDFDocument.load(r.corpo)).getPageCount(), 1);

  const signatario = novoCliente();
  r = await identificar(signatario, doc.api);
  assert.equal(r.corpo.documento.paginaAssinatura, 1, 'o signatário vê em que página vai assinar');
  await signatario(`${doc.api}/documento`);
  r = await signatario(`${doc.api}/assinar`, { metodo: 'POST', json: { aceite: true } });
  assert.equal(r.status, 201);
  assert.equal(r.corpo.assinatura.temDocumentoAssinado, true);

  // Cópia assinada: o hash dela está nas evidências (e nas colunas da assinatura).
  const copia = await solicitante(`/api/documentos/${doc.documentoId}/arquivo-assinado`);
  assert.equal(copia.status, 200);
  const [[linha]] = await pool.execute(
    `SELECT a.evidencias, a.hash_arquivo_assinado AS hashCopia
       FROM assinatura a JOIN link_assinatura l ON l.id = a.link_id WHERE l.documento_id = ?`,
    [doc.documentoId],
  );
  assert.equal(sha256(copia.corpo), linha.hashCopia);
  assert.equal(JSON.parse(linha.evidencias).documentoAssinado.hashSha256, linha.hashCopia);
  assert.equal(JSON.parse(linha.evidencias).versao, 2);

  // O original continua intacto: é o hash dele que vai para a blockchain.
  r = await solicitante(`/api/documentos/${doc.documentoId}/arquivo`);
  assert.equal(sha256(r.corpo), doc.hashDocumento);

  // Signatário abre a cópia assinada pelo comprovante; outra pessoa não.
  r = await signatario(`${doc.api}/documento-assinado`);
  assert.equal(r.status, 200);
  assert.equal(sha256(r.corpo), linha.hashCopia);
  r = await novoCliente()(`${doc.api}/documento-assinado`);
  assert.equal(r.status, 403);
});

test('sem assinatura, documento em estado final não tem versão com caixa', async () => {
  const doc = await enviarDocumento();
  const signatario = novoCliente();
  await identificar(signatario, doc.api);
  await signatario(`${doc.api}/recusar`, { metodo: 'POST', json: {} });

  const r = await solicitante(`/api/documentos/${doc.documentoId}/arquivo-assinado`);
  assert.equal(r.status, 404);
});
