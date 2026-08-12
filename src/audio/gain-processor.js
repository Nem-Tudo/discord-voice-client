'use strict';

class GainProcessor {
    constructor(percent = 100) {
        this.percent = 100;
        this.setGain(percent);
    }

    setGain(percent = 100) {
        const value = Number(percent);
        this.percent = Number.isFinite(value)
            ? Math.max(0, Math.min(2000, Math.round(value)))
            : 100;
    }

    process(pcmBuffer) {
        const gain = this.percent / 100;
        if (gain === 1) return pcmBuffer;

        const output = Buffer.from(pcmBuffer);
        const samples = new Int16Array(
            output.buffer,
            output.byteOffset,
            Math.floor(output.byteLength / 2)
        );

        for (let i = 0; i < samples.length; i++) {
            let value = samples[i] * gain;
            if (value > 32767) value = 32767;
            else if (value < -32768) value = -32768;
            samples[i] = value | 0;
        }

        return output;
    }
}

module.exports = { GainProcessor };
