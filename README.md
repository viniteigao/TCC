# Sistema de Assinatura Eletrônica via Link com Registro Imutável em Blockchain utilizando Smart Contracts

Trabalho de Conclusão de Curso do Bacharelado em Ciência da Computação do Centro Universitário Dinâmica das Cataratas (UDC), Foz do Iguaçu/PR, 2026.

- **Autor:** Vinícius Fosquiera Teigão
- **Orientador:** Prof. Dr. Miguel Diogenes Matrakas
- **Texto completo:** [`TCC Overleaf/TCC/TCC.pdf`](TCC%20Overleaf/TCC/TCC.pdf)

## Sobre o projeto

O remetente envia um documento em PDF, posiciona a caixa de assinatura e recebe um link único. O signatário abre o link, confirma a identidade com CPF e data de nascimento (até três tentativas), visualiza o documento e decide entre assinar e recusar, sem precisar de carteira digital, criptomoeda ou instalação de software.

Na assinatura, o sistema confere o hash SHA-256 do documento, coleta as evidências do ato e gera uma cópia com a caixa preenchida, sem alterar o original. Em seguida, a carteira da plataforma registra em um contrato inteligente na rede de testes Sepolia (Ethereum) o hash do documento e o hash das evidências. Nenhum dado pessoal é enviado à blockchain.

## Estrutura do repositório

| Pasta | Conteúdo |
|---|---|
| `TCC Overleaf/TCC/` | Texto do TCC em LaTeX (classe abnTeX2), referências, figuras, PDF compilado e fonte TikZ do diagrama de arquitetura (`fontes_diagramas/`) |
| `Sistema/src/` | *Backend* em Node.js e Express: rotas, serviços, integração com a blockchain (ethers.js) e geração da cópia assinada (pdf-lib) |
| `Sistema/public/` | Páginas do remetente e do signatário (HTML, CSS e JavaScript, com PDF.js) |
| `Sistema/contrato/` | Contrato inteligente `RegistroDocumentos.sol` (Solidity) |
| `Sistema/banco/` | Script de criação do banco de dados MySQL (`schema.sql`) |
| `Sistema/testes/` | Testes automatizados (37 casos), executados em um banco separado e, na política de registro, com rede simulada |
| `Sistema/scripts/` | Coleta de métricas de desempenho e utilitários do banco |

## Contrato implantado

| Item | Valor |
|---|---|
| Rede | Sepolia (identificador 11155111) |
| Endereço | [`0xA26De762ce93Dd07Fea5c4A362D25C683C273C81`](https://sepolia.etherscan.io/address/0xA26De762ce93Dd07Fea5c4A362D25C683C273C81) |
| Compilador | Solidity 0.8.34, sem otimização |

A função `consultarAssinatura(hashDocumento)` é pública e pode ser chamada sem custo por qualquer pessoa.

## Como executar o sistema

Requisitos: Node.js 20.11 ou superior (testado no 24) e MySQL 8.0.

```
cd Sistema
npm install
copy .env.example .env
```

No `.env`, preencha a senha do MySQL (`DB_PASSWORD`) e gere a `CHAVE_LINKS` com o comando indicado no próprio arquivo. Depois:

```
npm run db:reset
npm run dev
```

Abra http://localhost:3000 no navegador.

Sem `BLOCKCHAIN_CHAVE_PRIVADA` e `BLOCKCHAIN_CONTRATO`, o sistema funciona, mas as assinaturas ficam aguardando registro. Para ativar o registro, implante o `RegistroDocumentos.sol` na Sepolia (por exemplo, pelo Remix IDE com a MetaMask) usando uma conta só de testes, e informe no `.env` a chave privada dessa conta e o endereço do contrato. A conta que implanta o contrato é a única autorizada a registrar.

Para rodar os testes automatizados: `npm test`.

## Como compilar o texto

Na pasta `TCC Overleaf/TCC/`, com uma distribuição LaTeX que inclua o abnTeX2 (MiKTeX ou TeX Live):

```
latexmk -pdf TCC.tex
```

## O que não está no repositório

O arquivo `.env` (chaves da carteira e da cifra dos links), os dados do banco, os documentos enviados e assinados e as evidências dos testes realizados não são publicados, por conterem chaves e dados pessoais.
