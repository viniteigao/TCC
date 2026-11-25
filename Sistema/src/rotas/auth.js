// Cadastro, login e logout do solicitante (o signatário não tem login).

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { registrarEvento } from '../auditoria.js';
import { exigirSolicitante } from '../middlewares/autenticacao.js';

export const rotasAuth = Router();

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Gera um novo identificador de sessão no login (evita fixação de sessão).
function iniciarSessao(req, solicitanteId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((erro) => {
      if (erro) return reject(erro);
      req.session.solicitanteId = solicitanteId;
      resolve();
    });
  });
}

rotasAuth.post('/cadastro', async (req, res) => {
  const nome = String(req.body.nome ?? '').trim();
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const senha = String(req.body.senha ?? '');

  if (!nome || !EMAIL_VALIDO.test(email)) {
    return res.status(400).json({ erro: 'Informe nome e e-mail válidos.' });
  }
  if (senha.length < 8) {
    return res.status(400).json({ erro: 'A senha deve ter pelo menos 8 caracteres.' });
  }

  const senhaHash = await bcrypt.hash(senha, 10);
  try {
    const [resultado] = await pool.execute(
      "INSERT INTO usuario (tipo, nome, email, senha_hash) VALUES ('solicitante', ?, ?, ?)",
      [nome, email, senhaHash],
    );
    await registrarEvento(pool, { evento: 'cadastro_solicitante', usuarioId: resultado.insertId, ip: req.ip });
    await iniciarSessao(req, resultado.insertId);
    res.status(201).json({ id: resultado.insertId, nome, email });
  } catch (erro) {
    if (erro.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ erro: 'Já existe uma conta com este e-mail.' });
    }
    throw erro;
  }
});

rotasAuth.post('/login', async (req, res) => {
  const email = String(req.body.email ?? '').trim().toLowerCase();
  const senha = String(req.body.senha ?? '');

  const [[usuario]] = await pool.execute(
    "SELECT id, nome, email, senha_hash FROM usuario WHERE tipo = 'solicitante' AND email = ?",
    [email],
  );
  const senhaConfere = usuario ? await bcrypt.compare(senha, usuario.senha_hash) : false;
  if (!senhaConfere) {
    return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
  }

  await iniciarSessao(req, usuario.id);
  await registrarEvento(pool, { evento: 'login', usuarioId: usuario.id, ip: req.ip });
  res.json({ id: usuario.id, nome: usuario.nome, email: usuario.email });
});

rotasAuth.post('/logout', (req, res, next) => {
  req.session.destroy((erro) => (erro ? next(erro) : res.json({ ok: true })));
});

rotasAuth.get('/eu', exigirSolicitante, async (req, res) => {
  const [[usuario]] = await pool.execute(
    'SELECT id, nome, email FROM usuario WHERE id = ?',
    [req.session.solicitanteId],
  );
  if (!usuario) {
    return res.status(401).json({ erro: 'Faça login para continuar.' });
  }
  res.json(usuario);
});
