// Funções compartilhadas pelas páginas do front-end.

// Chama a API e devolve o JSON; em caso de erro, lança a mensagem do servidor.
async function api(url, opcoes = {}) {
  const resposta = await fetch(url, opcoes);
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.erro ?? `Erro ${resposta.status}`);
    erro.status = resposta.status;
    erro.dados = dados;
    throw erro;
  }
  return dados;
}

function enviarJson(url, corpo, metodo = 'POST') {
  return api(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function mostrarMensagem(elemento, texto, tipo = 'erro') {
  elemento.textContent = texto;
  elemento.className = `mensagem ${tipo}`;
}

function esconder(elemento) {
  elemento.classList.add('oculto');
}

// Formata o CPF enquanto o usuário digita (000.000.000-00).
function aplicarMascaraCpf(input) {
  input.addEventListener('input', () => {
    const digitos = input.value.replace(/\D/g, '').slice(0, 11);
    const blocos = [digitos.slice(0, 3), digitos.slice(3, 6), digitos.slice(6, 9)].filter(Boolean).join('.');
    input.value = digitos.length > 9 ? `${blocos}-${digitos.slice(9)}` : blocos;
  });
}

// Formata a data enquanto o usuário digita (dd/mm/aaaa).
function aplicarMascaraData(input) {
  input.addEventListener('input', () => {
    const digitos = input.value.replace(/\D/g, '').slice(0, 8);
    input.value = [digitos.slice(0, 2), digitos.slice(2, 4), digitos.slice(4)].filter(Boolean).join('/');
  });
}

// Converte dd/mm/aaaa para aaaa-mm-dd (formato enviado à API).
// Devolve null se o texto estiver incompleto ou a data não existir (ex.: 31/02).
function dataBrParaIso(texto) {
  const partes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(texto ?? '').trim());
  if (!partes) return null;
  const [, dia, mes, ano] = partes;
  const data = new Date(Number(ano), Number(mes) - 1, Number(dia));
  if (data.getFullYear() !== Number(ano) || data.getMonth() !== Number(mes) - 1 || data.getDate() !== Number(dia)) {
    return null;
  }
  return `${ano}-${mes}-${dia}`;
}

// aaaa-mm-dd -> dd/mm/aaaa
function dataIsoParaBr(iso) {
  const [ano, mes, dia] = String(iso ?? '').split('-');
  return dia ? `${dia}/${mes}/${ano}` : '';
}

// 11 dígitos -> 000.000.000-00
function formatarCpf(digitos) {
  return String(digitos ?? '').replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
}

// Copia para a área de transferência; se o navegador não permitir,
// mostra o texto para o usuário copiar manualmente.
async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    window.prompt('Copie o link abaixo (Ctrl+C):', texto);
    return false;
  }
}

function formatarDataHora(valor) {
  return valor ? new Date(valor).toLocaleString('pt-BR') : '';
}

const ROTULOS_STATUS = {
  criado: 'Criado',
  pendente: 'Pendente',
  assinado: 'Assinado',
  recusado: 'Recusado',
  expirado: 'Expirado',
  bloqueado: 'Bloqueado',
  aguardando_registro: 'Aguardando registro',
  confirmada: 'Confirmada',
  falha: 'Falha',
};

function seloStatus(status) {
  const selo = document.createElement('span');
  selo.className = `status status-${status ?? 'nenhum'}`;
  selo.textContent = status ? ROTULOS_STATUS[status] ?? status : 'Não iniciado';
  return selo;
}
