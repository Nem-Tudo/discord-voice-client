'use strict';

const {
    QMainWindow, QWidget, QBoxLayout, Direction, QLineEdit, QPushButton,
    QLabel, QTextEdit, QScrollArea, QPixmap, QIcon, QSize, WidgetEventTypes
} = require('@nodegui/nodegui');
const https = require('https');
const path = require('path');
const { createVoiceClient } = require('./src/voice-client.js');

const [, , ARG_TOKEN] = process.argv;
const ASSETS_BASE = path.join(__dirname, 'assets');
const iconDeafenOn = new QIcon(path.join(ASSETS_BASE, 'deafen_on.png'));
const iconDeafenOff = new QIcon(path.join(ASSETS_BASE, 'deafen_off.png'));
const iconMicOn = new QIcon(path.join(ASSETS_BASE, 'mic_on.png'));
const iconMicOff = new QIcon(path.join(ASSETS_BASE, 'mic_off.png'));
const ICON_SIZE = new QSize(18, 18);
const win = new QMainWindow();
win.setWindowTitle('Discord Voice');
win.setFixedSize(800, 720);
const central = new QWidget(); central.setObjectName('central');
const root = new QBoxLayout(Direction.TopToBottom); root.setContentsMargins(16, 16, 16, 16); root.setSpacing(8); central.setLayout(root);

const tokenLabel = new QLabel(); tokenLabel.setText('TOKEN'); tokenLabel.setObjectName('fieldLabel'); root.addWidget(tokenLabel);
const tokenInput = new QLineEdit(); tokenInput.setObjectName('fieldInput'); tokenInput.setEchoMode(2); tokenInput.setPlaceholderText('Token do Discord'); if (ARG_TOKEN) tokenInput.setText(ARG_TOKEN); root.addWidget(tokenInput);
const loadButton = new QPushButton(); loadButton.setText('Carregar servidores'); loadButton.setObjectName('loadButton'); root.addWidget(loadButton);
const status = new QLabel(); status.setObjectName('status'); status.setText('Informe o token para carregar seus servidores.'); root.addWidget(status);
const browser = new QWidget(); const browserLayout = new QBoxLayout(Direction.LeftToRight); browserLayout.setContentsMargins(0, 0, 0, 0); browserLayout.setSpacing(8); browser.setLayout(browserLayout);
const serverScroll = new QScrollArea(); serverScroll.setObjectName('serverScroll'); serverScroll.setWidgetResizable(true); serverScroll.setFixedWidth(205);
const activeCallsScroll = new QScrollArea(); activeCallsScroll.setObjectName('activeCalls'); activeCallsScroll.setWidgetResizable(true); activeCallsScroll.setFixedWidth(220);
const callsScroll = new QScrollArea(); callsScroll.setObjectName('callsScroll'); callsScroll.setWidgetResizable(true);
browserLayout.addWidget(serverScroll); browserLayout.addWidget(callsScroll, 1); browserLayout.addWidget(activeCallsScroll); root.addWidget(browser, 1);
const logs = new QTextEdit(); logs.setReadOnly(true); logs.setObjectName('logs'); logs.setMaximumHeight(95); root.addWidget(logs);
win.setCentralWidget(central);

central.setStyleSheet(`
 /* Fundo geral da janela e rótulos do campo de token. */
 #central { background:#313338; } #fieldLabel { color:#b5bac1; font-size:11px; font-weight:bold; }
 /* Campo onde o token é digitado. */
 #fieldInput { background:#1e1f22; color:#f2f3f5; border:1px solid #1e1f22; border-radius:5px; padding:8px; }
 /* Botão para carregar/atualizar servidores e texto de status. */
 #fieldInput:focus { border-color:#5865f2; } #loadButton { background:#5865f2; color:white; font-weight:bold; border:0; border-radius:5px; padding:9px; }
 #loadButton:hover { background:#4752c4; } #loadButton:disabled { background:#4e5058; } #status { color:#b5bac1; font-size:12px; }
 /* Fundos das duas colunas (servidores/calls) e da área de logs. */
 #serverScroll, #callsScroll, #logs { background:#1e1f22; color:#dbdee1; border:0; border-radius:6px; }
 /* Painel das calls conectadas: cartões, botões de áudio e saída. */
 #activeCalls { background:#202225; border:0; border-radius:8px; } #columnTitle { color:#b5bac1; font-size:11px; font-weight:bold; padding:7px 5px; }
 #activeCallTitle { color:#ffffff; font-size:14px; font-weight:bold; padding:5px; }
 #activeCallMeta { color:#b5bac1; font-size:12px; padding:2px 5px; } #activeCallCard { background:#2b2d31; border-radius:6px; padding:7px; }
 #muteButton { background:#4e5058; color:#f2f3f5; border:0; border-radius:4px; padding:6px 10px; } #muteButton:hover { background:#686b73; }
 #leaveButton { background:#da373c; color:white; border:0; border-radius:4px; padding:6px 10px; } #leaveButton:hover { background:#a1282c; }
 /* Itens da lista de servidores na lateral esquerda. */
 #page { background:#1e1f22; } #serverItem { background:transparent; border-radius:6px; padding:3px; } #serverButton { background:transparent; color:#dbdee1; border:0; border-radius:6px; text-align:left; padding:6px; }
 #serverButton:hover, #serverButton[selected="true"] { background:#404249; } #serverName { color:#f2f3f5; font-size:13px; font-weight:bold; }
 /* Servidor com call ativa: em vez de fundo verde, o nome do servidor fica verde. */
 #serverButton[connected="true"] #serverName { color:#23a55a; }
 #connectedBadge { background:#23a55a; color:white; border-radius:8px; font-size:10px; font-weight:bold; padding:2px 6px; }
 /* Ícone do servidor mantém o azul da marca; avatar do membro fica discreto. */
 #serverIcon { background:#5865f2; color:white; border-radius:20px; font-size:15px; font-weight:bold; padding:0px; }
 #avatar { background:#3a3c42; color:#dbdee1; border-radius:20px; font-size:15px; font-weight:bold; padding:0px; }
 /* Título do servidor, cartões de canais e informações dos membros. */
 #heading { color:#f2f3f5; font-size:18px; font-weight:bold; padding:8px; } #channelCard { background:#2b2d31; border-radius:6px; padding:8px; } #joinButton { background:transparent; color:#b5bac1; border:0; text-align:left; font-size:13px; font-weight:bold; padding:2px; }
 #joinButton:hover { color:#ffffff; }
 #channelName { color:#b5bac1; font-size:13px; font-weight:bold; } #memberName { color:#f2f3f5; font-size:13px; padding:4px; }
 #memberState { color:#f23f42; font-size:11px; } #empty { color:#949ba4; padding:8px; }
 #deafenButton { background:#4e5058; border:0; border-radius:4px; padding:6px; } #deafenButton:hover { background:#686b73; }
`);

let client = null;
let selectedGuildId = null;
let currentUserId = null;
let activeToken = null;
let serverPage = null;
let callsPage = null;
const guilds = new Map();
const imageDataCache = new Map();
const voiceClients = new Map();
let allMuted = false;
let allDeafened = false;

function log(message) { logs.append(`[${new Date().toLocaleTimeString('pt-BR')}] ${message}`); }
function page() { const widget = new QWidget(); widget.setObjectName('page'); const layout = new QBoxLayout(Direction.TopToBottom); layout.setContentsMargins(8, 8, 8, 8); layout.setSpacing(6); widget.setLayout(layout); return { widget, layout }; }
function replacePage(scroll, widget, oldPageName) { const old = scroll.takeWidget(); scroll.setWidget(widget); if (old) old.deleteLater(); if (oldPageName === 'server') serverPage = widget; else callsPage = widget; }
function initialFor(text) { return String(text || '?').trim().slice(0, 1).toUpperCase() || '?'; }
function fetchImage(url, done) {
    if (!url) return;
    if (imageDataCache.has(url)) return done(imageDataCache.get(url));
    const get = (address, redirects) => https.get(address, { headers: { 'User-Agent': 'DiscordVoiceClient/1.0' } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 3) {
            response.resume(); return get(new URL(response.headers.location, address).toString(), redirects + 1);
        }
        if (response.statusCode !== 200) { response.resume(); return; }
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const data = Buffer.concat(chunks); imageDataCache.set(url, data); done(data); });
    }).on('error', () => {});
    get(url, 0);
}
function setRemoteImage(label, url, size) {
    if (!url) return;
    fetchImage(url, data => {
        const pixmap = new QPixmap();
        // Sem padding no QLabel a imagem ocupa todo o quadrado do avatar.
        if (pixmap.loadFromData(data)) label.setPixmap(pixmap.scaled(size, size));
    });
}
function serverIconUrl(guild) { return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null; }
function userAvatarUrl(user) { return user?.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null; }
function getStateUser(guild, state) { return state.member?.user || guild.users.get(state.user_id); }

// Bits de permissão do Discord. BigInt evita perder precisão em permissões
// modernas, que são representadas como strings de 64 bits pelo Gateway.
const ADMINISTRATOR = 8n;
const VIEW_CHANNEL = 1024n;
const CONNECT = 1048576n;
function permissionBits(value) { try { return BigInt(value || 0); } catch (_) { return 0n; } }
function canEnterVoiceChannel(guild, channel) {
    const member = guild.members.get(currentUserId);
    if (!member) return false;
    if (guild.owner_id === currentUserId) return true;

    const roleIds = new Set([guild.id, ...(member.roles || [])]);
    let permissions = 0n;
    for (const role of guild.roles.values()) if (roleIds.has(role.id)) permissions |= permissionBits(role.permissions);
    if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

    const parent = guild.categories.get(channel.parent_id);
    const overwrites = channel.permission_overwrites?.length
        ? channel.permission_overwrites
        : (parent?.permission_overwrites || []);
    const apply = overwrite => {
        permissions &= ~permissionBits(overwrite.deny);
        permissions |= permissionBits(overwrite.allow);
    };
    const everyone = overwrites.find(overwrite => overwrite.id === guild.id);
    if (everyone) apply(everyone);
    // As sobrescritas de todos os cargos são combinadas primeiro: negações
    // têm precedência, depois permissões explicitamente liberadas por cargos.
    let roleDeny = 0n;
    let roleAllow = 0n;
    for (const overwrite of overwrites) {
        if (overwrite.type === 0 && overwrite.id !== guild.id && roleIds.has(overwrite.id)) {
            roleDeny |= permissionBits(overwrite.deny);
            roleAllow |= permissionBits(overwrite.allow);
        }
    }
    permissions &= ~roleDeny;
    permissions |= roleAllow;
    const memberOverwrite = overwrites.find(overwrite => overwrite.type === 1 && overwrite.id === currentUserId);
    if (memberOverwrite) apply(memberOverwrite);
    return (permissions & VIEW_CHANNEL) === VIEW_CHANNEL && (permissions & CONNECT) === CONNECT;
}

function normalizeGuild(data) {
    if (!data?.id) return;
    const guild = guilds.get(data.id) || { id: data.id, name: 'Carregando servidor...', channels: new Map(), categories: new Map(), voiceStates: new Map(), users: new Map(), roles: new Map(), members: new Map() };
    guild.name = data.name || guild.name; guild.icon = data.icon || guild.icon;
    for (const role of data.roles || []) guild.roles.set(role.id, role);
    for (const member of data.members || []) {
        if (member.user?.id) { guild.users.set(member.user.id, member.user); guild.members.set(member.user.id, member); }
    }
    for (const channel of data.channels || []) {
        if (channel.type === 2) guild.channels.set(channel.id, channel);
        if (channel.type === 4) guild.categories.set(channel.id, channel);
    }
    for (const state of data.voice_states || []) {
        if (state.member?.user?.id) guild.users.set(state.member.user.id, state.member.user);
        guild.voiceStates.set(state.user_id, state);
    }
    guilds.set(guild.id, guild);
}
function addServerButton(layout, guild) {
    const item = new QWidget(); item.setObjectName('serverItem'); const itemLayout = new QBoxLayout(Direction.LeftToRight); itemLayout.setContentsMargins(0, 0, 0, 0); item.setLayout(itemLayout);
    const button = new QPushButton(); button.setObjectName('serverButton'); button.setProperty('selected', String(guild.id === selectedGuildId)); button.setProperty('connected', String(voiceClients.has(guild.id)));
    const row = new QBoxLayout(Direction.LeftToRight); row.setContentsMargins(2, 2, 2, 2); row.setSpacing(8); button.setLayout(row);
    const icon = new QLabel(); icon.setObjectName('serverIcon'); icon.setFixedSize(40, 40); icon.setText(initialFor(guild.name)); setRemoteImage(icon, serverIconUrl(guild), 40); row.addWidget(icon);
    const name = new QLabel(); name.setObjectName('serverName'); name.setText(guild.name); row.addWidget(name, 1);
    button.addEventListener('clicked', () => { selectedGuildId = guild.id; renderBrowser(); }); itemLayout.addWidget(button, 1);
    const entry = voiceClients.get(guild.id);
    if (entry) {
        const leave = new QPushButton(); leave.setObjectName('leaveButton'); leave.setText('Sair'); leave.addEventListener('clicked', () => leaveVoiceCall(guild.id)); itemLayout.addWidget(leave);
    }
    layout.addWidget(item);
}
function renderServers() {
    const { widget, layout } = page();
    const heading = new QLabel(); heading.setObjectName('columnTitle'); heading.setText('SERVIDORES'); layout.addWidget(heading);
    const list = [...guilds.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) { const empty = new QLabel(); empty.setObjectName('empty'); empty.setText('Aguardando servidores...'); layout.addWidget(empty); }
    for (const guild of list) addServerButton(layout, guild);
    layout.addStretch(1); replacePage(serverScroll, widget, 'server');
}
function renderCalls() {
    const { widget, layout } = page(); const guild = guilds.get(selectedGuildId);
    if (!guild) { const empty = new QLabel(); empty.setObjectName('empty'); empty.setText('Selecione um servidor na lateral.'); layout.addWidget(empty); replacePage(callsScroll, widget, 'calls'); return; }
    const columnTitle = new QLabel(); columnTitle.setObjectName('columnTitle'); columnTitle.setText('CANAIS DE VOZ'); layout.addWidget(columnTitle);
    const heading = new QLabel(); heading.setObjectName('heading'); heading.setText(guild.name); layout.addWidget(heading);
    const channels = [...guild.channels.values()].filter(channel => canEnterVoiceChannel(guild, channel)).sort((a, b) => (a.position || 0) - (b.position || 0));
    if (!channels.length) { const empty = new QLabel(); empty.setObjectName('empty'); empty.setText('Você não tem permissão para entrar em nenhuma call deste servidor.'); layout.addWidget(empty); }
    for (const channel of channels) {
        const card = new QWidget(); card.setObjectName('channelCard'); const cardLayout = new QBoxLayout(Direction.TopToBottom); cardLayout.setContentsMargins(6, 6, 6, 6); cardLayout.setSpacing(2); card.setLayout(cardLayout);
        const header = new QWidget(); const headerLayout = new QBoxLayout(Direction.LeftToRight); headerLayout.setContentsMargins(0, 0, 0, 0); header.setLayout(headerLayout);
        const join = new QPushButton(); join.setObjectName('joinButton');
        const activeEntry = voiceClients.get(guild.id);
        join.setText(activeEntry?.channelId === channel.id ? `${channel.name}  •  CONECTADO` : channel.name);
        join.addEventListener('clicked', () => {
            status.setText(`Entrando em ${channel.name}...`);
            connectToVoiceCall(guild, channel);
        });
        headerLayout.addWidget(join, 1);
        if (activeEntry?.channelId === channel.id) {
            const mute = new QPushButton(); mute.setObjectName('muteButton'); mute.setIcon(activeEntry.muted ? iconMicOff : iconMicOn); mute.setIconSize(ICON_SIZE); mute.setToolTip(activeEntry.muted ? 'Reativar microfone' : 'Mutar microfone');
            mute.addEventListener('clicked', () => { activeEntry.muted = !activeEntry.muted; activeEntry.client.setMute(activeEntry.muted); renderActiveCalls(); renderCalls(); });
            headerLayout.addWidget(mute);
            const deafen = new QPushButton(); deafen.setObjectName('deafenButton'); deafen.setIcon(activeEntry.deafened ? iconDeafenOn : iconDeafenOff); deafen.setIconSize(ICON_SIZE); deafen.setToolTip(activeEntry.deafened ? 'Reativar áudio' : 'Ensurdecer');
            deafen.addEventListener('clicked', () => { activeEntry.deafened = !activeEntry.deafened; activeEntry.client.setDeafen(activeEntry.deafened); if (activeEntry.deafened) activeEntry.muted = true; renderActiveCalls(); renderCalls(); });
            headerLayout.addWidget(deafen);
            const leave = new QPushButton(); leave.setObjectName('leaveButton'); leave.setText('Sair'); leave.addEventListener('clicked', () => leaveVoiceCall(guild.id)); headerLayout.addWidget(leave);
        }
        cardLayout.addWidget(header);
        // Clicar em qualquer parte livre do card entra na call, não só no nome do canal.
        // Botões filhos (entrar/mutar/ensurdecer/sair) continuam tratando seus próprios cliques normalmente.
        card.addEventListener(WidgetEventTypes.MouseButtonPress, () => {
            status.setText(`Entrando em ${channel.name}...`);
            connectToVoiceCall(guild, channel);
        });
        const members = [...guild.voiceStates.values()].filter(state => state.channel_id === channel.id);
        if (!members.length) { const empty = new QLabel(); empty.setObjectName('empty'); empty.setText('Nenhum membro conectado'); cardLayout.addWidget(empty); }
        for (const state of members) {
            const user = getStateUser(guild, state); const row = new QWidget(); const rowLayout = new QBoxLayout(Direction.LeftToRight); rowLayout.setContentsMargins(2, 3, 2, 3); row.setLayout(rowLayout);
            const avatar = new QLabel(); avatar.setObjectName('avatar'); avatar.setFixedSize(32, 32); avatar.setText(initialFor(user?.global_name || user?.username)); setRemoteImage(avatar, userAvatarUrl(user), 32); rowLayout.addWidget(avatar);
            const memberName = new QLabel(); memberName.setObjectName('memberName'); memberName.setText(state.member?.nick || user?.global_name || user?.username || 'Usuário desconhecido'); rowLayout.addWidget(memberName, 1);
            const stateText = []; if (state.self_mute || state.mute) stateText.push('MUTADO'); if (state.self_deaf || state.deaf) stateText.push('ENSURDECIDO');
            if (stateText.length) { const flags = new QLabel(); flags.setObjectName('memberState'); flags.setText(stateText.join(' · ')); rowLayout.addWidget(flags); }
            cardLayout.addWidget(row);
        }
        layout.addWidget(card);
    }
    layout.addStretch(1); replacePage(callsScroll, widget, 'calls');
}
function renderBrowser() { renderServers(); renderCalls(); }
function renderActiveCalls() {
    const { widget, layout } = page();
    const columnTitle = new QLabel(); columnTitle.setObjectName('columnTitle'); columnTitle.setText('CALLS ATIVAS'); layout.addWidget(columnTitle);
    if (!voiceClients.size) {
        const empty = new QLabel(); empty.setObjectName('empty'); empty.setText('Nenhuma call ativa.'); layout.addWidget(empty);
    } else {
        const header = new QWidget(); const headerLayout = new QBoxLayout(Direction.LeftToRight); headerLayout.setContentsMargins(2, 2, 2, 2); header.setLayout(headerLayout);
        const headerText = new QLabel(); headerText.setObjectName('activeCallMeta'); headerText.setText(`${voiceClients.size} conectada(s)`); headerLayout.addWidget(headerText, 1);
        const generalMute = new QPushButton(); generalMute.setObjectName('muteButton'); generalMute.setIcon(allMuted ? iconMicOff : iconMicOn); generalMute.setIconSize(ICON_SIZE); generalMute.setToolTip(allMuted ? 'Reativar microfone de todas' : 'Mutar microfone de todas');
        generalMute.addEventListener('clicked', () => { allMuted = !allMuted; for (const entry of voiceClients.values()) { entry.muted = allMuted; entry.client.setMute(allMuted); } renderActiveCalls(); });
        headerLayout.addWidget(generalMute);
        const generalDeafen = new QPushButton(); generalDeafen.setObjectName('deafenButton'); generalDeafen.setIcon(allDeafened ? iconDeafenOn : iconDeafenOff); generalDeafen.setIconSize(ICON_SIZE); generalDeafen.setToolTip(allDeafened ? 'Reativar áudio de todas' : 'Ensurdecer todas');
        generalDeafen.addEventListener('clicked', () => { allDeafened = !allDeafened; for (const entry of voiceClients.values()) { entry.deafened = allDeafened; entry.client.setDeafen(allDeafened); } renderActiveCalls(); });
        headerLayout.addWidget(generalDeafen); layout.addWidget(header);
        for (const entry of voiceClients.values()) {
            const row = new QWidget(); row.setObjectName('activeCallCard'); const rowLayout = new QBoxLayout(Direction.LeftToRight); rowLayout.setContentsMargins(4, 4, 4, 4); rowLayout.setSpacing(6); row.setLayout(rowLayout);
            const labels = new QWidget(); const labelsLayout = new QBoxLayout(Direction.TopToBottom); labelsLayout.setContentsMargins(0, 0, 0, 0); labels.setLayout(labelsLayout);
            const name = new QLabel(); name.setObjectName('activeCallTitle'); name.setText(entry.channelName); labelsLayout.addWidget(name);
            const detail = new QLabel(); detail.setObjectName('activeCallMeta'); detail.setText(entry.guildName); labelsLayout.addWidget(detail); rowLayout.addWidget(labels, 1);
            const mute = new QPushButton(); mute.setObjectName('muteButton'); mute.setIcon(entry.muted ? iconMicOff : iconMicOn); mute.setIconSize(ICON_SIZE); mute.setToolTip(entry.muted ? 'Reativar microfone' : 'Mutar microfone'); mute.addEventListener('clicked', () => { entry.muted = !entry.muted; entry.client.setMute(entry.muted); renderActiveCalls(); }); rowLayout.addWidget(mute);
            const deafen = new QPushButton(); deafen.setObjectName('deafenButton'); deafen.setIcon(entry.deafened ? iconDeafenOn : iconDeafenOff); deafen.setIconSize(ICON_SIZE); deafen.setToolTip(entry.deafened ? 'Reativar áudio' : 'Ensurdecer');
            deafen.addEventListener('clicked', () => { entry.deafened = !entry.deafened; entry.client.setDeafen(entry.deafened); if (entry.deafened) entry.muted = true; renderActiveCalls(); }); rowLayout.addWidget(deafen);
            const leave = new QPushButton(); leave.setObjectName('leaveButton'); leave.setText('Sair'); leave.addEventListener('clicked', () => leaveVoiceCall(entry.guildId)); rowLayout.addWidget(leave);
            layout.addWidget(row);
        }
    }
    layout.addStretch(1); const old = activeCallsScroll.takeWidget(); activeCallsScroll.setWidget(widget); if (old) old.deleteLater();
}
function startVoiceCall(guild, channel) {
    if (!activeToken) return;
    const entry = { guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name, muted: allMuted, deafened: allDeafened, pending: null, client: null };
    const voiceClient = createVoiceClient({
        token: activeToken, guildId: guild.id, channelId: channel.id,
        onLog: log,
        onReady: () => { status.setText(`Conectado em ${channel.name} (${guild.name}).`); },
        onDisconnected: reason => {
            // Só a sessão que ainda está registrada pode alterar o painel.
            if (voiceClients.get(guild.id) !== entry) return;
            const nextChannel = entry.pending;
            voiceClients.delete(guild.id);
            renderActiveCalls();
            if (nextChannel) startVoiceCall(guild, nextChannel);
            else log(`[Voice] call removida (${reason}).`);
        }
    });
    entry.client = voiceClient;
    voiceClients.set(guild.id, entry);
    renderActiveCalls();
    voiceClient.connect();
    if (allMuted) voiceClient.setMute(true);
    if (allDeafened) voiceClient.setDeafen(true);
}
function connectToVoiceCall(guild, channel) {
    const entry = voiceClients.get(guild.id);
    if (!entry) return startVoiceCall(guild, channel);
    if (entry.channelId === channel.id) return;
    // Em vez de trocar o socket ainda ativo, encerra esta sessão do servidor
    // e cria outra ao receber onDisconnected. Assim não há eventos de voz
    // antigos concorrendo com os do canal novo.
    entry.pending = channel;
    entry.client.disconnect();
    status.setText(`Trocando para ${channel.name}...`);
}
function leaveVoiceCall(guildId) {
    const entry = voiceClients.get(guildId);
    if (!entry) return;
    entry.pending = null;
    // Remover antes do disconnect impede o callback assíncrono de recriar a
    // sessão que o usuário acabou de encerrar.
    voiceClients.delete(guildId);
    entry.client.disconnect();
    status.setText(`Saiu da call de ${entry.guildName}.`);
    renderActiveCalls();
    renderBrowser();
}
function updateVoiceState(state) {
    const guild = guilds.get(state.guild_id); if (!guild) return;
    if (state.member?.user?.id) guild.users.set(state.member.user.id, state.member.user);
    if (state.channel_id) guild.voiceStates.set(state.user_id, state); else guild.voiceStates.delete(state.user_id);
    if (selectedGuildId === guild.id) renderCalls();
}

loadButton.addEventListener('clicked', () => {
    const token = tokenInput.text().trim(); if (!token) return log('Informe o token antes de continuar.');
    client?.disconnect();
    for (const entry of voiceClients.values()) entry.client.disconnect();
    voiceClients.clear(); allMuted = false; allDeafened = false; renderActiveCalls();
    guilds.clear(); imageDataCache.clear(); selectedGuildId = null; activeToken = token; loadButton.setEnabled(false); loadButton.setText('Carregando...'); tokenInput.setEnabled(false); status.setText('Conectando ao Discord...'); renderBrowser();
    let nextClient;
    nextClient = createVoiceClient({ token, onLog: log,
        onGatewayReady: ready => {
            currentUserId = ready.user.id;
            for (const guild of ready.guilds || []) normalizeGuild(guild);
            log(`Logado como ${ready.user.username}`);
            loadButton.setEnabled(true); loadButton.setText('Atualizar servidores');
            status.setText('Servidores carregados. Escolha um servidor e depois uma call.');
            renderBrowser();
        },
        onGuildCreate: data => { normalizeGuild(data); renderBrowser(); }, onVoiceStateUpdate: updateVoiceState,
        onReady: () => { status.setText('Conectado ao canal de voz.'); },
        onDisconnected: reason => {
            // Um cliente anterior pode terminar o disconnect depois que um
            // novo carregamento já começou; ele não deve limpar a nova tela.
            if (client !== nextClient) return;
            log(`Desconectado (${reason})`); client = null; activeToken = null; loadButton.setEnabled(true); loadButton.setText('Carregar servidores'); tokenInput.setEnabled(true); status.setText('Desconectado');
        }
    });
    client = nextClient;
    client.connect();
});
win.addEventListener(WidgetEventTypes.Close, () => { client?.disconnect(); for (const entry of voiceClients.values()) entry.client.disconnect(); });
process.on('SIGINT', () => { client?.disconnect(); for (const entry of voiceClients.values()) entry.client.disconnect(); setTimeout(() => process.exit(0), 100); });
renderBrowser(); renderActiveCalls(); win.show(); global.win = win;