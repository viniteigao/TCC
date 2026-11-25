// Painel do solicitante: envio de documento (com a posição da caixa de
// assinatura), acompanhamento do status, cópia do link e edição dos dados.

import { criarPosicionador } from './posicionamento.js';

const formDocumento = document.getElementById('form-documento');
const areaPosicionamento = document.getElementById('posicionamento');
const mensagem = document.getElementById('mensagem');
const mensagemLista = document.getElementById('mensagem-lista');
const resultado = document.getElementById('resultado');
const lista = document.getElementById('lista-documentos');
const dialogoEdicao = document.getElementById('dialogo-edicao');
const formEdicao = document.getElementById('form-edicao');
const mensagemEdicao = document.getElementById('mensagem-edicao');

const STATUS_COM_ACOES = ['criado', 'pendente'];
let documentoEmEdicao = null;
let atualizacaoAutomatica = null;

aplicarMascaraCpf(document.getElementById('cpf-signatario'));
aplicarMascaraData(document.getElementById('nascimento-signatario'));
aplicarMascaraCpf(document.getElementById('edicao-cpf'));
aplicarMascaraData(document.getElementById('edicao-nascimento'));

const posicionador = criarPosicionador({
  container: document.getElementById('container-pdf'),
  canvas: document.getElementById('canvas-pdf'),
  caixa: document.getElementById('caixa-assinatura'),
  alca: document.getElementById('alca-caixa'),
  rotulo: document.getElementById('rotulo-caixa'),
  indicador: document.getElementById('indicador-pagina'),
  anterior: document.getElementById('pagina-anterior'),
  seguinte: document.getElementById('pagina-seguinte'),
});

function fecharPosicionamento() {
  posicionador.limpar();
  esconder(areaPosicionamento);
}

// Ao escolher o PDF, ele abre na tela com a caixa de assinatura para posicionar.
document.getElementById('arquivo').addEventListener('change', async (evento) => {
  const arquivo = evento.currentTarget.files[0];
  esconder(mensagem);
  if (!arquivo) {
    fecharPosicionamento();
    return;
  }
  areaPosicionamento.classList.remove('oculto');
  try {
    await posicionador.carregar(arquivo);
  } catch {
    fecharPosicionamento();
    mostrarMensagem(mensagem, 'Não foi possível abrir este PDF. Verifique se ele não está protegido por senha ou corrompido.');
  }
});

document.getElementById('nome-signatario').addEventListener('input', (evento) => {
  posicionador.definirNome(evento.currentTarget.value);
});

function redirecionarSeDeslogado(erro) {
  if (erro.status === 401) window.location.href = '/';
}

function celula(...conteudos) {
  const td = document.createElement('td');
  for (const conteudo of conteudos) {
    if (conteudo instanceof Node) td.append(conteudo);
    else {
      const div = document.createElement('div');
      div.textContent = conteudo;
      td.append(div);
    }
  }
  return td;
}

function textoPequeno(texto, classe) {
  const div = document.createElement('div');
  div.className = classe;
  div.textContent = texto;
  return div;
}

function botaoAcao(texto, acao, id) {
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.className = 'secundario pequeno';
  botao.textContent = texto;
  botao.dataset.acao = acao;
  botao.dataset.id = id;
  return botao;
}

function linkPdf(texto, endereco) {
  const link = document.createElement('a');
  link.className = 'botao secundario pequeno';
  link.href = endereco;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = texto;
  return link;
}

// Os PDFs abrem em nova aba: o original sempre; o assinado depois da
// assinatura, ou a prévia da caixa enquanto o link está pendente.
// Copiar e editar só com o link pendente.
function celulaAcoes(doc) {
  const grupo = document.createElement('div');
  grupo.className = 'acoes-linha';
  const pendente = STATUS_COM_ACOES.includes(doc.status);
  grupo.append(linkPdf('Documento original', `/api/documentos/${doc.id}/arquivo`));
  if (doc.temDocumentoAssinado) {
    grupo.append(linkPdf('Documento assinado', `/api/documentos/${doc.id}/arquivo-assinado`));
  } else if (doc.temCaixa && pendente) {
    grupo.append(linkPdf('Prévia da assinatura', `/api/documentos/${doc.id}/arquivo-assinado`));
  }
  if (pendente) {
    grupo.append(botaoAcao('Copiar link', 'copiar', doc.id), botaoAcao('Editar', 'editar', doc.id));
  }
  return celula(grupo);
}

function celulaStatus(doc) {
  const td = celula(seloStatus(doc.status));
  if (STATUS_COM_ACOES.includes(doc.status) && doc.tentativasIdentificacao > 0) {
    td.append(textoPequeno(`Identificação: ${doc.tentativasIdentificacao} de 3 tentativas usadas`, 'detalhe'));
  }
  return td;
}

function celulaBlockchain(doc) {
  const td = celula(seloStatus(doc.statusBlockchain));
  if (doc.urlTransacao) {
    const link = document.createElement('a');
    link.href = doc.urlTransacao;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Ver transação';
    const div = textoPequeno('', 'detalhe');
    div.append(link, ` (bloco ${doc.numeroBloco})`);
    td.append(div);
  }
  if (doc.tentativasEnvio > 1) {
    td.append(textoPequeno(`Tentativas de envio: ${doc.tentativasEnvio}`, 'detalhe'));
  }
  return td;
}

async function carregarDocumentos() {
  const documentos = await api('/api/documentos');
  // Enquanto algum registro estiver em andamento, a lista se atualiza sozinha.
  clearTimeout(atualizacaoAutomatica);
  if (documentos.some((doc) => doc.statusBlockchain === 'aguardando_registro')) {
    atualizacaoAutomatica = setTimeout(() => carregarDocumentos().catch(() => {}), 5000);
  }
  lista.replaceChildren();
  if (documentos.length === 0) {
    const tr = document.createElement('tr');
    const td = celula('Nenhum documento enviado ainda.');
    td.colSpan = 7;
    td.className = 'vazio';
    tr.append(td);
    lista.append(tr);
    return;
  }
  for (const doc of documentos) {
    const tr = document.createElement('tr');
    tr.append(
      celula(doc.nomeArquivo, textoPequeno(doc.hashDocumento, 'hash')),
      celula(doc.signatarioNome, doc.signatarioEmail),
      celula(formatarDataHora(doc.dataUpload)),
      celula(formatarDataHora(doc.dataExpiracao)),
      celulaStatus(doc),
      celulaBlockchain(doc),
      celulaAcoes(doc),
    );
    lista.append(tr);
  }
}

// Envio de novo documento.
formDocumento.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  esconder(mensagem);
  esconder(resultado);

  const formulario = new FormData(formDocumento);
  const nascimentoIso = dataBrParaIso(formulario.get('dataNascimentoSignatario'));
  if (!nascimentoIso) {
    mostrarMensagem(mensagem, 'Informe uma data de nascimento válida no formato dd/mm/aaaa.');
    return;
  }
  formulario.set('dataNascimentoSignatario', nascimentoIso);

  if (!posicionador.carregado()) {
    mostrarMensagem(mensagem, 'Escolha o PDF e posicione a caixa de assinatura.');
    return;
  }
  const campo = posicionador.campo();
  formulario.set('campoPagina', String(campo.pagina));
  formulario.set('campoX', campo.x.toFixed(6));
  formulario.set('campoY', campo.y.toFixed(6));
  formulario.set('campoLargura', campo.largura.toFixed(6));
  formulario.set('campoAltura', campo.altura.toFixed(6));

  const botao = formDocumento.querySelector('button[type="submit"]');
  botao.disabled = true;
  try {
    const dados = await api('/api/documentos', { method: 'POST', body: formulario });
    document.getElementById('resultado-hash').textContent = dados.hashDocumento;
    document.getElementById('resultado-validade').textContent = formatarDataHora(dados.dataExpiracao);
    document.getElementById('resultado-link').value = dados.link;
    resultado.classList.remove('oculto');
    formDocumento.reset();
    fecharPosicionamento();
    posicionador.definirNome('');
    await carregarDocumentos();
  } catch (erro) {
    redirecionarSeDeslogado(erro);
    mostrarMensagem(mensagem, erro.message);
  } finally {
    botao.disabled = false;
  }
});

document.getElementById('copiar-link').addEventListener('click', async (evento) => {
  const botao = evento.currentTarget;
  if (await copiarTexto(document.getElementById('resultado-link').value)) {
    botao.textContent = 'Copiado!';
    setTimeout(() => { botao.textContent = 'Copiar'; }, 2000);
  }
});

// Ações da lista (um único ouvinte para todos os botões da tabela).
lista.addEventListener('click', async (evento) => {
  const botao = evento.target.closest('button[data-acao]');
  if (!botao) return;
  const id = botao.dataset.id;
  esconder(mensagemLista);
  try {
    if (botao.dataset.acao === 'copiar') await copiarLink(id, botao);
    if (botao.dataset.acao === 'editar') await abrirEdicao(id);
  } catch (erro) {
    redirecionarSeDeslogado(erro);
    mostrarMensagem(mensagemLista, erro.message);
    await carregarDocumentos();
  }
});

async function copiarLink(id, botao) {
  const { link } = await api(`/api/documentos/${id}/link`);
  if (await copiarTexto(link)) {
    botao.textContent = 'Copiado!';
    setTimeout(() => { botao.textContent = 'Copiar link'; }, 2000);
  }
}

// Edição dos dados do signatário.
async function abrirEdicao(id) {
  const doc = await api(`/api/documentos/${id}`);
  documentoEmEdicao = doc.id;
  formEdicao.reset();
  esconder(mensagemEdicao);
  document.getElementById('edicao-documento').textContent = `Documento: ${doc.nomeArquivo}`;
  document.getElementById('edicao-nome').value = doc.signatario.nome;
  document.getElementById('edicao-email').value = doc.signatario.email;
  document.getElementById('edicao-cpf').value = formatarCpf(doc.signatario.cpf);
  document.getElementById('edicao-nascimento').value = dataIsoParaBr(doc.signatario.dataNascimento);
  document.getElementById('edicao-validade-atual').textContent =
    `Validade atual do link: ${formatarDataHora(doc.dataExpiracao)}.`;
  dialogoEdicao.showModal();
}

document.getElementById('cancelar-edicao').addEventListener('click', () => dialogoEdicao.close());

formEdicao.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  esconder(mensagemEdicao);
  const dados = Object.fromEntries(new FormData(formEdicao));
  dados.dataNascimentoSignatario = dataBrParaIso(dados.dataNascimentoSignatario);
  if (!dados.dataNascimentoSignatario) {
    mostrarMensagem(mensagemEdicao, 'Informe uma data de nascimento válida no formato dd/mm/aaaa.');
    return;
  }

  const botao = formEdicao.querySelector('button[type="submit"]');
  botao.disabled = true;
  try {
    const resposta = await enviarJson(`/api/documentos/${documentoEmEdicao}`, dados, 'PUT');
    dialogoEdicao.close();
    const partes = [resposta.alterados.length === 0 ? 'Nenhuma alteração foi feita.' : 'Dados atualizados.'];
    if (resposta.tentativasZeradas) partes.push('As tentativas de identificação foram zeradas.');
    if (resposta.linkReenviado) partes.push('Como o e-mail mudou, o link foi reenviado ao novo endereço.');
    mostrarMensagem(mensagemLista, partes.join(' '), 'ok');
    await carregarDocumentos();
  } catch (erro) {
    redirecionarSeDeslogado(erro);
    mostrarMensagem(mensagemEdicao, erro.message);
  } finally {
    botao.disabled = false;
  }
});

document.getElementById('atualizar').addEventListener('click', () => {
  esconder(mensagemLista);
  carregarDocumentos();
});

document.getElementById('sair').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

api('/api/auth/eu')
  .then((usuario) => {
    document.getElementById('nome-usuario').textContent = usuario.nome;
    return carregarDocumentos();
  })
  .catch(() => { window.location.href = '/'; });
