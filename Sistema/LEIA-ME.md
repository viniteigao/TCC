# Sistema de Assinatura Eletrônica via Link

Protótipo do TCC "Sistema de Assinatura Eletrônica via Link com Registro Imutável em Blockchain utilizando Smart Contracts".

## O que é preciso instalar

1. **Node.js 24 (LTS)**: https://nodejs.org (instalação padrão).
2. **MySQL Server 8.0 e MySQL Workbench**: https://dev.mysql.com/downloads/installer (escolha a instalação com servidor e Workbench). Anote a senha do usuário `root` definida durante a instalação.
3. **Internet**, para o registro das assinaturas na rede Sepolia.

O contrato inteligente já está implantado na Sepolia (endereço em `BLOCKCHAIN_CONTRATO` no `.env`). Não é preciso fazer deploy de novo nem abrir o Remix ou a MetaMask para o sistema funcionar.

## Levar o sistema para outro computador

1. No computador de origem, atualize a cópia do banco:

   ```
   npm run db:exportar
   ```

2. Copie a pasta `Sistema` inteira (pen drive ou nuvem privada). A pasta `node_modules` pode ficar de fora. É importante levar:
   - `.env` (configurações e chaves; **não compartilhe nem publique**);
   - `uploads/` (PDFs enviados);
   - `banco/dados_assinatura_eletronica.sql` (cópia do banco).

3. No computador de destino, abra um terminal na pasta `Sistema` e instale as dependências:

   ```
   npm install
   ```

4. No `.env`, altere `DB_PASSWORD` para a senha do MySQL desse computador (e `DB_USER`, se não for `root`). Não altere `CHAVE_LINKS` nem as variáveis `BLOCKCHAIN_*`.

5. Importe o banco com os documentos e as assinaturas já feitos:

   ```
   npm run db:importar
   ```

   Também é possível importar pelo MySQL Workbench: **Server → Data Import → Import from Self-Contained File**, com o arquivo `banco/dados_assinatura_eletronica.sql`. Para começar com o banco vazio, use `npm run db:reset`.

6. Inicie o sistema:

   ```
   npm run dev
   ```

   O terminal deve mostrar `Servidor rodando em http://localhost:3000` e `Blockchain ativa: rede sepolia, ...`. Abra http://localhost:3000 no navegador.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Inicia o servidor e reinicia sozinho a cada alteração no código |
| `npm start` | Inicia o servidor |
| `npm test` | Executa os testes automatizados (em um banco de teste separado) |
| `npm run db:reset` | Recria o banco vazio e apaga os PDFs enviados |
| `npm run db:exportar` | Gera `banco/dados_assinatura_eletronica.sql` com a estrutura e os dados |
| `npm run db:importar` | Importa `banco/dados_assinatura_eletronica.sql` no banco configurado no `.env` |
| `npm run metricas` | Coleta as métricas do Capítulo 3.4 em um banco separado (`assinatura_eletronica_metricas`); envia registros reais à Sepolia, então o servidor principal precisa estar desligado. Resultados em `../Testes/metricas` |

## Cuidados

- **Não rode o sistema em dois computadores ao mesmo tempo.** Os dois usariam a mesma carteira da plataforma, e as transações enviadas à blockchain poderiam entrar em conflito.
- **O `.env` guarda a chave da carteira de testes e a chave que cifra os links.** Copie por pen drive ou nuvem privada, nunca para repositórios públicos.
- Se o terminal mostrar `Blockchain desativada`, a mensagem explica o motivo (sem internet, chave ou contrato incorretos). As assinaturas feitas nesse período ficam aguardando e são registradas quando o servidor for iniciado com a blockchain ativa.
- Para conferir a situação a qualquer momento: http://localhost:3000/api/saude.
