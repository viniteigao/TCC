// Testes da caixa de assinatura no PDF: conversão da posição escolhida na
// tela para as coordenadas do PDF (inclusive páginas giradas), validação da
// caixa e geração da cópia. Não usam banco nem rede.
// Uso: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees } from 'pdf-lib';
import {
  retanguloNoPdf, pontoNoPdf, lerCampo, codigoVerificacao, dataHoraBrasilia, gerarPdfComCaixa,
} from '../src/servicos/carimbo.js';

const CORTE = { x: 0, y: 0, largura: 600, altura: 800 };
const CAMPO = { pagina: 1, x: 0.1, y: 0.2, largura: 0.3, altura: 0.1 };
const perto = (a, b) => Math.abs(a - b) < 1e-9;

function assertRetangulo(obtido, esperado) {
  for (const chave of ['x', 'y', 'largura', 'altura']) {
    assert.ok(perto(obtido[chave], esperado[chave]), `${chave}: ${obtido[chave]} ≠ ${esperado[chave]}`);
  }
}

test('caixa convertida para o PDF em cada rotação de página', () => {
  assertRetangulo(retanguloNoPdf(CAMPO, CORTE, 0), { x: 60, y: 560, largura: 180, altura: 80 });
  assertRetangulo(retanguloNoPdf(CAMPO, CORTE, 90), { x: 120, y: 80, largura: 60, altura: 240 });
  assertRetangulo(retanguloNoPdf(CAMPO, CORTE, 180), { x: 360, y: 160, largura: 180, altura: 80 });
  assertRetangulo(retanguloNoPdf(CAMPO, CORTE, 270), { x: 420, y: 480, largura: 60, altura: 240 });
});

test('área visível deslocada (CropBox fora da origem) é considerada', () => {
  const corte = { x: 10, y: 20, largura: 600, altura: 800 };
  assertRetangulo(retanguloNoPdf(CAMPO, corte, 0), { x: 70, y: 580, largura: 180, altura: 80 });
});

test('texto fica dentro da caixa e legível (da esquerda para a direita) em qualquer rotação', () => {
  for (const rotacao of [0, 90, 180, 270]) {
    const exibido = rotacao % 180 === 0 ? { l: 600, a: 800 } : { l: 800, a: 600 };
    const centro = {
      dx: (CAMPO.x + CAMPO.largura / 2) * exibido.l,
      dy: (CAMPO.y + CAMPO.altura / 2) * exibido.a,
    };
    const caixa = retanguloNoPdf(CAMPO, CORTE, rotacao);
    const ponto = pontoNoPdf(centro.dx, centro.dy, CORTE, rotacao);
    assert.ok(ponto.x > caixa.x && ponto.x < caixa.x + caixa.largura, `rotação ${rotacao}: x fora da caixa`);
    assert.ok(ponto.y > caixa.y && ponto.y < caixa.y + caixa.altura, `rotação ${rotacao}: y fora da caixa`);

    // Andar para a direita na tela = sentido da linha de texto girada.
    const direita = pontoNoPdf(centro.dx + 1, centro.dy, CORTE, rotacao);
    const radianos = (ponto.giro * Math.PI) / 180;
    assert.ok(perto(direita.x - ponto.x, Math.cos(radianos)), `rotação ${rotacao}: sentido do texto`);
    assert.ok(perto(direita.y - ponto.y, Math.sin(radianos)), `rotação ${rotacao}: sentido do texto`);
    // Subir na tela = "para cima" das letras.
    const acima = pontoNoPdf(centro.dx, centro.dy - 1, CORTE, rotacao);
    assert.ok(perto(acima.x - ponto.x, -Math.sin(radianos)), `rotação ${rotacao}: letras de ponta-cabeça`);
    assert.ok(perto(acima.y - ponto.y, Math.cos(radianos)), `rotação ${rotacao}: letras de ponta-cabeça`);
  }
});

test('validação da caixa enviada pelo formulário', () => {
  const valido = { campoPagina: '2', campoX: '0.5', campoY: '0.8', campoLargura: '0.3', campoAltura: '0.1' };
  assert.deepEqual(lerCampo(valido, 2).campo, { pagina: 2, x: 0.5, y: 0.8, largura: 0.3, altura: 0.1 });
  assert.ok(lerCampo({}, 2).erro, 'caixa ausente');
  assert.ok(lerCampo({ ...valido, campoPagina: '3' }, 2).erro, 'página inexistente');
  assert.ok(lerCampo({ ...valido, campoX: '0.8' }, 2).erro, 'caixa saindo pela direita');
  assert.ok(lerCampo({ ...valido, campoAltura: '0.001' }, 2).erro, 'caixa pequena demais');
  assert.ok(lerCampo({ ...valido, campoY: 'abc' }, 2).erro, 'valor não numérico');
});

test('código de verificação e data e hora no horário de Brasília', () => {
  assert.equal(codigoVerificacao('da5090070a48d56e66943a74148d923c9afae1cf5de807a20fff9b6f2e49b9ce'), 'DA50 9007 0A48 D56E');
  assert.equal(dataHoraBrasilia(new Date('2026-10-25T21:40:48Z')), '25/10/2026 às 18:40:48 (horário de Brasília)');
});

test('gera a cópia em página girada e com nome fora da fonte padrão, sem alterar o original', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  pdf.addPage([595, 842]).setRotation(degrees(90));
  const original = Buffer.from(await pdf.save());
  const copiaDoOriginal = Buffer.from(original);

  const copia = await gerarPdfComCaixa(original, { ...CAMPO, pagina: 2 }, {
    nome: 'Łukasz Żółć da Conceição',
    dataHora: '25/10/2026 às 18:40:48 (horário de Brasília)',
    codigo: 'DA50 9007 0A48 D56E',
  });

  const lida = await PDFDocument.load(copia);
  assert.equal(lida.getPageCount(), 2);
  assert.equal(lida.getPage(1).getRotation().angle, 90, 'a rotação da página é mantida');
  assert.ok(copia.length > original.length);
  assert.deepEqual(original, copiaDoOriginal, 'o buffer original não é modificado');

  const previa = await gerarPdfComCaixa(original, CAMPO, { nome: 'Maria', codigo: 'DA50 9007 0A48 D56E', previa: true });
  assert.equal((await PDFDocument.load(previa)).getPageCount(), 2);
});
