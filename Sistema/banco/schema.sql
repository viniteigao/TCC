-- =====================================================================
-- Banco de dados off-chain do Sistema de Assinatura Eletrônica via Link
-- com Registro Imutável em Blockchain utilizando Smart Contracts (TCC).
--
-- SGBD: MySQL 8.0+
--
-- Estrutura alinhada ao diagrama de classes do TCC:
--   usuario          -> classe Usuário (solicitante ou signatário)
--   documento        -> classe Documento
--   link_assinatura  -> classe LinkAssinatura (1:1 com documento)
--   assinatura       -> classe Assinatura (0..1 por link)
--   log_auditoria    -> trilha de eventos para rastreabilidade
--
-- Dados pessoais (CPF, data de nascimento, IP, navegador) ficam somente
-- aqui. Para a blockchain vão apenas o hash do documento e o hash das
-- evidências.
--
-- ATENÇÃO: este script recria o banco assinatura_eletronica do zero e
-- APAGA os dados existentes nele. Use apenas em desenvolvimento.
-- =====================================================================
DROP DATABASE IF EXISTS assinatura_eletronica;

CREATE DATABASE assinatura_eletronica
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE assinatura_eletronica;

-- ---------------------------------------------------------------------
-- usuario
-- Solicitante: possui login (email + senha_hash).
-- Signatário: não possui login; é cadastrado pelo solicitante no upload,
-- com nome, e-mail, CPF e data de nascimento (valores esperados na
-- verificação de identidade que antecede a abertura do documento).
-- ---------------------------------------------------------------------
CREATE TABLE usuario (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tipo                ENUM('solicitante', 'signatario') NOT NULL,
    nome                VARCHAR(150)    NOT NULL,
    email               VARCHAR(150)    NOT NULL,
    senha_hash          VARCHAR(255)    NULL COMMENT 'bcrypt; somente solicitante',
    cpf                 CHAR(11)        NULL COMMENT 'Somente dígitos; somente signatário',
    data_nascimento     DATE            NULL COMMENT 'Somente signatário',
    data_criacao        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- E-mail único apenas entre solicitantes (coluna gerada fica NULL
    -- para signatários, e o índice UNIQUE aceita vários NULL).
    email_solicitante   VARCHAR(150)
        AS (IF(tipo = 'solicitante', email, NULL)) STORED,
    CONSTRAINT uq_usuario_email_solicitante UNIQUE (email_solicitante),
    CONSTRAINT ck_usuario_solicitante
        CHECK (tipo <> 'solicitante' OR senha_hash IS NOT NULL),
    CONSTRAINT ck_usuario_signatario
        CHECK (tipo <> 'signatario' OR (cpf IS NOT NULL AND data_nascimento IS NOT NULL))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- documento
-- O arquivo fica no disco do servidor (fora da cadeia); aqui ficam o
-- caminho e o hash SHA-256 calculado no upload, recalculado e comparado
-- no momento da assinatura.
-- ---------------------------------------------------------------------
CREATE TABLE documento (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    solicitante_id      INT UNSIGNED    NOT NULL,
    nome_arquivo        VARCHAR(255)    NOT NULL COMMENT 'Nome original enviado',
    caminho_arquivo     VARCHAR(500)    NOT NULL COMMENT 'Caminho no armazenamento off-chain',
    tamanho_bytes       INT UNSIGNED    NOT NULL,
    hash_documento      CHAR(64)        NOT NULL COMMENT 'SHA-256 em hexadecimal',
    -- Caixa de assinatura escolhida pelo solicitante, em frações da página
    -- exibida (0 a 1, origem no canto superior esquerdo).
    campo_pagina        SMALLINT UNSIGNED NULL COMMENT 'Página da caixa de assinatura (1 = primeira)',
    campo_x             DECIMAL(7,6)    NULL,
    campo_y             DECIMAL(7,6)    NULL,
    campo_largura       DECIMAL(7,6)    NULL,
    campo_altura        DECIMAL(7,6)    NULL,
    data_upload         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_documento_solicitante FOREIGN KEY (solicitante_id)
        REFERENCES usuario (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    INDEX idx_documento_hash (hash_documento)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- link_assinatura
-- Um link por documento (1:1) e um signatário por documento.
-- O token aparece somente na URL enviada ao signatário. No banco ficam o
-- seu hash SHA-256 (usado para localizar o link) e uma cópia cifrada com
-- AES-256-GCM, cuja chave fica fora do banco (.env), para que o
-- solicitante possa copiar o link novamente. Um vazamento apenas do banco
-- não expõe links válidos.
-- Status segue o diagrama de estados (ciclo de vida do link).
-- ---------------------------------------------------------------------
CREATE TABLE link_assinatura (
    id                          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    documento_id                INT UNSIGNED    NOT NULL,
    signatario_id               INT UNSIGNED    NOT NULL,
    token_hash                  CHAR(64)        NOT NULL COMMENT 'SHA-256 do token da URL',
    token_cifrado               VARCHAR(255)    NOT NULL COMMENT 'Token cifrado com AES-256-GCM (chave no .env), para reexibir o link ao solicitante',
    status                      ENUM('criado', 'pendente', 'assinado',
                                     'recusado', 'expirado', 'bloqueado')
                                                NOT NULL DEFAULT 'criado',
    tentativas_identificacao    TINYINT UNSIGNED NOT NULL DEFAULT 0
                                    COMMENT 'Tentativas de CPF/data de nascimento sem sucesso (máximo 3)',
    versao_dados                SMALLINT UNSIGNED NOT NULL DEFAULT 0
                                    COMMENT 'Incrementada a cada edição; invalida identificações feitas com dados antigos',
    identidade_confirmada_em    DATETIME        NULL,
    data_criacao                DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    data_expiracao              DATETIME        NOT NULL,
    data_decisao                DATETIME        NULL COMMENT 'Momento em que chegou a um estado final',
    CONSTRAINT uq_link_documento UNIQUE (documento_id),
    CONSTRAINT uq_link_token UNIQUE (token_hash),
    CONSTRAINT fk_link_documento FOREIGN KEY (documento_id)
        REFERENCES documento (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_link_signatario FOREIGN KEY (signatario_id)
        REFERENCES usuario (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_link_tentativas CHECK (tentativas_identificacao <= 3),
    INDEX idx_link_status (status)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- assinatura
-- Criada somente quando o signatário confirma e o hash confere.
-- Guarda as evidências, o hash das evidências e a situação do registro
-- na blockchain (diagrama de estados, ciclo b).
-- ---------------------------------------------------------------------
CREATE TABLE assinatura (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    link_id             INT UNSIGNED    NOT NULL,
    signatario_id       INT UNSIGNED    NOT NULL,
    data_assinatura     DATETIME(3)     NOT NULL COMMENT 'Data/hora da assinatura (evidência)',
    hash_documento      CHAR(64)        NOT NULL,
    identidade_confirmada TINYINT(1)    NOT NULL,
    endereco_ip         VARCHAR(45)     NOT NULL,
    navegador           VARCHAR(500)    NOT NULL,
    aceite_explicito    TINYINT(1)      NOT NULL,
    evidencias          TEXT            NOT NULL COMMENT 'Evidências serializadas (JSON) exatamente como usadas no hash_evidencias',
    hash_evidencias     CHAR(64)        NOT NULL COMMENT 'SHA-256 das evidências serializadas',
    -- Cópia do PDF com a caixa preenchida (o original não é alterado).
    arquivo_assinado    VARCHAR(500)    NULL COMMENT 'Cópia do PDF com a caixa de assinatura preenchida',
    hash_arquivo_assinado CHAR(64)      NULL COMMENT 'SHA-256 da cópia assinada (também incluído nas evidências)',
    -- Registro on-chain
    status_blockchain   ENUM('aguardando_registro', 'confirmada', 'falha')
                                        NOT NULL DEFAULT 'aguardando_registro',
    tx_hash             CHAR(66)        NULL COMMENT 'Hash da última transação enviada (0x + 64 hex)',
    tentativas_envio    TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Máximo 3',
    numero_bloco        BIGINT UNSIGNED NULL,
    gas_usado           BIGINT UNSIGNED NULL,
    custo_wei           DECIMAL(30,0)   NULL,
    data_envio_tx       DATETIME(3)     NULL COMMENT 'Primeiro envio (métrica de tempo de confirmação)',
    data_confirmacao    DATETIME(3)     NULL,
    erro_blockchain     TEXT            NULL,
    CONSTRAINT uq_assinatura_link UNIQUE (link_id),
    CONSTRAINT fk_assinatura_link FOREIGN KEY (link_id)
        REFERENCES link_assinatura (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_assinatura_signatario FOREIGN KEY (signatario_id)
        REFERENCES usuario (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ck_assinatura_tentativas CHECK (tentativas_envio <= 3),
    INDEX idx_assinatura_status_blockchain (status_blockchain)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- log_auditoria
-- Trilha append-only dos eventos do processo (upload, acesso ao link,
-- falha de identificação, bloqueio, visualização, assinatura, recusa,
-- envio/confirmação/falha da transação).
-- ---------------------------------------------------------------------
CREATE TABLE log_auditoria (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    documento_id        INT UNSIGNED    NULL,
    usuario_id          INT UNSIGNED    NULL,
    evento              VARCHAR(60)     NOT NULL,
    detalhes            JSON            NULL,
    endereco_ip         VARCHAR(45)     NULL,
    data_hora           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_log_documento FOREIGN KEY (documento_id)
        REFERENCES documento (id) ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT fk_log_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuario (id) ON UPDATE CASCADE ON DELETE SET NULL,
    INDEX idx_log_documento (documento_id),
    INDEX idx_log_data (data_hora)
) ENGINE=InnoDB;
