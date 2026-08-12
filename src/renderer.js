'use strict';

const tokenInput = document.getElementById('tokenInput');
const tokenForm = document.getElementById('tokenForm');
const loadButton = document.getElementById('loadButton');
const statusLabel = document.getElementById('statusLabel');
const serverList = document.getElementById('serverList');
const channelList = document.getElementById('channelList');
const activeCallsEl = document.getElementById('activeCalls');
const logArea = document.getElementById('logArea');

const iconPaths = {
    micOn: '../assets/mic_on.png',
    micOff: '../assets/mic_off.png',
    deafenOn: '../assets/deafen_on.png',
    deafenOff: '../assets/deafen_off.png'
};

const ADMINISTRATOR = 8n;
const VIEW_CHANNEL = 1024n;
const CONNECT = 1048576n;

const guilds = new Map();
let selectedGuildId = null;
let currentUserId = null;
let activeCalls = { allMuted: false, allDeafened: false, calls: [] };

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function initialFor(text) {
    return String(text || '?').trim().slice(0, 1).toUpperCase() || '?';
}

function imageOrInitial(className, text, url) {
    const wrap = el('span', className, initialFor(text));
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('load', () => {
            wrap.textContent = '';
            wrap.appendChild(img);
        });
    }
    return wrap;
}

function iconButton(icon, title, onClick) {
    const button = el('button', 'icon-button');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    button.appendChild(img);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function serverIconUrl(guild) {
    return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null;
}

function userAvatarUrl(user) {
    return user?.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;
}

function permissionBits(value) {
    try {
        return BigInt(value || 0);
    } catch (_) {
        return 0n;
    }
}

function activeEntryFor(guildId) {
    return activeCalls.calls.find((entry) => entry.guildId === guildId) || null;
}

function activeEntryForChannel(guildId, channelId) {
    const entry = activeEntryFor(guildId);
    return entry?.channelId === channelId ? entry : null;
}

function normalizeGuild(data) {
    if (!data?.id) return;

    const guild = guilds.get(data.id) || {
        id: data.id,
        name: 'Carregando servidor...',
        icon: null,
        owner_id: null,
        channels: new Map(),
        categories: new Map(),
        voiceStates: new Map(),
        users: new Map(),
        roles: new Map(),
        members: new Map()
    };

    guild.name = data.name || guild.name;
    guild.icon = data.icon || guild.icon;
    guild.owner_id = data.owner_id || guild.owner_id;

    for (const role of data.roles || []) {
        guild.roles.set(role.id, role);
    }

    for (const member of data.members || []) {
        if (member.user?.id) {
            guild.users.set(member.user.id, member.user);
            guild.members.set(member.user.id, member);
        }
    }

    for (const channel of data.channels || []) {
        if (channel.type === 2) guild.channels.set(channel.id, channel);
        if (channel.type === 4) guild.categories.set(channel.id, channel);
    }

    for (const state of data.voice_states || []) {
        if (state.member?.user?.id) {
            guild.users.set(state.member.user.id, state.member.user);
            guild.members.set(state.member.user.id, state.member);
        }
        guild.voiceStates.set(state.user_id, state);
    }

    guilds.set(guild.id, guild);
    if (!selectedGuildId) selectedGuildId = guild.id;
}

function canEnterVoiceChannel(guild, channel) {
    const member = guild.members.get(currentUserId);
    if (!member) return true;
    if (guild.owner_id === currentUserId) return true;

    const roleIds = new Set([guild.id, ...(member.roles || [])]);
    let permissions = 0n;

    for (const role of guild.roles.values()) {
        if (roleIds.has(role.id)) permissions |= permissionBits(role.permissions);
    }

    if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

    const parent = guild.categories.get(channel.parent_id);
    const overwrites = channel.permission_overwrites?.length
        ? channel.permission_overwrites
        : (parent?.permission_overwrites || []);

    const apply = (overwrite) => {
        permissions &= ~permissionBits(overwrite.deny);
        permissions |= permissionBits(overwrite.allow);
    };

    const everyone = overwrites.find((overwrite) => overwrite.id === guild.id);
    if (everyone) apply(everyone);

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

    const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === currentUserId);
    if (memberOverwrite) apply(memberOverwrite);

    return (permissions & VIEW_CHANNEL) === VIEW_CHANNEL && (permissions & CONNECT) === CONNECT;
}

function getStateUser(guild, state) {
    return state.member?.user || guild.users.get(state.user_id);
}

function resetBrowser() {
    guilds.clear();
    selectedGuildId = null;
    currentUserId = null;
    activeCalls = { allMuted: false, allDeafened: false, calls: [] };
    renderAll();
}

function renderServers() {
    serverList.textContent = '';

    const list = Array.from(guilds.values()).sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) {
        serverList.appendChild(el('p', 'empty', 'Aguardando servidores...'));
        return;
    }

    for (const guild of list) {
        const button = el('button', 'server-row');
        button.type = 'button';
        if (guild.id === selectedGuildId) button.classList.add('selected');
        if (activeEntryFor(guild.id)) button.classList.add('connected');

        button.appendChild(imageOrInitial('server-icon', guild.name, serverIconUrl(guild)));
        button.appendChild(el('span', 'server-name', guild.name));

        const active = activeEntryFor(guild.id);
        if (active) {
            const leave = el('button', 'inline-leave', 'Sair');
            leave.type = 'button';
            leave.addEventListener('click', (event) => {
                event.stopPropagation();
                window.discordVoice.leaveCall(guild.id);
            });
            button.appendChild(leave);
        }

        button.addEventListener('click', () => {
            selectedGuildId = guild.id;
            renderAll();
        });

        serverList.appendChild(button);
    }
}

function renderChannels() {
    channelList.textContent = '';
    const guild = guilds.get(selectedGuildId);

    if (!guild) {
        channelList.appendChild(el('p', 'empty', 'Selecione um servidor na lateral.'));
        return;
    }

    channelList.appendChild(el('h3', 'channel-heading', guild.name));

    const channels = Array.from(guild.channels.values())
        .filter((channel) => canEnterVoiceChannel(guild, channel))
        .sort((a, b) => (a.position || 0) - (b.position || 0));

    if (!channels.length) {
        channelList.appendChild(el('p', 'empty', 'Voce nao tem permissao para entrar em nenhuma call deste servidor.'));
        return;
    }

    for (const channel of channels) {
        const card = el('article', 'channel-card');
        const header = el('div', 'channel-header');
        const join = el('button', 'channel-join', channel.name);
        const active = activeEntryForChannel(guild.id, channel.id);

        join.type = 'button';
        if (active) {
            join.textContent = `${channel.name}  -  CONECTADO`;
            join.classList.add('connected');
        }

        const joinCall = () => {
            window.discordVoice.joinCall({
                guild: { id: guild.id, name: guild.name },
                channel: { id: channel.id, name: channel.name }
            });
        };

        join.addEventListener('click', (event) => {
            event.stopPropagation();
            joinCall();
        });
        card.addEventListener('click', joinCall);
        header.appendChild(join);

        if (active) {
            header.appendChild(iconButton(active.muted ? iconPaths.micOff : iconPaths.micOn, active.muted ? 'Reativar microfone' : 'Mutar microfone', () => {
                window.discordVoice.toggleCallMute(guild.id);
            }));
            header.appendChild(iconButton(active.deafened ? iconPaths.deafenOn : iconPaths.deafenOff, active.deafened ? 'Reativar audio' : 'Ensurdecer', () => {
                window.discordVoice.toggleCallDeafen(guild.id);
            }));

            const leave = el('button', 'leave-button', 'Sair');
            leave.type = 'button';
            leave.addEventListener('click', (event) => {
                event.stopPropagation();
                window.discordVoice.leaveCall(guild.id);
            });
            header.appendChild(leave);
        }

        card.appendChild(header);

        const members = Array.from(guild.voiceStates.values()).filter((state) => state.channel_id === channel.id);
        if (!members.length) {
            card.appendChild(el('p', 'empty', 'Nenhum membro conectado'));
        }

        for (const state of members) {
            const user = getStateUser(guild, state);
            const row = el('div', 'member-row');
            row.appendChild(imageOrInitial('avatar', user?.global_name || user?.username, userAvatarUrl(user)));
            row.appendChild(el('span', 'member-name', state.member?.nick || user?.global_name || user?.username || 'Usuario desconhecido'));

            const stateText = [];
            if (state.self_mute || state.mute) stateText.push('MUTADO');
            if (state.self_deaf || state.deaf) stateText.push('ENSURDECIDO');
            if (stateText.length) row.appendChild(el('span', 'member-state', stateText.join(' / ')));

            card.appendChild(row);
        }

        channelList.appendChild(card);
    }
}

function renderActiveCalls() {
    activeCallsEl.textContent = '';

    if (!activeCalls.calls.length) {
        activeCallsEl.appendChild(el('p', 'empty', 'Nenhuma call ativa.'));
        return;
    }

    const toolbar = el('div', 'active-toolbar');
    toolbar.appendChild(el('span', 'active-count', `${activeCalls.calls.length} conectada(s)`));
    toolbar.appendChild(iconButton(activeCalls.allMuted ? iconPaths.micOff : iconPaths.micOn, activeCalls.allMuted ? 'Reativar microfone de todas' : 'Mutar microfone de todas', () => {
        window.discordVoice.toggleAllMute();
    }));
    toolbar.appendChild(iconButton(activeCalls.allDeafened ? iconPaths.deafenOn : iconPaths.deafenOff, activeCalls.allDeafened ? 'Reativar audio de todas' : 'Ensurdecer todas', () => {
        window.discordVoice.toggleAllDeafen();
    }));
    activeCallsEl.appendChild(toolbar);

    for (const entry of activeCalls.calls) {
        const card = el('article', 'active-card');
        const labels = el('div', 'active-labels');
        labels.appendChild(el('span', 'active-title', entry.switching ? `${entry.channelName}...` : entry.channelName));
        labels.appendChild(el('span', 'active-meta', entry.guildName));
        card.appendChild(labels);

        card.appendChild(iconButton(entry.muted ? iconPaths.micOff : iconPaths.micOn, entry.muted ? 'Reativar microfone' : 'Mutar microfone', () => {
            window.discordVoice.toggleCallMute(entry.guildId);
        }));
        card.appendChild(iconButton(entry.deafened ? iconPaths.deafenOn : iconPaths.deafenOff, entry.deafened ? 'Reativar audio' : 'Ensurdecer', () => {
            window.discordVoice.toggleCallDeafen(entry.guildId);
        }));

        const leave = el('button', 'leave-button', 'Sair');
        leave.type = 'button';
        leave.addEventListener('click', () => window.discordVoice.leaveCall(entry.guildId));
        card.appendChild(leave);
        activeCallsEl.appendChild(card);
    }
}

function renderAll() {
    renderServers();
    renderChannels();
    renderActiveCalls();
}

function updateVoiceState(state) {
    const guild = guilds.get(state.guild_id);
    if (!guild) return;

    if (state.member?.user?.id) {
        guild.users.set(state.member.user.id, state.member.user);
        guild.members.set(state.member.user.id, state.member);
    }

    if (state.channel_id) {
        guild.voiceStates.set(state.user_id, state);
    } else {
        guild.voiceStates.delete(state.user_id);
    }

    renderAll();
}

tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = tokenInput.value.trim();

    if (!token) {
        statusLabel.textContent = 'Informe o token antes de continuar.';
        return;
    }

    loadButton.disabled = true;
    loadButton.textContent = 'Carregando...';
    tokenInput.disabled = true;
    window.discordVoice.loadServers({ token });
});

window.discordVoice.onDefaults(({ token }) => {
    tokenInput.value = token || '';
});

window.discordVoice.onBrowserReset(() => {
    resetBrowser();
});

window.discordVoice.onGatewayReady((ready) => {
    currentUserId = ready.user?.id || null;
    for (const guild of ready.guilds || []) normalizeGuild(guild);
    loadButton.disabled = false;
    loadButton.textContent = 'Atualizar servidores';
    tokenInput.disabled = false;
    renderAll();
});

window.discordVoice.onGuildCreate((guild) => {
    normalizeGuild(guild);
    renderAll();
});

window.discordVoice.onVoiceStateUpdate(updateVoiceState);

window.discordVoice.onActiveCalls((payload) => {
    activeCalls = payload || { allMuted: false, allDeafened: false, calls: [] };
    renderAll();
});

window.discordVoice.onStatus((status) => {
    statusLabel.textContent = status || '';
    if (status === 'Desconectado') {
        loadButton.disabled = false;
        loadButton.textContent = 'Carregar servidores';
        tokenInput.disabled = false;
    }
});

window.discordVoice.onLog((line) => {
    logArea.textContent += `${line}\n`;
    logArea.scrollTop = logArea.scrollHeight;
});

renderAll();
