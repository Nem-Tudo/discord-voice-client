const params = new URLSearchParams(location.search);
const streamKey = params.get('streamKey') || '';

const canvas = document.getElementById('video');
const ctx = canvas.getContext('2d', { alpha: false });
const statusEl = document.getElementById('status');
const closeBtn = document.getElementById('close');

let decoder = null;
let configuredCodec = null;
let waitingForKeyframe = true;
let closed = false;
let cachedSps = null;
let cachedPps = null;

function status(text, error = false) {
    statusEl.textContent = text || '';
    statusEl.style.display = text ? 'block' : 'none';
    statusEl.style.color = error ? '#ff9b9b' : '#c9cdd2';
}

function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
        return new Uint8Array(value.data);
    }
    if (value && Array.isArray(value.data)) {
        return new Uint8Array(value.data);
    }
    return new Uint8Array();
}

function destroyDecoder() {
    if (!decoder) return;
    try { decoder.close(); } catch (_) {}
    decoder = null;
    configuredCodec = null;
    waitingForKeyframe = true;
}

function annexBNals(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const out = [];
    let i = 0;

    function startCodeAt(pos) {
        if (pos + 2 < bytes.length && bytes[pos] === 0 && bytes[pos + 1] === 0 && bytes[pos + 2] === 1) return 3;
        if (pos + 3 < bytes.length && bytes[pos] === 0 && bytes[pos + 1] === 0 && bytes[pos + 2] === 0 && bytes[pos + 3] === 1) return 4;
        return 0;
    }

    while (i < bytes.length) {
        const sc = startCodeAt(i);
        if (!sc) { i++; continue; }
        const nalStart = i + sc;
        let j = nalStart;
        while (j < bytes.length && !startCodeAt(j)) j++;
        if (j > nalStart) out.push(bytes.slice(nalStart, j));
        i = j;
    }
    return out;
}

function makeAvcC(sps, pps) {
    if (!sps || sps.length < 4 || !pps || !pps.length) return null;
    const out = new Uint8Array(11 + sps.length + pps.length);
    let o = 0;
    out[o++] = 1;
    out[o++] = sps[1];
    out[o++] = sps[2];
    out[o++] = sps[3];
    out[o++] = 0xff; // 4-byte NAL length field
    out[o++] = 0xe1; // one SPS
    out[o++] = (sps.length >>> 8) & 0xff;
    out[o++] = sps.length & 0xff;
    out.set(sps, o); o += sps.length;
    out[o++] = 1; // one PPS
    out[o++] = (pps.length >>> 8) & 0xff;
    out[o++] = pps.length & 0xff;
    out.set(pps, o);
    return out;
}

function annexBToAvcc(data) {
    const nals = annexBNals(data);
    if (!nals.length) return null;
    let total = 0;
    for (const nal of nals) total += 4 + nal.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const nal of nals) {
        out[o++] = (nal.length >>> 24) & 0xff;
        out[o++] = (nal.length >>> 16) & 0xff;
        out[o++] = (nal.length >>> 8) & 0xff;
        out[o++] = nal.length & 0xff;
        out.set(nal, o);
        o += nal.length;
    }
    return out;
}

function findParameterSets(data) {
    for (const nal of annexBNals(data)) {
        const type = nal[0] & 0x1f;
        if (type === 7) cachedSps = nal;
        else if (type === 8) cachedPps = nal;
    }
}

function ensureDecoder(codec, description) {
    codec = String(codec || '').toLowerCase();
    if (!window.VideoDecoder) {
        throw new Error('Este Chromium não disponibiliza WebCodecs VideoDecoder.');
    }
    if (decoder && configuredCodec === codec) return;

    destroyDecoder();

    decoder = new VideoDecoder({
        output(frame) {
            try {
                if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
                    canvas.width = frame.displayWidth;
                    canvas.height = frame.displayHeight;
                }
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            } finally {
                frame.close();
            }
        },
        error(error) {
            console.error('[StreamDecoder]', error);
            status(`Erro no decoder: ${error.message || error}`, true);
            waitingForKeyframe = true;
        }
    });

    const config = {
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'prefer-hardware',
        description
    };
    decoder.configure(config);
    configuredCodec = codec;
    waitingForKeyframe = false;
    status('');
}

function handleFrame(frame) {
    if (closed) return;
    const data = normalizeBytes(frame?.data);
    if (!data.length) return;

    try {
        findParameterSets(data);

        // Discord gives us Annex-B H.264. Chromium's AVC WebCodecs path
        // requires an AVCDecoderConfigurationRecord (avcC) description and
        // length-prefixed access units, hence the explicit conversion here.
        if (frame.key && cachedSps && cachedPps) {
            const description = makeAvcC(cachedSps, cachedPps);
            if (description) ensureDecoder(frame.codec || 'avc1.42E01E', description);
        }

        if (!decoder) return; // wait until a keyframe provides SPS/PPS
        if (waitingForKeyframe && !frame.key) return;

        const avcc = annexBToAvcc(data);
        if (!avcc) return;

        decoder.decode(new EncodedVideoChunk({
            type: frame.key ? 'key' : 'delta',
            timestamp: Number(frame.timestamp || 0),
            data: avcc
        }));
    } catch (error) {
        console.error('[StreamDecoder] decode failed', error);
        status(`Falha ao decodificar a transmissão: ${error.message || error}`, true);
        waitingForKeyframe = true;
    }
}

window.discordVoice?.onStreamVideoFrame?.(handleFrame);

window.discordVoice?.onStreamStatus?.((payload) => {
    if (!payload) return;

    if (payload.status === 'requested' || payload.status === 'connecting') {
        status('Conectando à transmissão…');
    } else if (payload.status === 'playing') {
        status('');
    } else if (payload.status === 'error') {
        status(payload.error || 'Erro ao abrir a transmissão.', true);
    } else if (payload.status === 'stopped') {
        status(payload.reason || 'A transmissão foi encerrada.');
        waitingForKeyframe = true;
    }
});

closeBtn.addEventListener('click', () => {
    closed = true;
    try { window.discordVoice?.stopWatchStream?.(streamKey); } catch (_) {}
    window.close();
});

window.addEventListener('beforeunload', () => {
    closed = true;
    destroyDecoder();
});
