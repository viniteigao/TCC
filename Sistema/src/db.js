// Pool de conexões com o MySQL (mysql2, interface com Promises).

import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
});

// Executa "funcao" dentro de uma transação: confirma se tudo der certo,
// desfaz se algum comando falhar.
export async function emTransacao(funcao) {
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    const resultado = await funcao(conexao);
    await conexao.commit();
    return resultado;
  } catch (erro) {
    await conexao.rollback();
    throw erro;
  } finally {
    conexao.release();
  }
}
