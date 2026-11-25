// Ponto de entrada do backend (Node.js + Express).

import { app } from './app.js';
import { config } from './config.js';
import { iniciarBlockchain } from './blockchain/registro.js';

app.listen(config.porta, () => {
  console.log(`Servidor rodando em http://localhost:${config.porta}`);
});

await iniciarBlockchain();
