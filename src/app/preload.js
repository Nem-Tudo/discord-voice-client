'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('discordVoice', {
    loadServers(data) {
        return ipcRenderer.invoke('voice:load-servers', data);
    },
    logout() {
        return ipcRenderer.invoke('voice:logout');
    },
    joinCall(data) {
        return ipcRenderer.invoke('voice:join-call', data);
    },
    leaveCall(guildId) {
        return ipcRenderer.invoke('voice:leave-call', { guildId });
    },
    toggleCallMute(guildId) {
        return ipcRenderer.invoke('voice:set-call-mute', { guildId });
    },
    toggleCallDeafen(guildId) {
        return ipcRenderer.invoke('voice:set-call-deafen', { guildId });
    },
    toggleAllMute() {
        return ipcRenderer.invoke('voice:set-all-mute');
    },
    toggleAllDeafen() {
        return ipcRenderer.invoke('voice:set-all-deafen');
    },
    onDefaults(callback) {
        return subscribe('voice:defaults', callback);
    },
    onLog(callback) {
        return subscribe('voice:log', callback);
    },
    onStatus(callback) {
        return subscribe('voice:status', callback);
    },
    onBrowserReset(callback) {
        return subscribe('voice:browser-reset', callback);
    },
    onLogout(callback) {
        return subscribe('voice:logout', callback);
    },
    onGatewayReady(callback) {
        return subscribe('voice:gateway-ready', callback);
    },
    onGuildCreate(callback) {
        return subscribe('voice:guild-create', callback);
    },
    onVoiceStateUpdate(callback) {
        return subscribe('voice:voice-state', callback);
    },
    onSpeaking(callback) {
        return subscribe('voice:speaking', callback);
    },
    onActiveCalls(callback) {
        return subscribe('voice:active-calls', callback);
    },
    listMics: () => ipcRenderer.invoke('voice:list-mics'),
    setMic: (deviceId) => ipcRenderer.invoke('voice:set-mic', deviceId),
    setMicGain: (percent) => ipcRenderer.invoke('voice:set-mic-gain', percent),
    startMicTest: (deviceId) => ipcRenderer.invoke('voice:start-mic-test', deviceId),
    stopMicTest: () => ipcRenderer.invoke('voice:stop-mic-test'),
    openDiscordUser: (userId) => ipcRenderer.invoke('open-discord-user', userId)
});