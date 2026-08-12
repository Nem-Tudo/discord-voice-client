'use strict';

const {
    QMainWindow, QWidget, QBoxLayout, Direction, QLineEdit,
    QPushButton, QLabel, QTextEdit, QIcon, QSize, QScrollArea,
    QPixmap, WidgetEventTypes
} = require('@nodegui/nodegui');
const path = require('path');
const https = require('https');
const { createVoiceClient } = require('./src/voice-client.js');

const [, , ARG_TOKEN] = process.argv;
const ASSETS_BASE = path.join(__dirname, 'assets');
const iconMicOn = new QIcon(path.join(ASSETS_BASE, 'mic_on.png'));
const iconMicOff = new QIcon(path.join(ASSETS_BASE, 'mic_off.png'));
const iconDeafenOn = new QIcon(path.join(ASSETS_BASE, 'deafen_on.png'));
const iconDeafenOff = new QIcon(path.join(ASSETS_BASE, 'deafen_off.png'));
const ICON_SIZE = new QSize(20, 20);

const win = new QMainWindow();
win.setWindowTitle('Discord Voice');
win.setFixedSize(460, 640);
const central = new QWidget();
central.setObjectName('central');
const root = new QBoxLayout(Direction.TopToBottom);
root.setSpacing(10); root.setContentsMargins(16, 16, 16, 16); central.setLayout(root);

function makeField(labelText, defaultValue) {
    const wrapper = new QWidget(); const layout = new QBoxLayout(Direction.TopToBottom);
    layout.setSpacing(4); layout.setContentsMargins(0, 0, 0, 0); wrapper.setLayout(layout);
    const label = new QLabel(); label.setText(labelText); label.setObjectName('fieldLabel');
    const input = new QLineEdit(); input.setObjectName('fieldInput'); input.setPlaceholderText(labelText);
    if (defaultValue) input.setText(defaultValue);
    layout.addWidget(label); layout.addWidget(input); return { wrapper, input };
}

const tokenField = makeField('Token', ARG_TOKEN);
tokenField.input.setEchoMode(2);
root.addWidget(tokenField.wrapper);
const loadBtn = new QPushButton(); loadBtn.setText('Carregar servidores'); loadBtn.setObjectName('connectBtn'); root.addWidget(loadBtn);
const statusLabel = new QLabel(); statusLabel.setText('Informe o token para começar'); statusLabel.setObjectName('statusLabel'); root.addWidget(statusLabel);

const view = new QScrollArea(); view.setWidgetResizable(true); view.setObjectName('contentScroll'); root.addWidget(view, 1);
const logArea = new QTextEdit(); logArea.setReadOnly(true); logArea.setObjectName('logArea'); logArea.setMaximumHeight(92); root.addWidget(logArea);

const controls = new QWidget(); const controlsLayout = new QBoxLayout(Direction.LeftToRight);
controlsLayout.setContentsMargins(0, 0, 0, 0); controls.setLayout(controlsLayout);
const muteBtn = new QPushButton(); muteBtn.setObjectName('controlIconButton'); muteBtn.setIcon(iconMicOn); muteBtn.setIconSize(ICON_SIZE);
const deafenBtn = new QPushButton(); deafenBtn.setObjectName('controlIconButton'); deafenBtn.setIcon(iconDeafenOff); deafenBtn.setIconSize(ICON_SIZE);
const disconnectBtn = new QPushButton(); disconnectBtn.setText('Desconectar'); disconnectBtn.setObjectName('disconnectBtn');
controlsLayout.addWidget(muteBtn); controlsLayout.addWidget(deafenBtn); controlsLayout.addStretch(1); controlsLayout.addWidget(disconnectBtn);
root.addWidget(controls); controls.hide();
win.setCentralWidget(central);

central.setStyleSheet(`
 #central { background-color:#313338; } #fieldLabel { color:#b5bac1; font-size:11px; font-weight:bold; }
 #fieldInput { background:#1e1f22; color:#f2f3f5; border-radius:4px; padding:8px; border:1px solid #1e1f22; font-size:13px; }
 #fieldInput:focus { border:1px solid #00a8fc; } #connectBtn { background:#5865f2; color:white; font-weight:bold; padding:10px; border-radius:6px; font-size:14px; }
 #connectBtn:hover { background:#4752c4; } #connectBtn:disabled { background:#4a4d52; color:#949ba4; } #statusLabel { color:#b5bac1; font-size:12px; }
 #contentScroll, #logArea { background:#1e1f22; color:#dbdee1; border:0; border-radius:5px; font-size:11px; padding:4px; }
 #content { background:#1e1f22; } #sectionTitle { color:#f2f3f5; font-size:16px; font-weight:bold; padding:8px; }
 #serverButton, #channelCard { background:#2b2d31; color:#f2f3f5; border:0; border-radius:6px; padding:10px; text-align:left; font-size:14px; }
 #serverButton:hover, #channelCard:hover { background:#3f4147; } #channelName { color:#b5bac1; font-size:13px; font-weight:bold; }
 #member { color:#dbdee1; padding:4px 8px; } #avatar { background:#5865f2; color:white; border-radius:16px; font-weight:bold; padding:7px; min-width:18px; }
 #muted { color:#f23f42; font-size:11px; } #controlIconButton { background:transparent; border:0; padding:6px; border-radius:5px; } #controlIconButton:hover { background:#4e5058; }
 #disconnectBtn { background:#da373c; color:white; font-weight:bold; padding:8px 14px; border-radius:6px; border:0; }
`);

let client = null, muted = false, deafened = false, currentWidget = null;
const guilds = new Map();

function log(message) { logArea.append(`[${new Date().toLocaleTimeString('pt-BR')}] ${message}`); }
function setView(widget) {
    const previous = view.takeWidget();
    view.setWidget(widget); currentWidget = widget;
    if (previous) previous.deleteLater();
}
function makePage(title) {
    const page = new QWidget(); page.setObjectName('content'); const layout = new QBoxLayout(Direction.TopToBottom);
    layout.setContentsMargins(8, 8, 8, 8); layout.setSpacing(6); page.setLayout(layout);
    const heading = new QLabel(); heading.setText(title); heading.setObjectName('sectionTitle'); layout.addWidget(heading);
    return { page, layout };
}
function avatarUrl(user, guildId) {
    if (!user || !user.id) return null;
    const hash = user.avatar;
    return hash ? `https://cdn.discordapp.com/avatars/${user.id}/${hash}.png?size=64` : null;
}
function applyAvatar(label, user) {
    const name = user?.global_name || user?.username || '?';
    label.setText(name.slice(0, 1).toUpperCase());
    const url = avatarUrl(user);
    if (!url) return;
    https.get(url, response => { const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => {
        if (!currentWidget || !label) return; const pixmap = new QPixmap();
        if (pixmap.loadFromData(Buffer.concat(chunks), 'PNG')) { label.setPixmap(pixmap.scaled(32, 32)); }
    }); }).on('error', () => {});
}
function normalizeGuild(data) {
    if (!data?.id) return;
    const existing = guilds.get(data.id) || { channels: new Map(), voiceStates: new Map() };
    existing.id = data.id; existing.name = data.name || existing.name || 'Servidor sem nome'; existing.icon = data.icon || existing.icon;
    for (const channel of data.channels || []) if (channel.type === 2) existing.channels.set(channel.id, channel);
    for (const state of data.voice_states || []) existing.voiceStates.set(state.user_id, state);
    guilds.set(data.id, existing);
}
function showServers() {
    const { page, layout } = makePage('Escolha um servidor');
    // READY já contém todos os servidores, enquanto GUILD_CREATE (que traz
    // os canais) pode chegar alguns instantes depois. Não escondemos a lista
    // enquanto esses eventos adicionais ainda estão sendo recebidos.
    const available = [...guilds.values()];
    if (!available.length) { const empty = new QLabel(); empty.setText('Aguardando os servidores do Discord...'); empty.setObjectName('member'); layout.addWidget(empty); }
    for (const guild of available.sort((a, b) => a.name.localeCompare(b.name))) {
        const button = new QPushButton(); button.setText(guild.name); button.setObjectName('serverButton');
        button.addEventListener('clicked', () => selectGuild(guild.id)); layout.addWidget(button);
    }
    layout.addStretch(1); setView(page); statusLabel.setText(`${available.length} servidor(es) carregado(s)`);
}
function selectGuild(guildId) {
    const guild = guilds.get(guildId); if (!guild) return;
    // Mantém somente o servidor selecionado e libera os dados das listas anteriores.
    guilds.clear(); guilds.set(guildId, guild);
    const { page, layout } = makePage(guild.name);
    const back = new QPushButton(); back.setText('← Servidores'); back.setObjectName('serverButton'); back.addEventListener('clicked', showServers); layout.addWidget(back);
    const channels = [...guild.channels.values()].sort((a, b) => a.position - b.position);
    for (const channel of channels) {
        const card = new QWidget(); card.setObjectName('channelCard'); const cardLayout = new QBoxLayout(Direction.TopToBottom); cardLayout.setContentsMargins(6, 6, 6, 6); card.setLayout(cardLayout);
        const title = new QLabel(); title.setText(`🔊 ${channel.name}`); title.setObjectName('channelName'); cardLayout.addWidget(title);
        const members = [...guild.voiceStates.values()].filter(state => state.channel_id === channel.id);
        if (!members.length) { const empty = new QLabel(); empty.setText('Nenhum membro conectado'); empty.setObjectName('member'); cardLayout.addWidget(empty); }
        for (const state of members) {
            const row = new QWidget(); const rowLayout = new QBoxLayout(Direction.LeftToRight); rowLayout.setContentsMargins(4, 2, 4, 2); row.setLayout(rowLayout);
            const avatar = new QLabel(); avatar.setObjectName('avatar'); avatar.setFixedSize(32, 32); applyAvatar(avatar, state.member?.user); rowLayout.addWidget(avatar);
            const name = new QLabel(); name.setText(state.member?.nick || state.member?.user?.global_name || state.member?.user?.username || state.user_id); name.setObjectName('member'); rowLayout.addWidget(name, 1);
            const flags = []; if (state.self_mute || state.mute) flags.push('🎙 Mutado'); if (state.self_deaf || state.deaf) flags.push('🔇 Ensurdecido');
            if (flags.length) { const stateLabel = new QLabel(); stateLabel.setText(flags.join(' · ')); stateLabel.setObjectName('muted'); rowLayout.addWidget(stateLabel); }
            cardLayout.addWidget(row);
        }
        layout.addWidget(card);
    }
    layout.addStretch(1); setView(page); statusLabel.setText('Canais de voz e membros atualizados em tempo real');
}
function updateVoiceState(state) {
    const guild = guilds.get(state.guild_id); if (!guild) return;
    if (!state.channel_id) guild.voiceStates.delete(state.user_id); else guild.voiceStates.set(state.user_id, state);
    // A tela do servidor é recriada somente quando ela está visível, liberando widgets antigos.
    if (guilds.size === 1) selectGuild(guild.id);
}
function updateButtonIcons() { muteBtn.setIcon(muted ? iconMicOff : iconMicOn); deafenBtn.setIcon(deafened ? iconDeafenOn : iconDeafenOff); }

loadBtn.addEventListener('clicked', () => {
    const token = tokenField.input.text().trim(); if (!token) return log('Informe o token antes de carregar os servidores.');
    if (client) client.disconnect(); guilds.clear(); loadBtn.setEnabled(false); loadBtn.setText('Carregando...'); statusLabel.setText('Conectando ao Discord...');
    client = createVoiceClient({ token,
        onLog: log,
        onGatewayReady: ready => {
            // Em algumas conexões o Discord atrasa GUILD_CREATE. READY contém
            // ao menos id, nome e ícone de cada servidor, então a tela pode
            // aparecer imediatamente.
            for (const guild of ready.guilds || []) normalizeGuild(guild);
            log(`Logado como ${ready.user.username}`);
            showServers();
        },
        onGuildCreate: guild => { normalizeGuild(guild); showServers(); },
        onVoiceStateUpdate: updateVoiceState,
        onDisconnected: reason => { log(`Desconectado (${reason})`); client = null; loadBtn.setEnabled(true); loadBtn.setText('Carregar servidores'); tokenField.input.setEnabled(true); controls.hide(); }
    });
    tokenField.input.setEnabled(false); client.connect();
});
muteBtn.addEventListener('clicked', () => { if (!client) return; muted = !muted; client.setMute(muted); updateButtonIcons(); });
deafenBtn.addEventListener('clicked', () => { if (!client) return; deafened = !deafened; if (deafened) muted = true; else muted = false; client.setDeafen(deafened); client.setMute(muted); updateButtonIcons(); });
disconnectBtn.addEventListener('clicked', () => client?.disconnect());
win.addEventListener(WidgetEventTypes.Close, () => client?.disconnect());
process.on('SIGINT', () => { client?.disconnect(); setTimeout(() => process.exit(0), 100); });
const initial = makePage('Servidores'); const initialText = new QLabel(); initialText.setText('Informe seu token para listar os servidores.'); initialText.setObjectName('member'); initial.layout.addWidget(initialText); setView(initial.page);
win.show(); global.win = win;
