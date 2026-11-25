// Tela de login e cadastro do solicitante.

const formLogin = document.getElementById('form-login');
const formCadastro = document.getElementById('form-cadastro');
const abaLogin = document.getElementById('aba-login');
const abaCadastro = document.getElementById('aba-cadastro');
const mensagem = document.getElementById('mensagem');

function selecionarAba(login) {
  formLogin.classList.toggle('oculto', !login);
  formCadastro.classList.toggle('oculto', login);
  abaLogin.classList.toggle('secundario', !login);
  abaCadastro.classList.toggle('secundario', login);
  esconder(mensagem);
}

abaLogin.addEventListener('click', () => selecionarAba(true));
abaCadastro.addEventListener('click', () => selecionarAba(false));

async function enviar(evento, url) {
  evento.preventDefault();
  const formulario = evento.currentTarget;
  const botao = formulario.querySelector('button[type="submit"]');
  botao.disabled = true;
  try {
    await enviarJson(url, Object.fromEntries(new FormData(formulario)));
    window.location.href = '/painel.html';
  } catch (erro) {
    mostrarMensagem(mensagem, erro.message);
  } finally {
    botao.disabled = false;
  }
}

formLogin.addEventListener('submit', (e) => enviar(e, '/api/auth/login'));
formCadastro.addEventListener('submit', (e) => enviar(e, '/api/auth/cadastro'));

// Quem já está logado vai direto para o painel.
api('/api/auth/eu')
  .then(() => { window.location.href = '/painel.html'; })
  .catch(() => {});
