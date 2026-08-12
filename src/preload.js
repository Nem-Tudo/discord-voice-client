'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('discordVoice', {
    connect(data) {
        return ipcRenderer.invoke('voice:connect', data);
    },
    disconnect() {
        return ipcRenderer.invoke('voice:disconnect');
    },
    toggleMute() {
        return ipcRenderer.invoke('voice:set-mute');
    },
    toggleDeafen() {
        return ipcRenderer.invoke('voice:set-deafen');
    },
    onDefaults(callback) {
        return subscribe('voice:defaults', callback);
    },
    onLog(callback) {
        return subscribe('voice:log', callback);
    },
    onState(callback) {
        return subscribe('voice:state', callback);
    }
});
