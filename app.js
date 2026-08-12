'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { createVoiceClient } = require('./src/voice-client.js');

const [, , ARG_TOKEN] = process.argv;

let mainWindow = null;
let browserClient = null;
let activeToken = null;
let allMuted = false;
let allDeafened = false;

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
        onLog: log,
        onReady: () => {
            log(`Conectado em ${channel.name} (${guild.name}).`);
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
        width: 920,
        height: 720,
        minWidth: 760,
        minHeight: 560,
        title: 'Discord Voice',
        backgroundColor: '#313338',
        webPreferences: {
            preload: path.join(__dirname, 'src', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    mainWindow.webContents.once('did-finish-load', () => {
        sendToRenderer('voice:defaults', { token: ARG_TOKEN || '' });
        publishActiveCalls();
    });

    mainWindow.on('close', () => {
        stopAllVoiceClients();
        stopBrowserClient();
    });
}

ipcMain.handle('voice:load-servers', async (_event, { token }) => {
    const nextToken = String(token || '').trim();
    if (!nextToken) {
        log('Informe o token antes de continuar.');
        return;
    }

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
    publishActiveCalls();
});

ipcMain.handle('voice:set-call-deafen', async (_event, { guildId }) => {
    const entry = voiceClients.get(guildId);
    if (!entry) return;

    entry.deafened = !entry.deafened;
    entry.client.setDeafen(entry.deafened);
    if (entry.deafened) entry.muted = true;
    publishActiveCalls();
});

ipcMain.handle('voice:set-all-mute', async () => {
    allMuted = !allMuted;
    for (const entry of voiceClients.values()) {
        entry.muted = allMuted;
        entry.client.setMute(allMuted);
    }
    publishActiveCalls();
});

ipcMain.handle('voice:set-all-deafen', async () => {
    allDeafened = !allDeafened;
    for (const entry of voiceClients.values()) {
        entry.deafened = allDeafened;
        entry.client.setDeafen(allDeafened);
        if (allDeafened) entry.muted = true;
    }
    publishActiveCalls();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
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
    stopAllVoiceClients();
    stopBrowserClient();
    setTimeout(() => process.exit(0), 100);
});
