// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RegistroDocumentos
/// @notice Registro imutável de assinaturas eletrônicas. Para cada documento,
///         guarda o hash SHA-256 do documento e o hash SHA-256 das evidências
///         da assinatura. Nenhum dado pessoal é gravado na blockchain.
/// @dev Somente a carteira da plataforma (dono) pode registrar; a consulta é
///      pública. Há um único registro por documento (trava de duplicidade).
contract RegistroDocumentos {
    struct Registro {
        bytes32 hashEvidencias;
        uint64 dataRegistro; // block.timestamp (segundos desde 01/01/1970)
        uint64 numeroBloco;
    }

    /// @notice Carteira da plataforma, que envia e paga as transações de registro.
    address public immutable dono;

    /// @dev hash do documento => registro da assinatura.
    mapping(bytes32 => Registro) private registros;

    /// @notice Emitido a cada registro; permite acompanhar os registros em
    ///         exploradores de blocos, como o Etherscan.
    event AssinaturaRegistrada(bytes32 indexed hashDocumento, bytes32 hashEvidencias, uint256 dataRegistro);

    error SomenteDono();
    error HashInvalido();
    error DocumentoJaRegistrado(bytes32 hashDocumento);

    constructor() {
        dono = msg.sender;
    }

    /// @notice Registra a assinatura de um documento.
    /// @param hashDocumento SHA-256 do documento (calculado no upload e conferido na assinatura).
    /// @param hashEvidencias SHA-256 das evidências coletadas na assinatura.
    function registrarAssinatura(bytes32 hashDocumento, bytes32 hashEvidencias) external {
        if (msg.sender != dono) revert SomenteDono();
        if (hashDocumento == bytes32(0) || hashEvidencias == bytes32(0)) revert HashInvalido();
        if (registros[hashDocumento].dataRegistro != 0) revert DocumentoJaRegistrado(hashDocumento);

        registros[hashDocumento] = Registro({
            hashEvidencias: hashEvidencias,
            dataRegistro: uint64(block.timestamp),
            numeroBloco: uint64(block.number)
        });
        emit AssinaturaRegistrada(hashDocumento, hashEvidencias, block.timestamp);
    }

    /// @notice Consulta o registro de um documento (aberta a qualquer pessoa).
    /// @param hashDocumento SHA-256 do documento.
    /// @return registrado Verdadeiro se o documento já foi registrado.
    /// @return hashEvidencias Hash das evidências gravado no registro.
    /// @return dataRegistro Data e hora do registro (timestamp do bloco).
    /// @return numeroBloco Número do bloco em que o registro foi incluído.
    function consultarAssinatura(bytes32 hashDocumento)
        external
        view
        returns (bool registrado, bytes32 hashEvidencias, uint256 dataRegistro, uint256 numeroBloco)
    {
        Registro memory registro = registros[hashDocumento];
        return (registro.dataRegistro != 0, registro.hashEvidencias, registro.dataRegistro, registro.numeroBloco);
    }
}
