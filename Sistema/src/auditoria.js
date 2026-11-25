// Registro de eventos na trilha de auditoria (tabela log_auditoria).
// "executor" pode ser o pool ou uma conexão dentro de uma transação.

export async function registrarEvento(executor, { evento, documentoId = null, usuarioId = null, detalhes = null, ip = null }) {
  await executor.execute(
    'INSERT INTO log_auditoria (documento_id, usuario_id, evento, detalhes, endereco_ip) VALUES (?, ?, ?, ?, ?)',
    [documentoId, usuarioId, evento, detalhes ? JSON.stringify(detalhes) : null, ip],
  );
}
