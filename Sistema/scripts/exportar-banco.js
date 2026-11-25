// Exporta o banco (estrutura e dados) para banco/dados_assinatura_eletronica.sql,
// usado para levar o sistema para outro computador.
// Uso: npm run db:exportar
// O mysqldump vem com o MySQL Server; outro caminho pode ser informado em MYSQLDUMP no .env.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../src/config.js';

const mysqldump = process.env.MYSQLDUMP ?? 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe';
const destino = path.join(import.meta.dirname, '..', 'banco', 'dados_assinatura_eletronica.sql');
const { host, port, user, password, database } = config.db;

const resultado = spawnSync(mysqldump, [
  `--host=${host}`,
  `--port=${port}`,
  `--user=${user}`,
  '--databases', database,
  '--single-transaction',
  '--routines',
  '--triggers',
  '--default-character-set=utf8mb4',
  '--set-gtid-purged=OFF',
  `--result-file=${destino}`,
], { env: { ...process.env, MYSQL_PWD: password }, encoding: 'utf8' });

if (resultado.error || resultado.status !== 0) {
  console.error('Falha ao exportar o banco:', resultado.error?.message ?? resultado.stderr);
  process.exit(1);
}
console.log(`Banco "${database}" exportado para ${destino}`);
