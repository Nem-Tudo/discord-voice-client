const params = new URLSearchParams(location.search);
const streamKey = params.get('streamKey') || '';
const streamerName = params.get('displayName') || 'Transmissão';

const canvas = document.getElementById('video');
const ctx = canvas.getContext('2d', { alpha: false });
const statusEl = document.getElementById('status');
const nameEl = document.getElementById('streamer-name');
const controlsEl = document.getElementById('controls');
const playBtn = document.getElementById('play');
const timeline = document.getElementById('timeline');
const timeEl = document.getElementById('time');
const liveBtn = document.getElementById('live');

nameEl.textContent = streamerName;

let decoder = null;
let configuredCodec = null;
let waitingForKeyframe = true;
let closed = false;
let cachedSps = null;
let cachedPps = null;
let advancedControls = params.get('advancedControls') === '1';
let liveMode = true;
let playing = true;
let playTimer = null;
let playbackGeneration = 0;
let playbackCursor = 0;
let buffer = [];
const BUFFER_MS = 30_000;

function status(text, error = false) {
    statusEl.textContent = text || '';
    statusEl.style.display = text ? 'block' : 'none';
    statusEl.style.color = error ? '#ff9b9b' : '#c9cdd2';
}

function updateControlsVisibility() {
    controlsEl.classList.toggle('visible', advancedControls);
}
updateControlsVisibility();

function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return new Uint8Array(value.data);
    if (value && Array.isArray(value.data)) return new Uint8Array(value.data);
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
    out[o++] = sps[1]; out[o++] = sps[2]; out[o++] = sps[3];
    out[o++] = 0xff; out[o++] = 0xe1;
    out[o++] = (sps.length >>> 8) & 0xff; out[o++] = sps.length & 0xff;
    out.set(sps, o); o += sps.length;
    out[o++] = 1;
    out[o++] = (pps.length >>> 8) & 0xff; out[o++] = pps.length & 0xff;
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
        out.set(nal, o); o += nal.length;
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
    if (!window.VideoDecoder) throw new Error('Este Chromium não disponibiliza WebCodecs VideoDecoder.');
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
            } finally { frame.close(); }
        },
        error(error) {
            console.error('[StreamDecoder]', error);
            status(`Erro no decoder: ${error.message || error}`, true);
            waitingForKeyframe = true;
        }
    });
    decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware', description });
    configuredCodec = codec;
    waitingForKeyframe = false;
    status('');
}

function appendBuffer(frame) {
    const now = Date.now();
    const data = normalizeBytes(frame?.data);
    if (!data.length) return null;
    const timestampUs = Number(frame.timestamp || 0);
    const entry = {
        data: new Uint8Array(data),
        key: Boolean(frame.key),
        codec: String(frame.codec || 'avc1.42e01e').toLowerCase(),
        arrival: now,
        // RTP/media clock. Never use wall-clock arrival time as the playback clock:
        // packets can arrive in bursts, which makes a DVR driven by arrival time
        // speed up, slow down, or appear to stutter.
        mediaMs: timestampUs / 1000,
        timestamp: timestampUs
    };
    buffer.push(entry);
    const cutoff = now - BUFFER_MS;
    while (buffer.length > 1 && buffer[0].arrival < cutoff) buffer.shift();
    return entry;
}

function bufferRange() {
    if (!buffer.length) {
        const now = Date.now();
        return { start: now, end: now };
    }
    return {
        start: buffer[0].mediaMs,
        end: buffer[buffer.length - 1].mediaMs
    };
}

function liveEdge() {
    return buffer.length ? buffer[buffer.length - 1].mediaMs : 0;
}

function formatTime(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
}

function updateTimeline() {
    const r = bufferRange();
    const duration = Math.max(0, r.end - r.start);
    timeline.max = String(Math.max(0, duration));
    let pos = Math.max(0, Math.min(duration, (liveMode ? r.end : playbackCursor) - r.start));
    timeline.value = String(pos);
    const behind = Math.max(0, r.end - (liveMode ? r.end : playbackCursor));
    timeEl.textContent = behind < 900 ? 'AO VIVO' : `-${formatTime(behind)}`;
    liveBtn.classList.toggle('live', behind < 900);
}

function stopPlaybackTimer() {
    if (playTimer) clearTimeout(playTimer);
    playTimer = null;
}

function decodeEntry(entry) {
    if (!entry) return;
    findParameterSets(entry.data);
    if (entry.key && cachedSps && cachedPps) {
        const desc = makeAvcC(cachedSps, cachedPps);
        if (desc) ensureDecoder(entry.codec, desc);
    }
    if (!decoder || (waitingForKeyframe && !entry.key)) return;
    const avcc = annexBToAvcc(entry.data);
    if (!avcc) return;
    decoder.decode(new EncodedVideoChunk({
        type: entry.key ? 'key' : 'delta',
        timestamp: Number(entry.timestamp),
        data: avcc
    }));
}

async function rebuildAt(target) {
    stopPlaybackTimer();
    const generation = ++playbackGeneration;
    const candidates = buffer.filter(x => x.mediaMs <= target && x.key);
    const start = candidates.length ? candidates[candidates.length - 1] : buffer.find(x => x.key);
    if (!start) return false;

    destroyDecoder();
    cachedSps = null;
    cachedPps = null;

    const startIndex = buffer.indexOf(start);
    const endIndex = buffer.findIndex(x => x.mediaMs > target);
    const end = endIndex < 0 ? buffer.length : endIndex;
    for (let i = startIndex; i < end; i++) {
        if (generation !== playbackGeneration) return false;
        decodeEntry(buffer[i]);
    }
    try { if (decoder) await decoder.flush(); } catch (_) {}
    playbackCursor = target;
    liveMode = Math.abs(target - liveEdge()) < 700;
    updateTimeline();
    return true;
}

function schedulePlayback() {
    stopPlaybackTimer();
    if (!playing || liveMode || buffer.length < 2) return;
    const target = playbackCursor;
    let nextIndex = buffer.findIndex(x => x.mediaMs > target + 0.5);
    if (nextIndex < 0) {
        const delay = Math.max(20, liveEdge() - target);
        playTimer = setTimeout(() => {
            if (liveMode) return;
            if (liveEdge() - playbackCursor < 120) { goLive(); return; }
            schedulePlayback();
        }, delay);
        return;
    }
    const next = buffer[nextIndex];
    const delay = Math.max(0, next.mediaMs - target);
    playTimer = setTimeout(() => {
        if (!playing || liveMode) return;
        playbackCursor = next.mediaMs;
        decodeEntry(next);
        updateTimeline();
        schedulePlayback();
    }, Math.max(0, delay));
}

function pausePlayback() {
    playing = false;
    stopPlaybackTimer();
    if (liveMode) playbackCursor = liveEdge();
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Reproduzir');
    updateTimeline();
}

function resumePlayback() {
    if (!buffer.length) return;
    playing = true;
    if (liveMode) {
        playbackCursor = liveEdge();
        playBtn.textContent = '❚❚';
        playBtn.setAttribute('aria-label', 'Pausar');
        updateTimeline();
        return;
    }
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pausar');
    schedulePlayback();
}

function goLive() {
    if (!buffer.length) return;
    ++playbackGeneration;
    liveMode = true;
    playing = true;
    playbackCursor = liveEdge();
    stopPlaybackTimer();
    // Decode the newest keyframe chain so returning to live is deterministic.
    rebuildAt(playbackCursor).then(() => {
        liveMode = true;
        playing = true;
        playbackCursor = liveEdge();
        updateTimeline();
    });
}

async function seekFromSlider(value) {
    if (!buffer.length) return;
    const r = bufferRange();
    const target = r.start + Number(value);
    const nearLive = r.end - target < 700;
    playing = false;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Reproduzir');
    liveMode = nearLive;
    if (nearLive) {
        goLive();
        return;
    }
    await rebuildAt(target);
    playbackCursor = target;
    liveMode = false;
    updateTimeline();
}

playBtn.addEventListener('click', () => playing ? pausePlayback() : resumePlayback());
liveBtn.addEventListener('click', goLive);
timeline.addEventListener('input', () => {
    // Do not rewrite the slider while the user drags it. The old implementation
    // did that on every input event, which caused the thumb to jump forward/back.
    const r = bufferRange();
    const target = r.start + Number(timeline.value || 0);
    const behind = Math.max(0, r.end - target);
    timeEl.textContent = behind < 900 ? 'AO VIVO' : `-${formatTime(behind)}`;
    liveBtn.classList.toggle('live', behind < 900);
});
timeline.addEventListener('change', () => seekFromSlider(timeline.value));

autoUpdate:
setInterval(() => {
    if (closed) return;
    if (liveMode && playing) playbackCursor = liveEdge();
    updateTimeline();
}, 250);

window.discordVoice?.onStreamVideoFrame?.((frame) => {
    if (closed) return;
    const entry = appendBuffer(frame);
    if (!entry) return;

    if (liveMode && playing) {
        decodeEntry(entry);
        playbackCursor = entry.mediaMs;
        updateTimeline();
    }
});

window.discordVoice?.onStreamStatus?.((payload) => {
    if (!payload) return;
    if (payload.status === 'requested' || payload.status === 'connecting') status('Conectando à transmissão…');
    else if (payload.status === 'playing') status('');
    else if (payload.status === 'error') status(payload.error || 'Erro ao abrir a transmissão.', true);
    else if (payload.status === 'stopped') { status(payload.reason || 'A transmissão foi encerrada.'); waitingForKeyframe = true; }
});

window.discordVoice?.onStreamControlsSetting?.((enabled) => {
    advancedControls = Boolean(enabled);
    updateControlsVisibility();
});

window.addEventListener('beforeunload', () => {
    closed = true;
    stopPlaybackTimer();
    destroyDecoder();
});
