// Acesso ao contrato RegistroDocumentos pela biblioteca ethers.js (v6).
//
// Os erros da rede são traduzidos para as categorias da política de reenvio:
//   transitoria     -> vale tentar de novo (provedor fora do ar, taxa baixa...)
//   deterministica  -> repetir não muda o resultado (reversão, saldo insuficiente)
//   ja_registrado   -> o contrato já tem o hash (a consulta seguinte decide)

import { ethers } from 'ethers';

// Interface do contrato (mesmas funções, evento e erros do RegistroDocumentos.sol).
export const ABI = [
  'function registrarAssinatura(bytes32 hashDocumento, bytes32 hashEvidencias)',
  'function consultarAssinatura(bytes32 hashDocumento) view returns (bool registrado, bytes32 hashEvidencias, uint256 dataRegistro, uint256 numeroBloco)',
  'function dono() view returns (address)',
  'event AssinaturaRegistrada(bytes32 indexed hashDocumento, bytes32 hashEvidencias, uint256 dataRegistro)',
  'error SomenteDono()',
  'error HashInvalido()',
  'error DocumentoJaRegistrado(bytes32 hashDocumento)',
];

const MENSAGENS_REVERSAO = {
  SomenteDono: 'A carteira configurada não é a dona do contrato.',
  HashInvalido: 'Hash inválido enviado ao contrato.',
};

export function classificarErro(erro) {
  if (erro.code === 'INSUFFICIENT_FUNDS') {
    return { tipo: 'deterministica', mensagem: 'Saldo insuficiente na carteira da plataforma para pagar o gas.' };
  }
  if (erro.code === 'CALL_EXCEPTION') {
    const nome = erro.revert?.name;
    if (nome === 'DocumentoJaRegistrado') {
      return { tipo: 'ja_registrado', mensagem: 'O contrato já possui registro deste documento.' };
    }
    return { tipo: 'deterministica', mensagem: MENSAGENS_REVERSAO[nome] ?? 'Transação revertida pelo contrato.' };
  }
  return { tipo: 'transitoria', mensagem: erro.shortMessage ?? erro.message };
}

// Descobre a rede (chainId) uma única vez, para o ethers não ficar
// consultando o provedor em segundo plano.
async function detectarRede(rpcUrl) {
  try {
    const resposta = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    const { result } = await resposta.json();
    return ethers.Network.from(BigInt(result));
  } catch (erro) {
    throw new Error(`Não foi possível acessar o RPC ${rpcUrl} (${erro.message}).`);
  }
}

function resumirRecibo(recibo) {
  return {
    hash: recibo.hash,
    status: recibo.status,
    numeroBloco: recibo.blockNumber,
    gasUsado: recibo.gasUsed,
    precoGas: recibo.gasPrice,
  };
}

export async function criarClienteEthers({ rpcUrl, chavePrivada, contrato: endereco, confirmacoes }) {
  const rede = await detectarRede(rpcUrl);
  const provedor = new ethers.JsonRpcProvider(rpcUrl, rede, { staticNetwork: rede });
  const carteira = new ethers.Wallet(chavePrivada.startsWith('0x') ? chavePrivada : `0x${chavePrivada}`, provedor);
  const contrato = new ethers.Contract(ethers.getAddress(endereco), ABI, carteira);

  return {
    async verificar() {
      const [dono, saldoWei, codigo] = await Promise.all([
        contrato.dono().catch(() => null),
        provedor.getBalance(carteira.address),
        provedor.getCode(contrato.target),
      ]);
      return {
        rede: rede.name,
        chainId: Number(rede.chainId),
        carteira: carteira.address,
        contrato: contrato.target,
        dono,
        saldoWei,
        temCodigo: codigo !== '0x',
      };
    },

    async consultar(hashDocumento) {
      const registro = await contrato.consultarAssinatura(hashDocumento);
      return {
        registrado: registro.registrado,
        hashEvidencias: registro.hashEvidencias,
        numeroBloco: Number(registro.numeroBloco),
      };
    },

    proximoNonce() {
      return provedor.getTransactionCount(carteira.address, 'pending');
    },

    async transacao(hash) {
      const tx = await provedor.getTransaction(hash);
      return tx && { nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas };
    },

    async taxas() {
      const dados = await provedor.getFeeData();
      return { maxFeePerGas: dados.maxFeePerGas, maxPriorityFeePerGas: dados.maxPriorityFeePerGas };
    },

    async enviar(hashDocumento, hashEvidencias, opcoes) {
      try {
        const tx = await contrato.registrarAssinatura(hashDocumento, hashEvidencias, opcoes);
        return { hash: tx.hash };
      } catch (erro) {
        throw classificarErro(erro);
      }
    },

    // Recibo da transação, somente depois do número de confirmações exigido.
    async recibo(hash) {
      const recibo = await provedor.getTransactionReceipt(hash);
      if (!recibo || (await recibo.confirmations()) < confirmacoes) return null;
      return resumirRecibo(recibo);
    },

    // Recibo da transação que gravou o registro, achado pelo evento no bloco
    // informado pelo contrato (útil quando o servidor reiniciou no meio).
    async reciboDoRegistro(hashDocumento, numeroBloco) {
      const eventos = await contrato.queryFilter(contrato.filters.AssinaturaRegistrada(hashDocumento), numeroBloco, numeroBloco);
      if (eventos.length === 0) return null;
      const recibo = await provedor.getTransactionReceipt(eventos[0].transactionHash);
      return recibo && resumirRecibo(recibo);
    },
  };
}
