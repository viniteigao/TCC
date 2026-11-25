// Aplicação Express: middlewares, rotas e tratamento de erros.
// Separada de server.js para que os testes possam subir a aplicação
// em outra porta.

import path from 'node:path';
import express from 'express';
import session from 'express-session';
import { config } from './config.js';
import { pool } from './db.js';
import { rotasAuth } from './rotas/auth.js';
import { rotasDocumentos } from './rotas/documentos.js';
import { rotasAssinatura } from './rotas/assinatura.js';
import { situacaoBlockchain } from './blockchain/registro.js';

export const app = express();
const pastaPublica = path.join(import.meta.dirname, '..', 'public');

// Acesso por túnel (cloudflared): as requisições chegam pelo próprio
// computador, e o IP do signatário vem no cabeçalho X-Forwarded-For.
// O cabeçalho só é aceito quando a conexão vem do próprio computador.
app.set('trust proxy', 'loopback');

app.use(express.json());
app.use(session({
  secret: config.segredoSessao,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(pastaPublica));
// PDF.js (exibição do PDF no navegador para posicionar a caixa de assinatura),
// com os arquivos auxiliares de fontes, mapas de caracteres e imagens.
const pastaPdfjs = path.join(import.meta.dirname, '..', 'node_modules', 'pdfjs-dist');
app.use('/vendor/pdfjs', express.static(path.join(pastaPdfjs, 'build')));
for (const recurso of ['cmaps', 'standard_fonts', 'wasm']) {
  app.use(`/vendor/pdfjs-recursos/${recurso}`, express.static(path.join(pastaPdfjs, recurso)));
}

// Verifica se o servidor está no ar, se a conexão com o banco funciona e a
// situação da conexão com a blockchain.
app.get('/api/saude', async (req, res) => {
  try {
    const [[linha]] = await pool.query('SELECT DATABASE() AS banco, NOW() AS agora');
    res.json({ status: 'ok', banco: linha.banco, horaBanco: linha.agora, blockchain: situacaoBlockchain() });
  } catch (erro) {
    res.status(500).json({ status: 'erro', mensagem: erro.message });
  }
});

app.use('/api/auth', rotasAuth);
app.use('/api/documentos', rotasDocumentos);
app.use('/api/assinatura', rotasAssinatura);

// Página do signatário. O token fica na URL; "no-referrer" evita que ele
// vaze no cabeçalho Referer para outros sites.
app.get('/assinar/:token', (req, res) => {
  res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
  res.sendFile(path.join(pastaPublica, 'assinar.html'));
});

// Tratamento centralizado de erros (o Express 5 encaminha para cá os erros
// lançados dentro das rotas assíncronas).
app.use((erro, req, res, next) => {
  if (erro.name === 'MulterError') {
    const mensagem = erro.code === 'LIMIT_FILE_SIZE'
      ? 'O arquivo excede o tamanho máximo de 10 MB.'
      : 'Falha no envio do arquivo.';
    return res.status(400).json({ erro: mensagem });
  }
  console.error(erro);
  res.status(500).json({ erro: 'Erro interno no servidor.' });
});
