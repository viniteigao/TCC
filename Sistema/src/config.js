// Configuração lida do arquivo .env (carregado pelo Node com --env-file).

import crypto from 'node:crypto';
import path from 'node:path';

function obrigatoria(nome) {
  const valor = process.env[nome];
  if (valor === undefined || valor === '') {
    throw new Error(`Variável ${nome} não definida no arquivo .env`);
  }
  return valor;
}

const porta = Number(process.env.PORTA ?? 3000);

const chaveLinks = obrigatoria('CHAVE_LINKS');
if (!/^[0-9a-fA-F]{64}$/.test(chaveLinks)) {
  throw new Error('CHAVE_LINKS deve ter 64 caracteres hexadecimais (veja .env.example)');
}

export const config = {
  porta,
  // Endereço usado para montar o link enviado ao signatário.
  baseUrl: process.env.BASE_URL ?? `http://localhost:${porta}`,
  // Sem SESSION_SECRET no .env, gera um segredo a cada início do servidor
  // (os logins ativos se perdem ao reiniciar, o que é aceitável no protótipo).
  segredoSessao: process.env.SESSION_SECRET ?? crypto.randomBytes(32).toString('hex'),
  chaveLinks: Buffer.from(chaveLinks, 'hex'),
  pastaUploads: process.env.PASTA_UPLOADS ?? path.join(import.meta.dirname, '..', 'uploads'),
  // Registro na blockchain. Sem RPC, chave ou contrato, o registro fica
  // desativado e as assinaturas aguardam até a configuração ser feita.
  blockchain: {
    rpcUrl: process.env.BLOCKCHAIN_RPC_URL ?? '',
    chavePrivada: process.env.BLOCKCHAIN_CHAVE_PRIVADA ?? '',
    contrato: process.env.BLOCKCHAIN_CONTRATO ?? '',
    explorador: process.env.BLOCKCHAIN_EXPLORADOR ?? 'https://sepolia.etherscan.io',
    // Política de reenvio: até 3 tentativas de envio, cada uma esperando a
    // inclusão em bloco por até "esperaSegundos".
    maximoTentativas: 3,
    esperaSegundos: Number(process.env.BLOCKCHAIN_ESPERA_SEGUNDOS ?? 90),
    confirmacoes: Number(process.env.BLOCKCHAIN_CONFIRMACOES ?? 1),
  },
  tamanhoMaximoPdf: 10 * 1024 * 1024,
  db: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: obrigatoria('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'assinatura_eletronica',
  },
};
