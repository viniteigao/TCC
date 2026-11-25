// Importa banco/dados_assinatura_eletronica.sql (gerado por npm run db:exportar)
// no banco definido em DB_NAME, usado ao levar o sistema para outro computador.
// Uso: npm run db:importar   (substitui as tabelas desse banco pelas do arquivo)

import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const arquivo = path.join(import.meta.dirname, '..', 'banco', 'dados_assinatura_eletronica.sql');
const { database, ...semBanco } = config.db;

// O arquivo cria e seleciona o banco de origem; usa o nome configurado no .env.
const script = (await fs.readFile(arquivo, 'utf8'))
  .replace(/^(CREATE DATABASE[^`]*`)[^`]+`/m, `$1${database}\``)
  .replace(/^USE `[^`]+`;/m, `USE \`${database}\`;`);

const conexao = await mysql.createConnection({ ...semBanco, multipleStatements: true });
try {
  await conexao.query(script);
} finally {
  await conexao.end();
}

const verificacao = await mysql.createConnection(config.db);
const [[contagem]] = await verificacao.query(
  'SELECT (SELECT COUNT(*) FROM documento) AS documentos, (SELECT COUNT(*) FROM assinatura) AS assinaturas',
);
await verificacao.end();
console.log(`Banco "${database}" importado: ${contagem.documentos} documento(s) e ${contagem.assinaturas} assinatura(s).`);
