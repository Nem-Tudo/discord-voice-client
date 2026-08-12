'use strict';

const FRAME_SIZE = 960; // 20 ms @ 48 kHz, stereo interleaved
const CHANNELS = 2;

function clampInt16(value) {
    if (value > 32767) return 32767;
    if (value < -32768) return -32768;
    return value;
}

/**
 * Generic realtime PCM pipeline.
 *
 * The microphone is the primary source. Additional sources (music, SFX,
 * announcements, etc.) can be registered and must expose pullFrame().
 * Sources should return one stereo Int16 frame (3840 bytes) or null.
 *
 * Processing order is deterministic and makes it easy to add DSP stages.
 */
class AudioPipeline {
    constructor({ frameSize = FRAME_SIZE, channels = CHANNELS, log } = {}) {
        this.frameSize = frameSize;
        this.channels = channels;
        this.log = log || console.log;
        this.processors = [];
        this.sources = new Map();
    }

    addProcessor(name, processor) {
        if (!name || !processor || typeof processor.process !== 'function') {
            throw new TypeError('Um processor válido é obrigatório.');
        }

        this.removeProcessor(name);
        this.processors.push({ name, processor });
        return processor;
    }

    removeProcessor(name) {
        const index = this.processors.findIndex((entry) => entry.name === name);
        if (index === -1) return false;

        const [{ processor }] = this.processors.splice(index, 1);
        try {
            processor.destroy?.();
        } catch (_) { }
        return true;
    }

    addSource(name, source, processors = []) {
        if (!name || !source || typeof source.pullFrame !== 'function') {
            throw new TypeError('A fonte de áudio precisa implementar pullFrame().');
        }

        this.sources.set(String(name), {
            source,
            processors: Array.isArray(processors) ? processors : []
        });
        return source;
    }

    removeSource(name) {
        const entry = this.sources.get(String(name));
        if (!entry) return false;

        this.sources.delete(String(name));
        try {
            entry.source.destroy?.();
        } catch (_) { }

        for (const processor of entry.processors) {
            try {
                processor.destroy?.();
            } catch (_) { }
        }
        return true;
    }

    listSources() {
        return Array.from(this.sources.keys());
    }

    /**
     * Mixes all queued secondary sources into the primary PCM frame and then
     * runs the processor chain.
     */
    processFrame(primaryPcm) {
        if (!Buffer.isBuffer(primaryPcm)) {
            throw new TypeError('O frame PCM principal precisa ser um Buffer.');
        }

        let output = Buffer.from(primaryPcm);

        for (const { source, processors } of this.sources.values()) {
            let frame = null;
            try {
                frame = source.pullFrame(this.frameSize, this.channels);
            } catch (error) {
                this.log(`[AudioPipeline] Fonte de áudio falhou: ${error.message}`);
            }

            if (frame) {
                for (const processor of processors) {
                    try {
                        frame = processor.process(frame, {
                            sampleRate: 48000,
                            channels: this.channels,
                            frameSize: this.frameSize
                        }) || frame;
                    } catch (error) {
                        this.log(`[AudioPipeline] Processor de fonte falhou: ${error.message}`);
                    }
                }

                output = this._mix(output, frame);
            }
        }

        for (const { name, processor } of this.processors) {
            try {
                const next = processor.process(output, {
                    sampleRate: 48000,
                    channels: this.channels,
                    frameSize: this.frameSize
                });
                if (Buffer.isBuffer(next)) output = next;
            } catch (error) {
                this.log(`[AudioPipeline] Processor "${name}" falhou: ${error.message}`);
            }
        }

        return output;
    }

    _mix(left, right) {
        const length = Math.min(left.length, right.length);
        const output = Buffer.from(left);
        const a = new Int16Array(output.buffer, output.byteOffset, Math.floor(length / 2));
        const b = new Int16Array(right.buffer, right.byteOffset, Math.floor(length / 2));

        for (let i = 0; i < a.length && i < b.length; i++) {
            a[i] = clampInt16(a[i] + b[i]);
        }

        return output;
    }

    destroy() {
        for (const name of Array.from(this.sources.keys())) {
            this.removeSource(name);
        }

        for (const { processor } of this.processors.splice(0)) {
            try {
                processor.destroy?.();
            } catch (_) { }
        }
    }
}

/**
 * Queue-based source. Future music/effect players can decode audio elsewhere
 * and simply push 20 ms PCM frames into this source.
 */
class PcmFrameSource {
    constructor({ maxFrames = 50 } = {}) {
        this.maxFrames = maxFrames;
        this.queue = [];
    }

    pushFrame(pcm) {
        if (!Buffer.isBuffer(pcm)) {
            throw new TypeError('O frame precisa ser um Buffer.');
        }

        this.queue.push(Buffer.from(pcm));
        while (this.queue.length > this.maxFrames) {
            this.queue.shift();
        }
    }

    pullFrame() {
        return this.queue.shift() || null;
    }

    clear() {
        this.queue.length = 0;
    }

    destroy() {
        this.clear();
    }
}

module.exports = {
    AudioPipeline,
    PcmFrameSource,
    FRAME_SIZE,
    CHANNELS
};
