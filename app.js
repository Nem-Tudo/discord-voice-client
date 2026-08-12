'use strict';

/**
 * Interface Electron para o cliente de voz.
 *
 * Rode com:
 *   npm start
 *   npm start -- <token> <guildId> <channelId>
 */

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { createVoiceClient } = require('./src/voice-client.js');

let mainWindow = null;
let client = null;
let muted = false;
let deafened = false;
let connected = false;

const [, , ARG_TOKEN, ARG_GUILD, ARG_CHANNEL] = process.argv;

function sendToRenderer(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

function log(message) {
    const time = new Date().toLocaleTimeString('pt-BR');
    sendToRenderer('voice:log', `[${time}] ${message}`);
}

function publishState(extra = {}) {
    sendToRenderer('voice:state', {
        connected,
        muted,
        deafened,
        ...extra
    });
}

function setConnectedState(isConnected) {
    connected = isConnected;
    publishState({
        status: isConnected ? 'Conectado a call' : 'Desconectado'
    });
}

function resetLocalState() {
    muted = false;
    deafened = false;
    client = null;
    setConnectedState(false);
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 460,
        height: 640,
        minWidth: 420,
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
        sendToRenderer('voice:defaults', {
            token: ARG_TOKEN || '',
            guildId: ARG_GUILD || '',
            channelId: ARG_CHANNEL || ''
        });
        publishState({ status: 'Desconectado' });
    });

    mainWindow.on('close', () => {
        if (client) {
            client.disconnect();
        }
    });
}

ipcMain.handle('voice:connect', async (_event, { token, guildId, channelId }) => {
    if (client) {
        log('Ja existe uma conexao ativa.');
        return;
    }

    if (!token || !guildId || !channelId) {
        log('Preencha token, ID do servidor e ID do canal antes de conectar.');
        publishState({ connecting: false });
        return;
    }

    publishState({
        connecting: true,
        status: 'Conectando...'
    });

    client = createVoiceClient({
        token,
        guildId,
        channelId,
        onLog: log,
        onReady: () => {
            muted = false;
            deafened = false;
            setConnectedState(true);
            publishState({ connecting: false });
        },
        onDisconnected: (reason) => {
            log(`Desconectado (${reason})`);
            resetLocalState();
            publishState({ connecting: false });
        }
    });

    client.connect();
});

ipcMain.handle('voice:disconnect', async () => {
    if (!client) return;
    client.disconnect();
});

ipcMain.handle('voice:set-mute', async () => {
    if (!client) return;

    muted = !muted;
    client.setMute(muted);

    log(muted ? 'Microfone mutado' : 'Microfone desmutado');
    publishState();
});

ipcMain.handle('voice:set-deafen', async () => {
    if (!client) return;

    deafened = !deafened;

    if (deafened) {
        muted = true;
        client.setDeafen(true);
        log('Audio ensurdecido (mic mutado junto)');
    } else {
        muted = false;
        client.setDeafen(false);
        client.setMute(false);
        log('Audio reativado (mic desmutado junto)');
    }

    publishState();
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
    if (client) {
        client.disconnect();
    }
    setTimeout(() => process.exit(0), 100);
});
