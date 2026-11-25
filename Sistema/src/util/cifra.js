// Cifragem simétrica AES-256-GCM dos tokens dos links (chave CHAVE_LINKS do .env).
// O GCM também autentica o conteúdo: um valor adulterado no banco não é aceito.
// Formato armazenado: iv.tag.dados (cada parte em base64url).

import crypto from 'node:crypto';
import { config } from '../config.js';

export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', config.chaveLinks, iv);
  const dados = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  return [iv, cifrador.getAuthTag(), dados].map((parte) => parte.toString('base64url')).join('.');
}

export function decifrar(valor) {
  const [iv, tag, dados] = valor.split('.').map((parte) => Buffer.from(parte, 'base64url'));
  const decifrador = crypto.createDecipheriv('aes-256-gcm', config.chaveLinks, iv);
  decifrador.setAuthTag(tag);
  return Buffer.concat([decifrador.update(dados), decifrador.final()]).toString('utf8');
}
