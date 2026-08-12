'use strict';

/**
 * RNNoise processor for Electron/Node.
 *
 * IMPORTANT: @shiguredo/rnnoise-wasm is a browser-oriented ESM build and its
 * Emscripten glue rejects Electron's Node main process. For this app we use
 * @echogarden/rnnoise-wasm, whose Emscripten glue explicitly supports Node.js.
 *
 * RNNoise itself works on mono 480-sample frames (10 ms @ 48 kHz). The app's
 * capture format is stereo Int16, 960 samples/channel (20 ms), so we mix each
 * 10 ms stereo slice to mono, denoise it, then write the denoised signal back
 * to both channels.
 */
class RnnoiseProcessor {
    constructor(log) {
        this.log = log || console.log;
        this.module = null;
        this.state = null;
        this.inputPtr = 0;
        this.outputPtr = 0;
        this.frameSize = 480;
        this._loadPromise = null;
        this.enabled = true;
        this.available = false;
    }

    async init() {
        if (this.state) return true;
        if (this._loadPromise) return this._loadPromise;

        this._loadPromise = (async () => {
            try {
                // This package is a genuine Node-compatible Emscripten build.
                const imported = await import('@echogarden/rnnoise-wasm');
                const initializer = imported.default || imported.RNNoise || imported;
                if (typeof initializer !== 'function') {
                    throw new Error('RNNoise: inicializador WASM não encontrado.');
                }

                this.module = await initializer();

                const reportedFrameSize = this.module._rnnoise_get_frame_size();
                if (reportedFrameSize !== this.frameSize) {
                    throw new Error(`RNNoise: frame size inesperado (${reportedFrameSize}).`);
                }

                this.inputPtr = this.module._malloc(this.frameSize * 4);
                this.outputPtr = this.module._malloc(this.frameSize * 4);
                this.state = this.module._rnnoise_create(0);

                if (!this.state) {
                    throw new Error('RNNoise: não foi possível criar o estado.');
                }

                this.available = true;
                this.enabled = true;
                this.log('[RNNoise] Supressão de ruído inicializada (Node/WASM, 48 kHz / 10 ms).');
                return true;
            } catch (error) {
                this._loadPromise = null;
                this.available = false;
                this.enabled = false;
                this.log(`[RNNoise] AVISO: indisponível, áudio seguirá sem supressão: ${error.message}`);
                // Never abort entering a voice call just because an optional
                // DSP module failed to load.
                return false;
            }
        })();

        return this._loadPromise;
    }

    process(pcmBuffer) {
        if (!this.enabled || !this.available || !this.state || !this.module) {
            return pcmBuffer;
        }

        const samples = new Int16Array(
            pcmBuffer.buffer,
            pcmBuffer.byteOffset,
            Math.floor(pcmBuffer.byteLength / 2)
        );

        // RtAudio gives us 960 samples/channel = 1920 interleaved Int16s.
        const samplesPerChannel = Math.floor(samples.length / 2);
        if (samplesPerChannel < this.frameSize) return pcmBuffer;

        const output = Buffer.from(pcmBuffer);
        const out = new Int16Array(
            output.buffer,
            output.byteOffset,
            Math.floor(output.byteLength / 2)
        );

        const heap = this.module.HEAPF32;
        const inputOffset = this.inputPtr >>> 2;
        const outputOffset = this.outputPtr >>> 2;

        // Process 20 ms as two independent 10 ms RNNoise frames.
        for (let frame = 0; frame < samplesPerChannel; frame += this.frameSize) {
            if (frame + this.frameSize > samplesPerChannel) break;

            // Stereo -> mono. RNNoise expects Int16-range values represented
            // as Float32, not normalized [-1, 1].
            for (let i = 0; i < this.frameSize; i++) {
                const base = (frame + i) * 2;
                heap[inputOffset + i] = (samples[base] + samples[base + 1]) * 0.5;
            }

            this.module._rnnoise_process_frame(
                this.state,
                this.outputPtr,
                this.inputPtr
            );

            for (let i = 0; i < this.frameSize; i++) {
                const value = Math.max(-32768, Math.min(32767, Math.round(heap[outputOffset + i])));
                const base = (frame + i) * 2;
                out[base] = value;
                out[base + 1] = value;
            }
        }

        return output;
    }

    destroy() {
        try {
            if (this.module && this.state) {
                this.module._rnnoise_destroy(this.state);
            }
        } catch (_) { }

        try {
            if (this.module && this.inputPtr) this.module._free(this.inputPtr);
            if (this.module && this.outputPtr) this.module._free(this.outputPtr);
        } catch (_) { }

        this.state = null;
        this.module = null;
        this.inputPtr = 0;
        this.outputPtr = 0;
        this.available = false;
        this._loadPromise = null;
    }
}

module.exports = { RnnoiseProcessor };
