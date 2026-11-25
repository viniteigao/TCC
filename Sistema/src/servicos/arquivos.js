// Entrega de PDFs ao navegador.

import path from 'node:path';
import { config } from '../config.js';

function cabecalhosPdf(res, nomeArquivo) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(nomeArquivo)}`,
    'Cache-Control': 'no-store',
  });
}

// Envia um PDF guardado na pasta de uploads. O original é enviado sem
// nenhuma alteração: é o mesmo arquivo cujo hash foi registrado na blockchain.
export function enviarPdf(res, caminhoArquivo, nomeArquivo) {
  cabecalhosPdf(res, nomeArquivo);
  res.sendFile(path.join(config.pastaUploads, caminhoArquivo));
}

// Envia um PDF gerado na hora (ex.: prévia da caixa de assinatura).
export function enviarPdfGerado(res, conteudo, nomeArquivo) {
  cabecalhosPdf(res, nomeArquivo);
  res.send(conteudo);
}
