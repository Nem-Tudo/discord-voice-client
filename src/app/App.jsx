import React, { useEffect, useMemo, useRef, useState } from 'react';

import micOnIcon from '../../assets/mic_on.png';
import micOffIcon from '../../assets/mic_off.png';
import deafenOnIcon from '../../assets/deafen_on.png';
import deafenOffIcon from '../../assets/deafen_off.png';

const ADMINISTRATOR = 8n;
const VIEW_CHANNEL = 1024n;
const CONNECT = 1048576n;
const emptyActiveCalls = { allMuted: false, allDeafened: false, calls: [] };

function initialFor(text) {
    return String(text || '?').trim().slice(0, 1).toUpperCase() || '?';
}

function Avatar({ className, text, url }) {
    return (
        <span className={className}>
            {url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : initialFor(text)}
        </span>
    );
}

function IconButton({ icon, title, onClick, className = '' }) {
    return (
        <button
            className={`icon-button ${className}`.trim()}
            type="button"
            title={title}
            aria-label={title}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            <img src={icon} alt="" />
        </button>
    );
}

function serverIconUrl(guild) {
    return guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64` : null;
}

function userAvatarUrl(user, size = 64) {
    return user?.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`
        : null;
}

function permissionBits(value) {
    try {
        return BigInt(value || 0);
    } catch (_) {
        return 0n;
    }
}

function normalizeGuilds(previous, data) {
    if (!data?.id) return previous;

    const guild = previous[data.id] || {
        id: data.id,
        name: 'Carregando servidor...',
        icon: null,
        owner_id: null,
        channels: {},
        categories: {},
        voiceStates: {},
        users: {},
        roles: {},
        members: {}
    };

    const next = {
        ...guild,
        name: data.name || guild.name,
        icon: data.icon || guild.icon,
        owner_id: data.owner_id || guild.owner_id,
        channels: { ...guild.channels },
        categories: { ...guild.categories },
        voiceStates: { ...guild.voiceStates },
        users: { ...guild.users },
        roles: { ...guild.roles },
        members: { ...guild.members }
    };

    for (const role of data.roles || []) next.roles[role.id] = role;

    for (const member of data.members || []) {
        if (member.user?.id) {
            next.users[member.user.id] = member.user;
            next.members[member.user.id] = member;
        }
    }

    for (const channel of data.channels || []) {
        if (channel.type === 2) next.channels[channel.id] = channel;
        if (channel.type === 4) next.categories[channel.id] = channel;
    }

    for (const state of data.voice_states || []) {
        if (state.member?.user?.id) {
            next.users[state.member.user.id] = state.member.user;
            next.members[state.member.user.id] = state.member;
        }
        next.voiceStates[state.user_id] = state;
    }

    return { ...previous, [next.id]: next };
}

function canEnterVoiceChannel(guild, channel, currentUserId) {
    const member = guild.members[currentUserId];
    if (!member) return true;
    if (guild.owner_id === currentUserId) return true;

    const roleIds = new Set([guild.id, ...(member.roles || [])]);
    let permissions = 0n;

    for (const role of Object.values(guild.roles)) {
        if (roleIds.has(role.id)) permissions |= permissionBits(role.permissions);
    }

    if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

    const parent = guild.categories[channel.parent_id];
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

function activeEntryFor(activeCalls, guildId) {
    return activeCalls.calls.find((entry) => entry.guildId === guildId) || null;
}

function activeEntryForChannel(activeCalls, guildId, channelId) {
    const entry = activeEntryFor(activeCalls, guildId);
    return entry?.channelId === channelId ? entry : null;
}

function getStateUser(guild, state) {
    return state.member?.user || guild.users[state.user_id];
}

function activateWithKeyboard(event, callback) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    callback();
}

function normalizeSearch(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function App() {
    const [token, setToken] = useState('');
    const [status, setStatus] = useState('Informe o token para carregar seus servidores.');
    const [loading, setLoading] = useState(false);
    const [guilds, setGuilds] = useState({});
    const [selectedGuildId, setSelectedGuildId] = useState(null);
    const [currentUserId, setCurrentUserId] = useState(null);
    const [currentUser, setCurrentUser] = useState(null);
    const [activeCalls, setActiveCalls] = useState(emptyActiveCalls);
    const [logs, setLogs] = useState([]);
    const logAreaRef = useRef(null);

    const [mics, setMics] = useState([]);
    const [selectedMicId, setSelectedMicId] = useState(() => {
        const saved = localStorage.getItem('selectedMicId');
        if (saved === null || saved === '') return null;
        const n = Number(saved);
        return Number.isNaN(n) ? null : n;
    });
    const [testingMic, setTestingMic] = useState(false);

    const [micGain, setMicGain] = useState(() => {
        const saved = localStorage.getItem('micGain');
        if (saved === null || saved === '') return 100;
        const n = Number(saved);
        if (Number.isNaN(n)) return 100;
        return Math.max(0, Math.min(2000, Math.round(n)));
    });

    const sortedGuilds = useMemo(
        () => Object.values(guilds).sort((a, b) => a.name.localeCompare(b.name)),
        [guilds]
    );
    const selectedGuild = selectedGuildId ? guilds[selectedGuildId] : null;

    const displayName =
        currentUser?.global_name || currentUser?.username || (currentUserId ? 'Usuário' : null);

    const refreshMics = async () => {
        try {
            const list = await window.discordVoice.listMics?.();
            if (Array.isArray(list)) {
                setMics(list);

                if (selectedMicId === null) {
                    const defaultMic = list.find((m) => m.isDefault);
                    if (defaultMic) {
                        setSelectedMicId(defaultMic.id);
                        localStorage.setItem('selectedMicId', String(defaultMic.id));
                        window.discordVoice.setMic?.(defaultMic.id);
                    }
                }
            }
        } catch (err) {
            console.error('Erro ao listar microfones:', err);
        }
    };

    useEffect(() => {
        refreshMics();
        window.discordVoice.setMicGain?.(micGain);
    }, []);

    const handleMicChange = (event) => {
        const value = event.target.value;
        const id = value === '' ? null : Number(value);

        setSelectedMicId(id);
        localStorage.setItem('selectedMicId', id === null ? '' : String(id));
        window.discordVoice.setMic?.(id);

        if (testingMic) {
            window.discordVoice.stopMicTest?.();
            window.discordVoice.startMicTest?.(id);
        }
    };

    const handleGainChange = (event) => {
        const value = Math.max(0, Math.min(2000, Number(event.target.value) || 0));
        setMicGain(value);
        localStorage.setItem('micGain', String(value));
        window.discordVoice.setMicGain?.(value);
    };

    const toggleMicTest = () => {
        if (testingMic) {
            window.discordVoice.stopMicTest?.();
            setTestingMic(false);
        } else {
            window.discordVoice.startMicTest?.(selectedMicId);
            setTestingMic(true);
        }
    };

    useEffect(() => {
        const api = window.discordVoice;
        const unsubscribers = [
            api.onDefaults(({ token: defaultToken }) => setToken(defaultToken || '')),
            api.onBrowserReset(() => {
                setGuilds({});
                setSelectedGuildId(null);
                setCurrentUserId(null);
                setCurrentUser(null);
                setActiveCalls(emptyActiveCalls);
            }),
            api.onGatewayReady((ready) => {
                setCurrentUserId(ready.user?.id || null);
                setCurrentUser(ready.user || null);
                setGuilds((previous) => {
                    let next = previous;
                    for (const guild of ready.guilds || []) next = normalizeGuilds(next, guild);
                    setSelectedGuildId((current) => current || Object.keys(next)[0] || null);
                    return next;
                });
                setLoading(false);
            }),
            api.onGuildCreate((guild) => {
                setGuilds((previous) => {
                    const next = normalizeGuilds(previous, guild);
                    setSelectedGuildId((current) => current || guild.id || Object.keys(next)[0] || null);
                    return next;
                });
            }),
            api.onVoiceStateUpdate((state) => {
                setGuilds((previous) => {
                    const guild = previous[state.guild_id];
                    if (!guild) return previous;

                    const nextGuild = {
                        ...guild,
                        voiceStates: { ...guild.voiceStates },
                        users: { ...guild.users },
                        members: { ...guild.members }
                    };

                    if (state.member?.user?.id) {
                        nextGuild.users[state.member.user.id] = state.member.user;
                        nextGuild.members[state.member.user.id] = state.member;
                    }

                    if (state.channel_id) nextGuild.voiceStates[state.user_id] = state;
                    else delete nextGuild.voiceStates[state.user_id];

                    return { ...previous, [nextGuild.id]: nextGuild };
                });
            }),
            api.onActiveCalls((payload) => setActiveCalls(payload || emptyActiveCalls)),
            api.onStatus((nextStatus) => {
                setStatus(nextStatus || '');
                if (nextStatus === 'Desconectado') {
                    setLoading(false);
                    setCurrentUser(null);
                    setCurrentUserId(null);
                }
            }),
            api.onLog((line) => setLogs((previous) => [...previous, line]))
        ];

        return () => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            window.discordVoice.stopMicTest?.();
        };
    }, []);

    useEffect(() => {
        if (logAreaRef.current) logAreaRef.current.scrollTop = logAreaRef.current.scrollHeight;
    }, [logs]);

    function loadServers(event) {
        event.preventDefault();
        const nextToken = token.trim();

        if (!nextToken) {
            setStatus('Informe o token antes de continuar.');
            return;
        }

        setLoading(true);
        window.discordVoice.loadServers({ token: nextToken });
    }

    return (
        <main className="app-shell">
            {/* ===== TOPO: usuário logado ===== */}
            {currentUser ? (
                <header className="user-bar">
                    <Avatar
                        className="user-bar-avatar"
                        text={displayName}
                        url={userAvatarUrl(currentUser, 128)}
                    />
                    <div className="user-bar-text">
                        <span className="user-bar-label">Logado como</span>
                        <span className="user-bar-name">
                            {displayName}
                            {currentUser.discriminator && currentUser.discriminator !== '0'
                                ? `#${currentUser.discriminator}`
                                : ''}
                        </span>
                    </div>
                    {activeCalls.calls.length > 0 ? (
                        <span className="user-bar-calls">
                            {activeCalls.calls.length} call{activeCalls.calls.length > 1 ? 's' : ''} ativa
                            {activeCalls.calls.length > 1 ? 's' : ''}
                        </span>
                    ) : null}
                    <button className="inline-leave"
                        onClick={() => {
                            window.discordVoice.disconnect?.();
                            setToken('');
                            setCurrentUser(null);
                            setCurrentUserId(null);
                            setGuilds({});
                            setSelectedGuildId(null);
                            setActiveCalls({ allMuted: false, allDeafened: false, calls: [] });
                            setStatus('Desconectado');
                            setLoading(false);
                        }}>
                        Logout
                    </button>
                </header>
            ) : null}

            {
                !currentUser && <form className="token-bar" onSubmit={loadServers}>
                    <label className="field">
                        <span>TOKEN</span>
                        <input
                            type="password"
                            placeholder="Token do Discord"
                            autoComplete="off"
                            value={token}
                            disabled={loading}
                            onChange={(event) => setToken(event.target.value)}
                        />
                    </label>

                    <button className="primary-button" type="submit" disabled={loading}>
                        {loading ? 'Carregando...' : sortedGuilds.length ? 'Atualizar servidores' : 'Logar'}
                    </button>
                </form>
            }

            <p className="status">{status}</p>

            <section className="browser">
                <ServersPanel
                    guilds={sortedGuilds}
                    selectedGuildId={selectedGuildId}
                    activeCalls={activeCalls}
                    onSelect={setSelectedGuildId}
                />
                <ChannelsPanel guild={selectedGuild} currentUserId={currentUserId} activeCalls={activeCalls} />
                <ActiveCallsPanel activeCalls={activeCalls} />
            </section>

            {/* ===== CONTROLES INFERIORES: mute/deafen geral + microfone ===== */}
            <section className="bottom-controls">
                <div className="global-voice-controls">
                    <h2>VOZ GERAL</h2>
                    <div className="global-voice-buttons">
                        <IconButton
                            className={activeCalls.allMuted ? 'is-off' : ''}
                            icon={activeCalls.allMuted ? micOffIcon : micOnIcon}
                            title={
                                activeCalls.allMuted
                                    ? 'Reativar microfone de todas'
                                    : 'Mutar microfone de todas'
                            }
                            onClick={() => window.discordVoice.toggleAllMute()}
                        />
                        <IconButton
                            className={activeCalls.allDeafened ? 'is-off' : ''}
                            icon={activeCalls.allDeafened ? deafenOnIcon : deafenOffIcon}
                            title={
                                activeCalls.allDeafened
                                    ? 'Reativar áudio de todas'
                                    : 'Ensurdecer todas'
                            }
                            onClick={() => window.discordVoice.toggleAllDeafen()}
                        />
                        <span className="global-voice-hint">
                            {activeCalls.calls.length
                                ? `${activeCalls.calls.length} call(s)`
                                : 'Nenhuma call'}
                        </span>
                    </div>
                </div>

                <section className="mic-section" aria-labelledby="micTitle">
                    <h2 id="micTitle">MICROFONE</h2>
                    <div className="mic-area">
                        <select
                            className="mic-select"
                            value={selectedMicId ?? ''}
                            onChange={handleMicChange}
                            disabled={!mics.length}
                        >
                            {!mics.length ? (
                                <option value="">Carregando microfones...</option>
                            ) : (
                                <>
                                    <option value="">Padrão do sistema</option>
                                    {mics.map((mic) => (
                                        <option key={mic.id} value={mic.id}>
                                            {mic.name}
                                            {mic.isDefault ? ' (padrão)' : ''}
                                            {mic.channels === 1 ? ' • mono' : ''}
                                        </option>
                                    ))}
                                </>
                            )}
                        </select>

                        <button
                            type="button"
                            className="secondary-button"
                            title="Atualizar lista de microfones"
                            onClick={refreshMics}
                        >
                            ↻
                        </button>

                        <button
                            type="button"
                            className={`test-mic-button${testingMic ? ' active' : ''}`}
                            onClick={toggleMicTest}
                        >
                            {testingMic ? 'Parar teste' : 'Testar microfone'}
                        </button>
                    </div>

                    <div className="mic-gain-area">
                        <label className="mic-gain-label" htmlFor="micGainSlider">
                            Ganho: <strong>{micGain}%</strong>
                        </label>
                        <input
                            id="micGainSlider"
                            className="mic-gain-slider"
                            type="range"
                            min={0}
                            max={2000}
                            step={1}
                            value={micGain}
                            onChange={handleGainChange}
                        />
                        <div className="mic-gain-presets">
                            {[0, 100, 200, 500, 1000, 2000].map((v) => (
                                <button
                                    key={v}
                                    type="button"
                                    className={`secondary-button${micGain === v ? ' preset-active' : ''}`}
                                    onClick={() => handleGainChange({ target: { value: v } })}
                                >
                                    {v}%
                                </button>
                            ))}
                        </div>
                    </div>
                </section>
            </section>

            <section className="log-section" aria-labelledby="logTitle">
                <h2 id="logTitle">LOGS</h2>
                <pre ref={logAreaRef} className="log-area">{logs.join('\n')}</pre>
            </section>
        </main>
    );
}

function ServersPanel({ guilds, selectedGuildId, activeCalls, onSelect }) {
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        const q = normalizeSearch(query);
        if (!q) return guilds;
        return guilds.filter((g) => normalizeSearch(g.name).includes(q));
    }, [guilds, query]);

    return (
        <aside className="panel servers-panel">
            <h2>SERVIDORES</h2>
            {
                guilds.length != 0 && <input
                    className="panel-search"
                    type="search"
                    placeholder="Buscar servidor..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Buscar servidor"
                />
            }
            <div className="scroll-list">
                {!guilds.length ? <p className="empty">Aguardando servidores...</p> : null}
                {guilds.length && !filtered.length ? (
                    <p className="empty">Nenhum servidor encontrado.</p>
                ) : null}
                {filtered.map((guild) => {
                    const active = activeEntryFor(activeCalls, guild.id);
                    const classes = [
                        'server-row',
                        guild.id === selectedGuildId ? 'selected' : '',
                        active ? 'connected' : ''
                    ]
                        .filter(Boolean)
                        .join(' ');

                    return (
                        <div
                            key={guild.id}
                            className={classes}
                            role="button"
                            tabIndex={0}
                            onClick={() => onSelect(guild.id)}
                            onKeyDown={(event) => activateWithKeyboard(event, () => onSelect(guild.id))}
                        >
                            <Avatar className="server-icon" text={guild.name} url={serverIconUrl(guild)} />
                            <span className="server-name">{guild.name}</span>
                            {active ? (
                                <button
                                    className="inline-leave"
                                    type="button"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        window.discordVoice.leaveCall(guild.id);
                                    }}
                                >
                                    Sair
                                </button>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </aside>
    );
}

function ChannelsPanel({ guild, currentUserId, activeCalls }) {
    const [query, setQuery] = useState('');

    const channels = useMemo(() => {
        if (!guild) return [];
        return Object.values(guild.channels)
            .filter((channel) => canEnterVoiceChannel(guild, channel, currentUserId))
            .sort((a, b) => (a.position || 0) - (b.position || 0));
    }, [guild, currentUserId]);

    const filtered = useMemo(() => {
        const q = normalizeSearch(query);
        if (!q) return channels;
        return channels.filter((c) => normalizeSearch(c.name).includes(q));
    }, [channels, query]);

    // limpa busca ao trocar de servidor
    useEffect(() => {
        setQuery('');
    }, [guild?.id]);

    return (
        <section className="panel channels-panel">
            <h2>CANAIS DE VOZ</h2>
            {
                guild && channels.length != 0 && <input
                    className="panel-search"
                    type="search"
                    placeholder="Buscar canal..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={!guild}
                    aria-label="Buscar canal de voz"
                />
            }
            <div className="scroll-list">
                {!guild ? <p className="empty">Selecione um servidor na lateral.</p> : null}
                {guild ? <h3 className="channel-heading">{guild.name}</h3> : null}
                {guild && !channels.length ? (
                    <p className="empty">Você não tem permissão para entrar em nenhuma call deste servidor.</p>
                ) : null}
                {guild && channels.length && !filtered.length ? (
                    <p className="empty">Nenhum canal encontrado.</p>
                ) : null}
                {guild
                    ? filtered.map((channel) => (
                        <ChannelCard
                            key={channel.id}
                            guild={guild}
                            channel={channel}
                            activeCalls={activeCalls}
                        />
                    ))
                    : null}
            </div>
        </section>
    );
}

function ChannelCard({ guild, channel, activeCalls }) {
    const active = activeEntryForChannel(activeCalls, guild.id, channel.id);
    const members = Object.values(guild.voiceStates).filter((state) => state.channel_id === channel.id);

    const joinCall = () => {
        window.discordVoice.joinCall({
            guild: { id: guild.id, name: guild.name },
            channel: { id: channel.id, name: channel.name }
        });
    };

    return (
        <article className="channel-card" onClick={joinCall}>
            <div className="channel-header">
                <button
                    className={`channel-join${active ? ' connected' : ''}`}
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        joinCall();
                    }}
                >
                    {active ? `${channel.name}  —  CONECTADO` : channel.name}
                </button>
                {active ? (
                    <>
                        <IconButton
                            icon={active.muted ? micOffIcon : micOnIcon}
                            title={active.muted ? 'Reativar microfone' : 'Mutar microfone'}
                            onClick={() => window.discordVoice.toggleCallMute(guild.id)}
                        />
                        <IconButton
                            icon={active.deafened ? deafenOnIcon : deafenOffIcon}
                            title={active.deafened ? 'Reativar áudio' : 'Ensurdecer'}
                            onClick={() => window.discordVoice.toggleCallDeafen(guild.id)}
                        />
                        <button
                            className="leave-button"
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                window.discordVoice.leaveCall(guild.id);
                            }}
                        >
                            Sair
                        </button>
                    </>
                ) : null}
            </div>

            {!members.length ? <p className="empty">Nenhum membro conectado</p> : null}
            {members.map((state) => {
                const user = getStateUser(guild, state);
                const stateText = [];
                if (state.self_mute || state.mute) stateText.push('MUTADO');
                if (state.self_deaf || state.deaf) stateText.push('ENSURDECIDO');

                return (
                    <div key={state.user_id} className="member-row">
                        <Avatar
                            className="avatar"
                            text={user?.global_name || user?.username}
                            url={userAvatarUrl(user)}
                        />
                        <span className="member-name">
                            {state.member?.nick || user?.global_name || user?.username || 'Usuário desconhecido'}
                        </span>
                        {stateText.length ? <span className="member-state">{stateText.join(' / ')}</span> : null}
                    </div>
                );
            })}
        </article>
    );
}

function ActiveCallsPanel({ activeCalls }) {
    return (
        <aside className="panel active-panel">
            <h2>CALLS ATIVAS</h2>
            <div className="scroll-list">
                {!activeCalls.calls.length ? <p className="empty">Nenhuma call ativa.</p> : null}
                {activeCalls.calls.map((entry) => (
                    <article key={entry.guildId} className="active-card">
                        <div className="active-labels">
                            <span className="active-title">
                                {entry.switching ? `${entry.channelName}...` : entry.channelName}
                            </span>
                            <span className="active-meta">{entry.guildName}</span>
                        </div>
                        <IconButton
                            icon={entry.muted ? micOffIcon : micOnIcon}
                            title={entry.muted ? 'Reativar microfone' : 'Mutar microfone'}
                            onClick={() => window.discordVoice.toggleCallMute(entry.guildId)}
                        />
                        <IconButton
                            icon={entry.deafened ? deafenOnIcon : deafenOffIcon}
                            title={entry.deafened ? 'Reativar áudio' : 'Ensurdecer'}
                            onClick={() => window.discordVoice.toggleCallDeafen(entry.guildId)}
                        />
                        <button
                            className="leave-button"
                            type="button"
                            onClick={() => window.discordVoice.leaveCall(entry.guildId)}
                        >
                            Sair
                        </button>
                    </article>
                ))}
            </div>
        </aside>
    );
}

export default App;