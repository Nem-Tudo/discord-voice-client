'use strict';

const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, globalShortcut, Notification } = require('electron');

const { createVoiceClient } = require('./src/voice-client.js');
const { AudioSender } = require('./src/audio-sender.js');
const { AudioPipeline } = require('./src/audio/audio-pipeline.js');
const { RnnoiseProcessor } = require('./src/audio/rnnoise-processor.js');
const { GainProcessor } = require('./src/audio/gain-processor.js');

const [, , ARG_TOKEN] = process.argv;

let mainWindow = null;
let logsWindow = null;
const streamWindows = new Map();
let browserClient = null;
let activeToken = null;
let allMuted = false;
let allDeafened = false;
let noiseSuppressionEnabled = true;
let streamAdvancedControlsEnabled = false;

/** ID do microfone escolhido na UI (null = padrão do sistema) */
let selectedMicId = null;

/** Ganho do microfone em % (0–2000, 100 = normal) */
let selectedMicGain = 100;

/** Stream de teste de microfone (loopback) */
let micTestRtAudio = null;
let micTestGainPercent = 100;
let micTestPipeline = null;
let micTestGainProcessor = null;

const voiceClients = new Map();

// ============================================================
// Atalhos de teclado globais (mutar/ensurdecer)
// ============================================================
// Funcionam mesmo com outro programa em foco (Discord, jogo, etc.),
// pois usam globalShortcut do Electron em vez de um listener da janela.

const SHORTCUTS_CONFIG_PATH = path.join(app.getPath('userData'), 'shortcuts.json');

const DEFAULT_SHORTCUTS = {
    toggleMute: 'CommandOrControl+Shift+M',
    toggleDeafen: 'CommandOrControl+Shift+D'
};

/** Atalhos atualmente configurados (accelerator do Electron, ou '' para desativado) */
let shortcuts = { ...DEFAULT_SHORTCUTS };

/** true enquanto a UI está gravando um atalho novo (ver shortcuts:suspend) */
let shortcutsSuspended = false;

/**
 * Tenta extrair o token do Discord oficial instalado no Windows.
 * Procura nos arquivos LevelDB (versão estável, Canary e PTB).
 * Funciona melhor quando o token ainda está em texto puro.
 * Em versões recentes o token costuma estar criptografado e este método pode não encontrar.
 */
function getDefaultDiscordToken() {
    const clients = [
        { name: 'discord', path: path.join(process.env.APPDATA || '', 'discord') },
        { name: 'discordcanary', path: path.join(process.env.APPDATA || '', 'discordcanary') },
        { name: 'discordptb', path: path.join(process.env.APPDATA || '', 'discordptb') },
    ];

    const tokenRegexPlain = /[\w-]{24}\.[\w-]{6}\.[\w-]{25,110}|mfa\.[\w-]{80,}/g;
    const encryptedRegex = /dQw4w9WgXcQ:[A-Za-z0-9+/=]+/g;

    for (const client of clients) {
        const localStatePath = path.join(client.path, 'Local State');
        const leveldbPath = path.join(client.path, 'Local Storage', 'leveldb');

        if (!fs.existsSync(localStatePath) || !fs.existsSync(leveldbPath)) continue;

        let masterKey;
        try {
            const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
            const encryptedKeyB64 = localState?.os_crypt?.encrypted_key;
            if (!encryptedKeyB64) continue;

            // Remove o prefixo "DPAPI"
            const encryptedKey = Buffer.from(encryptedKeyB64, 'base64').subarray(5);
            const encryptedKeyB64Clean = encryptedKey.toString('base64');

            // Script PowerShell limpo
            const psScript = `
                Add-Type -AssemblyName System.Security
                $encrypted = [Convert]::FromBase64String('${encryptedKeyB64Clean}')
                $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
                [Convert]::ToBase64String($decrypted)
            `;

            // Codifica em Base64 para evitar problemas de escaping
            const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

            const masterKeyB64 = execSync(
                `powershell -NoProfile -EncodedCommand ${encoded}`,
                { encoding: 'utf8', windowsHide: true }
            ).trim();

            masterKey = Buffer.from(masterKeyB64, 'base64');
        } catch (err) {
            console.error(`[Token] Erro ao pegar master key do ${client.name}:`, err.message);
            continue;
        }

        // Procura nos arquivos LevelDB
        let files = [];
        try {
            files = fs.readdirSync(leveldbPath).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));
        } catch (_) {
            continue;
        }

        for (const file of files) {
            let content = '';
            try {
                content = fs.readFileSync(path.join(leveldbPath, file), 'utf8');
            } catch (_) {
                continue;
            }

            // 1. Tokens em texto puro
            const plainMatches = content.match(tokenRegexPlain);
            if (plainMatches) {
                for (const t of plainMatches) {
                    if (t.length > 50) return t;
                }
            }

            // 2. Tokens criptografados
            const encryptedMatches = content.match(encryptedRegex);
            if (!encryptedMatches) continue;

            for (const enc of encryptedMatches) {
                try {
                    const encrypted = Buffer.from(enc.split('dQw4w9WgXcQ:')[1], 'base64');
                    if (encrypted.length < 31) continue;

                    const nonce = encrypted.subarray(3, 15);
                    const ciphertext = encrypted.subarray(15, encrypted.length - 16);
                    const tag = encrypted.subarray(encrypted.length - 16);

                    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
                    decipher.setAuthTag(tag);

                    const decrypted = Buffer.concat([
                        decipher.update(ciphertext),
                        decipher.final()
                    ]).toString('utf8');

                    if (decrypted && decrypted.length > 50) {
                        return decrypted;
                    }
                } catch (_) {
                    // token inválido, tenta o próximo
                }
            }
        }
    }

    return null;
}

let defaultToken = ARG_TOKEN || getDefaultDiscordToken() || '';

function loadShortcuts() {
    try {
        const raw = fs.readFileSync(SHORTCUTS_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        shortcuts = {
            toggleMute: typeof parsed.toggleMute === 'string' ? parsed.toggleMute : DEFAULT_SHORTCUTS.toggleMute,
            toggleDeafen: typeof parsed.toggleDeafen === 'string' ? parsed.toggleDeafen : DEFAULT_SHORTCUTS.toggleDeafen
        };
    } catch (_) {
        // Primeiro uso, arquivo corrompido ou ausente: cai nos padrões.
        shortcuts = { ...DEFAULT_SHORTCUTS };
    }
}

function saveShortcuts() {
    try {
        fs.mkdirSync(path.dirname(SHORTCUTS_CONFIG_PATH), { recursive: true });
        fs.writeFileSync(SHORTCUTS_CONFIG_PATH, JSON.stringify(shortcuts, null, 2), 'utf8');
    } catch (error) {
        log(`[Atalhos] Erro ao salvar configuração: ${error.message}`);
    }
}

/** Mostra feedback do atalho mesmo se a janela não estiver em foco. */
function notifyShortcutAction(text) {
    sendToRenderer('voice:status', text);
    log(`[Atalhos] ${text}`);
    try {
        if (Notification.isSupported()) {
            new Notification({ title: 'Discord Voice Pro', body: text, silent: true }).show();
        }
    } catch (_) { }
}

/** Registra os atalhos configurados. Chame de novo sempre que `shortcuts` mudar. */
function registerGlobalShortcuts() {
    globalShortcut.unregisterAll();

    if (shortcutsSuspended) {
        // A UI está gravando uma combinação nova: mantém tudo desregistrado
        // pra não disparar mute/deafen enquanto o usuário aperta as teclas,
        // nem competir pela combinação sendo capturada.
        return { toggleMute: true, toggleDeafen: true };
    }

    const registered = { toggleMute: true, toggleDeafen: true };

    if (shortcuts.toggleMute) {
        registered.toggleMute = globalShortcut.register(shortcuts.toggleMute, () => toggleAllMute());
        if (!registered.toggleMute) {
            log(`[Atalhos] Falha ao registrar atalho de mutar ("${shortcuts.toggleMute}"). Pode já estar em uso por outro programa.`);
        }
    }

    if (shortcuts.toggleDeafen) {
        registered.toggleDeafen = globalShortcut.register(shortcuts.toggleDeafen, () => toggleAllDeafen());
        if (!registered.toggleDeafen) {
            log(`[Atalhos] Falha ao registrar atalho de ensurdecer ("${shortcuts.toggleDeafen}"). Pode já estar em uso por outro programa.`);
        }
    }

    sendToRenderer('voice:shortcuts', { ...shortcuts, registered });
    return registered;
}

function sendToRenderer(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

function streamWindowKey(guildId, channelId, userId) {
    return `guild:${guildId}:${channelId}:${userId}`;
}

function createStreamWindow(streamKey, userId, displayName = 'Transmissão') {
    const existing = streamWindows.get(streamKey);
    if (existing && !existing.isDestroyed()) {
        existing.focus();
        return existing;
    }

    const win = new BrowserWindow({
        width: 1100,
        height: 700,
        minWidth: 500,
        minHeight: 350,
        title: `Discord Voice Pro — Live`,
        backgroundColor: '#000000',
        parent: mainWindow || undefined,
        webPreferences: {
            preload: path.join(__dirname, 'src', 'app', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    streamWindows.set(streamKey, win);

    win.loadFile(
        path.join(__dirname, 'src', 'app', 'stream.html'),
        { query: { streamKey, userId: String(userId || ''), displayName: String(displayName || 'Transmissão'), advancedControls: streamAdvancedControlsEnabled ? '1' : '0' } }
    );

    win.on('closed', () => {
        streamWindows.delete(streamKey);

        // The media session is separate from the voice call, so closing the
        // viewer should stop only this stream subscription.
        const parsed = streamKey.split(':');
        if (parsed[0] === 'camera' && parsed.length === 4) {
            const entry = voiceClients.get(parsed[1]);
            entry?.client?.stopWatchingCamera?.(parsed[3]);
            entry?.cameraKeys?.delete(streamKey);
            return;
        }

        if (parsed.length === 4) {
            const entry = voiceClients.get(parsed[1]);
            entry?.client?.stopWatchingStream?.(streamKey);
            entry?.streamKeys?.delete(streamKey);
            if (entry?.streamKey === streamKey) entry.streamKey = entry.streamKeys?.values().next().value || null;
        }
    });

    return win;
}

function sendToStreamWindow(streamKey, channel, payload) {
    const win = streamWindows.get(streamKey);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
}

function sendToLogsWindow(channel, payload) {
    if (!logsWindow || logsWindow.isDestroyed()) return;
    logsWindow.webContents.send(channel, payload);
}

function log(message) {
    const time = new Date().toLocaleTimeString('pt-BR');
    sendToLogsWindow('voice:log', `[${time}] ${message}`);
}

function activeCallsPayload() {
    return {
        allMuted,
        allDeafened,
        noiseSuppressionEnabled,

        calls: Array.from(
            voiceClients.values()
        ).map((entry) => ({
            // Identificador único para ações da UI (sair/mutar/ensurdecer):
            // guildId para calls de servidor, channelId para calls de DM.
            id: entry.guildId || entry.channelId,

            isDm: Boolean(entry.isDm),

            guildId: entry.guildId,
            guildName: entry.guildName,

            channelId: entry.channelId,
            channelName: entry.channelName,

            dmName: entry.dmName || null,
            dmAvatarUrl: entry.dmAvatarUrl || null,
            dmType: entry.dmType ?? null,

            // Outros participantes já conectados a esta call de DM/grupo
            // (o "eu" não entra aqui — ver `muted`/`deafened` abaixo).
            // Vazio/undefined para calls de servidor (a UI de servidor usa
            // guild.voiceStates, que já traz tudo isso).
            dmMembers: entry.isDm ? { ...(entry.voiceStates || {}) } : undefined,

            muted: entry.muted,
            deafened: entry.deafened,

            status: entry.status || 'connected',
            error: entry.error || null,

            switching: Boolean(entry.pending),

            inputLevel: Number(entry.inputLevel || 0),
            outputLevel: Number(entry.outputLevel || 0)
        }))
    };
}

function publishActiveCalls() {
    sendToRenderer('voice:active-calls', activeCallsPayload());
}

function stopBrowserClient() {
    const oldClient = browserClient;
    browserClient = null;

    if (!oldClient) return;

    try {
        oldClient.disconnect();
    } catch (error) {
        log(`[Gateway] erro ao desconectar: ${error.message}`);
    }
}

function logout() {
    // Invalida imediatamente qualquer callback da sessão anterior.
    activeToken = null;

    stopMicTestInternal();
    stopAllVoiceClients();
    stopBrowserClient();

    // Garante que nenhum estado global de voz permaneça para o próximo login.
    allMuted = false;
    allDeafened = false;

    publishActiveCalls();

    sendToRenderer('voice:logout');
    sendToRenderer('voice:status', 'Desconectado');
}

function stopAllVoiceClients() {
    for (const entry of voiceClients.values()) {
        entry.pending = null;
        entry.client.stopWatchingStream?.();
        entry.client.disconnect();
    }

    for (const win of streamWindows.values()) {
        if (win && !win.isDestroyed()) win.close();
    }
    streamWindows.clear();

    voiceClients.clear();
    allMuted = false;
    allDeafened = false;
    publishActiveCalls();
}

function stopMicTestInternal() {
    if (micTestRtAudio) {
        try { micTestRtAudio.stop(); } catch (_) { }
        try { micTestRtAudio.closeStream(); } catch (_) { }
        micTestRtAudio = null;
    }

    micTestPipeline?.destroy?.();
    micTestPipeline = null;
    micTestGainProcessor = null;
    log('[Mic-Test] Teste de microfone parado.');
}

async function startMicTestInternal(deviceId) {
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
        micTestPipeline = new AudioPipeline({ frameSize: FRAME_SIZE, channels: CHANNELS, log });
        const rnnoise = new RnnoiseProcessor(log);
        const gain = new GainProcessor(selectedMicGain);
        micTestPipeline.addProcessor('rnnoise', rnnoise);
        micTestPipeline.addProcessor('gain', gain);
        micTestGainProcessor = gain;

        await rnnoise.init();
        rnnoise.enabled = noiseSuppressionEnabled;

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
        gain.setGain(micTestGainPercent);

        log(`[Mic-Test] Capturando: "${deviceName}" → reproduzindo em: "${outName}" (RNNoise=${rnnoise.enabled && rnnoise.available ? 'ON' : 'OFF'}, ganho=${micTestGainPercent}%)`);

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
            if (!micTestRtAudio || !micTestPipeline) return;
            try {
                micTestRtAudio.write(micTestPipeline.processFrame(pcm));
            } catch (error) {
                log(`[Mic-Test] Erro processando áudio: ${error.message}`);
            }
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

/**
 * Muta/desmuta todas as calls ativas. Usado tanto pelo IPC (UI) quanto
 * pelo atalho de teclado global.
 */
function toggleAllMute() {
    allMuted = !allMuted;
    for (const entry of voiceClients.values()) {
        entry.muted = allMuted;
        entry.client.setMute(allMuted);
        applySpeakingState(entry);
    }
    publishActiveCalls();
    notifyShortcutAction(allMuted ? 'Microfone mutado' : 'Microfone reativado');
    return allMuted;
}

/**
 * Ensurdece/reativa todas as calls ativas. Ensurdecer também muta o mic,
 * igual ao comportamento do Discord.
 */
function toggleAllDeafen() {
    allDeafened = !allDeafened;
    for (const entry of voiceClients.values()) {
        entry.deafened = allDeafened;
        entry.client.setDeafen(allDeafened);
        if (allDeafened) entry.muted = true;
        applySpeakingState(entry);
    }
    publishActiveCalls();
    notifyShortcutAction(allDeafened ? 'Áudio ensurdecido' : 'Áudio reativado');
    return allDeafened;
}

function showVoiceJoinError(guild, channel, message) {
    const entry = {
        guildId: guild.id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: channel.name,

        muted: false,
        deafened: false,

        status: 'error',
        error: message,

        inputLevel: 0,
        outputLevel: 0,

        pending: null,
        externallyDisconnected: false,
        streamKey: null,
        streamKeys: new Set(),
        client: null
    };

    voiceClients.set(guild.id, entry);

    publishActiveCalls();

    sendToRenderer(
        'voice:status',
        `Erro ao entrar em ${channel.name}: ${message}`
    );

    log(
        `[Voice] ERRO ao entrar em ${channel.name}: ${message}`
    );

    setTimeout(() => {
        if (voiceClients.get(guild.id) === entry) {
            voiceClients.delete(guild.id);
            publishActiveCalls();
        }
    }, 4000);
}

function startVoiceCall(guild, channel, {
    canConnect = true,
    isFull = false
} = {}) {
    if (!activeToken) {
        log('Carregue os servidores antes de entrar em uma call.');
        return;
    }

    if (!canConnect) {
        showVoiceJoinError(
            guild,
            channel,
            'Você não tem permissão para entrar neste canal.'
        );

        return;
    }

    if (isFull) {
        showVoiceJoinError(
            guild,
            channel,
            'Este canal de voz está cheio.'
        );

        return;
    }

    const entry = {
        guildId: guild.id,
        guildName: guild.name,

        channelId: channel.id,
        channelName: channel.name,

        muted: allMuted,
        deafened: allDeafened,

        status: 'connecting',
        error: null,

        inputLevel: 0,
        outputLevel: 0,

        pending: null,
        externallyDisconnected: false,
        streamKey: null,
        streamKeys: new Set(),
        client: null
    };

    const voiceClient = createVoiceClient({
        token: activeToken,
        guildId: guild.id,
        channelId: channel.id,
        deviceId: selectedMicId,
        gainPercent: selectedMicGain,
        onLog: log,
        onVoiceStateUpdate: (state) => {
            if (voiceClients.get(guild.id) !== entry) return;

            // Cada cliente de voz é associado a uma guild específica.
            // Não processe eventos VOICE_STATE_UPDATE de outras guilds,
            // mesmo que o user_id seja o mesmo.
            if (String(state.guild_id) !== String(guild.id)) return;

            const ownUserId =
                typeof voiceClient.getUserId === 'function'
                    ? voiceClient.getUserId()
                    : null;

            if (ownUserId && state.user_id === ownUserId) {
                const movedTo = state.channel_id ? String(state.channel_id) : null;

                if (movedTo && movedTo !== entry.channelId) {
                    const previousChannelName = entry.channelName;
                    // VOICE_STATE_UPDATE só traz o channel_id. O objeto `guild`
                    // recebido quando a call foi criada pode estar defasado, então
                    // nunca use o ID como nome permanente da call. A UI também
                    // resolve o nome a partir do cache mais recente do Discord.
                    const nextChannel = guild.channels?.[movedTo] || null;
                    const nextChannelName = nextChannel?.name || entry.channelName || 'Canal de voz';

                    log(`[Voice] Discord moveu você de ${previousChannelName} para ${nextChannelName}. Reconectando...`);

                    // Atualizamos a UI imediatamente, mas a reconexão é feita
                    // pelo próprio voice-client usando o mesmo Gateway principal.
                    entry.channelId = movedTo;
                    entry.channelName = nextChannelName;
                    entry.status = 'connecting';
                    entry.error = null;
                    entry.pending = null;
                    publishActiveCalls();

                    if (typeof voiceClient.moveToChannel === 'function') {
                        voiceClient.moveToChannel(movedTo);
                    }

                    sendToRenderer('voice:status', `Você foi movido para ${nextChannelName}. Reconectando...`);
                } else if (!movedTo) {
                    // Remoção feita por outro usuário/admin. Não deixe o
                    // voice-client vivo em estado "error": isso mantém
                    // sockets/áudio antigos e causa o estado quebrado.
                    entry.pending = null;
                    entry.externallyDisconnected = true;
                    entry.status = 'disconnected';
                    entry.error = null;

                    log(`[Voice] Você foi desconectado de ${entry.channelName} externamente.`);

                    if (voiceClients.get(guild.id) === entry) {
                        voiceClients.delete(guild.id);
                    }

                    publishActiveCalls();
                    sendToRenderer('voice:status', 'Você foi desconectado da call por outro usuário.');

                    if (typeof voiceClient.forceDisconnect === 'function') {
                        voiceClient.forceDisconnect('desconectado externamente');
                    } else {
                        voiceClient.disconnect();
                    }
                }
            }
        },
        onSpeaking: (speaking) => {
            if (voiceClients.get(guild.id) !== entry) return;
            if (!speaking?.user_id) return;

            sendToRenderer('voice:speaking', {
                guild_id: guild.id,
                user_id: String(speaking.user_id),
                speaking: Boolean(speaking.speaking)
            });
        },
        onAudioLevel: ({ direction, level }) => {
            if (voiceClients.get(guild.id) !== entry) return;

            const value = Math.max(0, Math.min(1, Number(level) || 0));
            if (direction === 'input') entry.inputLevel = value;
            if (direction === 'output') entry.outputLevel = value;

            const now = Date.now();
            if (!entry._lastAudioPublish || now - entry._lastAudioPublish >= 50) {
                entry._lastAudioPublish = now;
                publishActiveCalls();
            }
        },
        onStreamFrame: (frame) => {
            const streamKey = frame?.streamKey || entry.streamKey;
            if (!streamKey) return;
            sendToStreamWindow(streamKey, 'stream:video-frame', {
                codec: frame.codec,
                key: Boolean(frame.key),
                timestamp: Number(frame.timestamp || 0),
                data: Buffer.from(frame.data || [])
            });
        },
        onStreamStatus: (status) => {
            const streamKey = status?.streamKey || entry.streamKey;
            if (!streamKey) return;
            sendToStreamWindow(streamKey, 'stream:status', status);
        },
        onCameraFrame: (frame) => {
            if (!frame?.userId) return;
            const streamKey = `camera:${guild.id}:${entry.channelId}:${String(frame.userId)}`;
            sendToStreamWindow(streamKey, 'stream:video-frame', {
                codec: frame.codec,
                key: Boolean(frame.key),
                timestamp: Number(frame.timestamp || 0),
                data: Buffer.from(frame.data || [])
            });
        },
        onCameraStatus: (status) => {
            if (!status?.userId) return;
            const streamKey = `camera:${guild.id}:${entry.channelId}:${String(status.userId)}`;
            sendToStreamWindow(streamKey, 'stream:status', {
                ...status,
                streamKey
            });
        },
        onReady: () => {
            entry.status = 'connected';
            entry.error = null;

            log(
                `Conectado em ${entry.channelName} (${guild.name}).`
            );

            applyMicToClient(voiceClient);
            applyGainToClient(voiceClient);
            applyNoiseSuppressionToClient(voiceClient);
            applySpeakingState(entry);

            publishActiveCalls();

            sendToRenderer(
                'voice:status',
                `Conectado em ${entry.channelName}.`
            );
        },
        onDisconnected: (reason) => {
            if (voiceClients.get(guild.id) !== entry) return;

            // forceDisconnect() usado após um VOICE_STATE_UPDATE externo remove
            // a entrada antes de chegar aqui. Este guard existe para qualquer
            // corrida entre o evento do Discord e o fechamento dos sockets.
            if (entry.externallyDisconnected) {
                voiceClients.delete(guild.id);
                entry.pending = null;
                entry.status = 'disconnected';
                entry.error = null;
                publishActiveCalls();
                return;
            }

            const nextChannel = entry.pending;

            // Troca de canal: não é erro.
            if (nextChannel) {
                entry.pending = null;

                voiceClients.delete(guild.id);
                publishActiveCalls();

                startVoiceCall(guild, nextChannel);
                return;
            }

            // Se nunca chegou a ficar conectado, foi uma falha de conexão.
            if (entry.status === 'connecting') {
                entry.status = 'error';
                entry.error = reason || 'Falha desconhecida';

                publishActiveCalls();

                log(
                    `[Voice] Erro ao conectar em ${channel.name}: ${reason || 'falha desconhecida'}`
                );

                sendToRenderer(
                    'voice:status',
                    `Erro ao conectar em ${entry.channelName}.`
                );

                // Deixa o erro visível por alguns segundos.
                setTimeout(() => {
                    if (voiceClients.get(guild.id) === entry) {
                        voiceClients.delete(guild.id);
                        publishActiveCalls();
                    }
                }, 4000);

                return;
            }

            // Já estava conectado e perdeu a conexão.
            entry.status = 'error';
            entry.error = reason || 'Conexão perdida';

            publishActiveCalls();

            log(
                `[Voice] Conexão perdida em ${entry.channelName}: ${reason || 'motivo desconhecido'}`
            );

            sendToRenderer(
                'voice:status',
                `Erro: conexão com ${entry.channelName} foi perdida.`
            );

            setTimeout(() => {
                if (voiceClients.get(guild.id) === entry) {
                    voiceClients.delete(guild.id);
                    publishActiveCalls();
                }
            }, 4000);
        },
        onJoinError: (reason) => {
            if (voiceClients.get(guild.id) !== entry) {
                return;
            }

            entry.status = 'error';
            entry.error = reason;

            publishActiveCalls();

            sendToRenderer(
                'voice:status',
                `Erro ao entrar em ${entry.channelName}: ${reason}`
            );

            log(
                `[Voice] ERRO ao entrar em ${channel.name}: ${reason}`
            );

            setTimeout(() => {
                if (voiceClients.get(guild.id) === entry) {
                    voiceClients.delete(guild.id);
                    publishActiveCalls();
                }
            }, 4000);
        },
    });

    entry.client = voiceClient;
    entry.status = 'connecting';

    voiceClients.set(guild.id, entry);
    publishActiveCalls();

    sendToRenderer(
        'voice:status',
        `Conectando em ${channel.name}...`
    );

    voiceClient.connect();

    if (entry.muted) voiceClient.setMute(true);
    if (entry.deafened) voiceClient.setDeafen(true);
}

/**
 * Inicia uma call de voz em uma DM ou grupo de DM. Diferente de
 * startVoiceCall(), não há guild_id (o Discord usa guild_id: null pra
 * chamadas privadas), nem verificação de permissão/lotação, nem
 * transmissão de tela/câmera — só o áudio, como pedido.
 */
function startDmVoiceCall(dmChannel) {
    if (!activeToken) {
        log('Carregue os servidores antes de entrar em uma call.');
        return;
    }

    const channelId = dmChannel.id;
    const displayName = dmChannel.name || 'Chamada de voz';

    const entry = {
        guildId: null,
        guildName: null,

        isDm: true,
        dmName: displayName,
        dmAvatarUrl: dmChannel.avatarUrl || null,
        dmType: dmChannel.type,

        channelId,
        channelName: displayName,

        muted: allMuted,
        deafened: allDeafened,

        status: 'connecting',
        error: null,

        inputLevel: 0,
        outputLevel: 0,

        // Estado de voz dos OUTROS participantes da chamada (DM ou grupo).
        // Chave: user_id (string) -> { selfMute, selfDeaf, selfVideo, selfStream, mute, deaf }.
        // Alimentado pelos VOICE_STATE_UPDATE recebidos nesta sessão de gateway
        // dedicada da call (própria conexão criada abaixo). Não inclui o próprio
        // usuário: o front usa `entry.muted`/`entry.deafened` para o "eu".
        voiceStates: {},

        pending: null,
        externallyDisconnected: false,
        streamKey: null,
        streamKeys: new Set(),
        client: null
    };

    const voiceClient = createVoiceClient({
        token: activeToken,
        guildId: null,
        channelId,
        deviceId: selectedMicId,
        gainPercent: selectedMicGain,
        onLog: log,
        onVoiceStateUpdate: (state) => {
            if (voiceClients.get(channelId) !== entry) return;

            // Só nos interessam updates de chamada privada (guild_id null).
            if (state.guild_id) return;

            const ownUserId =
                typeof voiceClient.getUserId === 'function'
                    ? voiceClient.getUserId()
                    : null;

            if (ownUserId && state.user_id === ownUserId && !state.channel_id) {
                // Alguém encerrou a chamada, ou o Discord recusou a entrada.
                entry.pending = null;
                entry.externallyDisconnected = true;
                entry.status = 'disconnected';
                entry.error = null;

                log(`[Voice] Você foi desconectado da call em ${entry.channelName} externamente.`);

                if (voiceClients.get(channelId) === entry) {
                    voiceClients.delete(channelId);
                }

                publishActiveCalls();
                sendToRenderer('voice:status', 'Você foi desconectado da call por outro usuário.');

                if (typeof voiceClient.forceDisconnect === 'function') {
                    voiceClient.forceDisconnect('desconectado externamente');
                } else {
                    voiceClient.disconnect();
                }

                return;
            }

            // Daqui pra baixo: voice state de outro participante da call
            // (ou o nosso próprio, com channel_id preenchido — ignorado, pois
            // o "eu" já é representado por entry.muted/entry.deafened).
            if (ownUserId && state.user_id === ownUserId) return;

            const userId = String(state.user_id);

            if (state.channel_id === channelId) {
                // Entrou na call ou atualizou mute/deaf/vídeo/stream.
                entry.voiceStates[userId] = {
                    userId,
                    selfMute: Boolean(state.self_mute),
                    selfDeaf: Boolean(state.self_deaf),
                    selfVideo: Boolean(state.self_video),
                    selfStream: Boolean(state.self_stream),
                    mute: Boolean(state.mute),
                    deaf: Boolean(state.deaf)
                };

                log(`[Voice] ${userId} entrou na call de ${entry.channelName}.`);
            } else {
                // Saiu da call (channel_id null ou trocou de canal).
                if (entry.voiceStates[userId]) {
                    delete entry.voiceStates[userId];
                    log(`[Voice] ${userId} saiu da call de ${entry.channelName}.`);
                }
            }

            publishActiveCalls();
        },
        onSpeaking: (speaking) => {
            if (voiceClients.get(channelId) !== entry) return;
            if (!speaking?.user_id) return;

            sendToRenderer('voice:speaking', {
                guild_id: null,
                channel_id: channelId,
                user_id: String(speaking.user_id),
                speaking: Boolean(speaking.speaking)
            });
        },
        onAudioLevel: ({ direction, level }) => {
            if (voiceClients.get(channelId) !== entry) return;

            const value = Math.max(0, Math.min(1, Number(level) || 0));
            if (direction === 'input') entry.inputLevel = value;
            if (direction === 'output') entry.outputLevel = value;

            const now = Date.now();
            if (!entry._lastAudioPublish || now - entry._lastAudioPublish >= 50) {
                entry._lastAudioPublish = now;
                publishActiveCalls();
            }
        },
        onReady: () => {
            entry.status = 'connected';
            entry.error = null;

            log(`Conectado na call de ${entry.channelName}.`);

            applyMicToClient(voiceClient);
            applyGainToClient(voiceClient);
            applyNoiseSuppressionToClient(voiceClient);
            applySpeakingState(entry);

            publishActiveCalls();

            sendToRenderer('voice:status', `Conectado na call de ${entry.channelName}.`);
        },
        onDisconnected: (reason) => {
            if (voiceClients.get(channelId) !== entry) return;

            if (entry.externallyDisconnected) {
                voiceClients.delete(channelId);
                entry.pending = null;
                entry.status = 'disconnected';
                entry.error = null;
                publishActiveCalls();
                return;
            }

            if (entry.status === 'connecting') {
                entry.status = 'error';
                entry.error = reason || 'Falha desconhecida';

                publishActiveCalls();

                log(`[Voice] Erro ao conectar na call de ${entry.channelName}: ${reason || 'falha desconhecida'}`);
                sendToRenderer('voice:status', `Erro ao conectar na call de ${entry.channelName}.`);

                setTimeout(() => {
                    if (voiceClients.get(channelId) === entry) {
                        voiceClients.delete(channelId);
                        publishActiveCalls();
                    }
                }, 4000);

                return;
            }

            entry.status = 'error';
            entry.error = reason || 'Conexão perdida';

            publishActiveCalls();

            log(`[Voice] Conexão perdida na call de ${entry.channelName}: ${reason || 'motivo desconhecido'}`);
            sendToRenderer('voice:status', `Erro: conexão com a call de ${entry.channelName} foi perdida.`);

            setTimeout(() => {
                if (voiceClients.get(channelId) === entry) {
                    voiceClients.delete(channelId);
                    publishActiveCalls();
                }
            }, 4000);
        },
        onJoinError: (reason) => {
            if (voiceClients.get(channelId) !== entry) return;

            entry.status = 'error';
            entry.error = reason;

            publishActiveCalls();

            sendToRenderer('voice:status', `Erro ao entrar na call de ${entry.channelName}: ${reason}`);
            log(`[Voice] ERRO ao entrar na call de ${entry.channelName}: ${reason}`);

            setTimeout(() => {
                if (voiceClients.get(channelId) === entry) {
                    voiceClients.delete(channelId);
                    publishActiveCalls();
                }
            }, 4000);
        }
    });

    entry.client = voiceClient;
    entry.status = 'connecting';

    voiceClients.set(channelId, entry);
    publishActiveCalls();

    sendToRenderer('voice:status', `Conectando na call de ${entry.channelName}...`);

    voiceClient.connect();

    if (entry.muted) voiceClient.setMute(true);
    if (entry.deafened) voiceClient.setDeafen(true);
}

function createLogsWindow() {
    if (!mainWindow) return;

    const mainBounds = mainWindow.getBounds();
    const logsWidth = 420;

    logsWindow = new BrowserWindow({
        x: mainBounds.x + mainBounds.width,
        y: mainBounds.y,
        width: logsWidth,
        height: mainBounds.height,
        minWidth: 300,
        minHeight: 300,
        title: 'Discord Voice Pro — Logs',
        backgroundColor: '#1e1f22',
        icon: "./assets/logo.png",
        parent: mainWindow,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'src', 'app', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    logsWindow.setMenuBarVisibility(false);
    logsWindow.loadFile(path.join(__dirname, 'src', 'dist', 'logs.html'));

    logsWindow.once('ready-to-show', () => {
        logsWindow.show();
    });

    logsWindow.on('closed', () => {
        logsWindow = null;
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1024,
        height: 950,
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
        sendToRenderer('voice:defaults', { token: defaultToken || '' });
        sendToRenderer('voice:shortcuts', { ...shortcuts });
        publishActiveCalls();
    });

    mainWindow.on('move', () => {
        // Mantém a janela de logs "grudada" à direita da janela principal.
        if (!logsWindow || logsWindow.isDestroyed()) return;
        const mainBounds = mainWindow.getBounds();
        logsWindow.setPosition(mainBounds.x + mainBounds.width, mainBounds.y);
    });

    mainWindow.on('close', () => {
        stopMicTestInternal();
        stopAllVoiceClients();
        stopBrowserClient();

        if (logsWindow && !logsWindow.isDestroyed()) {
            logsWindow.close();
        }

        for (const win of streamWindows.values()) {
            if (win && !win.isDestroyed()) win.close();
        }
        streamWindows.clear();
    });

    createLogsWindow();
}

// ============================================================
// IPC – servidores / calls
// ============================================================

ipcMain.handle('voice:logout', async () => {
    logout();
    return true;
});

ipcMain.handle('open-discord-user', (_, userId) => {
    return shell.openExternal(`discord://-/users/${userId}`);
});

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

ipcMain.handle('voice:set-stream-advanced-controls', async (_event, { enabled } = {}) => {
    streamAdvancedControlsEnabled = Boolean(enabled);
    for (const win of streamWindows.values()) {
        if (!win || win.isDestroyed()) continue;
        win.webContents.send('stream:controls-setting', streamAdvancedControlsEnabled);
    }
    return { ok: true, enabled: streamAdvancedControlsEnabled };
});

ipcMain.handle('voice:watch-stream', async (_event, { guildId, channelId, userId, displayName }) => {
    const entry = voiceClients.get(String(guildId));
    if (!entry?.client || entry.status !== 'connected') {
        return { ok: false, error: 'Você precisa estar conectado à call.' };
    }

    const streamKey = streamWindowKey(guildId, channelId, userId);

    if (!entry.streamKeys) entry.streamKeys = new Set();
    entry.streamKeys.add(streamKey);
    // Mantém o campo legado apenas como referência à última stream aberta;
    // ele não controla mais qual viewer fica ativo.
    entry.streamKey = streamKey;
    const streamWindow = createStreamWindow(streamKey, userId, displayName);

    const startWatching = () => {
        if (!entry.streamKeys?.has(streamKey)) return;
        entry.client.watchStream?.(streamKey, userId);
    };

    if (streamWindow.webContents.isLoading()) {
        streamWindow.webContents.once('did-finish-load', startWatching);
    } else {
        startWatching();
    }

    return { ok: true, streamKey };
});

ipcMain.handle('voice:watch-camera', async (_event, { guildId, channelId, userId, displayName }) => {
    const entry = voiceClients.get(String(guildId));
    if (!entry?.client || entry.status !== 'connected') {
        return { ok: false, error: 'Você precisa estar conectado à call.' };
    }

    const streamKey = `camera:${guildId}:${channelId}:${String(userId)}`;
    if (!entry.cameraKeys) entry.cameraKeys = new Set();
    entry.cameraKeys.add(streamKey);

    const streamWindow = createStreamWindow(streamKey, userId, displayName || 'Câmera');

    const startWatching = () => {
        if (!entry.cameraKeys?.has(streamKey)) return;
        entry.client.watchCamera?.(String(userId));
    };

    if (streamWindow.webContents.isLoading()) {
        streamWindow.webContents.once('did-finish-load', startWatching);
    } else {
        startWatching();
    }

    return { ok: true, streamKey };
});

ipcMain.handle('voice:stop-watch-camera', async (_event, { streamKey }) => {
    const key = String(streamKey || '');
    for (const entry of voiceClients.values()) {
        if (entry.cameraKeys?.has(key)) {
            entry.client?.stopWatchingCamera?.(key.split(':')[3]);
            entry.cameraKeys.delete(key);
        }
    }
    const win = streamWindows.get(key);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
});

ipcMain.handle('voice:stop-watch-stream', async (_event, { streamKey }) => {
    const key = String(streamKey || '');
    for (const entry of voiceClients.values()) {
        if (entry.streamKeys?.has(key)) {
            entry.client?.stopWatchingStream?.(key);
            entry.streamKeys.delete(key);
            if (entry.streamKey === key) {
                entry.streamKey = entry.streamKeys.values().next().value || null;
            }
        }
    }

    const win = streamWindows.get(key);
    if (win && !win.isDestroyed()) win.close();

    return { ok: true };
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
    sendToRenderer(
        'voice:status',
        `Conectando em ${channel.name}...`
    );
    publishActiveCalls();
});

ipcMain.handle('voice:join-dm-call', async (_event, { channel } = {}) => {
    if (!channel?.id) return;

    const existing = voiceClients.get(channel.id);
    if (existing) return; // já conectado (ou conectando) nessa DM

    sendToRenderer('voice:status', `Entrando na call de ${channel.name || 'DM'}...`);
    startDmVoiceCall(channel);
});

ipcMain.handle('voice:leave-call', async (_event, { guildId }) => {
    const entry = voiceClients.get(guildId);
    if (!entry) return;

    entry.pending = null;
    voiceClients.delete(guildId);
    entry.client.disconnect();
    sendToRenderer('voice:status', `Saiu da call de ${entry.guildName || entry.dmName || entry.channelName}.`);
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

ipcMain.handle('voice:leave-all-calls', async () => {
    if (!voiceClients.size) return;

    stopAllVoiceClients();
    sendToRenderer('voice:status', 'Você saiu de todas as calls.');
    log('[Voice] Saiu de todas as calls ativas.');
});

ipcMain.handle('voice:set-all-mute', async () => {
    toggleAllMute();
});

ipcMain.handle('voice:set-all-deafen', async () => {
    toggleAllDeafen();
});

// ============================================================
// IPC – atalhos de teclado globais
// ============================================================

ipcMain.handle('shortcuts:get', async () => ({ ...shortcuts }));

/**
 * Troca o accelerator de uma ação ('toggleMute' | 'toggleDeafen').
 * Envie accelerator = '' para desativar o atalho daquela ação.
 * Formato do accelerator segue o padrão do Electron, ex: "CommandOrControl+Shift+M".
 */
ipcMain.handle('shortcuts:set', async (_event, { action, accelerator } = {}) => {
    if (action !== 'toggleMute' && action !== 'toggleDeafen') {
        return { ok: false, error: 'Ação de atalho inválida.' };
    }

    const value = String(accelerator || '').trim();
    const other = action === 'toggleMute' ? shortcuts.toggleDeafen : shortcuts.toggleMute;

    if (value && value === other) {
        return { ok: false, error: 'Esse atalho já está em uso pela outra ação.' };
    }

    // Testa se o accelerator é válido/livre antes de confirmar a troca:
    // libera tudo, tenta registrar o novo valor sozinho e já desregistra.
    globalShortcut.unregisterAll();
    let valid = true;
    if (value) {
        valid = globalShortcut.register(value, () => { });
        if (valid) globalShortcut.unregister(value);
    }

    if (!valid) {
        registerGlobalShortcuts(); // restaura os atalhos anteriores
        return { ok: false, error: 'Combinação inválida ou já usada por outro programa.' };
    }

    shortcuts = { ...shortcuts, [action]: value };
    saveShortcuts();
    const registered = registerGlobalShortcuts();

    return { ok: true, shortcuts: { ...shortcuts }, registered };
});

ipcMain.handle('shortcuts:reset', async () => {
    shortcuts = { ...DEFAULT_SHORTCUTS };
    saveShortcuts();
    const registered = registerGlobalShortcuts();
    return { ok: true, shortcuts: { ...shortcuts }, registered };
});

/**
 * Pausa os atalhos globais enquanto a UI está gravando uma combinação nova.
 * Sem isso, apertar o atalho atual durante a gravação executaria a ação
 * (mutar/ensurdecer) ao mesmo tempo em que está sendo capturada como tecla.
 */
ipcMain.handle('shortcuts:suspend', async () => {
    shortcutsSuspended = true;
    globalShortcut.unregisterAll();
    return true;
});

ipcMain.handle('shortcuts:resume', async () => {
    shortcutsSuspended = false;
    registerGlobalShortcuts();
    return true;
});

// ============================================================
// IPC – microfone
// ============================================================

function applyNoiseSuppressionToClient(client) {
    if (!client) return;
    if (typeof client.setNoiseSuppression === 'function') {
        client.setNoiseSuppression(noiseSuppressionEnabled);
    }
}


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
    micTestGainProcessor?.setGain(selectedMicGain);

    log(`[Mic] Ganho definido: ${selectedMicGain}%`);

    for (const entry of voiceClients.values()) {
        applyGainToClient(entry.client);
        applyNoiseSuppressionToClient(entry.client);
    }

    return selectedMicGain;
});

ipcMain.handle('voice:set-noise-suppression', async (_event, enabled) => {
    noiseSuppressionEnabled = Boolean(enabled);
    if (micTestPipeline) {
        const rnnoise = micTestPipeline.processors?.get?.('rnnoise');
        if (rnnoise) rnnoise.enabled = noiseSuppressionEnabled;
    }
    for (const entry of voiceClients.values()) {
        applyNoiseSuppressionToClient(entry.client);
    }
    log(`[Mic] Supressão de ruído ${noiseSuppressionEnabled ? 'ativada' : 'desativada'}.`);
    publishActiveCalls();
    return noiseSuppressionEnabled;
});

ipcMain.handle('voice:get-noise-suppression', async () => noiseSuppressionEnabled);

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

app.whenReady().then(() => {
    loadShortcuts();
    registerGlobalShortcuts();
    createWindow();
});

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
    } else if (mainWindow && (!logsWindow || logsWindow.isDestroyed())) {
        createLogsWindow();
    }
});

app.on('will-quit', () => {
    // Evita que os atalhos globais fiquem "presos" no SO após o app fechar.
    globalShortcut.unregisterAll();
});

process.on('SIGINT', () => {
    globalShortcut.unregisterAll();
    stopMicTestInternal();
    stopAllVoiceClients();
    stopBrowserClient();
    setTimeout(() => process.exit(0), 100);
});