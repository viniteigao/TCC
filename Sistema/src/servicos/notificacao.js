// Notificações do sistema (envio do link ao signatário e avisos ao solicitante).
// No protótipo, as mensagens são exibidas no console do servidor. O envio
// real por e-mail (SMTP) pode ser ligado aqui sem alterar o restante do código.

export async function enviarLinkAoSignatario({ nome, email, url, dataExpiracao }) {
  const validade = dataExpiracao.toLocaleString('pt-BR');
  console.log(
    `\n[E-mail para ${nome} <${email}>]\n` +
    `Você recebeu um documento para assinatura eletrônica.\n` +
    `Acesse: ${url}\n` +
    `Link válido até ${validade}.\n`,
  );
}

export async function notificarSolicitante({ nome, email, assunto, texto }) {
  console.log(`\n[E-mail para ${nome} <${email}>]\nAssunto: ${assunto}\n${texto}\n`);
}
