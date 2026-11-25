// Página do signatário: identificação, visualização do documento e decisão.

const token = window.location.pathname.split('/').pop();
const baseApi = `/api/assinatura/${encodeURIComponent(token)}`;

const etapas = ['carregando', 'etapa-identificacao', 'etapa-documento', 'etapa-final'];
const elemento = (id) => document.getElementById(id);

function mostrarEtapa(id) {
  for (const etapa of etapas) elemento(etapa).classList.toggle('oculto', etapa !== id);
}

const FINAIS = {
  assinado: ['Documento assinado', 'sucesso'],
  recusado: ['Assinatura recusada', 'alerta'],
  expirado: ['Link expirado', 'alerta'],
  bloqueado: ['Link bloqueado', 'alerta'],
  criado: ['Link indisponível', 'alerta'],
  invalido: ['Link inválido', 'alerta'],
  integridade: ['Assinatura bloqueada', 'alerta'],
};

// Título e mensagem do comprovante conforme a situação do registro na blockchain.
const SITUACOES_REGISTRO = {
  aguardando_registro: ['Documento assinado', 'Assinatura gravada. Registrando na blockchain Ethereum, o que costuma levar menos de um minuto...', 'ok'],
  confirmada: ['Assinatura concluída', 'Sua assinatura foi registrada na blockchain Ethereum. O solicitante foi notificado.', 'sucesso'],
  falha: ['Documento assinado', 'Sua assinatura foi gravada, mas o registro na blockchain não pôde ser concluído. O solicitante foi notificado.', 'alerta'],
};

function mostrarFinal(tipo, texto) {
  const [titulo, estilo] = FINAIS[tipo];
  elemento('titulo-final').textContent = titulo;
  mostrarMensagem(elemento('texto-final'), texto, estilo);
  mostrarEtapa('etapa-final');
}

function preencherComprovante(assinatura) {
  const [titulo, texto, estilo] = SITUACOES_REGISTRO[assinatura.statusBlockchain];
  elemento('titulo-final').textContent = titulo;
  mostrarMensagem(elemento('texto-final'), texto, estilo);
  elemento('comprovante-data').textContent = formatarDataHora(assinatura.dataAssinatura);
  elemento('comprovante-hash-documento').textContent = assinatura.hashDocumento;
  elemento('comprovante-hash-evidencias').textContent = assinatura.hashEvidencias;
  elemento('comprovante-blockchain').replaceChildren(seloStatus(assinatura.statusBlockchain));

  const confirmada = Boolean(assinatura.urlTransacao);
  for (const item of document.querySelectorAll('.registro-confirmado')) item.classList.toggle('oculto', !confirmada);
  if (confirmada) {
    elemento('comprovante-transacao').href = assinatura.urlTransacao;
    elemento('comprovante-transacao').textContent = assinatura.txHash;
    elemento('comprovante-bloco').textContent = assinatura.numeroBloco;
  }
  elemento('comprovante').classList.remove('oculto');
  elemento('ver-documento-original').href = `${baseApi}/documento`;
  elemento('ver-documento-assinado').href = `${baseApi}/documento-assinado`;
  elemento('ver-documento-assinado').classList.toggle('oculto', !assinatura.temDocumentoAssinado);
  elemento('acoes-comprovante').classList.remove('oculto');
}

function mostrarComprovante(assinatura) {
  preencherComprovante(assinatura);
  mostrarEtapa('etapa-final');
  if (assinatura.statusBlockchain === 'aguardando_registro') acompanharRegistro();
}

// Consulta a situação do registro a cada 3 segundos, até a confirmação ou a
// falha (a política de reenvio pode levar alguns minutos no pior caso).
function acompanharRegistro() {
  let consultas = 0;
  const intervalo = setInterval(async () => {
    consultas += 1;
    try {
      const assinatura = await api(`${baseApi}/registro`);
      preencherComprovante(assinatura);
      if (assinatura.statusBlockchain !== 'aguardando_registro') {
        clearInterval(intervalo);
      } else if (consultas >= 120) {
        clearInterval(intervalo);
        mostrarMensagem(
          elemento('texto-final'),
          'Assinatura gravada. O registro na blockchain ainda está em andamento; o solicitante acompanha a conclusão pelo painel.',
          'ok',
        );
      }
    } catch {
      clearInterval(intervalo);
    }
  }, 3000);
}

function mostrarIdentificacao(tentativasRestantes) {
  elemento('tentativas').textContent = `Tentativas restantes: ${tentativasRestantes} de 3.`;
  mostrarEtapa('etapa-identificacao');
}

function mostrarDocumento(documento) {
  elemento('nome-documento').textContent = documento.nomeArquivo;
  elemento('nome-solicitante').textContent = documento.solicitante;
  elemento('nome-signatario').textContent = documento.signatario;
  elemento('info-caixa').textContent = documento.paginaAssinatura
    ? `Ao assinar, seu nome, a data e a hora serão inseridos na página ${documento.paginaAssinatura}, no local definido pelo remetente.`
    : '';
  elemento('visualizador').src = `${baseApi}/documento`;
  elemento('abrir-documento').href = `${baseApi}/documento`;
  mostrarEtapa('etapa-documento');
}

// Situação inicial do link.
async function carregar() {
  try {
    const dados = await api(baseApi);
    if (dados.status === 'pendente') {
      if (dados.identidadeConfirmada) mostrarDocumento(dados.documento);
      else mostrarIdentificacao(dados.tentativasRestantes);
    } else if (dados.status === 'assinado' && dados.assinatura) {
      mostrarComprovante(dados.assinatura);
    } else {
      mostrarFinal(dados.status, dados.mensagem);
    }
  } catch (erro) {
    mostrarFinal('invalido', erro.message);
  }
}

aplicarMascaraCpf(elemento('cpf'));
aplicarMascaraData(elemento('nascimento'));

elemento('form-identificacao').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const mensagem = elemento('mensagem-identificacao');
  const dataNascimento = dataBrParaIso(elemento('nascimento').value);
  if (!dataNascimento) {
    mostrarMensagem(mensagem, 'Informe a data de nascimento no formato dd/mm/aaaa.');
    return;
  }
  const botao = evento.currentTarget.querySelector('button[type="submit"]');
  botao.disabled = true;
  try {
    const dados = await enviarJson(`${baseApi}/identificacao`, { cpf: elemento('cpf').value, dataNascimento });
    mostrarDocumento(dados.documento);
  } catch (erro) {
    if (erro.dados?.status) {
      mostrarFinal(erro.dados.status, erro.message);
    } else {
      mostrarMensagem(mensagem, erro.message);
      if (erro.dados?.tentativasRestantes !== undefined) {
        elemento('tentativas').textContent = `Tentativas restantes: ${erro.dados.tentativasRestantes} de 3.`;
      }
    }
  } finally {
    botao.disabled = false;
  }
});

elemento('aceite').addEventListener('change', (evento) => {
  elemento('assinar').disabled = !evento.currentTarget.checked;
});

async function decidir(acao) {
  const mensagem = elemento('mensagem-documento');
  esconder(mensagem);
  elemento('assinar').disabled = true;
  elemento('recusar').disabled = true;
  try {
    if (acao === 'assinar') {
      const dados = await enviarJson(`${baseApi}/assinar`, { aceite: elemento('aceite').checked });
      mostrarComprovante(dados.assinatura);
    } else {
      await enviarJson(`${baseApi}/recusar`, {});
      mostrarFinal('recusado', 'Você recusou a assinatura deste documento. O solicitante foi notificado.');
    }
  } catch (erro) {
    if (erro.dados?.integridadeViolada) mostrarFinal('integridade', erro.message);
    else if (erro.dados?.status) mostrarFinal(erro.dados.status, erro.message);
    else mostrarMensagem(mensagem, erro.message);
  } finally {
    elemento('assinar').disabled = !elemento('aceite').checked;
    elemento('recusar').disabled = false;
  }
}

elemento('assinar').addEventListener('click', () => decidir('assinar'));
elemento('recusar').addEventListener('click', () => {
  if (window.confirm('Confirma a recusa da assinatura? Esta ação não pode ser desfeita.')) decidir('recusar');
});

carregar();
