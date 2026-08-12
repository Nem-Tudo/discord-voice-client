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

/*
 * Discord voice:
 *
 * 48000 Hz
 * 2 canais
 * 20 ms por frame
 *
 * 48000 * 0.020 = 960 samples/channel
 */
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES = 960; // por canal
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2; // int16 = 2 bytes
/*
 * Janela de mixagem orientada a EVENTO (não a um relógio próprio).
 *
 * Quando o primeiro frame decodificado de um "ciclo" chega, abrimos
 * uma janela curtíssima (poucos ms) para dar tempo de outros
 * usuários que estejam falando ao mesmo tempo entregarem o frame
 * deles também, e então escrevemos UM frame combinado.
 *
 * Isso é diferente de um setInterval: não existe um "relógio" de
 * fundo rodando independente da chegada real dos pacotes. Sem
 * isso, o timer podia dessincronizar do ritmo real de chegada dos
 * pacotes RTP (drift do event loop do Node) e causar faltas de
 * dados (underrun) na saída de áudio — o que soa robótico mesmo
 * com um único usuário falando.
 */
const MIX_WINDOW_MS = 3;

/*
 * Tamanho máximo de um frame Opus válido (RFC 6716): 1275 bytes.
 *
 * Um "frame" maior que isso não é Opus válido — decodificá-lo
 * pode derrubar o decoder (abort interno do WASM), então
 * descartamos antes de chegar perto do decoder.
 */
const MAX_OPUS_FRAME_BYTES = 1275;

/*
 * Quantos frames extras por usuário podem ficar em espera para a
 * PRÓXIMA janela de mixagem, caso dois frames do mesmo usuário
 * cheguem antes da janela atual fechar.
 */
const MAX_QUEUE_FRAMES = 3;

class AudioPlayer {
    constructor(onLog) {
        this.log = onLog || console.log;

        // Antes: um único decoder para TODOS os usuários.
        // Isso corrompia o estado interno do Opus quando
        // pacotes de SSRCs diferentes chegavam intercalados
        // (ex.: duas pessoas falando ao mesmo tempo), gerando
        // áudio robótico/metálico.
        //
        // Agora: um decoder por SSRC, criado sob demanda.
        this.opusDecoders = new Map(); // ssrc -> OpusScript

        // Fila de frames PCM que chegaram enquanto uma janela de
        // mixagem já estava em andamento para aquele SSRC (ou seja,
        // o "próximo" frame daquele usuário, que entra na próxima
        // janela).
        this.userQueues = new Map(); // ssrc -> Buffer[]

        // Janela de mixagem atual em andamento (ou null se nenhuma).
        // { buffer, contributors: Set<ssrc>, timer }
        this.pendingMix = null;

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
            this.rtAudio = new audify.RtAudio();

            this.rtAudio.openStream(
                {
                    deviceId: this.rtAudio.getDefaultOutputDevice(),
                    nChannels: CHANNELS,
                    firstChannel: 0
                },
                null,
                audify.RtAudioFormat.RTAUDIO_SINT16,
                SAMPLE_RATE,
                FRAME_SAMPLES,
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
     * Retorna (criando se necessário) o decoder Opus dedicado
     * a um SSRC específico.
     *
     * Cada usuário tem seu próprio encoder Opus do lado dele,
     * então cada um precisa de seu próprio decoder deste lado
     * para preservar o estado de predição/continuidade entre
     * frames consecutivos daquele mesmo usuário.
     */
    _getDecoderForSsrc(ssrc) {
        let decoder = this.opusDecoders.get(ssrc);

        if (!decoder) {
            decoder = new OpusScript(
                SAMPLE_RATE,
                CHANNELS,
                OpusScript.Application.AUDIO
            );

            this.opusDecoders.set(ssrc, decoder);
        }

        return decoder;
    }

    /**
     * Remove o decoder e a fila associados a um SSRC.
     *
     * Deve ser chamado quando um usuário sai do canal de voz
     * (ex.: CLIENT_DISCONNECT), para não vazar decoders/memória
     * e para não deixar frames "fantasmas" na fila do mixer.
     */
    releaseSsrc(ssrc) {
        const decoder = this.opusDecoders.get(ssrc);

        if (decoder) {
            try {
                decoder.delete();
            } catch (e) {
                // Ignorado
            }

            this.opusDecoders.delete(ssrc);
        }

        this.userQueues.delete(ssrc);
    }

    /**
     * Soma (mixa) `src` dentro de `dst`, amostra a amostra, com
     * clipping em int16. Só mixa se os tamanhos baterem com o
     * frame esperado (960 samples/canal, 2 canais) — caso
     * contrário ignora com segurança em vez de corromper o buffer.
     */
    _sumInto(dst, src) {
        if (
            !src ||
            src.length !== FRAME_BYTES ||
            dst.length !== FRAME_BYTES
        ) {
            return;
        }

        for (let i = 0; i < FRAME_BYTES; i += 2) {
            const a = dst.readInt16LE(i);
            const b = src.readInt16LE(i);

            let sum = a + b;

            if (sum > 32767) {
                sum = 32767;
            } else if (sum < -32768) {
                sum = -32768;
            }

            dst.writeInt16LE(sum, i);
        }
    }

    /**
     * Entrega um frame PCM recém-decodificado de um SSRC para a
     * mixagem.
     *
     * Não existe um "relógio" de fundo aqui: a primeira chamada
     * depois que a janela anterior fechou abre uma nova janela
     * curtíssima (MIX_WINDOW_MS) e agenda o flush dela. Qualquer
     * outro usuário que decodificar um frame ENQUANTO essa janela
     * está aberta é somado ao mesmo buffer. Isso segue o ritmo
     * real de chegada dos pacotes em vez de brigar com ele.
     */
    _queueFrameForMix(ssrc, frame) {
        if (frame.length !== FRAME_BYTES) {
            // Frame de tamanho inesperado (ex.: FEC/DTX). Ignora
            // com segurança em vez de corromper a mixagem.
            return;
        }

        if (!this.pendingMix) {
            this.pendingMix = {
                buffer: Buffer.from(frame),
                contributors: new Set([ssrc]),
                timer: setTimeout(
                    () => this._flushMix(),
                    MIX_WINDOW_MS
                )
            };

            return;
        }

        if (this.pendingMix.contributors.has(ssrc)) {
            // Este usuário já contribuiu para a janela atual;
            // este frame é o PRÓXIMO dele, guarda para depois
            // do flush em vez de perder ou misturar na janela errada.
            let queue = this.userQueues.get(ssrc);

            if (!queue) {
                queue = [];
                this.userQueues.set(ssrc, queue);
            }

            queue.push(frame);

            while (queue.length > MAX_QUEUE_FRAMES) {
                queue.shift();
            }

            return;
        }

        this._sumInto(this.pendingMix.buffer, frame);
        this.pendingMix.contributors.add(ssrc);
    }

    /**
     * Fecha a janela de mixagem atual, escreve o frame combinado
     * na saída de áudio, e imediatamente abre a próxima janela
     * caso já existam frames de usuários esperando (evita perder
     * cadência quando duas pessoas falam continuamente).
     */
    _flushMix() {
        const mix = this.pendingMix;

        this.pendingMix = null;

        if (!mix) {
            return;
        }

        if (this.rtAudio) {
            try {
                this.rtAudio.write(mix.buffer);
            } catch (e) {
                if (!this.debugFlags.speakerError) {
                    this.log(
                        `[Áudio-Debug] (4/4) ERRO HARDWARE: ${e.message}`
                    );

                    this.debugFlags.speakerError = true;
                }
            }
        }

        for (const [ssrc, queue] of this.userQueues) {
            if (queue.length > 0) {
                const next = queue.shift();

                this._queueFrameForMix(ssrc, next);
            }
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
     * Opus (decoder por SSRC)
     *  ↓
     * PCM -> fila do usuário
     *  ↓
     * mixer (a cada 20ms) -> speaker
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
             *
             * Usa o decoder DEDICADO deste SSRC, não um decoder
             * global compartilhado entre todos os usuários. Isso
             * é o que evita o áudio robótico quando duas ou mais
             * pessoas falam ao mesmo tempo.
             */

            /*
             * Um frame Opus válido tem no máximo 1275 bytes
             * (RFC 6716). Se o DAVE devolveu algo maior — por
             * exemplo, dado corrompido durante uma transição de
             * chave em andamento — não passamos isso pro decoder:
             * o decoder Opus (WASM) pode sofrer um abort interno
             * IRREVERSÍVEL ao receber dado malformado, o que trava
             * o processo inteiro, não só aquele pacote.
             */
            if (
                opusFrame.length === 0 ||
                opusFrame.length > MAX_OPUS_FRAME_BYTES
            ) {
                if (!this.debugFlags.decodeError) {
                    this.log(
                        `[Áudio-Debug] (3/4) Frame Opus com tamanho ` +
                        `inválido (${opusFrame.length} bytes), descartado.`
                    );

                    this.debugFlags.decodeError = true;
                }

                return;
            }

            let pcmData;

            try {
                const decoder = this._getDecoderForSsrc(ssrc);

                pcmData = decoder.decode(opusFrame);

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

                /*
                 * A instância do decoder pode ter ficado num estado
                 * inconsistente/corrompido internamente após esse
                 * erro (comum em bindings WASM após um abort).
                 * Descartamos e deixamos uma nova ser criada no
                 * próximo pacote deste SSRC, em vez de continuar
                 * usando um decoder potencialmente quebrado.
                 */
                this.releaseSsrc(ssrc);

                return;
            }

            /*
             * ======================================================
             * 6. PCM -> MIXAGEM (orientada a evento) -> SPEAKER
             * ======================================================
             */
            this._queueFrameForMix(ssrc, pcmData);

        } catch (err) {
            this.log(
                `[Áudio-Debug] Erro genérico inesperado: ${err.message}`
            );
        }
    }

    destroy() {
        if (this.pendingMix) {
            clearTimeout(this.pendingMix.timer);
            this.pendingMix = null;
        }

        for (const decoder of this.opusDecoders.values()) {
            try {
                decoder.delete();
            } catch (e) {
                // Ignorado
            }
        }

        this.opusDecoders.clear();
        this.userQueues.clear();

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