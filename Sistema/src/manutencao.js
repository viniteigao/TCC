// Recriação do banco (desenvolvimento e testes automatizados).

import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from './config.js';

// Executa banco/schema.sql no banco definido em DB_NAME e esvazia a pasta
// de uploads. APAGA todos os dados desse banco.
export async function recriarBanco() {
  const { database, ...semBanco } = config.db;
  const arquivo = path.join(import.meta.dirname, '..', 'banco', 'schema.sql');
  const script = (await fs.readFile(arquivo, 'utf8')).replace(/\bassinatura_eletronica\b/g, database);

  const conexao = await mysql.createConnection({ ...semBanco, multipleStatements: true });
  try {
    await conexao.query(script);
  } finally {
    await conexao.end();
  }
  await fs.rm(config.pastaUploads, { recursive: true, force: true });
  return database;
}
