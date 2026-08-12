'use strict';

const crypto = require('crypto');

let audify = null;
try {
    audify = require('audify');
} catch (e) { }

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20 ms
const BITRATE = 64000;

class AudioSender {
    constructor(log) {
        this.log = log || console.log;
        this.isInitialized = false;
        this.isDestroyed = false;

        this.encoder = null;
        this.rtAudio = null;
        this.speaking = false;
        this.sequence = 0;
        this.timestamp = 0;
        this.ssrc = null;

        this.udpSocket = null;
        this.voiceIp = null;
        this.voicePort = null;
        this.secretKey = null;
        this.encryptionMode = null;
        this.daveSession = null;
        this.botUserId = null;
        this.sendVoice = null;

        this.deviceId = null;
        this.gainPercent = 100;
    }

    /**
     * Lista dispositivos de entrada com o ID real do RtAudio
     */
    static listInputDevices() {
        if (!audify) {
            throw new Error('audify não está instalado');
        }

        const rt = new audify.RtAudio();
        const devices = rt.getDevices();
        const defaultId = rt.getDefaultInputDevice();

        const inputs = [];

        for (let i = 0; i < devices.length; i++) {
            const d = devices[i];
            if (!d || d.inputChannels < 1) continue;

            // Preferir id real do device; fallback para índice
            const id = typeof d.id === 'number' ? d.id : i;

            inputs.push({
                id,
                name: d.name || `Device ${id}`,
                isDefault: id === defaultId || i === defaultId,
                channels: d.inputChannels,
                sampleRates: d.sampleRates || []
            });
        }

        return inputs;
    }

    /**
     * Resolve um deviceId válido a partir da lista do RtAudio
     */
    static resolveInputDeviceId(rtAudio, preferredId) {
        const devices = rtAudio.getDevices();
        const defaultId = rtAudio.getDefaultInputDevice();

        const isValid = (id) => {
            if (id === null || id === undefined || Number.isNaN(Number(id))) return false;
            const n = Number(id);

            // 1) índice no array
            if (devices[n] && devices[n].inputChannels > 0) return true;

            // 2) campo .id do device
            for (let i = 0; i < devices.length; i++) {
                const d = devices[i];
                if (d && typeof d.id === 'number' && d.id === n && d.inputChannels > 0) {
                    return true;
                }
            }
            return false;
        };

        if (isValid(preferredId)) {
            return Number(preferredId);
        }

        // Default do sistema
        if (isValid(defaultId)) {
            return Number(defaultId);
        }

        // Primeiro input disponível
        for (let i = 0; i < devices.length; i++) {
            if (devices[i] && devices[i].inputChannels > 0) {
                return typeof devices[i].id === 'number' ? devices[i].id : i;
            }
        }

        return 0;
    }

    static deviceNameForId(rtAudio, deviceId) {
        const devices = rtAudio.getDevices();
        const n = Number(deviceId);

        if (devices[n] && devices[n].name) return devices[n].name;

        for (let i = 0; i < devices.length; i++) {
            const d = devices[i];
            if (d && typeof d.id === 'number' && d.id === n) {
                return d.name || `ID ${n}`;
            }
        }

        return `ID ${deviceId}`;
    }

    init({
        ssrc,
        udpSocket,
        voiceIp,
        voicePort,
        secretKey,
        encryptionMode,
        daveSession,
        botUserId,
        sendVoice,
        deviceId = null,
        gainPercent = 100
    }) {
        if (!audify) {
            this.log('[Áudio-Sender] ERRO: audify não encontrado');
            return false;
        }

        this.ssrc = ssrc;
        this.udpSocket = udpSocket;
        this.voiceIp = voiceIp;
        this.voicePort = voicePort;
        this.secretKey = secretKey;
        this.encryptionMode = encryptionMode;
        this.daveSession = daveSession;
        this.botUserId = botUserId;
        this.sendVoice = sendVoice;
        this.deviceId = deviceId;
        this.gainPercent = Math.max(0, Math.min(2000, Number(gainPercent) || 100));

        const { OpusEncoder, OpusApplication } = audify;
        this.encoder = new OpusEncoder(
            SAMPLE_RATE,
            CHANNELS,
            OpusApplication.OPUS_APPLICATION_VOIP
        );

        try {
            this.encoder.setBitrate(BITRATE);
        } catch (_) { }

        this._openInputStream();

        this.isInitialized = true;
        this.log(`[Áudio-Sender] Microfone pronto (ganho=${this.gainPercent}%)`);
        return true;
    }

    updateTransport({ ssrc, udpSocket, voiceIp, voicePort, secretKey, encryptionMode, daveSession, botUserId, sendVoice }) {
        this.ssrc = ssrc;
        this.udpSocket = udpSocket;
        this.voiceIp = voiceIp;
        this.voicePort = voicePort;
        this.secretKey = secretKey;
        this.encryptionMode = encryptionMode;
        this.daveSession = daveSession;
        this.botUserId = botUserId;
        this.sendVoice = sendVoice;
        this.sequence = 0;
        this.timestamp = 0;
    }

    /** Atualiza a referência da sessão DAVE (após reinit/welcome) */
    setDaveSession(session) {
        this.daveSession = session || null;
    }

    _openInputStream() {
        if (this.rtAudio) {
            try {
                this.rtAudio.stop();
                this.rtAudio.closeStream();
            } catch (_) { }
            this.rtAudio = null;
        }

        this.rtAudio = new audify.RtAudio();

        const chosenId = AudioSender.resolveInputDeviceId(this.rtAudio, this.deviceId);
        const deviceName = AudioSender.deviceNameForId(this.rtAudio, chosenId);

        this.log(`[Áudio-Sender] Usando microfone: "${deviceName}" (id=${chosenId})`);

        this.rtAudio.openStream(
            null,
            {
                deviceId: chosenId,
                nChannels: CHANNELS,
                firstChannel: 0
            },
            audify.RtAudioFormat.RTAUDIO_SINT16,
            SAMPLE_RATE,
            FRAME_SIZE,
            'DiscordBot-Mic'
        );

        this.rtAudio.setInputCallback((pcm) => {
            if (this.isDestroyed || !this.speaking) return;
            this._processAndSend(pcm);
        });

        this.rtAudio.start();
    }

    setDevice(deviceId = null) {
        if (!this.isInitialized) {
            this.deviceId = deviceId;
            return;
        }

        const wasSpeaking = this.speaking;
        if (wasSpeaking) this.stopSpeaking();

        this.deviceId = deviceId;
        this._openInputStream();

        if (wasSpeaking) this.startSpeaking();

        this.log(`[Áudio-Sender] Microfone alterado para id=${deviceId ?? 'padrão'}`);
    }

    setGain(percent = 100) {
        this.gainPercent = Math.max(0, Math.min(2000, Number(percent) || 0));
        this.log(`[Áudio-Sender] Ganho definido: ${this.gainPercent}%`);
    }

    _applyGain(pcmBuffer) {
        const gain = this.gainPercent / 100;
        if (gain === 1) return pcmBuffer;

        // Cópia para não mutar o buffer original do callback
        const out = Buffer.from(pcmBuffer);
        const samples = new Int16Array(out.buffer, out.byteOffset, out.byteLength / 2);

        for (let i = 0; i < samples.length; i++) {
            let v = samples[i] * gain;
            if (v > 32767) v = 32767;
            else if (v < -32768) v = -32768;
            samples[i] = v | 0;
        }

        return out;
    }

    startSpeaking() {
        if (this.speaking || !this.isInitialized) return;
        this.speaking = true;

        this.sendVoice?.(5, {
            speaking: 1,
            delay: 0,
            ssrc: this.ssrc
        });

        this.log('[Áudio-Sender] Microfone LIGADO');
    }

    stopSpeaking() {
        if (!this.speaking) return;
        this.speaking = false;

        this.sendVoice?.(5, {
            speaking: 0,
            delay: 0,
            ssrc: this.ssrc
        });

        this.log('[Áudio-Sender] Microfone DESLIGADO');
    }

    /**
     * Criptografa o frame Opus com DAVE (E2EE), se a sessão estiver pronta.
     * API correta do @snazzah/davey:
     *   session.encryptOpus(packet)
     *   session.encrypt(MediaType.AUDIO, Codec.OPUS, packet)
     */
    _encryptDave(opusFrame) {
        const session = this.daveSession;
        if (!session) return opusFrame;

        // Só criptografa quando a sessão MLS está ready
        if (session.ready === false) return opusFrame;

        try {
            if (typeof session.encryptOpus === 'function') {
                const out = session.encryptOpus(opusFrame);
                return out ? Buffer.from(out) : opusFrame;
            }

            if (typeof session.encrypt === 'function') {
                // Assinatura: encrypt(MediaType, Codec, packet)
                // MediaType.AUDIO = 0, Codec.OPUS = 1
                const out = session.encrypt(0, 1, opusFrame);
                return out ? Buffer.from(out) : opusFrame;
            }
        } catch (e) {
            if (!this._lastDaveError || Date.now() - this._lastDaveError > 5000) {
                this.log(`[Áudio-Sender] Erro DAVE encrypt: ${e.message}`);
                this._lastDaveError = Date.now();
            }
        }

        return opusFrame;
    }

    _processAndSend(pcmBuffer) {
        try {
            const gained = this._applyGain(pcmBuffer);
            const opusFrame = this.encoder.encode(gained, FRAME_SIZE);
            if (!opusFrame || opusFrame.length === 0) return;

            const mediaPayload = this._encryptDave(opusFrame);
            if (!mediaPayload || mediaPayload.length === 0) return;

            const packet = this._buildRtpPacket(mediaPayload);
            if (!packet) return;

            this.udpSocket.send(packet, this.voicePort, this.voiceIp);
        } catch (e) {
            if (!this._lastError || Date.now() - this._lastError > 5000) {
                this.log(`[Áudio-Sender] Erro enviando frame: ${e.message}`);
                this._lastError = Date.now();
            }
        }
    }

    _buildRtpPacket(payload) {
        if (!this.secretKey || this.encryptionMode !== 'aead_aes256_gcm_rtpsize') {
            return null;
        }

        const header = Buffer.alloc(12);
        header[0] = 0x80;
        header[1] = 0x78; // PT 120
        header.writeUInt16BE(this.sequence, 2);
        header.writeUInt32BE(this.timestamp, 4);
        header.writeUInt32BE(this.ssrc, 8);

        this.sequence = (this.sequence + 1) & 0xffff;
        this.timestamp = (this.timestamp + FRAME_SIZE) >>> 0;

        const nonce4 = Buffer.alloc(4);
        crypto.randomFillSync(nonce4);

        const nonce = Buffer.alloc(12);
        nonce4.copy(nonce, 0);

        const cipher = crypto.createCipheriv('aes-256-gcm', this.secretKey, nonce);
        cipher.setAAD(header);

        const encrypted = Buffer.concat([
            cipher.update(payload),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        return Buffer.concat([header, encrypted, authTag, nonce4]);
    }

    destroy() {
        this.isDestroyed = true;
        this.stopSpeaking();

        try {
            this.rtAudio?.stop();
            this.rtAudio?.closeStream();
        } catch (_) { }

        this.rtAudio = null;
        this.encoder = null;
        this.isInitialized = false;
        this.log('[Áudio-Sender] destruído');
    }
}

module.exports = { AudioSender };