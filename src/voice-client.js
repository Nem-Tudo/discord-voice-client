'use strict';

const WebSocket = require('ws');
const dgram = require('dgram');

const { AudioPlayer } = require('./audio-player');

let Davey = null;

try {
    Davey = require('@snazzah/davey');
} catch (e) {
    // Tratado em createVoiceClient()
}

const DAVESession = Davey?.DAVESession;
const MAX_DAVE_VERSION = Davey?.DAVE_PROTOCOL_VERSION ?? 0;

const GATEWAY_VERSION = 10;
const VOICE_VERSION = 8;

const INTENTS =
    (1 << 0) | // GUILDS
    (1 << 7);  // GUILD_VOICE_STATES


const VoiceOp = {
    IDENTIFY: 0,
    SELECT_PROTOCOL: 1,
    READY: 2,
    HEARTBEAT: 3,
    SESSION_DESCRIPTION: 4,
    SPEAKING: 5,
    HEARTBEAT_ACK: 6,
    RESUME: 7,
    HELLO: 8,
    RESUMED: 9,

    CLIENTS_CONNECT: 11,
    CLIENT_DISCONNECT: 13,

    DAVE_PREPARE_TRANSITION: 21,
    DAVE_EXECUTE_TRANSITION: 22,
    DAVE_TRANSITION_READY: 23,

    DAVE_PREPARE_EPOCH: 24,

    MLS_EXTERNAL_SENDER: 25,
    MLS_KEY_PACKAGE: 26,
    MLS_PROPOSALS: 27,
    MLS_COMMIT_WELCOME: 28,
    MLS_ANNOUNCE_COMMIT_TRANSITION: 29,
    MLS_WELCOME: 30,
    MLS_INVALID_COMMIT_WELCOME: 31
};


function createVoiceClient({
    token,
    guildId,
    channelId,
    onLog,
    onReady,
    onDisconnected,
    onGatewayReady,
    onGuildCreate,
    onVoiceStateUpdate
}) {
    const log = (msg) => {
        if (onLog) {
            onLog(msg);
        }
    };


    // ============================================================
    // GATEWAY PRINCIPAL
    // ============================================================

    let gatewayWs = null;
    let gatewayHeartbeatInterval = null;
    let lastSeq = null;

    let botUserId = null;


    // ============================================================
    // VOICE STATE
    // ============================================================

    let voiceServerToken = null;
    let voiceEndpoint = null;
    let voiceSessionId = null;

    let voiceWs = null;
    let voiceHeartbeatInterval = null;
    let lastVoiceSeq = -1;

    let udpSocket = null;

    let ssrc = null;
    let voiceIp = null;
    let voicePort = null;


    // ============================================================
    // VOICE CRYPTO
    // ============================================================

    let voiceSecretKey = null;

    /*
     * Discord pode negociar:
     *
     * aead_aes256_gcm_rtpsize
     * aead_xchacha20_poly1305_rtpsize
     */
    let voiceEncryptionMode = null;


    // ============================================================
    // DAVE
    // ============================================================

    let daveSession = null;

    let daveProtocolVersion = 0;

    const davePendingTransitions = new Map();

    /*
     * Usuários que já foram conhecidos pelo cliente.
     *
     * Necessário para MLS proposals.
     */
    const recognizedUserIds = new Set();

    /*
     * SSRC -> Discord User ID
     */
    const ssrcMap = new Map();


    // ============================================================
    // ESTADO DO CLIENTE
    // ============================================================

    let selfMute = false;
    let selfDeaf = false;

    let intentionalDisconnect = false;
    let sessionEstablished = false;


    // ============================================================
    // ÁUDIO
    // ============================================================

    const audioPlayer = new AudioPlayer(log);


    // ============================================================
    // GATEWAY PRINCIPAL
    // ============================================================

    function connectGateway() {
        if (
            gatewayWs &&
            (
                gatewayWs.readyState === WebSocket.OPEN ||
                gatewayWs.readyState === WebSocket.CONNECTING
            )
        ) {
            return;
        }

        log('[Gateway] conectando...');

        gatewayWs = new WebSocket(
            `wss://gateway.discord.gg/?v=${GATEWAY_VERSION}&encoding=json`
        );

        gatewayWs.on('open', () => {
            log('[Gateway] conectado');
        });

        gatewayWs.on('message', (data) => {
            try {
                const payload = JSON.parse(data.toString());

                handleGatewayPayload(payload);
            } catch (e) {
                log(
                    `[Gateway] erro processando payload: ${e.message}`
                );
            }
        });

        gatewayWs.on('close', (code, reason) => {
            log(
                `[Gateway] conexão fechada: ${code} ${reason}`
            );

            clearInterval(gatewayHeartbeatInterval);
            gatewayHeartbeatInterval = null;

            if (!intentionalDisconnect) {
                finishDisconnect(
                    `gateway fechado (${code})`
                );
            }
        });

        gatewayWs.on('error', (err) => {
            log(
                `[Gateway] erro: ${err.message}`
            );
        });
    }


    function handleGatewayPayload(payload) {
        const {
            op,
            d,
            s,
            t
        } = payload;

        if (typeof s === 'number') {
            lastSeq = s;
        }

        switch (op) {

            // HELLO
            case 10: {
                clearInterval(gatewayHeartbeatInterval);

                gatewayHeartbeatInterval = setInterval(
                    () => {
                        sendGateway(
                            1,
                            lastSeq
                        );
                    },
                    d.heartbeat_interval
                );

                identifyGateway();

                break;
            }


            // DISPATCH
            case 0: {
                handleDispatch(t, d);

                break;
            }


            // HEARTBEAT
            case 1: {
                sendGateway(
                    1,
                    lastSeq
                );

                break;
            }


            // RECONNECT
            case 7: {
                log(
                    '[Gateway] Discord solicitou reconexão.'
                );

                try {
                    gatewayWs?.close();
                } catch (_) { }

                setTimeout(
                    connectGateway,
                    1000
                );

                break;
            }


            // INVALID SESSION
            case 9: {
                log(
                    '[Gateway] sessão inválida, reconectando em 5s...'
                );

                setTimeout(
                    connectGateway,
                    5000
                );

                break;
            }


            default:
                break;
        }
    }


    function identifyGateway() {
        sendGateway(
            2,
            {
                token,

                intents: INTENTS,

                properties: {
                    os: process.platform,
                    browser: 'custom-voice-bot',
                    device: 'custom-voice-bot'
                }
            }
        );
    }


    function handleDispatch(type, d) {
        switch (type) {

            case 'READY': {
                botUserId = d.user.id;

                log(
                    `[Gateway] logado como ${d.user.username}`
                );

                // A interface pode usar o Gateway apenas para listar servidores
                // antes de decidir em qual canal de voz entrar.
                if (onGatewayReady) {
                    onGatewayReady(d);
                }

                if (guildId && channelId) {
                    joinVoiceChannel();
                }

                break;
            }

            case 'GUILD_CREATE': {
                if (onGuildCreate) {
                    onGuildCreate(d);
                }
                break;
            }


            case 'VOICE_STATE_UPDATE': {
                if (onVoiceStateUpdate) {
                    onVoiceStateUpdate(d);
                }
                /*
                 * Discord envia nosso próprio session_id
                 * através desse evento.
                 */
                if (d.user_id === botUserId) {
                    voiceSessionId = d.session_id;

                    maybeConnectVoice();
                }

                /*
                 * Atualização de outros usuários.
                 *
                 * Em algumas situações o SSRC chega pelo
                 * Speaking posteriormente, portanto não
                 * tentamos inventar um SSRC aqui.
                 */
                break;
            }


            case 'VOICE_SERVER_UPDATE': {
                voiceServerToken = d.token;
                voiceEndpoint = d.endpoint;

                maybeConnectVoice();

                break;
            }


            default:
                break;
        }
    }


    function sendGateway(op, d) {
        if (
            gatewayWs &&
            gatewayWs.readyState === WebSocket.OPEN
        ) {
            gatewayWs.send(
                JSON.stringify({
                    op,
                    d
                })
            );
        }
    }


    function joinVoiceChannel() {
        log(
            `[Gateway] entrando no canal de voz ${channelId}...`
        );

        sendGateway(
            4,
            {
                guild_id: guildId,
                channel_id: channelId,

                self_mute: selfMute,
                self_deaf: selfDeaf
            }
        );
    }


    // ============================================================
    // VOICE GATEWAY
    // ============================================================

    function maybeConnectVoice() {
        if (
            !voiceSessionId ||
            !voiceServerToken ||
            !voiceEndpoint
        ) {
            return;
        }

        if (
            voiceWs &&
            (
                voiceWs.readyState === WebSocket.OPEN ||
                voiceWs.readyState === WebSocket.CONNECTING
            )
        ) {
            return;
        }

        connectVoiceGateway();
    }


    function connectVoiceGateway() {
        /*
         * Endpoint pode vir com :80.
         */
        const endpoint = voiceEndpoint
            .replace(':80', '');

        log(
            `[Voice] conectando em ${endpoint}...`
        );

        voiceWs = new WebSocket(
            `wss://${endpoint}/?v=${VOICE_VERSION}`
        );

        voiceWs.on('open', () => {
            log(
                '[Voice] conectado ao voice gateway'
            );
        });

        voiceWs.on('message', (data, isBinary) => {
            try {
                if (isBinary) {
                    handleVoiceBinary(
                        Buffer.from(data)
                    );
                } else {
                    handleVoicePayload(
                        JSON.parse(
                            data.toString('utf8')
                        )
                    );
                }
            } catch (e) {
                log(
                    `[Voice] erro processando payload: ${e.message}`
                );
            }
        });

        voiceWs.on('close', (code, reason) => {
            log(
                `[Voice] fechado: ${code} ${reason}`
            );

            clearInterval(
                voiceHeartbeatInterval
            );

            voiceHeartbeatInterval = null;

            if (!intentionalDisconnect) {
                finishDisconnect(
                    `voice gateway (${code})`
                );
            }
        });

        voiceWs.on('error', (err) => {
            log(
                `[Voice] erro: ${err.message}`
            );
        });
    }


    function sendVoice(op, d) {
        if (
            voiceWs &&
            voiceWs.readyState === WebSocket.OPEN
        ) {
            voiceWs.send(
                JSON.stringify({
                    op,
                    d
                })
            );
        }
    }


    /*
     * Voice Gateway binary packet:
     *
     * [2 bytes sequence]
     * [1 byte opcode]
     * [payload]
     */
    function sendVoiceBinary(op, payload) {
        if (
            voiceWs &&
            voiceWs.readyState === WebSocket.OPEN
        ) {
            const packet = Buffer.concat([
                Buffer.from([op]),
                payload
            ]);

            voiceWs.send(packet, {
                binary: true
            });
        }
    }


    // ============================================================
    // VOICE PAYLOAD
    // ============================================================

    function handleVoicePayload(payload) {
        const {
            op,
            d,
            seq
        } = payload;

        if (typeof seq === 'number') {
            lastVoiceSeq = seq;
        }

        switch (op) {

            // ----------------------------------------------------
            // HELLO
            // ----------------------------------------------------

            case VoiceOp.HELLO: {
                clearInterval(
                    voiceHeartbeatInterval
                );

                voiceHeartbeatInterval = setInterval(
                    () => {
                        sendVoice(
                            VoiceOp.HEARTBEAT,
                            {
                                t: Date.now(),
                                seq_ack: lastVoiceSeq
                            }
                        );
                    },
                    d.heartbeat_interval
                );


                /*
                 * DAVE negotiation:
                 *
                 * O cliente informa a versão máxima que
                 * suporta.
                 */
                sendVoice(
                    VoiceOp.IDENTIFY,
                    {
                        server_id: guildId,
                        user_id: botUserId,
                        session_id: voiceSessionId,
                        token: voiceServerToken,

                        max_dave_protocol_version:
                            MAX_DAVE_VERSION
                    }
                );

                break;
            }


            // ----------------------------------------------------
            // READY
            // ----------------------------------------------------

            case VoiceOp.READY: {
                ssrc = d.ssrc;
                voiceIp = d.ip;
                voicePort = d.port;

                log(
                    `[Voice] UDP pronto: ${voiceIp}:${voicePort} ` +
                    `(SSRC ${ssrc})`
                );

                /*
                 * Primeiro fazemos IP discovery.
                 */
                doIpDiscovery(d);

                break;
            }


            // ----------------------------------------------------
            // SPEAKING
            // ----------------------------------------------------

            case VoiceOp.SPEAKING: {
                if (
                    d &&
                    d.user_id &&
                    d.ssrc
                ) {
                    const remoteSsrc =
                        Number(d.ssrc);

                    const remoteUserId =
                        String(d.user_id);

                    ssrcMap.set(
                        remoteSsrc,
                        remoteUserId
                    );

                    recognizedUserIds.add(
                        remoteUserId
                    );

                    if (
                        d.speaking === 1 ||
                        d.speaking === 5
                    ) {
                        log(
                            `[Voice-Debug] Usuário ${remoteUserId} ` +
                            `(SSRC: ${remoteSsrc}) ABRIU o microfone.`
                        );
                    } else if (
                        d.speaking === 0
                    ) {
                        log(
                            `[Voice-Debug] Usuário ${remoteUserId} ` +
                            `(SSRC: ${remoteSsrc}) FECHOU o microfone.`
                        );
                    }
                }

                break;
            }


            // ----------------------------------------------------
            // SESSION DESCRIPTION
            // ----------------------------------------------------

            case VoiceOp.SESSION_DESCRIPTION: {
                /*
                 * DAVE protocol version selecionada pelo Discord.
                 */
                daveProtocolVersion =
                    Number(
                        d.dave_protocol_version || 0
                    );

                /*
                 * Secret key de transporte.
                 */
                voiceSecretKey =
                    Buffer.from(
                        d.secret_key
                    );

                /*
                 * Guardamos o modo selecionado no
                 * SELECT_PROTOCOL.
                 *
                 * Algumas respostas também podem expor
                 * o modo, então usamos como fallback.
                 */
                if (d.mode) {
                    voiceEncryptionMode = d.mode;
                }

                log(
                    `[Voice] sessão de voz estabelecida ` +
                    `(DAVE v${daveProtocolVersion}, ` +
                    `crypto=${voiceEncryptionMode || 'desconhecido'})`
                );

                /*
                 * Inicializa DAVE.
                 */
                reinitDaveSession();

                sessionEstablished = true;

                /*
                 * NÃO enviamos SPEAKING artificialmente.
                 *
                 * SPEAKING anuncia transmissão de mídia
                 * do próprio cliente; não é necessário para
                 * receber áudio.
                 */

                /*
                 * Inicializa áudio depois que toda a sessão
                 * de transporte está pronta.
                 */
                if (!audioPlayer.isInitialized) {
                    audioPlayer.init();
                }

                if (onReady) {
                    onReady();
                }

                break;
            }


            // ----------------------------------------------------
            // CLIENTS CONNECT
            // ----------------------------------------------------

            case VoiceOp.CLIENTS_CONNECT: {
                const ids =
                    Array.isArray(d.user_ids)
                        ? d.user_ids
                        : [];

                for (const id of ids) {
                    if (!id) {
                        continue;
                    }

                    recognizedUserIds.add(
                        String(id)
                    );
                }

                log(
                    `[DAVE] ${ids.length} cliente(s) conectado(s).`
                );

                break;
            }


            // ----------------------------------------------------
            // CLIENT DISCONNECT
            // ----------------------------------------------------

            case VoiceOp.CLIENT_DISCONNECT: {
                if (d.user_id) {
                    const userId =
                        String(d.user_id);

                    recognizedUserIds.delete(
                        userId
                    );

                    /*
                     * Remove todos os SSRCs associados ao usuário.
                     */
                    for (
                        const [
                            mappedSsrc,
                            mappedUserId
                        ] of ssrcMap
                    ) {
                        if (
                            mappedUserId === userId
                        ) {
                            ssrcMap.delete(
                                mappedSsrc
                            );
                        }
                    }

                    log(
                        `[DAVE] usuário ${userId} desconectou.`
                    );
                }

                break;
            }


            // ----------------------------------------------------
            // DAVE PREPARE TRANSITION
            // ----------------------------------------------------

            case VoiceOp.DAVE_PREPARE_TRANSITION: {
                const transitionId =
                    Number(
                        d.transition_id
                    );

                const protocolVersion =
                    Number(
                        d.protocol_version
                    );

                davePendingTransitions.set(
                    transitionId,
                    protocolVersion
                );

                log(
                    `[DAVE] PREPARE_TRANSITION ` +
                    `id=${transitionId} ` +
                    `version=${protocolVersion}`
                );

                /*
                 * Transition 0 é a transição inicial.
                 */
                if (transitionId === 0) {
                    executePendingTransition(
                        transitionId
                    );

                    break;
                }

                /*
                 * Protocol version 0 significa downgrade
                 * para transport-only.
                 */
                if (
                    protocolVersion === 0
                ) {
                    try {
                        daveSession?.setPassthroughMode(
                            true,
                            120
                        );
                    } catch (e) {
                        log(
                            `[DAVE] erro ativando passthrough: ${e.message}`
                        );
                    }
                }

                /*
                 * Informamos que nosso estado local
                 * está preparado.
                 */
                sendVoice(
                    VoiceOp.DAVE_TRANSITION_READY,
                    {
                        transition_id:
                            transitionId
                    }
                );

                break;
            }


            // ----------------------------------------------------
            // DAVE EXECUTE TRANSITION
            // ----------------------------------------------------

            case VoiceOp.DAVE_EXECUTE_TRANSITION: {
                const transitionId =
                    Number(
                        d.transition_id
                    );

                log(
                    `[DAVE] EXECUTE_TRANSITION ` +
                    `id=${transitionId}`
                );

                executePendingTransition(
                    transitionId
                );

                break;
            }


            // ----------------------------------------------------
            // DAVE PREPARE EPOCH
            // ----------------------------------------------------

            case VoiceOp.DAVE_PREPARE_EPOCH: {
                const epoch =
                    Number(
                        d.epoch
                    );

                const protocolVersion =
                    Number(
                        d.protocol_version
                    );

                log(
                    `[DAVE] PREPARE_EPOCH ` +
                    `epoch=${epoch} ` +
                    `version=${protocolVersion}`
                );

                /*
                 * Quando o epoch muda, precisamos reconfigurar
                 * o DAVE com o novo contexto.
                 */
                if (
                    epoch === 1 ||
                    protocolVersion !== daveProtocolVersion
                ) {
                    daveProtocolVersion =
                        protocolVersion;

                    reinitDaveSession();
                }

                break;
            }


            default:
                break;
        }
    }


    // ============================================================
    // VOICE BINARY
    // ============================================================

    function handleVoiceBinary(data) {
        if (!Buffer.isBuffer(data)) {
            data = Buffer.from(data);
        }

        if (data.length < 3) {
            return;
        }

        /*
         * Voice binary header:
         *
         * 2 bytes sequence
         * 1 byte opcode
         */
        const seq =
            data.readUInt16BE(0);

        const op =
            data.readUInt8(2);

        const payload =
            data.subarray(3);

        lastVoiceSeq = seq;

        switch (op) {

            // ----------------------------------------------------
            // MLS EXTERNAL SENDER
            // ----------------------------------------------------

            case VoiceOp.MLS_EXTERNAL_SENDER: {
                if (!daveSession) {
                    log(
                        '[DAVE] External sender recebido antes da sessão.'
                    );

                    break;
                }

                try {
                    daveSession.setExternalSender(
                        payload
                    );

                    log(
                        '[DAVE] MLS external sender atualizado.'
                    );
                } catch (e) {
                    log(
                        `[DAVE] erro em external sender: ${e.message}`
                    );
                }

                break;
            }


            // ----------------------------------------------------
            // MLS PROPOSALS
            // ----------------------------------------------------

            case VoiceOp.MLS_PROPOSALS: {
                if (!daveSession) {
                    break;
                }

                if (payload.length < 1) {
                    break;
                }

                const optype =
                    payload.readUInt8(0);

                const proposals =
                    payload.subarray(1);

                try {
                    const result =
                        daveSession.processProposals(
                            optype,
                            proposals,
                            Array.from(
                                recognizedUserIds
                            )
                        );

                    const commit =
                        result?.commit;

                    const welcome =
                        result?.welcome;

                    if (commit) {
                        const outgoing =
                            welcome
                                ? Buffer.concat([
                                    commit,
                                    welcome
                                ])
                                : commit;

                        sendVoiceBinary(
                            VoiceOp.MLS_COMMIT_WELCOME,
                            outgoing
                        );

                        log(
                            '[DAVE] MLS commit enviado.'
                        );
                    }
                } catch (e) {
                    log(
                        `[DAVE] erro processando MLS proposals: ${e.message}`
                    );
                }

                break;
            }


            // ----------------------------------------------------
            // MLS ANNOUNCE COMMIT TRANSITION
            // ----------------------------------------------------

            case VoiceOp.MLS_ANNOUNCE_COMMIT_TRANSITION: {
                if (payload.length < 2) {
                    break;
                }

                const transitionId =
                    payload.readUInt16BE(0);

                const commitData =
                    payload.subarray(2);

                try {
                    if (!daveSession) {
                        throw new Error(
                            'DAVE session inexistente'
                        );
                    }

                    daveSession.processCommit(
                        commitData
                    );

                    log(
                        `[DAVE] MLS commit processado ` +
                        `(transition=${transitionId}).`
                    );

                    if (transitionId !== 0) {
                        davePendingTransitions.set(
                            transitionId,
                            daveProtocolVersion
                        );

                        sendVoice(
                            VoiceOp.DAVE_TRANSITION_READY,
                            {
                                transition_id:
                                    transitionId
                            }
                        );
                    }
                } catch (e) {
                    log(
                        `[DAVE] commit inválido: ${e.message}`
                    );

                    recoverFromInvalidCommit(
                        transitionId
                    );
                }

                break;
            }


            // ----------------------------------------------------
            // MLS WELCOME
            // ----------------------------------------------------

            case VoiceOp.MLS_WELCOME: {
                if (payload.length < 2) {
                    break;
                }

                const transitionId =
                    payload.readUInt16BE(0);

                const welcomeData =
                    payload.subarray(2);

                try {
                    if (!daveSession) {
                        throw new Error(
                            'DAVE session inexistente'
                        );
                    }

                    daveSession.processWelcome(
                        welcomeData
                    );

                    log(
                        `[DAVE] MLS welcome processado ` +
                        `(transition=${transitionId}).`
                    );

                    if (transitionId !== 0) {
                        davePendingTransitions.set(
                            transitionId,
                            daveProtocolVersion
                        );

                        sendVoice(
                            VoiceOp.DAVE_TRANSITION_READY,
                            {
                                transition_id:
                                    transitionId
                            }
                        );
                    }
                } catch (e) {
                    log(
                        `[DAVE] welcome inválido: ${e.message}`
                    );

                    recoverFromInvalidCommit(
                        transitionId
                    );
                }

                break;
            }


            default:
                break;
        }
    }


    // ============================================================
    // DAVE
    // ============================================================

    function reinitDaveSession() {
        if (!DAVESession) {
            log(
                '[DAVE] DAVESession indisponível.'
            );

            return;
        }

        /*
         * Protocol 0:
         *
         * Transport-only.
         */
        if (
            daveProtocolVersion <= 0
        ) {
            try {
                if (daveSession) {
                    daveSession.reset();

                    daveSession.setPassthroughMode(
                        true,
                        10
                    );
                }
            } catch (e) {
                log(
                    `[DAVE] erro no reset: ${e.message}`
                );
            }

            return;
        }

        try {
            if (daveSession) {
                /*
                 * Reutiliza a sessão existente quando possível.
                 */
                daveSession.reinit(
                    daveProtocolVersion,
                    botUserId,
                    channelId
                );
            } else {
                daveSession =
                    new DAVESession(
                        daveProtocolVersion,
                        botUserId,
                        channelId
                    );
            }

            /*
             * O Key Package é enviado ao Voice Gateway
             * para o processo MLS.
             */
            const keyPackage =
                daveSession.getSerializedKeyPackage();

            sendVoiceBinary(
                VoiceOp.MLS_KEY_PACKAGE,
                keyPackage
            );

            log(
                `[DAVE] sessão inicializada ` +
                `(v${daveProtocolVersion}).`
            );
        } catch (e) {
            log(
                `[DAVE] falha inicializando sessão: ${e.message}`
            );
        }
    }


    function executePendingTransition(
        transitionId
    ) {
        if (
            !davePendingTransitions.has(
                transitionId
            )
        ) {
            return;
        }

        const protocolVersion =
            davePendingTransitions.get(
                transitionId
            );

        davePendingTransitions.delete(
            transitionId
        );

        daveProtocolVersion =
            protocolVersion;

        log(
            `[DAVE] transição ${transitionId} ` +
            `executada (v${protocolVersion}).`
        );

        /*
         * Se houve downgrade para transport-only,
         * ativa passthrough.
         *
         * Se houve upgrade para DAVE, a sessão já foi
         * preparada pelos eventos MLS anteriores.
         */
        try {
            if (
                protocolVersion === 0
            ) {
                daveSession?.setPassthroughMode(
                    true,
                    120
                );
            } else {
                daveSession?.setPassthroughMode(
                    false,
                    120
                );
            }
        } catch (e) {
            /*
             * Algumas versões de davey podem não expor
             * exatamente essa API. Não derrubamos a conexão.
             */
            log(
                `[DAVE] aviso ao aplicar transição: ${e.message}`
            );
        }
    }


    function recoverFromInvalidCommit(
        transitionId
    ) {
        log(
            `[DAVE] recuperando de commit inválido ` +
            `(transition=${transitionId}).`
        );

        sendVoice(
            VoiceOp.MLS_INVALID_COMMIT_WELCOME,
            {
                transition_id:
                    transitionId
            }
        );

        reinitDaveSession();
    }


    // ============================================================
    // UDP / IP DISCOVERY
    // ============================================================

    function doIpDiscovery(readyData) {
        if (udpSocket) {
            try {
                udpSocket.close();
            } catch (_) { }

            udpSocket = null;
        }

        udpSocket =
            dgram.createSocket('udp4');


        /*
         * Listener geral dos pacotes RTP.
         *
         * O primeiro pacote também pode ser o IP discovery
         * response, por isso tratamos os dois separadamente.
         */
        udpSocket.on(
            'message',
            (msg) => {
                if (!Buffer.isBuffer(msg)) {
                    return;
                }

                /*
                 * Type 2 = IP discovery response.
                 */
                if (
                    msg.length >= 74 &&
                    msg.readUInt16BE(0) === 2
                ) {
                    return;
                }

                /*
                 * Pacote RTP.
                 */
                audioPlayer.processPacket(
                    msg,
                    daveSession,
                    selfDeaf,
                    ssrcMap,
                    voiceSecretKey,
                    voiceEncryptionMode
                );
            }
        );


        /*
         * Pacote IP discovery.
         *
         * 74 bytes:
         *
         * type       2
         * length     70
         * SSRC       4
         * address    64
         * port       2
         */
        const packet =
            Buffer.alloc(74);

        packet.writeUInt16BE(
            1,
            0
        );

        packet.writeUInt16BE(
            70,
            2
        );

        packet.writeUInt32BE(
            ssrc,
            4
        );


        /*
         * Resposta do IP discovery.
         */
        udpSocket.once(
            'message',
            (msg) => {
                if (
                    msg.length < 74 ||
                    msg.readUInt16BE(0) !== 2
                ) {
                    return;
                }

                const address =
                    msg
                        .subarray(8, 72)
                        .toString('utf8')
                        .replace(/\0.*$/, '');

                const port =
                    msg.readUInt16BE(72);

                log(
                    `[Voice] IP externo descoberto: ` +
                    `${address}:${port}`
                );


                /*
                 * Escolhe o modo de transporte.
                 *
                 * AES-GCM é preferido.
                 */
                voiceEncryptionMode =
                    pickMode(
                        readyData.modes
                    );


                log(
                    `[Voice] modo de criptografia selecionado: ` +
                    `${voiceEncryptionMode}`
                );


                sendVoice(
                    VoiceOp.SELECT_PROTOCOL,
                    {
                        protocol: 'udp',

                        data: {
                            address,
                            port,
                            mode: voiceEncryptionMode
                        }
                    }
                );
            }
        );


        udpSocket.on(
            'error',
            (err) => {
                log(
                    `[Voice/UDP] erro: ${err.message}`
                );
            }
        );


        udpSocket.send(
            packet,
            voicePort,
            voiceIp,
            (err) => {
                if (err) {
                    log(
                        `[Voice] erro enviando IP discovery: ${err.message}`
                    );
                }
            }
        );
    }


    // ============================================================
    // ENCRYPTION MODE
    // ============================================================

    function pickMode(modes) {
        if (!Array.isArray(modes)) {
            throw new Error(
                'Voice READY não forneceu modos de criptografia.'
            );
        }

        /*
         * O AudioPlayer atual implementa AES-GCM.
         *
         * XChaCha fica propositalmente fora até existir
         * implementação correspondente no AudioPlayer.
         */
        const supported =
            [
                'aead_aes256_gcm_rtpsize'
            ];

        const mode =
            supported.find(
                (value) =>
                    modes.includes(value)
            );

        if (!mode) {
            throw new Error(
                'Nenhum modo de criptografia suportado. ' +
                `Discord ofereceu: ${modes.join(', ')}`
            );
        }

        return mode;
    }


    // ============================================================
    // DISCONNECT
    // ============================================================

    function finishDisconnect(reason) {
        clearInterval(
            gatewayHeartbeatInterval
        );

        clearInterval(
            voiceHeartbeatInterval
        );

        gatewayHeartbeatInterval = null;
        voiceHeartbeatInterval = null;


        if (udpSocket) {
            try {
                udpSocket.removeAllListeners();
                udpSocket.close();
            } catch (_) { }

            udpSocket = null;
        }


        if (voiceWs) {
            try {
                voiceWs.removeAllListeners();
            } catch (_) { }
        }


        if (gatewayWs) {
            try {
                gatewayWs.removeAllListeners();
            } catch (_) { }
        }


        /*
         * Desliga áudio.
         */
        audioPlayer.destroy();


        /*
         * Reset de estado.
         */
        voiceSecretKey = null;
        voiceEncryptionMode = null;

        voiceSessionId = null;
        voiceServerToken = null;
        voiceEndpoint = null;

        voiceIp = null;
        voicePort = null;

        ssrc = null;

        daveProtocolVersion = 0;

        davePendingTransitions.clear();

        recognizedUserIds.clear();
        ssrcMap.clear();

        sessionEstablished = false;


        if (onDisconnected) {
            onDisconnected(reason);
        }
    }


    // ============================================================
    // API PÚBLICA
    // ============================================================

    return {

        connect() {
            if (!DAVESession) {
                log(
                    '[DAVE] ERRO: @snazzah/davey não encontrado.'
                );
            }

            intentionalDisconnect = false;

            connectGateway();
        },


        disconnect() {
            intentionalDisconnect = true;

            log(
                '[Voice] saindo da call...'
            );


            /*
             * Remove o bot do canal.
             */
            sendGateway(
                4,
                {
                    guild_id: guildId,
                    channel_id: null,
                    self_mute: false,
                    self_deaf: false
                }
            );


            setTimeout(
                () => {
                    try {
                        voiceWs?.close();
                    } catch (_) { }

                    try {
                        gatewayWs?.close();
                    } catch (_) { }

                    finishDisconnect(
                        'desconectado pelo usuário'
                    );
                },
                400
            );
        },


        setMute(mute) {
            selfMute = Boolean(mute);

            sendGateway(
                4,
                {
                    guild_id: guildId,
                    channel_id: channelId,

                    self_mute: selfMute,
                    self_deaf: selfDeaf
                }
            );
        },


        setDeafen(deaf) {
            selfDeaf = Boolean(deaf);

            if (selfDeaf) {
                selfMute = true;
            }

            sendGateway(
                4,
                {
                    guild_id: guildId,
                    channel_id: channelId,

                    self_mute: selfMute,
                    self_deaf: selfDeaf
                }
            );
        },


        isReady() {
            return sessionEstablished;
        },


        getEncryptionMode() {
            return voiceEncryptionMode;
        },


        getDaveProtocolVersion() {
            return daveProtocolVersion;
        }
    };
}


module.exports = {
    createVoiceClient
};
