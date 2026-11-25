// Recria o banco a partir de banco/schema.sql e apaga os PDFs enviados.
// Uso: npm run db:reset   (APAGA todos os dados; somente para desenvolvimento)

import { recriarBanco } from '../src/manutencao.js';

const banco = await recriarBanco();
console.log(`Banco "${banco}" recriado e pasta de uploads limpa.`);
