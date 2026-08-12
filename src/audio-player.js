'use strict';

const crypto = require('crypto');

let OpusScript = null;
let audify = null;

try {
    OpusScript = require('opusscript');
    audify = require('audify');
} catch (e) {
    // Erros de importação são tratados em init()
}

class AudioPlayer {
    constructor(onLog) {
        this.log = onLog || console.log;

        this.opusDecoder = null;
        this.rtAudio = null;
        this.isInitialized = false;

        this.debugFlags = {
            firstPacket: false,
            transportError: false,
            decryptEmpty: false,
            decryptError: false,
            decodeError: false,
            speakerError: false
        };
    }

    init() {
        if (!OpusScript || !audify) {
            this.log(
                '[Áudio-Init] ERRO: Dependências ausentes (opusscript ou audify).'
            );
            return false;
        }

        try {
            /*
             * Discord voice:
             *
             * 48000 Hz
             * 2 canais
             * 20 ms por frame
             *
             * 48000 * 0.020 = 960 samples/channel
             */
            this.opusDecoder = new OpusScript(
                48000,
                2,
                OpusScript.Application.AUDIO
            );

            this.rtAudio = new audify.RtAudio();

            this.rtAudio.openStream(
                {
                    deviceId: this.rtAudio.getDefaultOutputDevice(),
                    nChannels: 2,
                    firstChannel: 0
                },
                null,
                audify.RtAudioFormat.RTAUDIO_SINT16,
                48000,
                960,
                'DiscordBot'
            );

            this.rtAudio.start();

            this.isInitialized = true;

            this.log(
                '[Áudio-Init] Placa de som e Opus iniciados com sucesso.'
            );

            return true;
        } catch (e) {
            this.log(
                `[Áudio-Init] Falha ao iniciar hardware: ${e.message}`
            );

            return false;
        }
    }

    /**
     * Descriptografa o transporte RTP do Discord.
     *
     * Suporta:
     *
     *   aead_aes256_gcm_rtpsize
     *
     * Estrutura:
     *
     * RTP fixed header
     * CSRCs
     * RTP extension preamble (4 bytes)
     * encrypted extension + DAVE frame
     * authentication tag (16 bytes)
     * nonce/counter (4 bytes)
     *
     * IMPORTANTE:
     *
     * Apenas o RTP header + CSRCs + extension preamble
     * entram como AAD.
     *
     * O conteúdo da extensão RTP NÃO entra no AAD.
     */
    decryptAesGcmTransport(packet, secretKey) {
        if (!Buffer.isBuffer(packet)) {
            throw new Error('Pacote inválido');
        }

        if (!Buffer.isBuffer(secretKey) || secretKey.length !== 32) {
            throw new Error(
                `Secret key AES inválida (${secretKey?.length ?? 0} bytes)`
            );
        }

        if (packet.length < 12 + 16 + 4) {
            throw new Error('Pacote RTP muito pequeno');
        }

        /*
         * RTP fixed header = 12 bytes
         */
        let headerLen = 12;

        /*
         * CC = número de CSRCs
         */
        const csrcCount = packet[0] & 0x0f;

        headerLen += csrcCount * 4;

        if (packet.length < headerLen + 4 + 16 + 4) {
            throw new Error('Pacote RTP truncado');
        }

        /*
         * RTP extension
         *
         * O bit X está no bit 4 do primeiro byte.
         */
        const hasExtension = (packet[0] & 0x10) !== 0;

        let extensionDataLen = 0;

        if (hasExtension) {
            /*
             * O extension header possui:
             *
             * 2 bytes: profile
             * 2 bytes: length em words de 32 bits
             */
            if (packet.length < headerLen + 4) {
                throw new Error('RTP extension header truncado');
            }

            const extensionLengthWords =
                packet.readUInt16BE(headerLen + 2);

            extensionDataLen = extensionLengthWords * 4;

            /*
             * SOMENTE estes 4 bytes ficam no AAD.
             *
             * Não avançamos pelo conteúdo da extensão.
             */
            headerLen += 4;

            /*
             * Precisamos garantir que a extensão realmente
             * esteja dentro do ciphertext.
             */
            if (
                packet.length <
                headerLen +
                extensionDataLen +
                16 +
                4
            ) {
                throw new Error('RTP extension truncada');
            }
        }

        /*
         * O header usado como AAD.
         */
        const aad = packet.subarray(0, headerLen);

        /*
         * Últimos 4 bytes:
         *
         * nonce/counter transmitido pelo Discord.
         */
        const nonce4 = packet.subarray(packet.length - 4);

        /*
         * AES-256-GCM utiliza nonce de 12 bytes.
         *
         * Discord envia 4 bytes e completa o restante
         * com zero.
         */
        const nonce = Buffer.alloc(12);

        nonce4.copy(nonce, 0);

        /*
         * Remove nonce.
         */
        const encryptedWithTag = packet.subarray(
            headerLen,
            packet.length - 4
        );

        if (encryptedWithTag.length < 16) {
            throw new Error('Ciphertext sem authentication tag');
        }

        /*
         * AES-GCM:
         *
         * ciphertext + 16-byte authentication tag
         */
        const authTag = encryptedWithTag.subarray(
            encryptedWithTag.length - 16
        );

        const ciphertext = encryptedWithTag.subarray(
            0,
            encryptedWithTag.length - 16
        );

        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            secretKey,
            nonce
        );

        /*
         * Ordem importante:
         *
         * AAD
         * AuthTag
         * decrypt
         */
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);

        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);

        /*
         * plaintext:
         *
         * [RTP extension data]
         * [DAVE encrypted frame]
         */
        return {
            rtpHeader: aad,
            hasExtension,
            extensionDataLen,
            plaintext
        };
    }

    /**
     * Descriptografa o transporte XChaCha20-Poly1305.
     *
     * Este método fica separado porque o Discord pode negociar:
     *
     * aead_xchacha20_poly1305_rtpsize
     *
     * Caso esse modo seja negociado, o chamador deve utilizar
     * esta função em vez da AES-GCM.
     *
     * O suporte depende da API disponível na versão do Node/OpenSSL.
     */
    decryptXChaChaTransport(packet, secretKey) {
        throw new Error(
            'aead_xchacha20_poly1305_rtpsize foi negociado, ' +
            'mas XChaCha20-Poly1305 não está implementado neste AudioPlayer.'
        );
    }

    /**
     * Remove RTP padding.
     *
     * O padding é indicado pelo bit P do primeiro byte RTP.
     */
    removeRtpPadding(packet, hasPadding) {
        if (!hasPadding) {
            return packet;
        }

        if (!packet || packet.length === 0) {
            throw new Error('Payload vazio com padding RTP');
        }

        const paddingLength = packet[packet.length - 1];

        if (
            paddingLength === 0 ||
            paddingLength > packet.length
        ) {
            throw new Error(
                `Padding RTP inválido: ${paddingLength}`
            );
        }

        return packet.subarray(
            0,
            packet.length - paddingLength
        );
    }

    /**
     * Processa um pacote UDP recebido do Discord.
     *
     * Fluxo:
     *
     * UDP
     *  ↓
     * RTP
     *  ↓
     * AES-GCM
     *  ↓
     * RTP extension
     *  ↓
     * DAVE
     *  ↓
     * Opus
     *  ↓
     * PCM
     *  ↓
     * speaker
     */
    processPacket(
        msg,
        daveSession,
        isDeafened,
        ssrcMap,
        secretKey,
        encryptionMode = 'aead_aes256_gcm_rtpsize'
    ) {
        if (!Buffer.isBuffer(msg)) {
            return;
        }

        /*
         * RTP mínimo.
         */
        if (msg.length < 12) {
            return;
        }

        /*
         * Primeiro byte RTP:
         *
         * V = bits 7-6
         *
         * Versão RTP deve ser 2.
         */
        const version = msg[0] >> 6;

        if (version !== 2) {
            return;
        }

        if (
            isDeafened ||
            !daveSession ||
            !this.isInitialized ||
            !secretKey
        ) {
            return;
        }

        /*
         * Payload Type.
         *
         * Discord normalmente usa 120 para Opus.
         */
        const payloadType = msg[1] & 0x7f;

        if (payloadType !== 120) {
            return;
        }

        /*
         * SSRC = bytes 8-11.
         */
        const ssrc = msg.readUInt32BE(8);

        const userId = ssrcMap.get(ssrc);

        if (!userId) {
            return;
        }

        if (!this.debugFlags.firstPacket) {
            this.log(
                `[Áudio-Debug] (1/4) Primeiro pacote recebido ` +
                `do usuário SSRC: ${ssrc}!`
            );

            this.debugFlags.firstPacket = true;
        }

        /*
         * RTP padding.
         */
        const hasPadding = (msg[0] & 0x20) !== 0;

        try {
            /*
             * ======================================================
             * 1. TRANSPORT DECRYPTION
             * ======================================================
             */
            let transport;

            try {
                switch (encryptionMode) {
                    case 'aead_aes256_gcm_rtpsize':
                        transport =
                            this.decryptAesGcmTransport(
                                msg,
                                secretKey
                            );
                        break;

                    case 'aead_xchacha20_poly1305_rtpsize':
                        transport =
                            this.decryptXChaChaTransport(
                                msg,
                                secretKey
                            );
                        break;

                    default:
                        throw new Error(
                            `Modo de criptografia não suportado: ${encryptionMode}`
                        );
                }
            } catch (e) {
                if (!this.debugFlags.transportError) {
                    this.log(
                        `[Áudio-Debug] (1.5/4) ERRO TRANSPORTE ` +
                        `(${encryptionMode}): ${e.message}`
                    );

                    this.debugFlags.transportError = true;
                }

                return;
            }

            /*
             * ======================================================
             * 2. REMOVE RTP EXTENSION
             * ======================================================
             *
             * Depois do transporte:
             *
             * plaintext =
             *
             * [RTP extension data]
             * [DAVE frame]
             */
            let mediaPayload = transport.plaintext;

            if (transport.extensionDataLen > 0) {
                if (
                    mediaPayload.length <
                    transport.extensionDataLen
                ) {
                    throw new Error(
                        'Payload menor que RTP extension'
                    );
                }

                mediaPayload = mediaPayload.subarray(
                    transport.extensionDataLen
                );
            }

            /*
             * ======================================================
             * 3. REMOVE RTP PADDING
             * ======================================================
             */
            mediaPayload = this.removeRtpPadding(
                mediaPayload,
                hasPadding
            );

            if (!mediaPayload || mediaPayload.length === 0) {
                if (!this.debugFlags.decryptEmpty) {
                    this.log(
                        '[Áudio-Debug] (2/4) ERRO: frame DAVE vazio.'
                    );

                    this.debugFlags.decryptEmpty = true;
                }

                return;
            }

            /*
             * ======================================================
             * 4. DAVE DECRYPTION
             * ======================================================
             *
             * IMPORTANTE:
             *
             * O DAVE recebe o frame de mídia.
             *
             * Não passamos:
             *
             * - RTP header
             * - RTP extension
             * - nonce
             * - AES tag
             */
            let opusFrame;

            try {
                /*
                 * O segundo argumento representa o tipo de mídia.
                 *
                 * Para áudio:
                 *
                 * 0 = audio
                 */
                opusFrame = daveSession.decrypt(
                    userId,
                    0,
                    mediaPayload
                );

                if (
                    !opusFrame ||
                    !Buffer.isBuffer(opusFrame) ||
                    opusFrame.length === 0
                ) {
                    if (!this.debugFlags.decryptEmpty) {
                        this.log(
                            '[Áudio-Debug] (2/4) ERRO: DAVE retornou vazio.'
                        );

                        this.debugFlags.decryptEmpty = true;
                    }

                    return;
                }
            } catch (e) {
                if (!this.debugFlags.decryptError) {
                    this.log(
                        `[Áudio-Debug] (2/4) ERRO FATAL DAVE: ${e.message}`
                    );

                    this.debugFlags.decryptError = true;
                }

                return;
            }

            /*
             * ======================================================
             * 5. OPUS -> PCM
             * ======================================================
             */
            let pcmData;

            try {
                pcmData = this.opusDecoder.decode(opusFrame);

                if (!pcmData || pcmData.length === 0) {
                    if (!this.debugFlags.decodeError) {
                        this.log(
                            '[Áudio-Debug] (3/4) Opus retornou PCM vazio.'
                        );

                        this.debugFlags.decodeError = true;
                    }

                    return;
                }
            } catch (e) {
                if (!this.debugFlags.decodeError) {
                    this.log(
                        `[Áudio-Debug] (3/4) ERRO OPUS: ${e.message}`
                    );

                    this.debugFlags.decodeError = true;
                }

                return;
            }

            /*
             * ======================================================
             * 6. PCM -> SPEAKER
             * ======================================================
             */
            try {
                this.rtAudio.write(pcmData);
            } catch (e) {
                if (!this.debugFlags.speakerError) {
                    this.log(
                        `[Áudio-Debug] (4/4) ERRO HARDWARE: ${e.message}`
                    );

                    this.debugFlags.speakerError = true;
                }
            }

        } catch (err) {
            this.log(
                `[Áudio-Debug] Erro genérico inesperado: ${err.message}`
            );
        }
    }

    destroy() {
        if (this.opusDecoder) {
            try {
                this.opusDecoder.delete();
            } catch (e) {
                // Ignorado
            }

            this.opusDecoder = null;
        }

        if (this.rtAudio) {
            try {
                this.rtAudio.stop();
            } catch (e) {
                // Ignorado
            }

            try {
                this.rtAudio.closeStream();
            } catch (e) {
                // Ignorado
            }

            this.rtAudio = null;
        }

        this.isInitialized = false;

        for (const key in this.debugFlags) {
            this.debugFlags[key] = false;
        }
    }
}

module.exports = {
    AudioPlayer
};