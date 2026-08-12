'use strict';

const crypto = require('crypto');
const { OpusDecoder } = require('opus-decoder');

let audify = null;

try {
    audify = require('audify');
} catch (e) {
    // tratado no init()
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SAMPLES_PER_CHANNEL = 960;
const EXPECTED_PCM_SIZE = FRAME_SAMPLES_PER_CHANNEL * CHANNELS * 2; // 3840 bytes (Int16)

class AudioPlayer {
    constructor(onLog, onSpeaking, onAudioLevel) {
        this.log = onLog || console.log;
        this.onSpeaking = typeof onSpeaking === 'function' ? onSpeaking : null;
        this.onAudioLevel = typeof onAudioLevel === 'function' ? onAudioLevel : null;
        this.isInitialized = false;
        this.isDestroyed = false;
        this.userStreams = new Map(); // ssrc -> { decoder, rtAudio, ready, speaking, lastVoiceAt, releaseTimer }
        this._ssrcUserIds = new Map();

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
        if (!audify) {
            this.log('[Áudio-Init] ERRO: Dependência ausente (audify).');
            return false;
        }

        this.isDestroyed = false;
        this.isInitialized = true;
        this.log('[Áudio-Init] AudioPlayer pronto (usando opus-decoder WASM).');
        return true;
    }

    /**
     * Cria decoder + stream de saída para um SSRC
     */
    async _getOrCreateUserStream(ssrc) {
        if (this.isDestroyed) {
            return null;
        }

        let entry = this.userStreams.get(ssrc);
        if (entry) {
            // espera o decoder ficar pronto se ainda não estiver
            if (!entry.ready) {
                await entry.readyPromise;
            }
            return this.isDestroyed ? null : entry;
        }

        const decoder = new OpusDecoder({
            sampleRate: SAMPLE_RATE,
            channels: CHANNELS,
            // forceStereo: true // opcional
        });

        // Promise que resolve quando o WASM estiver pronto
        const readyPromise = decoder.ready.then(() => {
            entry.ready = true;
        });

        const rtAudio = new audify.RtAudio();
        rtAudio.openStream(
            {
                deviceId: rtAudio.getDefaultOutputDevice(),
                nChannels: CHANNELS,
                firstChannel: 0
            },
            null,
            audify.RtAudioFormat.RTAUDIO_SINT16,
            SAMPLE_RATE,
            FRAME_SAMPLES_PER_CHANNEL,
            `DiscordBot-${ssrc}`
        );
        rtAudio.start();

        entry = {
            decoder,
            rtAudio,
            ready: false,
            readyPromise,
            speaking: false,
            lastVoiceAt: 0,
            releaseTimer: null
        };

        this.userStreams.set(ssrc, entry);
        this.log(`[Áudio] Stream de saída criado para SSRC ${ssrc}.`);

        // espera o decoder ficar pronto na primeira vez
        await readyPromise;

        return this.isDestroyed ? null : entry;
    }

    decryptAesGcmTransport(packet, secretKey) {
        if (!Buffer.isBuffer(packet)) throw new Error('Pacote inválido');
        if (!Buffer.isBuffer(secretKey) || secretKey.length !== 32) {
            throw new Error(`Secret key AES inválida (${secretKey?.length ?? 0} bytes)`);
        }
        if (packet.length < 12 + 16 + 4) throw new Error('Pacote RTP muito pequeno');

        let headerLen = 12;
        const csrcCount = packet[0] & 0x0f;
        headerLen += csrcCount * 4;

        if (packet.length < headerLen + 4 + 16 + 4) {
            throw new Error('Pacote RTP truncado');
        }

        const hasExtension = (packet[0] & 0x10) !== 0;
        let extensionDataLen = 0;

        if (hasExtension) {
            if (packet.length < headerLen + 4) throw new Error('RTP extension header truncado');

            const extensionLengthWords = packet.readUInt16BE(headerLen + 2);
            extensionDataLen = extensionLengthWords * 4;
            headerLen += 4;

            if (packet.length < headerLen + extensionDataLen + 16 + 4) {
                throw new Error('RTP extension truncada');
            }
        }

        const aad = packet.subarray(0, headerLen);
        const nonce4 = packet.subarray(packet.length - 4);
        const nonce = Buffer.alloc(12);
        nonce4.copy(nonce, 0);

        const encryptedWithTag = packet.subarray(headerLen, packet.length - 4);
        if (encryptedWithTag.length < 16) throw new Error('Ciphertext sem authentication tag');

        const authTag = encryptedWithTag.subarray(encryptedWithTag.length - 16);
        const ciphertext = encryptedWithTag.subarray(0, encryptedWithTag.length - 16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(authTag);

        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final()
        ]);

        return {
            rtpHeader: aad,
            hasExtension,
            extensionDataLen,
            plaintext
        };
    }

    decryptXChaChaTransport() {
        throw new Error('aead_xchacha20_poly1305_rtpsize não implementado');
    }

    removeRtpPadding(packet, hasPadding) {
        if (!hasPadding) return packet;
        if (!packet || packet.length === 0) throw new Error('Payload vazio com padding RTP');

        const paddingLength = packet[packet.length - 1];
        if (paddingLength === 0 || paddingLength > packet.length) {
            throw new Error(`Padding RTP inválido: ${paddingLength}`);
        }

        return packet.subarray(0, packet.length - paddingLength);
    }

    /**
     * Converte Float32 planar → Int16 interleaved
     */
    float32ToInt16(channelData, samplesDecoded) {
        const pcm = Buffer.alloc(samplesDecoded * CHANNELS * 2);
        let offset = 0;

        for (let i = 0; i < samplesDecoded; i++) {
            for (let ch = 0; ch < CHANNELS; ch++) {
                let sample = channelData[ch][i];

                // clamp
                if (sample > 1.0) sample = 1.0;
                if (sample < -1.0) sample = -1.0;

                // Float32 → Int16
                const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
                pcm.writeInt16LE(Math.round(int16), offset);
                offset += 2;
            }
        }

        return pcm;
    }

    _updateAudioLevel(pcmData) {
        if (!this.onAudioLevel || !pcmData || pcmData.length < 4) return;

        const samples = new Int16Array(
            pcmData.buffer,
            pcmData.byteOffset,
            Math.floor(pcmData.byteLength / 2)
        );

        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
            const normalized = samples[i] / 32768;
            sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
        const db = 20 * Math.log10(Math.max(rms, 0.001));
        const level = Math.max(0, Math.min(1, (db + 60) / 60));

        try { this.onAudioLevel(level); } catch (_) { }
    }

    _updateVoiceActivity(ssrc, userId, pcmData) {
        if (!this.onSpeaking || !pcmData || pcmData.length < 4) return;

        // RMS em Int16 estéreo. O SPEAKING do Gateway indica transmissão,
        // não necessariamente que existe voz naquele instante. Para a UI
        // usamos a energia real do PCM já decodificado.
        const samples = new Int16Array(
            pcmData.buffer,
            pcmData.byteOffset,
            Math.floor(pcmData.byteLength / 2)
        );

        let sumSquares = 0;
        for (let i = 0; i < samples.length; i++) {
            const normalized = samples[i] / 32768;
            sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / samples.length);
        const threshold = 0.012; // ~ -38 dBFS
        const now = Date.now();

        let state = this.userStreams.get(ssrc);
        if (!state) return;

        if (rms >= threshold) {
            state.lastVoiceAt = now;

            if (state.releaseTimer) {
                clearTimeout(state.releaseTimer);
                state.releaseTimer = null;
            }

            if (!state.speaking) {
                state.speaking = true;
                this.onSpeaking({
                    user_id: String(userId),
                    ssrc: Number(ssrc),
                    speaking: true
                });
            }

            return;
        }

        if (!state.speaking || state.releaseTimer) return;

        // Pequena retenção para evitar piscar entre frames de voz/silêncio.
        state.releaseTimer = setTimeout(() => {
            state.releaseTimer = null;

            if (this.isDestroyed) return;

            const current = this.userStreams.get(ssrc);
            if (!current || !current.speaking) return;

            if (Date.now() - current.lastVoiceAt >= 160) {
                current.speaking = false;
                this.onSpeaking({
                    user_id: String(userId),
                    ssrc: Number(ssrc),
                    speaking: false
                });
            }
        }, 180);
    }

    async processPacket(
        msg,
        daveSession,
        isDeafened,
        ssrcMap,
        secretKey,
        encryptionMode = 'aead_aes256_gcm_rtpsize'
    ) {
        if (!Buffer.isBuffer(msg) || msg.length < 12) return;

        const version = msg[0] >> 6;
        if (version !== 2) return;

        if (isDeafened || !daveSession || !this.isInitialized || !secretKey) return;

        const payloadType = msg[1] & 0x7f;
        if (payloadType !== 120) return;

        const ssrc = msg.readUInt32BE(8);
        const userId = ssrcMap.get(ssrc);
        if (!userId) return;
        this._ssrcUserIds.set(ssrc, String(userId));

        if (!this.debugFlags.firstPacket) {
            this.log(`[Áudio-Debug] (1/4) Primeiro pacote recebido do usuário SSRC: ${ssrc}!`);
            this.debugFlags.firstPacket = true;
        }

        const hasPadding = (msg[0] & 0x20) !== 0;

        try {
            // 1. TRANSPORT DECRYPT
            let transport;
            try {
                if (encryptionMode === 'aead_aes256_gcm_rtpsize') {
                    transport = this.decryptAesGcmTransport(msg, secretKey);
                } else {
                    throw new Error(`Modo não suportado: ${encryptionMode}`);
                }
            } catch (e) {
                if (!this.debugFlags.transportError) {
                    this.log(`[Áudio-Debug] (1.5/4) ERRO TRANSPORTE: ${e.message}`);
                    this.debugFlags.transportError = true;
                }
                return;
            }

            // 2. REMOVE RTP EXTENSION
            let mediaPayload = transport.plaintext;
            if (transport.extensionDataLen > 0) {
                if (mediaPayload.length < transport.extensionDataLen) {
                    throw new Error('Payload menor que RTP extension');
                }
                mediaPayload = mediaPayload.subarray(transport.extensionDataLen);
            }

            // 3. REMOVE PADDING
            mediaPayload = this.removeRtpPadding(mediaPayload, hasPadding);
            if (!mediaPayload || mediaPayload.length === 0) {
                if (!this.debugFlags.decryptEmpty) {
                    this.log('[Áudio-Debug] (2/4) ERRO: frame DAVE vazio.');
                    this.debugFlags.decryptEmpty = true;
                }
                return;
            }

            // 4. DAVE DECRYPT
            let opusFrame;
            try {
                opusFrame = daveSession.decrypt(userId, 0, mediaPayload);

                if (!opusFrame || !Buffer.isBuffer(opusFrame) || opusFrame.length === 0) {
                    if (!this.debugFlags.decryptEmpty) {
                        this.log('[Áudio-Debug] (2/4) ERRO: DAVE retornou vazio.');
                        this.debugFlags.decryptEmpty = true;
                    }
                    return;
                }
            } catch (e) {
                if (!this.debugFlags.decryptError) {
                    this.log(`[Áudio-Debug] (2/4) ERRO FATAL DAVE: ${e.message}`);
                    this.debugFlags.decryptError = true;
                }
                return;
            }

            // Proteção de tamanho
            if (opusFrame.length < 3 || opusFrame.length > 1500) return;

            // 5. OPUS → PCM (usando opus-decoder)
            const stream = await this._getOrCreateUserStream(ssrc);
            if (!stream) return;

            const { decoder, rtAudio } = stream;

            let pcmData;
            try {
                // opus-decoder espera Uint8Array
                const result = decoder.decodeFrame(opusFrame);

                if (!result || !result.channelData || result.samplesDecoded === 0) {
                    if (!this.debugFlags.decodeError) {
                        this.log('[Áudio-Debug] (3/4) Opus retornou PCM vazio.');
                        this.debugFlags.decodeError = true;
                    }
                    return;
                }

                // Converte Float32 planar → Int16 interleaved
                pcmData = this.float32ToInt16(result.channelData, result.samplesDecoded);

                // Garante tamanho esperado (pode variar um pouco)
                if (pcmData.length > EXPECTED_PCM_SIZE) {
                    pcmData = pcmData.subarray(0, EXPECTED_PCM_SIZE);
                }
            } catch (e) {
                if (!this.debugFlags.decodeError) {
                    this.log(`[Áudio-Debug] (3/4) ERRO OPUS: ${e.message}`);
                    this.debugFlags.decodeError = true;
                }
                return;
            }

            // 6. Mede o áudio que efetivamente será reproduzido e detecta
            // atividade real de voz para a UI.
            this._updateAudioLevel(pcmData);
            this._updateVoiceActivity(ssrc, userId, pcmData);

            // 7. PCM → SPEAKER
            try {
                rtAudio.write(pcmData);
            } catch (e) {
                if (!this.debugFlags.speakerError) {
                    this.log(`[Áudio-Debug] (4/4) ERRO HARDWARE (SSRC ${ssrc}): ${e.message}`);
                    this.debugFlags.speakerError = true;
                }
            }

        } catch (err) {
            this.log(`[Áudio-Debug] Erro genérico inesperado: ${err.message}`);
        }
    }

    releaseSsrc(ssrc) {
        const entry = this.userStreams.get(ssrc);
        if (!entry) return;

        const { decoder, rtAudio } = entry;

        if (entry.releaseTimer) {
            clearTimeout(entry.releaseTimer);
            entry.releaseTimer = null;
        }

        if (this.onAudioLevel) {
            try { this.onAudioLevel(0); } catch (_) { }
        }

        if (entry.speaking && this.onSpeaking) {
            try {
                this.onSpeaking({
                    user_id: String(this._ssrcUserIds?.get?.(ssrc) || ''),
                    ssrc: Number(ssrc),
                    speaking: false
                });
            } catch (_) { }
        }

        try {
            decoder.free();
        } catch (_) { }

        try {
            rtAudio.stop();
        } catch (_) { }

        try {
            rtAudio.closeStream();
        } catch (_) { }

        this.userStreams.delete(ssrc);
        this.log(`[Áudio] Stream de saída encerrado para SSRC ${ssrc}.`);
    }

    reset() {
        for (const ssrc of Array.from(this.userStreams.keys())) {
            this.releaseSsrc(ssrc);
        }
        this.userStreams.clear();
        this._ssrcUserIds.clear();
        this.isInitialized = false;
        this.isDestroyed = false;
        for (const key in this.debugFlags) {
            this.debugFlags[key] = false;
        }
    }

    destroy() {
        this.isDestroyed = true;

        for (const ssrc of Array.from(this.userStreams.keys())) {
            this.releaseSsrc(ssrc);
        }
        this.userStreams.clear();
        this._ssrcUserIds.clear();
        this.isInitialized = false;

        for (const key in this.debugFlags) {
            this.debugFlags[key] = false;
        }
    }
}

module.exports = { AudioPlayer };
