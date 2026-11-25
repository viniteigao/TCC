// Regras do ciclo de vida do link de assinatura (diagrama de estados).

import { pool } from '../db.js';

// Prazo vencido sem decisão leva o link ao estado final Expirado.
// Os vencidos são localizados por uma leitura sem travas e atualizados pela
// chave primária. Um UPDATE com essa condição direto na tabela travaria o
// índice de status inteiro e entraria em impasse (deadlock) com assinaturas
// simultâneas, que também mudam o status do link (achado do teste de carga).
export async function expirarLinksVencidos(executor = pool) {
  const [vencidos] = await executor.execute(
    "SELECT id FROM link_assinatura WHERE status IN ('criado', 'pendente') AND data_expiracao < NOW()",
  );
  if (vencidos.length === 0) return;
  await executor.query(
    `UPDATE link_assinatura
        SET status = 'expirado', data_decisao = NOW()
      WHERE id IN (?) AND status IN ('criado', 'pendente') AND data_expiracao < NOW()`,
    [vencidos.map((link) => link.id)],
  );
}
