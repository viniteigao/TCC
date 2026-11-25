// Funções criptográficas usadas pelo sistema (módulo crypto nativo do Node).

import crypto from 'node:crypto';

// SHA-256 em hexadecimal (64 caracteres), de um Buffer ou texto.
export function sha256(dados) {
  return crypto.createHash('sha256').update(dados).digest('hex');
}

// Token do link: 32 bytes aleatórios (256 bits), seguro para usar na URL.
export function gerarToken() {
  return crypto.randomBytes(32).toString('base64url');
}
