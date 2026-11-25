// Posicionamento da caixa de assinatura sobre o PDF escolhido no envio.
// O PDF é desenhado na tela com o PDF.js; a caixa pode ser arrastada,
// redimensionada pelo canto inferior direito ou movida com as setas do
// teclado. A posição é guardada em frações da página exibida (0 a 1, origem
// no canto superior esquerdo), que o servidor converte para o PDF.

import * as pdfjs from '/vendor/pdfjs/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

const TAMANHO_INICIAL = { largura: 0.34, altura: 0.09 };
const TAMANHO_MINIMO = { largura: 0.12, altura: 0.04 };

const limitar = (valor, minimo, maximo) => Math.min(Math.max(valor, minimo), maximo);

export function criarPosicionador({ container, canvas, caixa, alca, rotulo, indicador, anterior, seguinte }) {
  let carregamento = null;
  let documento = null;
  let renderizacao = null;
  const campo = { pagina: 1, x: 0, y: 0, ...TAMANHO_INICIAL };

  // Começa no canto inferior direito da última página, onde costuma ficar a assinatura.
  function posicaoInicial() {
    Object.assign(campo, TAMANHO_INICIAL, {
      pagina: documento.numPages,
      x: 1 - TAMANHO_INICIAL.largura - 0.06,
      y: 1 - TAMANHO_INICIAL.altura - 0.05,
    });
  }

  async function carregar(arquivo) {
    limpar();
    carregamento = pdfjs.getDocument({
      data: new Uint8Array(await arquivo.arrayBuffer()),
      cMapUrl: '/vendor/pdfjs-recursos/cmaps/',
      standardFontDataUrl: '/vendor/pdfjs-recursos/standard_fonts/',
      wasmUrl: '/vendor/pdfjs-recursos/wasm/',
    });
    documento = await carregamento.promise;
    posicaoInicial();
    await desenhar();
  }

  // Libera o PDF anterior. No PDF.js 6, quem é destruída é a tarefa de
  // carregamento (getDocument), e não o documento.
  function limpar() {
    renderizacao?.cancel();
    carregamento?.destroy().catch(() => {});
    carregamento = null;
    documento = null;
    renderizacao = null;
  }

  async function desenhar() {
    const pagina = await documento.getPage(campo.pagina);
    const larguraDisponivel = container.clientWidth - 24;
    const escala = Math.min(larguraDisponivel / pagina.getViewport({ scale: 1 }).width, 1.5);
    const viewport = pagina.getViewport({ scale: escala });
    const densidade = window.devicePixelRatio || 1;

    canvas.width = Math.floor(viewport.width * densidade);
    canvas.height = Math.floor(viewport.height * densidade);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    renderizacao?.cancel();
    renderizacao = pagina.render({
      canvas,
      viewport,
      transform: densidade === 1 ? null : [densidade, 0, 0, densidade, 0, 0],
    });
    try {
      await renderizacao.promise;
    } catch (erro) {
      if (erro?.name !== 'RenderingCancelledException') throw erro;
    }

    indicador.textContent = `Página ${campo.pagina} de ${documento.numPages}`;
    anterior.disabled = campo.pagina <= 1;
    seguinte.disabled = campo.pagina >= documento.numPages;
    posicionarCaixa();
  }

  function posicionarCaixa() {
    const largura = canvas.clientWidth;
    const altura = canvas.clientHeight;
    caixa.style.left = `${campo.x * largura}px`;
    caixa.style.top = `${campo.y * altura}px`;
    caixa.style.width = `${campo.largura * largura}px`;
    caixa.style.height = `${campo.altura * altura}px`;
  }

  // Arrastar (mover) ou redimensionar com mouse, toque ou caneta.
  function iniciarArraste(evento, modo) {
    evento.preventDefault();
    evento.stopPropagation();
    const alvo = evento.currentTarget;
    const inicio = { px: evento.clientX, py: evento.clientY, ...campo };
    const largura = canvas.clientWidth;
    const altura = canvas.clientHeight;
    alvo.setPointerCapture(evento.pointerId);

    const mover = (e) => {
      const dx = (e.clientX - inicio.px) / largura;
      const dy = (e.clientY - inicio.py) / altura;
      if (modo === 'mover') {
        campo.x = limitar(inicio.x + dx, 0, 1 - campo.largura);
        campo.y = limitar(inicio.y + dy, 0, 1 - campo.altura);
      } else {
        campo.largura = limitar(inicio.largura + dx, TAMANHO_MINIMO.largura, 1 - campo.x);
        campo.altura = limitar(inicio.altura + dy, TAMANHO_MINIMO.altura, 1 - campo.y);
      }
      posicionarCaixa();
    };
    const soltar = () => {
      alvo.removeEventListener('pointermove', mover);
      alvo.removeEventListener('pointerup', soltar);
      alvo.removeEventListener('pointercancel', soltar);
    };
    alvo.addEventListener('pointermove', mover);
    alvo.addEventListener('pointerup', soltar);
    alvo.addEventListener('pointercancel', soltar);
  }

  caixa.addEventListener('pointerdown', (e) => iniciarArraste(e, 'mover'));
  alca.addEventListener('pointerdown', (e) => iniciarArraste(e, 'redimensionar'));

  // Setas movem 1% da página (com Shift, 5%).
  caixa.addEventListener('keydown', (evento) => {
    const passo = evento.shiftKey ? 0.05 : 0.01;
    const deslocamentos = { ArrowLeft: [-passo, 0], ArrowRight: [passo, 0], ArrowUp: [0, -passo], ArrowDown: [0, passo] };
    const deslocamento = deslocamentos[evento.key];
    if (!deslocamento) return;
    evento.preventDefault();
    campo.x = limitar(campo.x + deslocamento[0], 0, 1 - campo.largura);
    campo.y = limitar(campo.y + deslocamento[1], 0, 1 - campo.altura);
    posicionarCaixa();
  });

  anterior.addEventListener('click', () => {
    campo.pagina -= 1;
    desenhar();
  });
  seguinte.addEventListener('click', () => {
    campo.pagina += 1;
    desenhar();
  });

  // Ao redimensionar a janela, redesenha a página no novo tamanho.
  let espera = null;
  window.addEventListener('resize', () => {
    clearTimeout(espera);
    espera = setTimeout(() => documento && desenhar(), 200);
  });

  return {
    carregar,
    limpar,
    carregado: () => documento !== null,
    campo: () => ({ ...campo }),
    definirNome(nome) {
      rotulo.textContent = nome.trim() ? `Assinatura de ${nome.trim()}` : 'Assinatura do signatário';
    },
  };
}
