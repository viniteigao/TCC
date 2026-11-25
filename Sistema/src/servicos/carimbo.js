// Caixa de assinatura no PDF (biblioteca pdf-lib).
//
// O PDF original nunca é alterado: o hash dele é o que está na blockchain.
// A caixa é escrita numa cópia, que é o "documento assinado" (gerado na
// assinatura) ou uma prévia com a caixa vazia (enquanto o link está pendente).
//
// A posição da caixa é guardada em frações da página como ela aparece na tela
// (0 a 1, origem no canto superior esquerdo). Aqui ela é convertida para as
// coordenadas do PDF (origem no canto inferior esquerdo), considerando a área
// visível da página (CropBox) e a rotação definida no arquivo.

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const AZUL = rgb(0.17, 0.42, 0.69);
const TEXTO = rgb(0.11, 0.15, 0.2);
const CINZA = rgb(0.36, 0.4, 0.45);

const LARGURA_MINIMA = 0.05;
const ALTURA_MINIMA = 0.02;

// Lê o PDF para validar o arquivo e contar as páginas. Recusa PDFs
// protegidos por senha ou corrompidos, nos quais a caixa não pode ser escrita.
export async function contarPaginas(conteudo) {
  try {
    const pdf = await PDFDocument.load(conteudo, { updateMetadata: false });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}

// Valida a caixa enviada pelo formulário. Devolve { campo } ou { erro }.
export function lerCampo(corpo, totalPaginas) {
  if (corpo.campoPagina === undefined || corpo.campoPagina === '') {
    return { erro: 'Posicione a caixa de assinatura no documento.' };
  }
  const pagina = Number(corpo.campoPagina);
  const [x, y, largura, altura] = ['campoX', 'campoY', 'campoLargura', 'campoAltura'].map((nome) => Number(corpo[nome]));
  if (![x, y, largura, altura].every(Number.isFinite)) {
    return { erro: 'Posicione a caixa de assinatura no documento.' };
  }
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > totalPaginas) {
    return { erro: 'A página escolhida para a caixa de assinatura não existe no documento.' };
  }
  const folga = 1e-6;
  if (x < 0 || y < 0 || largura < LARGURA_MINIMA || altura < ALTURA_MINIMA ||
      x + largura > 1 + folga || y + altura > 1 + folga) {
    return { erro: 'A caixa de assinatura precisa ficar inteira dentro da página.' };
  }
  return { campo: { pagina, x, y, largura, altura } };
}

// Monta a caixa a partir das colunas do banco (null em documentos antigos).
export function campoDoBanco(linha) {
  if (!linha.campoPagina) return null;
  return {
    pagina: Number(linha.campoPagina),
    x: Number(linha.campoX),
    y: Number(linha.campoY),
    largura: Number(linha.campoLargura),
    altura: Number(linha.campoAltura),
  };
}

// Código curto para conferência visual: início do SHA-256 do documento.
export function codigoVerificacao(hashDocumento) {
  return hashDocumento.slice(0, 16).toUpperCase().match(/.{4}/g).join(' ');
}

export function dataHoraBrasilia(data) {
  const fuso = { timeZone: 'America/Sao_Paulo' };
  return `${data.toLocaleDateString('pt-BR', fuso)} às ${data.toLocaleTimeString('pt-BR', fuso)} (horário de Brasília)`;
}

export function nomeDaCopia(nomeArquivo, sufixo) {
  return nomeArquivo.replace(/(\.pdf)?$/i, ` (${sufixo}).pdf`);
}

function rotacaoNormalizada(angulo) {
  return ((Math.round(angulo / 90) * 90) % 360 + 360) % 360;
}

// Tamanho da página como aparece na tela (rotações de 90 e 270 invertem os lados).
function tamanhoExibido(corte, rotacao) {
  return rotacao % 180 === 0
    ? { largura: corte.largura, altura: corte.altura }
    : { largura: corte.altura, altura: corte.largura };
}

// Retângulo da caixa nas coordenadas do PDF.
export function retanguloNoPdf(campo, corte, rotacao) {
  const exibido = tamanhoExibido(corte, rotacao);
  const X = campo.x * exibido.largura;
  const Y = campo.y * exibido.altura;
  const L = campo.largura * exibido.largura;
  const A = campo.altura * exibido.altura;
  const { x: cx, y: cy, largura: cl, altura: ca } = corte;
  switch (rotacao) {
    case 90: return { x: cx + Y, y: cy + X, largura: A, altura: L };
    case 180: return { x: cx + cl - X - L, y: cy + Y, largura: L, altura: A };
    case 270: return { x: cx + cl - Y - A, y: cy + ca - X - L, largura: A, altura: L };
    default: return { x: cx + X, y: cy + ca - Y - A, largura: L, altura: A };
  }
}

// Ponto do PDF correspondente a um ponto da tela (dx, dy a partir do canto
// superior esquerdo) e o giro que deixa o texto horizontal para quem lê.
export function pontoNoPdf(dx, dy, corte, rotacao) {
  const { x: cx, y: cy, largura: cl, altura: ca } = corte;
  switch (rotacao) {
    case 90: return { x: cx + dy, y: cy + dx, giro: 90 };
    case 180: return { x: cx + cl - dx, y: cy + dy, giro: 180 };
    case 270: return { x: cx + cl - dy, y: cy + ca - dx, giro: 270 };
    default: return { x: cx + dx, y: cy + ca - dy, giro: 0 };
  }
}

// As fontes padrão do PDF não têm todos os caracteres: letras fora delas
// perdem o acento (ex.: "ł" vira "l") ou viram "?".
function textoSuportado(texto, fonte) {
  const suportados = new Set(fonte.getCharacterSet());
  const cabe = (trecho) => [...trecho].every((c) => suportados.has(c.codePointAt(0)));
  return [...texto].map((c) => {
    if (cabe(c)) return c;
    const semAcento = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return semAcento && cabe(semAcento) ? semAcento : '?';
  }).join('');
}

// Gera a cópia do PDF com a caixa: preenchida (nome, data e hora e código)
// ou, com "previa", vazia e tracejada, para conferir a posição.
export async function gerarPdfComCaixa(original, campo, { nome, dataHora, codigo, previa = false }) {
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  const pagina = pdf.getPage(campo.pagina - 1);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const area = pagina.getCropBox();
  const corte = { x: area.x, y: area.y, largura: area.width, altura: area.height };
  const rotacao = rotacaoNormalizada(pagina.getRotation().angle);

  const caixa = retanguloNoPdf(campo, corte, rotacao);
  pagina.drawRectangle({
    x: caixa.x,
    y: caixa.y,
    width: caixa.largura,
    height: caixa.altura,
    color: rgb(1, 1, 1),
    opacity: 0.9,
    borderColor: AZUL,
    borderWidth: 1,
    borderDashArray: previa ? [4, 3] : undefined,
  });

  const linhas = previa
    ? [
      ['Assinatura eletrônica de', regular, 0.8, CINZA],
      [nome, negrito, 1.3, TEXTO],
      ['Aguardando assinatura', regular, 0.8, CINZA],
      [`Código de verificação: ${codigo}`, regular, 0.7, CINZA],
    ]
    : [
      ['Assinado eletronicamente por', regular, 0.8, CINZA],
      [nome, negrito, 1.3, TEXTO],
      [dataHora, regular, 0.8, TEXTO],
      [`Código de verificação: ${codigo}`, regular, 0.7, CINZA],
    ];

  // Distribui as linhas na altura da caixa e reduz a fonte das que não
  // couberem na largura (cálculos em pontos, na orientação da tela).
  const exibido = tamanhoExibido(corte, rotacao);
  const X = campo.x * exibido.largura;
  const Y = campo.y * exibido.altura;
  const L = campo.largura * exibido.largura;
  const A = campo.altura * exibido.altura;
  const margem = Math.min(L, A) * 0.08;
  const larguraUtil = L - 2 * margem;
  const unidade = (A - 2 * margem) / (linhas.reduce((soma, [, , peso]) => soma + peso, 0) * 1.25);

  let topo = Y + margem;
  for (const [conteudo, fonte, peso, cor] of linhas) {
    const texto = textoSuportado(conteudo, fonte);
    const nominal = peso * unidade;
    const largura = fonte.widthOfTextAtSize(texto, nominal);
    const tamanho = largura > larguraUtil ? nominal * (larguraUtil / largura) : nominal;
    const ponto = pontoNoPdf(X + margem, topo + nominal * 0.95, corte, rotacao);
    pagina.drawText(texto, { x: ponto.x, y: ponto.y, size: tamanho, font: fonte, color: cor, rotate: degrees(ponto.giro) });
    topo += nominal * 1.25;
  }

  return Buffer.from(await pdf.save());
}
