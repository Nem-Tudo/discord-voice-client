'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { createVoiceClient } = require('./src/voice-client.js');
const { AudioSender } = require('./src/audio-sender.js');

const [, , ARG_TOKEN] = process.argv;

let mainWindow = null;
let browserClient = null;
let activeToken = null;
let allMuted = false;
let allDeafened = false;

/** ID do microfone escolhido na UI (null = padrão do sistema) */
let selectedMicId = null;

/** Ganho do microfone em % (0–2000, 100 = normal) */
let selectedMicGain = 100;

/** Stream de teste de microfone (loopback) */
let micTestRtAudio = null;
let micTestGainPercent = 100;

const voiceClients = new Map();

function sendToRenderer(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

function log(message) {
    const time = new Date().toLocaleTimeString('pt-BR');
    sendToRenderer('voice:log', `[${time}] ${message}`);
}

function activeCallsPayload() {
    return {
        allMuted,
        allDeafened,
        calls: Array.from(voiceClients.values()).map((entry) => ({
            guildId: entry.guildId,
            guildName: entry.guildName,
            channelId: entry.channelId,
            channelName: entry.channelName,
            muted: entry.muted,
            deafened: entry.deafened,
            switching: Boolean(entry.pending)
        }))
    };
}

function publishActiveCalls() {
    sendToRenderer('voice:active-calls', activeCallsPayload());
}

function stopBrowserClient() {
    if (!browserClient) return;
    const oldClient = browserClient;
    browserClient = null;
    oldClient.disconnect();
}

function stopAllVoiceClients() {
    for (const entry of voiceClients.values()) {
        entry.pending = null;
        entry.client.disconnect();
    }
    voiceClients.clear();
    allMuted = false;
    allDeafened = false;
    publishActiveCalls();
}

function stopMicTestInternal() {
    if (!micTestRtAudio) return;

    try {
        micTestRtAudio.stop();
    } catch (_) { }

    try {
        micTestRtAudio.closeStream();
    } catch (_) { }

    micTestRtAudio = null;
    log('[Mic-Test] Teste de microfone parado.');
}

function applyGainToPcm(pcm, gainPercent) {
    const gain = (gainPercent || 100) / 100;
    if (gain === 1) return pcm;

    const buf = Buffer.from(pcm);
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
    for (let i = 0; i < samples.length; i++) {
        let v = samples[i] * gain;
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        samples[i] = v | 0;
    }
    return buf;
}

function startMicTestInternal(deviceId) {
    stopMicTestInternal();

    let audify = null;
    try {
        audify = require('audify');
    } catch (e) {
        log('[Mic-Test] ERRO: audify não encontrado.');
        return;
    }

    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;
    const FRAME_SIZE = 960;

    try {
        micTestRtAudio = new audify.RtAudio();

        const devices = micTestRtAudio.getDevices();
        let chosen = deviceId;

        if (chosen === null || chosen === undefined) {
            chosen = micTestRtAudio.getDefaultInputDevice();
        }

        if (!devices[chosen] || devices[chosen].inputChannels < 1) {
            log(`[Mic-Test] Dispositivo ${chosen} inválido, usando padrão.`);
            chosen = micTestRtAudio.getDefaultInputDevice();
        }

        const deviceName = devices[chosen]?.name || `ID ${chosen}`;
        const outId = micTestRtAudio.getDefaultOutputDevice();
        const outName = devices[outId]?.name || `ID ${outId}`;

        micTestGainPercent = selectedMicGain;

        log(`[Mic-Test] Capturando: "${deviceName}" → reproduzindo em: "${outName}" (ganho=${micTestGainPercent}%)`);

        micTestRtAudio.openStream(
            {
                deviceId: outId,
                nChannels: CHANNELS,
                firstChannel: 0
            },
            {
                deviceId: chosen,
                nChannels: CHANNELS,
                firstChannel: 0
            },
            audify.RtAudioFormat.RTAUDIO_SINT16,
            SAMPLE_RATE,
            FRAME_SIZE,
            'MicTest-Loopback'
        );

        micTestRtAudio.setInputCallback((pcm) => {
            if (!micTestRtAudio) return;
            try {
                const gained = applyGainToPcm(pcm, micTestGainPercent);
                micTestRtAudio.write(gained);
            } catch (_) { }
        });

        micTestRtAudio.start();
        log('[Mic-Test] Teste iniciado. Fale no microfone.');
    } catch (e) {
        log(`[Mic-Test] Erro ao iniciar teste: ${e.message}`);
        stopMicTestInternal();
    }
}

/**
 * Aplica o microfone escolhido em um voice client (se a API existir).
 */
function applyMicToClient(client) {
    if (!client) return;

    if (typeof client.setMic === 'function') {
        client.setMic(selectedMicId);
    }
}

/**
 * Aplica o ganho em um voice client (se a API existir).
 */
function applyGainToClient(client) {
    if (!client) return;

    if (typeof client.setMicGain === 'function') {
        client.setMicGain(selectedMicGain);
    } else if (typeof client.setGain === 'function') {
        client.setGain(selectedMicGain);
    }
}

/**
 * Liga/desliga o envio de áudio do mic conforme mute.
 */
function applySpeakingState(entry) {
    if (!entry?.client) return;

    const shouldSpeak = !entry.muted && !entry.deafened;

    if (shouldSpeak && typeof entry.client.startMic === 'function') {
        entry.client.startMic();
    } else if (!shouldSpeak && typeof entry.client.stopMic === 'function') {
        entry.client.stopMic();
    }
}

function startVoiceCall(guild, channel) {
    if (!activeToken) {
        log('Carregue os servidores antes de entrar em uma call.');
        return;
    }

    const entry = {
        guildId: guild.id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: channel.name,
        muted: allMuted,
        deafened: allDeafened,
        pending: null,
        client: null
    };

    const voiceClient = createVoiceClient({
        token: activeToken,
        guildId: guild.id,
        channelId: channel.id,
        deviceId: selectedMicId,
        gainPercent: selectedMicGain,
        onLog: log,
        onReady: () => {
            log(`Conectado em ${channel.name} (${guild.name}).`);

            applyMicToClient(voiceClient);
            applyGainToClient(voiceClient);
            applySpeakingState(entry);

            publishActiveCalls();
        },
        onDisconnected: (reason) => {
            if (voiceClients.get(guild.id) !== entry) return;

            const nextChannel = entry.pending;
            voiceClients.delete(guild.id);
            publishActiveCalls();

            if (nextChannel) {
                startVoiceCall(guild, nextChannel);
            } else {
                log(`[Voice] call removida (${reason}).`);
                sendToRenderer('voice:status', `Saiu da call de ${guild.name}.`);
            }
        }
    });

    entry.client = voiceClient;
    voiceClients.set(guild.id, entry);
    publishActiveCalls();

    voiceClient.connect();

    if (entry.muted) voiceClient.setMute(true);
    if (entry.deafened) voiceClient.setDeafen(true);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 800,
        minWidth: 760,
        minHeight: 560,
        title: 'Discord Voice Pro',
        backgroundColor: '#313338',
        icon: "./assets/logo.png",
        webPreferences: {
            preload: path.join(__dirname, 'src', 'app', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'src', 'dist', 'index.html'));

    mainWindow.webContents.once('did-finish-load', () => {
        sendToRenderer('voice:defaults', { token: ARG_TOKEN || '' });
        publishActiveCalls();
    });

    mainWindow.on('close', () => {
        stopMicTestInternal();
        stopAllVoiceClients();
        stopBrowserClient();
    });
}

// ============================================================
// IPC – servidores / calls
// ============================================================

ipcMain.handle('voice:load-servers', async (_event, { token }) => {
    const nextToken = String(token || '').trim();
    if (!nextToken) {
        log('Informe o token antes de continuar.');
        return;
    }

    stopMicTestInternal();
    stopBrowserClient();
    stopAllVoiceClients();

    activeToken = nextToken;
    sendToRenderer('voice:browser-reset');
    sendToRenderer('voice:status', 'Conectando ao Discord...');

    let nextClient = null;
    nextClient = createVoiceClient({
        token: nextToken,
        onLog: log,
        onGatewayReady: (ready) => {
            if (browserClient !== nextClient) return;
            sendToRenderer('voice:gateway-ready', ready);
            log(`Logado como ${ready.user.username}`);
            sendToRenderer('voice:status', 'Servidores carregados. Escolha um servidor e depois uma call.');
        },
        onGuildCreate: (guild) => {
            if (browserClient !== nextClient) return;
            sendToRenderer('voice:guild-create', guild);
        },
        onVoiceStateUpdate: (state) => {
            if (browserClient !== nextClient) return;
            sendToRenderer('voice:voice-state', state);
        },
        onDisconnected: (reason) => {
            if (browserClient !== nextClient) return;
            browserClient = null;
            activeToken = null;
            log(`Desconectado (${reason})`);
            sendToRenderer('voice:status', 'Desconectado');
        }
    });

    browserClient = nextClient;
    browserClient.connect();
});

ipcMain.handle('voice:join-call', async (_event, { guild, channel }) => {
    if (!guild?.id || !channel?.id) return;

    const entry = voiceClients.get(guild.id);
    if (!entry) {
        sendToRenderer('voice:status', `Entrando em ${channel.name}...`);
        startVoiceCall(guild, channel);
        return;
    }

    if (entry.channelId === channel.id) return;

    entry.pending = channel;
    entry.client.disconnect();
    sendToRenderer('voice:status', `Trocando para ${channel.name}...`);
    publishActiveCalls();
});

ipcMain.handle('voice:leave-call', async (_event, { guildId }) => {
    const entry = voiceClients.get(guildId);
    if (!entry) return;

    entry.pending = null;
    voiceClients.delete(guildId);
    entry.client.disconnect();
    sendToRenderer('voice:status', `Saiu da call de ${entry.guildName}.`);
    publishActiveCalls();
});

ipcMain.handle('voice:set-call-mute', async (_event, { guildId }) => {
    const entry = voiceClients.get(guildId);
    if (!entry) return;

    entry.muted = !entry.muted;
    entry.client.setMute(entry.muted);
    applySpeakingState(entry);
    publishActiveCalls();
});

ipcMain.handle('voice:set-call-deafen', async (_event, { guildId }) => {
    const entry = voiceClients.get(guildId);
    if (!entry) return;

    entry.deafened = !entry.deafened;
    entry.client.setDeafen(entry.deafened);
    if (entry.deafened) entry.muted = true;
    applySpeakingState(entry);
    publishActiveCalls();
});

ipcMain.handle('voice:set-all-mute', async () => {
    allMuted = !allMuted;
    for (const entry of voiceClients.values()) {
        entry.muted = allMuted;
        entry.client.setMute(allMuted);
        applySpeakingState(entry);
    }
    publishActiveCalls();
});

ipcMain.handle('voice:set-all-deafen', async () => {
    allDeafened = !allDeafened;
    for (const entry of voiceClients.values()) {
        entry.deafened = allDeafened;
        entry.client.setDeafen(allDeafened);
        if (allDeafened) entry.muted = true;
        applySpeakingState(entry);
    }
    publishActiveCalls();
});

// ============================================================
// IPC – microfone
// ============================================================

ipcMain.handle('voice:list-mics', async () => {
    try {
        return AudioSender.listInputDevices();
    } catch (e) {
        log(`[Mic] Erro ao listar microfones: ${e.message}`);
        return [];
    }
});

ipcMain.handle('voice:set-mic', async (_event, deviceId) => {
    if (deviceId === '' || deviceId === undefined) {
        selectedMicId = null;
    } else {
        selectedMicId = Number(deviceId);
        if (Number.isNaN(selectedMicId)) selectedMicId = null;
    }

    log(
        selectedMicId === null
            ? '[Mic] Microfone definido: padrão do sistema'
            : `[Mic] Microfone definido: id=${selectedMicId}`
    );

    for (const entry of voiceClients.values()) {
        applyMicToClient(entry.client);
    }

    return selectedMicId;
});

ipcMain.handle('voice:set-mic-gain', async (_event, percent) => {
    let value = Number(percent);
    if (Number.isNaN(value)) value = 100;
    selectedMicGain = Math.max(0, Math.min(2000, Math.round(value)));
    micTestGainPercent = selectedMicGain;

    log(`[Mic] Ganho definido: ${selectedMicGain}%`);

    for (const entry of voiceClients.values()) {
        applyGainToClient(entry.client);
    }

    return selectedMicGain;
});

ipcMain.handle('voice:start-mic-test', async (_event, deviceId) => {
    const id =
        deviceId === '' || deviceId === undefined || deviceId === null
            ? selectedMicId
            : Number(deviceId);

    startMicTestInternal(Number.isNaN(id) ? null : id);
});

ipcMain.handle('voice:stop-mic-test', async () => {
    stopMicTestInternal();
});

// ============================================================
// App lifecycle
// ============================================================

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    stopMicTestInternal();
    stopAllVoiceClients();
    stopBrowserClient();

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

process.on('SIGINT', () => {
    stopMicTestInternal();
    stopAllVoiceClients();
    stopBrowserClient();
    setTimeout(() => process.exit(0), 100);
});