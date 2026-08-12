'use strict';

const tokenInput = document.getElementById('tokenInput');
const guildInput = document.getElementById('guildInput');
const channelInput = document.getElementById('channelInput');
const connectForm = document.getElementById('connectForm');
const connectBtn = document.getElementById('connectBtn');
const statusLabel = document.getElementById('statusLabel');
const logArea = document.getElementById('logArea');
const controls = document.getElementById('controls');
const muteBtn = document.getElementById('muteBtn');
const deafenBtn = document.getElementById('deafenBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const muteIcon = document.getElementById('muteIcon');
const deafenIcon = document.getElementById('deafenIcon');

const iconPaths = {
    micOn: '../assets/mic_on.png',
    micOff: '../assets/mic_off.png',
    deafenOn: '../assets/deafen_on.png',
    deafenOff: '../assets/deafen_off.png'
};

function setFieldsEnabled(enabled) {
    tokenInput.disabled = !enabled;
    guildInput.disabled = !enabled;
    channelInput.disabled = !enabled;
}

function updateState(state) {
    const isConnected = Boolean(state.connected);
    const isConnecting = Boolean(state.connecting);

    setFieldsEnabled(!isConnected && !isConnecting);
    connectBtn.disabled = isConnected || isConnecting;
    connectBtn.textContent = isConnecting ? 'Conectando...' : (isConnected ? 'Conectado' : 'Conectar');
    statusLabel.textContent = state.status || (isConnected ? 'Conectado a call' : 'Desconectado');
    controls.hidden = !isConnected;

    muteIcon.src = state.muted ? iconPaths.micOff : iconPaths.micOn;
    deafenIcon.src = state.deafened ? iconPaths.deafenOn : iconPaths.deafenOff;
}

connectForm.addEventListener('submit', (event) => {
    event.preventDefault();

    window.discordVoice.connect({
        token: tokenInput.value.trim(),
        guildId: guildInput.value.trim(),
        channelId: channelInput.value.trim()
    });
});

muteBtn.addEventListener('click', () => {
    window.discordVoice.toggleMute();
});

deafenBtn.addEventListener('click', () => {
    window.discordVoice.toggleDeafen();
});

disconnectBtn.addEventListener('click', () => {
    window.discordVoice.disconnect();
});

window.discordVoice.onDefaults(({ token, guildId, channelId }) => {
    tokenInput.value = token || '';
    guildInput.value = guildId || '';
    channelInput.value = channelId || '';
});

window.discordVoice.onLog((line) => {
    logArea.textContent += `${line}\n`;
    logArea.scrollTop = logArea.scrollHeight;
});

window.discordVoice.onState(updateState);
