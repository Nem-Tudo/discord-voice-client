import React, { useEffect, useMemo, useRef, useState } from 'react';
import tippy from 'tippy.js';
import 'tippy.js/dist/tippy.css';

import micOnIcon from '../../assets/mic_on.png';
import micOffIcon from '../../assets/mic_off.png';
import deafenOnIcon from '../../assets/deafen_on.png';
import deafenOffIcon from '../../assets/deafen_off.png';

const ADMINISTRATOR = 8n;
const VIEW_CHANNEL = 1024n;
const CONNECT = 1048576n;
const MOVE_MEMBERS = 2n;

const emptyActiveCalls = { allMuted: false, allDeafened: false, noiseSuppressionEnabled: true, calls: [] };

// ============================================================
// Atalhos de teclado — utilidades de captura (botão direito nos
// botões de mutar/ensurdecer do toolbar).
// ============================================================

const SHORTCUT_MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight',
    'MetaLeft', 'MetaRight'
]);

const SHORTCUT_KEY_NAME_MAP = (() => {
    const map = {
        Escape: 'Escape', Tab: 'Tab', Space: 'Space', Enter: 'Return', NumpadEnter: 'Return',
        Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
        PageUp: 'PageUp', PageDown: 'PageDown', PrintScreen: 'PrintScreen', CapsLock: 'Capslock',
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
        Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
        NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
        NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
        MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop',
        MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
        AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute'
    };
    for (let i = 0; i <= 9; i++) map[`Digit${i}`] = String(i);
    for (let i = 0; i <= 9; i++) map[`Numpad${i}`] = `num${i}`;
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') map[`Key${letter}`] = letter;
    for (let i = 1; i <= 24; i++) map[`F${i}`] = `F${i}`;
    return map;
})();

const SHORTCUT_IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
const SHORTCUT_MODIFIER_ORDER = ['CommandOrControl', 'Control', 'Cmd', 'Alt', 'Shift', 'Super'];

function shortcutModifierLabel(code) {
    if (code === 'ControlLeft' || code === 'ControlRight') return SHORTCUT_IS_MAC ? 'Control' : 'CommandOrControl';
    if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
    if (code === 'MetaLeft' || code === 'MetaRight') return SHORTCUT_IS_MAC ? 'Cmd' : 'Super';
    return null;
}

/** Monta um accelerator no formato do Electron a partir dos `event.code` pressionados juntos. */
function buildAcceleratorFromCodes(codes) {
    const modifiers = [];
    let mainKey = null;

    for (const code of codes) {
        if (SHORTCUT_MODIFIER_CODES.has(code)) {
            const modLabel = shortcutModifierLabel(code);
            if (modLabel && !modifiers.includes(modLabel)) modifiers.push(modLabel);
        } else {
            const name = SHORTCUT_KEY_NAME_MAP[code];
            if (name) mainKey = name; // último não-modificador pressionado vira a tecla principal
        }
    }

    modifiers.sort((a, b) => SHORTCUT_MODIFIER_ORDER.indexOf(a) - SHORTCUT_MODIFIER_ORDER.indexOf(b));

    if (!mainKey) return null; // só modificador pressionado não forma atalho válido
    return [...modifiers, mainKey].join('+');
}

function humanizeAccelerator(accel) {
    if (!accel) return 'Nenhum';
    return accel
        .replace('CommandOrControl', 'Ctrl')
        .replace('Super', 'Win')
        .split('+')
        .join(' + ');
}

function useOutsideClick(ref, onOutside, active) {
    useEffect(() => {
        if (!active) return undefined;

        function handlePointerDown(event) {
            if (ref.current && !ref.current.contains(event.target)) onOutside();
        }

        document.addEventListener('mousedown', handlePointerDown, true);
        return () => document.removeEventListener('mousedown', handlePointerDown, true);
    }, [active, onOutside, ref]);
}

/**
 * Menu que abre com o botão direito em cima de um botão de ação do toolbar
 * (mutar/ensurdecer) para gravar um atalho de teclado global novo.
 */
function ShortcutRecorderMenu({ action, label, onClose }) {
    const [phase, setPhase] = useState('menu'); // 'menu' | 'recording' | 'saving' | 'error'
    const [currentAccel, setCurrentAccel] = useState('');
    const [liveAccel, setLiveAccel] = useState('');
    const [errorMsg, setErrorMsg] = useState('');
    const heldCodes = useRef(new Set());
    const menuRef = useRef(null);

    useOutsideClick(menuRef, onClose, true);

    useEffect(() => {
        let cancelled = false;
        window.discordVoice.getShortcuts?.().then((all) => {
            if (!cancelled) setCurrentAccel(all?.[action] || '');
        });
        return () => { cancelled = true; };
    }, [action]);

    useEffect(() => {
        if (phase !== 'recording') return undefined;

        function onKeyDown(event) {
            event.preventDefault();
            event.stopPropagation();

            if (event.code === 'Escape' && heldCodes.current.size === 0) {
                window.discordVoice.resumeShortcuts?.();
                setPhase('menu');
                return;
            }

            heldCodes.current.add(event.code);
            setLiveAccel(buildAcceleratorFromCodes(heldCodes.current) || '');
        }

        async function onKeyUp(event) {
            event.preventDefault();
            event.stopPropagation();

            const accelerator = buildAcceleratorFromCodes(heldCodes.current);
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);

            if (!accelerator) {
                // Só um modificador foi pressionado e solto: não é um atalho válido.
                await window.discordVoice.resumeShortcuts?.();
                setPhase('menu');
                return;
            }

            setPhase('saving');

            let result;
            try {
                result = await window.discordVoice.setShortcut(action, accelerator);
            } catch (err) {
                result = { ok: false, error: err?.message || 'Erro desconhecido.' };
            }

            await window.discordVoice.resumeShortcuts?.();

            if (result?.ok) {
                setCurrentAccel(accelerator);
                setPhase('menu');
                setTimeout(onClose, 700);
            } else {
                setErrorMsg(result?.error || 'Não foi possível registrar esse atalho.');
                setPhase('error');
            }
        }

        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);

        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
        };
    }, [phase, action, onClose]);

    const startRecording = async () => {
        heldCodes.current = new Set();
        setLiveAccel('');
        setErrorMsg('');
        await window.discordVoice.suspendShortcuts?.();
        setPhase('recording');
    };

    const clearShortcut = async () => {
        setPhase('saving');
        const result = await window.discordVoice.setShortcut(action, '');
        if (result?.ok) {
            setCurrentAccel('');
            setPhase('menu');
        } else {
            setErrorMsg(result?.error || 'Não foi possível remover o atalho.');
            setPhase('error');
        }
    };

    return (
        <div
            className="shortcut-recorder-menu"
            ref={menuRef}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
        >
            <div className="shortcut-recorder-title">{label}</div>

            {phase === 'menu' ? (
                <>
                    <div className="shortcut-recorder-current">
                        Atalho atual: <b>{humanizeAccelerator(currentAccel)}</b>
                    </div>
                    <button type="button" className="shortcut-recorder-btn" onClick={startRecording}>
                        Gravar novo atalho
                    </button>
                    <button type="button" className="shortcut-recorder-btn shortcut-recorder-btn-danger" onClick={clearShortcut}>
                        Remover atalho
                    </button>
                </>
            ) : null}

            {phase === 'recording' ? (
                <>
                    <div className="shortcut-recorder-recording">Pressione a combinação desejada…</div>
                    <div className="shortcut-recorder-live">{liveAccel ? humanizeAccelerator(liveAccel) : '…'}</div>
                    <div className="shortcut-recorder-hint">Solte as teclas para confirmar • Esc cancela</div>
                </>
            ) : null}

            {phase === 'saving' ? (
                <div className="shortcut-recorder-saving">Salvando…</div>
            ) : null}

            {phase === 'error' ? (
                <>
                    <div className="shortcut-recorder-error">{errorMsg}</div>
                    <button type="button" className="shortcut-recorder-btn" onClick={startRecording}>
                        Tentar novamente
                    </button>
                </>
            ) : null}
        </div>
    );
}

function initialFor(text) {
    return String(text || '?').trim().slice(0, 1).toUpperCase() || '?';
}

function Avatar({ className, text, url }) {
    return (
        <span className={className}>
            {url ? <img style={{ width: "100%" }} src={url} alt="" referrerPolicy="no-referrer" /> : initialFor(text)}
        </span>
    );
}

function LockIcon() {
    return (
        <svg
            className="voice-lock-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <rect
                x="5"
                y="10"
                width="14"
                height="10"
                rx="2"
                fill="currentColor"
            />

            <path
                d="M8 10V7a4 4 0 0 1 8 0v3"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />

            <circle
                cx="12"
                cy="15"
                r="1.2"
                fill="#1e1f22"
            />
        </svg>
    );
}
function SpeakingPriorityIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            {/* Pessoa */}
            <circle
                cx="8"
                cy="7"
                r="3"
                fill="currentColor"
            />
            <path
                d="M2.5 19.5C2.5 15.91 4.96 13.5 8 13.5C11.04 13.5 13.5 15.91 13.5 19.5"
                fill="currentColor"
            />

            {/* Ondas de fala */}
            <path
                d="M15.5 8.5C16.8 9.25 17.5 10.55 17.5 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
            <path
                d="M18.5 6.5C20.3 7.8 21.5 9.75 21.5 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />

            {/* Seta indicando prioridade */}
            <path
                d="M16 16.5H21"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
            <path
                d="M18.5 14L21 16.5L18.5 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function LeaveAllIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M17 15l4-3-4-3M21 12H9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ScreenShareIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
            <path d="M8 20h8M12 16v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path
                d="M12 13V7m0 0-2.5 2.5M12 7l2.5 2.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function SystemAudioIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
            <path
                d="M14.5 9.5a4 4 0 0 1 0 5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
            />
            <path
                d="M20 5l-3 3m3-3h-3m3 0v3"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function VoiceModIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M3.5 13h2l2-5 3 10 3-14 2 9h2.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M19 4.2l.6 1.4L21 6.2l-1.4.6L19 8.2l-.6-1.4L17 6.2l1.4-.6L19 4.2Z"
                fill="currentColor"
            />
        </svg>
    );
}

function SoundEffectsIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M13 3 6 14h5l-1 7 7-11h-5l1-7Z" fill="currentColor" />
        </svg>
    );
}

function MusicIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M9 18V5l10-2v13"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="6.5" cy="18" r="2.5" fill="currentColor" />
            <circle cx="16.5" cy="16" r="2.5" fill="currentColor" />
        </svg>
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

// ============================================================
// DMs (mensagens diretas / grupos)
// ============================================================

/** Ícone de um canal privado: ícone do grupo (type 3) ou avatar do outro usuário (type 1). */
function dmAvatarUrl(channel) {
    if (!channel) return null;

    if (channel.type === 3) {
        return channel.icon
            ? `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png?size=64`
            : null;
    }

    return userAvatarUrl(channel.recipients?.[0], 64);
}

/** Nome de exibição de uma DM (nome do outro usuário) ou grupo (nome do grupo, ou lista de membros). */
function dmDisplayName(channel) {
    if (!channel) return 'Conversa';

    if (channel.type === 3) {
        if (channel.name) return channel.name;

        const names = (channel.recipients || [])
            .map((user) => user.global_name || user.username)
            .filter(Boolean);

        if (!names.length) return 'Grupo sem nome';
        if (names.length <= 3) return names.join(', ');
        return `${names.slice(0, 3).join(', ')} e mais ${names.length - 3}`;
    }

    const recipient = channel.recipients?.[0];
    return recipient?.global_name || recipient?.username || 'Usuário desconhecido';
}

/** Ordena conversas privadas da mais recente para a mais antiga. */
function sortPrivateChannels(channels) {
    return [...(channels || [])].sort((a, b) => {
        let idA, idB;
        try {
            idA = BigInt(a.last_message_id || a.id || 0);
            idB = BigInt(b.last_message_id || b.id || 0);
        } catch (_) {
            return 0;
        }
        if (idA === idB) return 0;
        return idA > idB ? -1 : 1;
    });
}

function activeDmEntryFor(activeCalls, channelId) {
    return activeCalls.calls.find((entry) => entry.isDm && entry.channelId === channelId) || null;
}

function CallIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1.1.5 1.1 1.1V20c0 .6-.5 1.1-1.1 1.1C10.4 21.1 2.9 13.6 2.9 4.2 2.9 3.6 3.4 3 4 3h3.3c.6 0 1.1.5 1.1 1.1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1L6.6 10.8Z"
                fill="currentColor"
            />
        </svg>
    );
}

function HangUpIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
                d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.5.6.6 0 1.1.5 1.1 1.1V20c0 .6-.5 1.1-1.1 1.1C10.4 21.1 2.9 13.6 2.9 4.2 2.9 3.6 3.4 3 4 3h3.3c.6 0 1.1.5 1.1 1.1 0 1.2.2 2.4.6 3.5.1.4 0 .8-.2 1L6.6 10.8Z"
                fill="currentColor"
            />
            <path d="M3 3l18 18" stroke="#f23f42" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
    );
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

function getVoiceChannelPermissions(guild, channel, currentUserId) {
    const member = guild.members[currentUserId];

    if (!member) {
        return {
            view: true,
            connect: true,
            connectToFull: true
        };
    }

    if (guild.owner_id === currentUserId) {
        return {
            view: true,
            connect: true,
            connectToFull: true
        };
    }

    const roleIds = new Set([
        guild.id,
        ...(member.roles || [])
    ]);

    let permissions = 0n;

    for (const role of Object.values(guild.roles)) {
        if (roleIds.has(role.id)) {
            permissions |= permissionBits(role.permissions);
        }
    }

    if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) {
        return {
            view: true,
            connect: true,
            connectToFull: true
        };
    }

    const parent = guild.categories[channel.parent_id];

    const overwrites =
        channel.permission_overwrites?.length
            ? channel.permission_overwrites
            : (parent?.permission_overwrites || []);

    const apply = (overwrite) => {
        permissions &= ~permissionBits(overwrite.deny);
        permissions |= permissionBits(overwrite.allow);
    };

    // @everyone
    const everyone = overwrites.find(
        overwrite => overwrite.id === guild.id
    );

    if (everyone) {
        apply(everyone);
    }

    // Cargos
    let roleDeny = 0n;
    let roleAllow = 0n;

    for (const overwrite of overwrites) {
        if (
            overwrite.type === 0 &&
            overwrite.id !== guild.id &&
            roleIds.has(overwrite.id)
        ) {
            roleDeny |= permissionBits(overwrite.deny);
            roleAllow |= permissionBits(overwrite.allow);
        }
    }

    permissions &= ~roleDeny;
    permissions |= roleAllow;

    // Usuário
    const memberOverwrite = overwrites.find(
        overwrite =>
            overwrite.type === 1 &&
            overwrite.id === currentUserId
    );

    if (memberOverwrite) {
        apply(memberOverwrite);
    }

    const view =
        (permissions & VIEW_CHANNEL) === VIEW_CHANNEL;

    const connect =
        (permissions & CONNECT) === CONNECT;

    const connectToFull =
        (permissions & MOVE_MEMBERS) === MOVE_MEMBERS;

    return {
        view,
        connect,
        connectToFull
    };
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

    const [privateChannels, setPrivateChannels] = useState([]);
    const [browserMode, setBrowserMode] = useState(() => {
        return localStorage.getItem('browserMode') === 'dms' ? 'dms' : 'servers';
    });

    const handleBrowserModeChange = (next) => {
        setBrowserMode(next);
        localStorage.setItem('browserMode', next);
    };

    const [streamAdvancedControlsEnabled, setStreamAdvancedControlsEnabled] = useState(() => {
        const saved = localStorage.getItem('streamAdvancedControlsEnabled');
        return saved === 'true';
    });

    useEffect(() => {
        window.discordVoice.setStreamAdvancedControls?.(streamAdvancedControlsEnabled);
    }, [streamAdvancedControlsEnabled]);

    const [speakingPriorityEnabled, setSpeakingPriorityEnabled] = useState(() => {
        const saved = localStorage.getItem('speakingPriorityEnabled');
        return saved === null ? true : saved === 'true';
    });

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
                setPrivateChannels([]);
            }),
            api.onLogout(() => {
                setGuilds({});
                setSelectedGuildId(null);
                setCurrentUserId(null);
                setCurrentUser(null);
                setActiveCalls(emptyActiveCalls);
                setPrivateChannels([]);
                setLoading(false);
                setStatus('Desconectado');
            }),
            api.onGatewayReady((ready) => {
                setCurrentUserId(ready.user?.id || null);
                setCurrentUser(ready.user || null);
                setPrivateChannels(Array.isArray(ready.private_channels) ? ready.private_channels : []);
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
            api.onSpeaking((speaking) => {
                if (!speaking?.guild_id || !speaking?.user_id) return;

                setGuilds((previous) => {
                    const guild = previous[speaking.guild_id];
                    if (!guild) return previous;

                    const state = guild.voiceStates[speaking.user_id];
                    if (!state) return previous;

                    const nextGuild = {
                        ...guild,
                        voiceStates: {
                            ...guild.voiceStates,
                            [speaking.user_id]: {
                                ...state,
                                speaking: Boolean(speaking.speaking)
                            }
                        }
                    };

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
        ];

        return () => {
            unsubscribers.forEach((unsubscribe) => unsubscribe());
            window.discordVoice.stopMicTest?.();
        };
    }, []);

    const toggleSpeakingPriority = () => {
        setSpeakingPriorityEnabled((current) => {
            const next = !current;
            localStorage.setItem('speakingPriorityEnabled', String(next));
            return next;
        });
    };

    async function handleLogout() {
        if (loading) return;

        setLoading(true);

        try {
            await window.discordVoice.logout();
        } catch (error) {
            console.error('Erro ao fazer logout:', error);
            setLoading(false);
            setStatus('Erro ao desconectar.');
        }
    }

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
                    <button
                        type="button"
                        className="inline-leave"
                        onClick={handleLogout}
                        disabled={loading}
                        aria-busy={loading}
                    >
                        {loading ? 'Saindo...' : 'Logout'}
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
                    mode={browserMode}
                    onModeChange={handleBrowserModeChange}
                    privateChannels={privateChannels}
                />
                {browserMode === 'servers' ? (
                    <ChannelsPanel guild={selectedGuild} currentUserId={currentUserId} activeCalls={activeCalls} speakingPriorityEnabled={speakingPriorityEnabled} />
                ) : (
                    <section className="panel channels-panel discord-channels-panel">
                        <div className="channels-panel-title">
                            <h2>CHAMADAS DIRETAS</h2>
                        </div>
                        <div className="discord-channel-list">
                            <p className="empty">
                                Escolha uma conversa na lateral e clique no ícone de ligar para iniciar uma chamada
                                de voz (apenas áudio, sem chat de texto).
                            </p>
                        </div>
                    </section>
                )}
                <ActiveCallsPanel activeCalls={activeCalls} guilds={guilds} />
            </section>

            {/* ===== CONTROLES INFERIORES: microfone ===== */}
            <section className="bottom-controls">
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
                        <div className="audio-meter mic-send-meter" aria-label="Áudio enviado ao Discord">
                            <div
                                className="audio-meter-fill"
                                style={{
                                    width: `${Math.round(Math.max(...activeCalls.calls.map((entry) => entry.inputLevel || 0), 0) * 100)}%`
                                }}
                            />
                        </div>
                        <span className="audio-meter-caption">Áudio enviado ao Discord</span>
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

            <ActionToolbar
                activeCalls={activeCalls}
                speakingPriorityEnabled={speakingPriorityEnabled}
                onToggleSpeakingPriority={toggleSpeakingPriority}
                streamAdvancedControlsEnabled={streamAdvancedControlsEnabled}
                onToggleStreamAdvancedControls={async () => {
                    const next = !streamAdvancedControlsEnabled;
                    setStreamAdvancedControlsEnabled(next);
                    localStorage.setItem('streamAdvancedControlsEnabled', String(next));
                    await window.discordVoice.setStreamAdvancedControls?.(next);
                }}
            />
        </main>
    );
}

function ServersPanel({
    guilds, selectedGuildId, activeCalls, onSelect,
    mode, onModeChange, privateChannels
}) {
    const [query, setQuery] = useState('');

    const filteredGuilds = useMemo(() => {
        const q = normalizeSearch(query);
        if (!q) return guilds;
        return guilds.filter((g) => normalizeSearch(g.name).includes(q));
    }, [guilds, query]);

    const sortedDms = useMemo(() => sortPrivateChannels(privateChannels), [privateChannels]);

    const filteredDms = useMemo(() => {
        const q = normalizeSearch(query);
        if (!q) return sortedDms;
        return sortedDms.filter((channel) => normalizeSearch(dmDisplayName(channel)).includes(q));
    }, [sortedDms, query]);

    // Reseta a busca ao trocar de aba, pra não filtrar a lista errada "por engano".
    useEffect(() => {
        setQuery('');
    }, [mode]);

    return (
        <aside className="panel servers-panel">
            <div className="servers-mode-switch" role="tablist" aria-label="Servidores ou mensagens diretas">
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'servers'}
                    className={`servers-mode-tab${mode === 'servers' ? ' active' : ''}`}
                    onClick={() => onModeChange('servers')}
                >
                    Servidores
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={mode === 'dms'}
                    className={`servers-mode-tab${mode === 'dms' ? ' active' : ''}`}
                    onClick={() => onModeChange('dms')}
                >
                    DMs
                </button>
            </div>

            {mode === 'servers' ? (
                <>
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
                        {guilds.length && !filteredGuilds.length ? (
                            <p className="empty">Nenhum servidor encontrado.</p>
                        ) : null}
                        {filteredGuilds.map((guild) => {
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
                </>
            ) : (
                <>
                    <h2>MENSAGENS DIRETAS</h2>
                    {
                        sortedDms.length != 0 && <input
                            className="panel-search"
                            type="search"
                            placeholder="Buscar conversa..."
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            aria-label="Buscar conversa"
                        />
                    }
                    <div className="scroll-list">
                        {!sortedDms.length ? <p className="empty">Nenhuma conversa recente.</p> : null}
                        {sortedDms.length && !filteredDms.length ? (
                            <p className="empty">Nenhuma conversa encontrada.</p>
                        ) : null}
                        {filteredDms.map((channel) => (
                            <DmRow key={channel.id} channel={channel} activeCalls={activeCalls} />
                        ))}
                    </div>
                </>
            )}
        </aside>
    );
}

function DmRow({ channel, activeCalls }) {
    const active = activeDmEntryFor(activeCalls, channel.id);
    const name = dmDisplayName(channel);
    const avatarUrl = dmAvatarUrl(channel);

    const connecting = active?.status === 'connecting';
    const error = active?.status === 'error';

    const classes = [
        'server-row',
        'dm-row',
        active ? 'connected' : '',
        error ? 'call-error' : ''
    ]
        .filter(Boolean)
        .join(' ');

    const call = async (event) => {
        event.stopPropagation();
        if (active) return;

        await window.discordVoice.joinDmCall({
            id: channel.id,
            name,
            avatarUrl,
            type: channel.type
        });
    };

    const hangUp = (event) => {
        event.stopPropagation();
        window.discordVoice.leaveCall(channel.id);
    };

    return (
        <div className={classes}>
            <Avatar className="server-icon" text={name} url={avatarUrl} />
            <span className="server-name">
                {name}
                {error ? <span className="dm-row-error"> — {active.error || 'Erro ao conectar'}</span> : null}
            </span>
            {active ? (
                <button className="inline-leave dm-hangup-button" type="button" onClick={hangUp} title="Sair da call">
                    <HangUpIcon />
                    {connecting ? 'Cancelar' : 'Sair'}
                </button>
            ) : (
                <button className="dm-call-button" type="button" onClick={call} title={`Ligar para ${name}`} aria-label={`Ligar para ${name}`}>
                    <CallIcon />
                </button>
            )}
        </div>
    );
}

function VoiceChannelIcon({ muted = false }) {
    return (
        <svg
            className={`voice-channel-icon${muted ? ' muted' : ''}`}
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M4 9v6h4l5 4V5L8 9H4Z"
                fill="currentColor"
            />
            <path
                d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
            />
        </svg>
    );
}

function CameraIcon() {
    return (
        <svg
            className="discord-member-video-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
        >
            <path
                d="M4 7.5A2.5 2.5 0 0 1 6.5 5h7A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 16.5v-9Z"
                fill="currentColor"
            />
            <path
                d="m16 10 4-2.5v9L16 14"
                fill="currentColor"
            />
        </svg>
    );
}

function StreamBadge({ onClick, disabled = false }) {
    return (
        <button
            type="button"
            className={`discord-member-live${disabled ? ' disabled' : ''}`}
            title={disabled ? 'Entre na call para assistir' : 'Assistir transmissão'}
            disabled={disabled}
            onClick={(event) => {
                event.stopPropagation();
                if (!disabled) onClick?.(event);
            }}
        >
            LIVE
        </button>
    );
}

function CategoryHeader({ name, collapsed, onClick }) {
    return (
        <div
            className={`voice-category-header${collapsed ? ' collapsed' : ''}`}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onClick();
                }
            }}
        >
            <svg
                className="category-chevron"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
            >
                <path
                    d="M8 5l8 7-8 7"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>

            <span>{name || 'Canais de voz'}</span>
        </div>
    );
}

function ChannelsPanel({ guild, currentUserId, activeCalls, speakingPriorityEnabled }) {
    const [query, setQuery] = useState('');
    const [memberQuery, setMemberQuery] = useState('');
    const [collapsedCategories, setCollapsedCategories] = useState(
        new Set()
    );

    const toggleCategory = (categoryId) => {
        setCollapsedCategories((previous) => {
            const next = new Set(previous);

            if (next.has(categoryId)) {
                next.delete(categoryId);
            } else {
                next.add(categoryId);
            }

            return next;
        });
    };

    const channels = useMemo(() => {
        if (!guild) return [];

        return Object.values(guild.channels)
            .filter((channel) => {
                const permissions = getVoiceChannelPermissions(
                    guild,
                    channel,
                    currentUserId
                );

                return permissions.view;
            })
            .sort(
                (a, b) =>
                    (a.position || 0) -
                    (b.position || 0)
            );
    }, [guild, currentUserId]);

    const categories = useMemo(() => {
        if (!guild) return [];

        return Object.values(guild.categories || {})
            .sort((a, b) => (a.position || 0) - (b.position || 0));
    }, [guild]);

    const groupedChannels = useMemo(() => {
        const q = normalizeSearch(query);
        const memberQ = normalizeSearch(memberQuery);

        const channelHasMember = (channel) => {
            if (!memberQ) return true;

            return Object.values(guild?.voiceStates || {}).some((state) => {
                if (state.channel_id !== channel.id) return false;

                const user = getStateUser(guild, state) || {};
                const member = state.member || guild?.members?.[state.user_id] || {};

                return [
                    state.user_id,
                    user.username,
                    user.global_name,
                    member.nick
                ].some((value) => normalizeSearch(value).includes(memberQ));
            });
        };

        const matches = channels.filter((channel) =>
            (!q || normalizeSearch(channel.name).includes(q)) &&
            channelHasMember(channel)
        );

        // Discord ordena a árvore pela posição global dos containers.
        // Isso permite que canais sem categoria apareçam entre categorias.
        const groups = [];

        for (const category of categories) {
            const categoryChannels = matches
                .filter((channel) => channel.parent_id === category.id)
                .sort((a, b) => (a.position || 0) - (b.position || 0));

            if (categoryChannels.length) {
                groups.push({
                    category,
                    channels: categoryChannels,
                    position: Number(category.position || 0),
                    uncategorized: false
                });
            }
        }

        const uncategorized = matches
            .filter((channel) => !channel.parent_id)
            .sort((a, b) => (a.position || 0) - (b.position || 0));

        for (const channel of uncategorized) {
            groups.push({
                category: null,
                channels: [channel],
                position: Number(channel.position || 0),
                uncategorized: true
            });
        }

        groups.sort((a, b) => {
            const positionDiff = a.position - b.position;
            if (positionDiff !== 0) return positionDiff;

            if (a.uncategorized !== b.uncategorized) {
                return a.uncategorized ? 1 : -1;
            }

            return (a.category?.id || a.channels[0]?.id || '')
                .localeCompare(b.category?.id || b.channels[0]?.id || '');
        });

        return groups;
    }, [channels, categories, query, memberQuery, guild]);

    useEffect(() => {
        setQuery('');
        setMemberQuery('');
    }, [guild?.id]);

    return (
        <section className="panel channels-panel discord-channels-panel">
            <div className="channels-panel-title">
                <h2>CANAIS DE VOZ</h2>
            </div>

            {guild && channels.length ? (
                <div className="channel-search-row">
                    <input
                        className="panel-search"
                        type="search"
                        placeholder="Buscar canal..."
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        aria-label="Buscar canal de voz"
                    />
                    <input
                        className="panel-search"
                        type="search"
                        placeholder="Buscar membro..."
                        value={memberQuery}
                        onChange={(event) => setMemberQuery(event.target.value)}
                        aria-label="Buscar membro por ID, username, apelido ou display name"
                    />
                </div>
            ) : null}

            <div className="discord-channel-list">
                {!guild ? (
                    <p className="empty">
                        Selecione um servidor na lateral.
                    </p>
                ) : null}

                {guild && !channels.length ? (
                    <p className="empty">
                        Você não tem permissão para entrar em nenhuma call deste servidor.
                    </p>
                ) : null}

                {guild && channels.length && !groupedChannels.length ? (
                    <p className="empty">
                        Nenhum canal encontrado.
                    </p>
                ) : null}

                {groupedChannels.map((group) => {
                    const categoryId =
                        group.category?.id || 'uncategorized';

                    const collapsed =
                        collapsedCategories.has(categoryId);

                    return (
                        <div
                            key={categoryId}
                            className={`voice-category${collapsed ? ' collapsed' : ''
                                }`}
                        >
                            {group.category ? (
                                <CategoryHeader
                                    name={group.category.name}
                                    collapsed={collapsed}
                                    onClick={() =>
                                        toggleCategory(categoryId)
                                    }
                                />
                            ) : null}

                            {!collapsed && (
                                <div className="voice-category-channels">
                                    {group.channels.map((channel) => (
                                        <ChannelCard
                                            key={channel.id}
                                            guild={guild}
                                            channel={channel}
                                            activeCalls={activeCalls}
                                            currentUserId={currentUserId}
                                            speakingPriorityEnabled={speakingPriorityEnabled}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function ChannelCard({ guild, channel, activeCalls, currentUserId, speakingPriorityEnabled }) {
    const active = activeEntryForChannel(
        activeCalls,
        guild.id,
        channel.id
    );

    const permissions = getVoiceChannelPermissions(
        guild,
        channel,
        currentUserId
    );

    const locked = !permissions.connect;

    const connecting = active?.status === 'connecting';
    const connected = active?.status === 'connected';
    const error = active?.status === 'error';

    const members = Object.values(guild.voiceStates)
        .filter((state) => state.channel_id === channel.id)
        .sort((a, b) => {
            const priorityA =
                (a.self_stream ? 4 : 0) +
                (a.self_video ? 2 : 0) +
                (speakingPriorityEnabled && a.speaking ? 1 : 0);

            const priorityB =
                (b.self_stream ? 4 : 0) +
                (b.self_video ? 2 : 0) +
                (speakingPriorityEnabled && b.speaking ? 1 : 0);

            if (priorityA !== priorityB) {
                return priorityB - priorityA;
            }

            const userA = getStateUser(guild, a);
            const userB = getStateUser(guild, b);

            const nameA =
                a.member?.nick ||
                userA?.global_name ||
                userA?.username ||
                '';

            const nameB =
                b.member?.nick ||
                userB?.global_name ||
                userB?.username ||
                '';

            return nameA.localeCompare(nameB);
        });

    const hasLimit =
        Number(channel.user_limit || 0) > 0;

    const isFull =
        hasLimit &&
        members.length >= Number(channel.user_limit);

    const joinCall = async () => {
        if (active?.status === 'connecting') {
            return;
        }

        const activeSameGuild = activeCalls.calls.find(
            (entry) => entry.guildId === guild.id
        );

        if (activeSameGuild && activeSameGuild.channelId !== channel.id) {
            await window.discordVoice.leaveCall(guild.id);
        }

        window.discordVoice.joinCall({
            guild: {
                id: guild.id,
                name: guild.name
            },
            channel: {
                id: channel.id,
                name: channel.name,
                userLimit: Number(channel.user_limit || 0)
            },
            canConnect: permissions.connect,
            isFull
        });
    };

    const watchStream = async (userId, displayName = 'Transmissão') => {
        if (!connected) {
            alert('Entre nesta call para assistir à transmissão.');
            return;
        }

        const result = await window.discordVoice.watchStream?.({
            guildId: guild.id,
            channelId: channel.id,
            userId: String(userId),
            displayName: String(displayName || 'Transmissão')
        });

        if (result?.ok === false) {
            alert(result.error || 'Não foi possível abrir a transmissão.');
        }
    };

    const watchCamera = async (userId, displayName = 'Câmera') => {
        if (!connected) {
            alert('Entre nesta call para assistir à câmera.');
            return;
        }

        const result = await window.discordVoice.watchCamera?.({
            guildId: guild.id,
            channelId: channel.id,
            userId: String(userId),
            displayName: String(displayName || 'Câmera')
        });

        if (result?.ok === false) {
            alert(result.error || 'Não foi possível abrir a câmera.');
        }
    };

    return (
        <div
            className={[
                'discord-voice-channel',
                connected ? 'active' : '',
                connecting ? 'connecting' : '',
                error ? 'error' : '',
                locked ? 'locked' : ''
            ]
                .filter(Boolean)
                .join(' ')}
        >
            <div
                className="discord-voice-channel-row"
                role="button"
                tabIndex={0}
                onClick={() => {
                    if (locked) return alert("Você não tem permissão para entrar nesse canal");
                    if (isFull && !permissions.connectToFull) return alert("Este canal está cheio")
                    joinCall()
                }}
                onKeyDown={(event) =>
                    activateWithKeyboard(event, joinCall)
                }
            >

                {locked ? (
                    <LockIcon />
                ) : <VoiceChannelIcon />}

                <span className="discord-voice-channel-name">
                    {channel.name}
                </span>

                {hasLimit ? (
                    <span className="voice-channel-limit">
                        <span className="voice-channel-count">
                            {String(members.length).padStart(2, '0')}
                        </span>

                        <span className="voice-channel-limit-separator">
                            /
                        </span>

                        <span>
                            {String(channel.user_limit).padStart(2, '0')}
                        </span>
                    </span>
                ) : null}

                {connecting ? (
                    <span className="voice-connection-status connecting">
                        <span className="voice-status-dot" />
                        Conectando...
                    </span>
                ) : null}

                {error ? (
                    <span
                        className="voice-connection-status error"
                        title={active.error || 'Erro desconhecido'}
                    >
                        <span className="voice-status-dot" />
                        Erro
                    </span>
                ) : null}
            </div>

            {members.length ? (
                <div className="discord-channel-members">
                    {members.map((state) => {
                        const user = getStateUser(guild, state);

                        const name =
                            state.member?.nick ||
                            user?.global_name ||
                            user?.username ||
                            'Usuário desconhecido';

                        const muted =
                            state.self_mute ||
                            state.mute;

                        const deafened =
                            state.self_deaf ||
                            state.deaf;

                        return (
                            <div
                                key={state.user_id}
                                className="discord-voice-member"
                                onClick={() => {
                                    window.discordVoice.openDiscordUser(state.user_id);
                                }}
                            >
                                <Avatar
                                    className={`discord-voice-member-avatar${state.speaking ? ' speaking' : ''}`}
                                    text={name}
                                    url={userAvatarUrl(user, 64)}
                                />

                                <span className="discord-voice-member-name">
                                    {name}
                                </span>

                                {state.self_video ? (
                                    <span
                                        className="discord-member-media discord-member-media-clickable"
                                        title={connected ? 'Assistir à câmera' : 'Câmera ligada'}
                                        role="button"
                                        tabIndex={connected ? 0 : -1}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            if (connected) watchCamera(state.user_id, name);
                                        }}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                if (connected) watchCamera(state.user_id, name);
                                            }
                                        }}
                                    >
                                        <CameraIcon />
                                    </span>
                                ) : null}

                                {state.self_stream ? (
                                    <StreamBadge
                                        disabled={!connected}
                                        onClick={() => watchStream(state.user_id, name)}
                                    />
                                ) : null}

                                {muted ? (
                                    <span
                                        className="discord-member-state"
                                        title="Mutado"
                                    >
                                        <img
                                            src={micOffIcon}
                                            alt=""
                                        />
                                    </span>
                                ) : null}

                                {deafened ? (
                                    <span
                                        className="discord-member-state"
                                        title="Ensurd ecido"
                                    >
                                        <img
                                            src={deafenOnIcon}
                                            alt=""
                                        />
                                    </span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}

function ToolbarIconButton({
    icon, label, onClick, active = false, danger = false, disabled = false,
    placeholder = false, className = '', shortcutAction = null, shortcutLabel = null
}) {
    const buttonRef = useRef(null);
    const [shortcutMenuOpen, setShortcutMenuOpen] = useState(false);

    useEffect(() => {
        if (!buttonRef.current) return undefined;

        const instance = tippy(buttonRef.current, {
            content: label,
            placement: 'top',
            theme: 'discord-voice',
            animation: 'shift-away',
            delay: [200, 0],
            arrow: true
        });

        return () => instance.destroy();
    }, [label]);

    const handleContextMenu = (event) => {
        if (!shortcutAction) return;
        event.preventDefault();
        event.stopPropagation();
        setShortcutMenuOpen(true);
    };

    return (
        <span className="toolbar-icon-button-wrapper">
            <button
                ref={buttonRef}
                type="button"
                className={[
                    'toolbar-icon-button',
                    className,
                    active ? 'is-active' : '',
                    danger ? 'is-danger' : '',
                    placeholder ? 'is-placeholder' : ''
                ].filter(Boolean).join(' ')}
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
                onContextMenu={handleContextMenu}
            >
                {icon}
            </button>

            {shortcutMenuOpen && shortcutAction ? (
                <ShortcutRecorderMenu
                    action={shortcutAction}
                    label={shortcutLabel || label}
                    onClose={() => setShortcutMenuOpen(false)}
                />
            ) : null}
        </span>
    );
}

function NoiseSuppressionIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function ActionToolbar({
    activeCalls,
    speakingPriorityEnabled,
    onToggleSpeakingPriority,
    streamAdvancedControlsEnabled,
    onToggleStreamAdvancedControls
}) {
    const hasActiveCalls = activeCalls.calls.length > 0;
    const noop = () => { };

    return (
        <section className="action-toolbar" aria-label="Ações rápidas">
            <ToolbarIconButton
                icon={
                    <img
                        src={activeCalls.allMuted ? micOffIcon : micOnIcon}
                        alt=""
                    />
                }
                label={
                    activeCalls.allMuted
                        ? 'Reativar microfone de todas as calls'
                        : 'Mutar microfone de todas as calls'
                }
                active={activeCalls.allMuted}
                onClick={() => window.discordVoice.toggleAllMute()}
                shortcutAction="toggleMute"
                shortcutLabel="Mutar / Desmutar (todas as calls)"
            />

            <ToolbarIconButton
                icon={
                    <img
                        src={
                            activeCalls.allDeafened
                                ? deafenOnIcon
                                : deafenOffIcon
                        }
                        alt=""
                    />
                }
                label={
                    activeCalls.allDeafened
                        ? 'Reativar áudio de todas as calls'
                        : 'Ensurdecer todas as calls'
                }
                active={activeCalls.allDeafened}
                onClick={() => window.discordVoice.toggleAllDeafen()}
                shortcutAction="toggleDeafen"
                shortcutLabel="Ensurdecer / Escutar (todas as calls)"
            />

            <ToolbarIconButton
                icon={<LeaveAllIcon />}
                label={
                    hasActiveCalls
                        ? 'Sair de todas as calls'
                        : 'Nenhuma call ativa'
                }
                danger
                disabled={!hasActiveCalls}
                onClick={() => window.discordVoice.leaveAllCalls()}
            />

            <span className="toolbar-divider" aria-hidden="true" />

            <ToolbarIconButton
                icon={<ScreenShareIcon />}
                label="Compartilhar tela (em breve)"
                placeholder
                onClick={noop}
            />

            <ToolbarIconButton
                icon={<SystemAudioIcon />}
                label="Compartilhar áudio do sistema (em breve)"
                placeholder
                onClick={noop}
            />

            <ToolbarIconButton
                icon={<NoiseSuppressionIcon />}
                label={
                    activeCalls.noiseSuppressionEnabled
                        ? 'Desativar supressão de ruído (RNNoise)'
                        : 'Ativar supressão de ruído (RNNoise)'
                }
                className={
                    activeCalls.noiseSuppressionEnabled
                        ? 'noise-suppression-active'
                        : 'noise-suppression-inactive'
                }
                onClick={() =>
                    window.discordVoice.setNoiseSuppression(
                        !activeCalls.noiseSuppressionEnabled
                    )
                }
            />

            <ToolbarIconButton
                icon={<VoiceModIcon />}
                label="Voice Mod (em breve)"
                placeholder
                onClick={noop}
            />

            <ToolbarIconButton
                icon={<SoundEffectsIcon />}
                label="Efeitos sonoros (em breve)"
                placeholder
                onClick={noop}
            />

            <ToolbarIconButton
                icon={<MusicIcon />}
                label="Música (em breve)"
                placeholder
                onClick={noop}
            />

            {/* Prioridade por speaking — fica à direita da Música */}
            <ToolbarIconButton
                icon={<SpeakingPriorityIcon />}
                label={
                    speakingPriorityEnabled
                        ? 'Desativar ordenação de quem está falando'
                        : 'Ativar ordenação de quem está falando'
                }
                active={speakingPriorityEnabled}
                className={
                    speakingPriorityEnabled
                        ? 'speaking-priority-active'
                        : 'speaking-priority-inactive'
                }
                onClick={onToggleSpeakingPriority}
            />

            <ToolbarIconButton
                icon={<ScreenShareIcon />}
                label={streamAdvancedControlsEnabled
                    ? 'Desativar controles avançados de stream'
                    : 'Ativar controles avançados de stream'}
                active={streamAdvancedControlsEnabled}
                className={streamAdvancedControlsEnabled
                    ? 'noise-suppression-active'
                    : 'noise-suppression-inactive'}
                onClick={onToggleStreamAdvancedControls}
            />
        </section>
    );
}

function ActiveCallsPanel({ activeCalls, guilds }) {
    return (
        <aside className="panel active-panel">
            <h2>CALLS ATIVAS</h2>
            <div className="scroll-list">
                {!activeCalls.calls.length ? <p className="empty">Nenhuma call ativa.</p> : null}
                {activeCalls.calls.map((entry) => {
                    if (entry.isDm) {
                        const title = entry.switching ? `${entry.dmName}...` : (entry.dmName || 'Chamada de voz');

                        return (
                            <article key={entry.id} className="active-card">
                                <Avatar
                                    className="active-server-icon"
                                    text={entry.dmName}
                                    url={entry.dmAvatarUrl}
                                />
                                <div className="active-labels">
                                    <span className="active-title">{title}</span>
                                    <span className="active-meta">
                                        {entry.dmType === 3 ? 'Chamada em grupo' : 'Chamada direta'}
                                    </span>
                                    <div className="audio-meter active-audio-meter" aria-label="Áudio recebido da call">
                                        <div
                                            className="audio-meter-fill"
                                            style={{ width: `${Math.round((entry.outputLevel || 0) * 100)}%` }}
                                        />
                                    </div>
                                </div>
                                <IconButton
                                    icon={entry.muted ? micOffIcon : micOnIcon}
                                    title={entry.muted ? 'Reativar microfone' : 'Mutar microfone'}
                                    onClick={() => window.discordVoice.toggleCallMute(entry.id)}
                                />
                                <IconButton
                                    icon={entry.deafened ? deafenOnIcon : deafenOffIcon}
                                    title={entry.deafened ? 'Reativar áudio' : 'Ensurdecer'}
                                    onClick={() => window.discordVoice.toggleCallDeafen(entry.id)}
                                />
                                <button
                                    className="leave-button"
                                    type="button"
                                    onClick={() => window.discordVoice.leaveCall(entry.id)}
                                >
                                    Sair
                                </button>
                            </article>
                        );
                    }

                    // O backend recebe apenas channel_id no VOICE_STATE_UPDATE.
                    // O nome verdadeiro deve ser resolvido pelo cache de guilds
                    // mais recente do renderer, evitando mostrar o ID quando um
                    // admin move o usuário para outro canal.
                    const channelName =
                        guilds?.[entry.guildId]?.channels?.[entry.channelId]?.name ||
                        (entry.channelName && entry.channelName !== entry.channelId
                            ? entry.channelName
                            : 'Canal de voz');

                    return (
                        <article key={entry.id} className="active-card">
                            <Avatar
                                className="active-server-icon"
                                text={entry.guildName}
                                url={serverIconUrl(guilds?.[entry.guildId])}
                            />
                            <div className="active-labels">
                                <span className="active-title">
                                    {entry.switching ? `${channelName}...` : channelName}
                                </span>
                                <span className="active-meta">{entry.guildName}</span>
                                <div className="audio-meter active-audio-meter" aria-label="Áudio recebido da call">
                                    <div
                                        className="audio-meter-fill"
                                        style={{ width: `${Math.round((entry.outputLevel || 0) * 100)}%` }}
                                    />
                                </div>
                            </div>
                            <IconButton
                                icon={entry.muted ? micOffIcon : micOnIcon}
                                title={entry.muted ? 'Reativar microfone' : 'Mutar microfone'}
                                onClick={() => window.discordVoice.toggleCallMute(entry.id)}
                            />
                            <IconButton
                                icon={entry.deafened ? deafenOnIcon : deafenOffIcon}
                                title={entry.deafened ? 'Reativar áudio' : 'Ensurdecer'}
                                onClick={() => window.discordVoice.toggleCallDeafen(entry.id)}
                            />
                            <button
                                className="leave-button"
                                type="button"
                                onClick={() => window.discordVoice.leaveCall(entry.id)}
                            >
                                Sair
                            </button>
                        </article>
                    )
                })}
            </div>
        </aside>
    );
}

export default App;