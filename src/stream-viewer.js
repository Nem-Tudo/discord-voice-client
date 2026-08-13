'use strict';

const WebSocket = require('ws');
const dgram = require('dgram');
const crypto = require('crypto');

let Davey = null;
try {
    Davey = require('@snazzah/davey');
} catch (_) {}

const DAVESession = Davey?.DAVESession;
const MAX_DAVE_VERSION = Davey?.DAVE_PROTOCOL_VERSION ?? 0;
const MediaType = Davey?.MediaType;
const Codec = Davey?.Codec;

const VoiceOp = {
    IDENTIFY: 0,
    SELECT_PROTOCOL: 1,
    READY: 2,
    HEARTBEAT: 3,
    SESSION_DESCRIPTION: 4,
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

function parseStreamKey(key) {
    const parts = String(key || '').split(':');
    if (parts[0] === 'guild' && parts.length >= 4) {
        return {
            type: 'guild',
            guildId: parts[1],
            channelId: parts[2],
            userId: parts[3]
        };
    }
    if (parts[0] === 'call' && parts.length >= 3) {
        return {
            type: 'call',
            guildId: null,
            channelId: parts[1],
            userId: parts[2]
        };
    }
    return null;
}

/*
 * Discord's stream voice connection is a separate media session.
 * This class intentionally uses UDP + DAVE instead of the normal voice
 * connection. The decoded access units are sent to Electron's stream window,
 * where Chromium WebCodecs performs the actual H.264 decode.
 */
function createStreamViewer({
    token,
    guildId,
    channelId,
    botUserId,
    sessionId,
    sendGateway,
    log,
    onFrame,
    onStatus
}) {
    let targetStreamKey = null;
    let targetUserId = null;

    let rtcServerId = null;
    let rtcChannelId = null;
    let streamToken = null;
    let streamEndpoint = null;

    let ws = null;
    let heartbeat = null;
    let lastSeq = -1;

    let udp = null;
    let udpReady = false;
    let streamIp = null;
    let streamPort = null;

    let encryptionMode = null;
    let secretKey = null;
    // RTP payload types are negotiated in Voice Gateway READY. Stream audio
    // and video share the same UDP socket, so we must never feed an Opus
    // packet to the H264/DAVE VIDEO decryptor.
    const videoPayloadTypes = new Set();
    const audioPayloadTypes = new Set();
    const rtxPayloadTypes = new Set();
    let negotiatedVideoCodec = 'H264';
    let negotiatedAudioCodec = 'opus';

    let daveProtocolVersion = 0;
    let daveSession = null;
    const recognizedUserIds = new Set();
    const pendingTransitions = new Map();

    // Remote stream state announced by Voice Opcode 12. A stream may have
    // multiple simulcast SSRCs, and the SSRC namespace is local to this RTC
    // connection. Keep the mapping so DAVE and RTCP feedback use the actual
    // media sender rather than assuming targetUserId/any is sufficient.
    const remoteVideoStreams = new Map(); // primary SSRC -> { userId, rtxSsrc, rid, quality, active }
    let keyframeTimer = null;
    let rtcpNonce = 1;
    let localRtcpSsrc = 0;

    let running = false;
    let intentionalStop = false;

    let firstTimestamp = null;
    let timestampBase = 0;

    // H264 access-unit assembly.
    let currentFrameTimestamp = null;
    let currentNalUnits = [];
    let currentFu = null;

    const emitStatus = (status, extra = {}) => {
        try {
            onStatus?.({ status, streamKey: targetStreamKey, ...extra });
        } catch (_) {}
    };

    const writeLog = (message) => {
        try { log?.(`[Stream] ${message}`); } catch (_) {}
    };

    function sendVoice(op, d) {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ op, d }));
        }
    }

    function sendVoiceBinary(op, payload) {
        if (ws?.readyState !== WebSocket.OPEN) return;
        ws.send(Buffer.concat([Buffer.from([op]), Buffer.from(payload)]), { binary: true });
    }

    function chooseTransportMode(modes) {
        if (Array.isArray(modes) && modes.includes('aead_aes256_gcm_rtpsize')) {
            return 'aead_aes256_gcm_rtpsize';
        }
        if (Array.isArray(modes) && modes.includes('aead_xchacha20_poly1305_rtpsize')) {
            return 'aead_xchacha20_poly1305_rtpsize';
        }
        throw new Error(`O stream server não ofereceu um modo AEAD suportado: ${modes?.join(', ')}`);
    }

    function decryptAesGcmTransport(packet) {
        if (!Buffer.isBuffer(secretKey) || secretKey.length !== 32) {
            throw new Error('Secret key AES inválida.');
        }

        let headerLen = 12;
        const csrcCount = packet[0] & 0x0f;
        headerLen += csrcCount * 4;

        const hasExtension = (packet[0] & 0x10) !== 0;
        let extensionDataLen = 0;

        if (hasExtension) {
            if (packet.length < headerLen + 4) throw new Error('RTP extension truncada.');
            const words = packet.readUInt16BE(headerLen + 2);
            extensionDataLen = words * 4;
            headerLen += 4;
            if (packet.length < headerLen + extensionDataLen + 20) {
                throw new Error('RTP extension truncada.');
            }
        }

        // In the RTP-size AEAD modes, only the RTP header + extension
        // preamble is AAD. The extension payload itself is encrypted.
        // The previous implementation accidentally included the extension
        // payload in AAD and then excluded it from the ciphertext, causing
        // every packet carrying RTP header extensions to fail authentication.
        const aadHeaderLen = headerLen;
        const aad = packet.subarray(0, aadHeaderLen);
        const nonce4 = packet.subarray(packet.length - 4);
        const nonce = Buffer.alloc(12);
        nonce4.copy(nonce, 0);

        const encrypted = packet.subarray(aadHeaderLen, packet.length - 4);
        const tag = encrypted.subarray(encrypted.length - 16);
        const ciphertext = encrypted.subarray(0, encrypted.length - 16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);

        return {
            plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
            extensionDataLen,
            hasPadding: (packet[0] & 0x20) !== 0
        };
    }

    function removePadding(buffer, hasPadding) {
        if (!hasPadding) return buffer;
        if (!buffer.length) return buffer;
        const n = buffer[buffer.length - 1];
        if (n === 0 || n > buffer.length) throw new Error('Padding RTP inválido.');
        return buffer.subarray(0, buffer.length - n);
    }

    function decryptTransport(packet) {
        if (encryptionMode === 'aead_aes256_gcm_rtpsize') {
            return decryptAesGcmTransport(packet);
        }

        /*
         * XChaCha is mandatory on modern Discord voice servers, but this
         * project currently has no XChaCha transport implementation. Keep
         * this explicit rather than silently producing corrupt media.
         */
        throw new Error(`Modo de transporte não implementado: ${encryptionMode}`);
    }

    function pushNal(nal) {
        if (!nal || !nal.length) return;
        currentNalUnits.push(Buffer.from(nal));
    }

    function depacketizeH264(payload, marker, timestamp) {
        if (!Buffer.isBuffer(payload) || payload.length < 1) return;

        if (currentFrameTimestamp === null) {
            currentFrameTimestamp = timestamp;
        }

        const type = payload[0] & 0x1f;

        // Single NAL unit packet.
        if (type >= 1 && type <= 23) {
            pushNal(payload);
        }
        // STAP-A.
        else if (type === 24) {
            let off = 1;
            while (off + 2 <= payload.length) {
                const size = payload.readUInt16BE(off);
                off += 2;
                if (!size || off + size > payload.length) break;
                pushNal(payload.subarray(off, off + size));
                off += size;
            }
        }
        // FU-A.
        else if (type === 28) {
            if (payload.length < 2) return;

            const fuHeader = payload[1];
            const start = (fuHeader & 0x80) !== 0;
            const end = (fuHeader & 0x40) !== 0;
            const nalType = fuHeader & 0x1f;
            const reconstructedHeader = Buffer.from([
                (payload[0] & 0xe0) | nalType
            ]);

            if (start) {
                currentFu = {
                    timestamp,
                    nal: Buffer.concat([
                        reconstructedHeader,
                        payload.subarray(2)
                    ])
                };
            } else if (currentFu && currentFu.timestamp === timestamp) {
                currentFu.nal = Buffer.concat([
                    currentFu.nal,
                    payload.subarray(2)
                ]);
            }

            if (end && currentFu && currentFu.timestamp === timestamp) {
                pushNal(currentFu.nal);
                currentFu = null;
            }
        }

        if (!marker) return;

        const frameTimestamp = currentFrameTimestamp;
        const frame = Buffer.concat(
            currentNalUnits.map((nal) =>
                Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])
            )
        );

        currentNalUnits = [];
        currentFrameTimestamp = null;
        currentFu = null;

        if (frame.length) {
            handleEncodedFrame(frame, frameTimestamp, null);
        }
    }

    function hasH264Keyframe(frame) {
        let i = 0;
        while (i + 4 < frame.length) {
            let start = -1;
            if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1) {
                start = i + 3;
            } else if (
                frame[i] === 0 && frame[i + 1] === 0 &&
                frame[i + 2] === 0 && frame[i + 3] === 1
            ) {
                start = i + 4;
            }

            if (start >= 0 && start < frame.length) {
                if ((frame[start] & 0x1f) === 5) return true;
                i = start + 1;
            } else {
                i++;
            }
        }
        return false;
    }

    function getCodecString(frame) {
        // SPS: start code + NAL header + profile_idc + constraints + level_idc.
        let i = 0;
        while (i + 8 < frame.length) {
            let start = -1;
            if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1) {
                start = i + 3;
            } else if (
                frame[i] === 0 && frame[i + 1] === 0 &&
                frame[i + 2] === 0 && frame[i + 3] === 1
            ) {
                start = i + 4;
            }

            if (start >= 0 && (frame[start] & 0x1f) === 7 && start + 3 < frame.length) {
                const profile = frame[start + 1];
                const constraints = frame[start + 2];
                const level = frame[start + 3];
                return `avc1.${profile.toString(16).padStart(2, '0')}${constraints.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`;
            }

            i = start >= 0 ? start + 1 : i + 1;
        }
        return 'avc1.42e01e';
    }

    function handleEncodedFrame(frame, rtpTimestamp, frameSsrc = null) {
        const isKey = hasH264Keyframe(frame);

        if (firstTimestamp === null) {
            firstTimestamp = rtpTimestamp >>> 0;
            timestampBase = Date.now() * 1000;
        }

        let delta = (rtpTimestamp >>> 0) - (firstTimestamp >>> 0);
        if (delta < -0x80000000) delta += 0x100000000;
        if (delta > 0x80000000) delta -= 0x100000000;

        const timestampUs = Math.max(
            0,
            Math.round(timestampBase + (delta * 1000000 / 90000))
        );

        // writeLog(`H264 frame pronto key=${isKey} bytes=${frame.length} codec=${getCodecString(frame)} ssrc=${frameSsrc ?? 'n/a'}`);
        onFrame?.({
            streamKey: targetStreamKey,
            userId: targetUserId,
            codec: getCodecString(frame),
            key: isKey,
            timestamp: timestampUs,
            data: frame
        });
    }

    function encryptAesGcmRtcp(packet) {
        if (!Buffer.isBuffer(secretKey) || secretKey.length !== 32) {
            throw new Error('Secret key AES inválida para RTCP.');
        }
        if (packet.length < 4) throw new Error('RTCP inválido.');

        // Discord's RTP-size AEAD mode leaves the fixed RTCP header as AAD
        // and encrypts the RTCP feedback body. The 32-bit nonce is appended.
        const aad = packet.subarray(0, 4);
        const body = packet.subarray(4);
        const nonce = Buffer.alloc(12);
        nonce.writeUInt32BE(rtcpNonce >>> 0, 8);
        rtcpNonce = (rtcpNonce + 1) >>> 0;

        const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, nonce);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
        const tag = cipher.getAuthTag();
        const nonce4 = nonce.subarray(8, 12);
        return Buffer.concat([aad, ciphertext, tag, nonce4]);
    }

    function sendRtcpPli(mediaSsrc) {
        if (!udp || !udpReady || !streamIp || !streamPort || !secretKey) return;
        const ssrc = Number(mediaSsrc) >>> 0;
        if (!ssrc) return;

        // RTCP PSFB / PLI (RFC 4585): V=2, FMT=1, PT=206, length=2.
        const pli = Buffer.alloc(12);
        pli[0] = 0x81;
        pli[1] = 206;
        pli.writeUInt16BE(2, 2);
        pli.writeUInt32BE(localRtcpSsrc >>> 0, 4);
        pli.writeUInt32BE(ssrc, 8);

        try {
            const encrypted = encryptAesGcmRtcp(pli);
            udp.send(encrypted, streamPort, streamIp);
            writeLog(`RTCP PLI enviado mediaSSRC=${ssrc}`);
        } catch (e) {
            writeLog(`RTCP PLI falhou: ${e.message}`);
        }
    }

    function requestKeyframes() {
        if (!remoteVideoStreams.size) return;
        for (const [ssrc, info] of remoteVideoStreams) {
            if (info.active !== false) sendRtcpPli(ssrc);
        }
    }

    function startKeyframeRequests() {
        clearInterval(keyframeTimer);
        // A viewer can join in the middle of an H.264 GOP. Discord normally
        // emits a keyframe for a new subscriber, but requesting PLI makes the
        // custom receiver robust to missed/late Welcome or layer transitions.
        requestKeyframes();
        keyframeTimer = setInterval(requestKeyframes, 1000);
    }

    function stopKeyframeRequests() {
        clearInterval(keyframeTimer);
        keyframeTimer = null;
    }

    function processRtp(packet) {
        if (!Buffer.isBuffer(packet) || packet.length < 12) return;
        if ((packet[0] >> 6) !== 2) return;
        // RTP and RTCP share the UDP socket and both use RTP version 2.
        // RTCP packet types occupy 192..223; they are not media payloads and
        // must not be fed into the RTP/H264 transport path. Doing so produces
        // misleading AEAD authentication failures.
        const secondByte = packet[1];
        const rtcpType = secondByte & 0x7f;
        if (secondByte >= 192 && secondByte <= 223) return;

        const payloadType = packet[1] & 0x7f;
        // The stream RTC socket can carry audio and video. Only video packets
        // may enter the H264 + DAVE VIDEO pipeline. Treat unknown PTs as probes
        // until READY has told us the negotiated codec map.
        if (rtxPayloadTypes.has(payloadType) || payloadType === 96 || payloadType === 102 || payloadType === 104) return;
        if (videoPayloadTypes.size > 0 && !videoPayloadTypes.has(payloadType)) return;
        if (videoPayloadTypes.size === 0 && audioPayloadTypes.has(payloadType)) return;

        const sequence = packet.readUInt16BE(2);
        const timestamp = packet.readUInt32BE(4);
        const marker = (packet[1] & 0x80) !== 0;

        let transport;
        try {
            transport = decryptTransport(packet);
        } catch (e) {
            writeLog(`erro decrypt transporte: ${e.message}`);
            return;
        }

        let media = transport.plaintext;
        if (transport.extensionDataLen > 0) {
            if (media.length < transport.extensionDataLen) return;
            media = media.subarray(transport.extensionDataLen);
        }

        try {
            media = removePadding(media, transport.hasPadding);
        } catch (_) {
            return;
        }

        // Reassemble one WebRTC encoded frame, then apply DAVE once to it.
        if (daveProtocolVersion > 0 && daveSession) {
            /*
             * The DAVE frame is reconstructed by the codec depacketizer
             * before decrypting. Therefore the actual decrypt call occurs
             * in flushDAVEFrame(), not on individual RTP fragments.
             */
            if (!processRtp.daveFrames) processRtp.daveFrames = new Map();
            const packetSsrc = packet.readUInt32BE(8) >>> 0;
            let state = processRtp.daveFrames.get(packetSsrc);
            if (!state || state.timestamp !== timestamp) {
                state = { timestamp, parts: [], sequence, ssrc: packetSsrc };
                processRtp.daveFrames.set(packetSsrc, state);
            }

            state.parts.push({
                media,
                marker,
                sequence
            });

            if (!marker) return;

            processRtp.daveFrames.delete(1);

            const reconstructed = reconstructH264FromParts(state.parts);
            if (!reconstructed) return;

            try {
                if (!daveSession?.ready) {
                    writeLog(`DAVE vídeo ainda não está pronto; descartando frame SSRC=${state.ssrc ?? 'n/a'}`);
                    return;
                }
                const mapped = remoteVideoStreams.get(state.ssrc);
                const userId = String(mapped?.userId || targetUserId);
                const decrypted = daveSession.decrypt(
                    userId,
                    MediaType?.VIDEO ?? 1,
                    reconstructed
                );
                // writeLog(`DAVE vídeo decrypt ok user=${userId} bytes=${reconstructed.length}->${decrypted?.length ?? 0}`);

                if (decrypted && (Buffer.isBuffer(decrypted) || decrypted instanceof Uint8Array) && decrypted.length) {
                    handleEncodedFrame(Buffer.from(decrypted), timestamp, state.ssrc);
                }
            } catch (e) {
                writeLog(`DAVE vídeo: ${e.message}`);
            }

            return;
        }

        depacketizeH264(media, marker, timestamp);
    }

    /*
     * This function mirrors the H264 packetization boundary used above, but
     * returns the reconstructed encoded frame so DAVE sees one whole frame.
     */
    function reconstructH264FromParts(parts) {
        let fu = null;
        const nals = [];

        for (const part of parts) {
            const p = part.media;
            if (!p.length) continue;
            const type = p[0] & 0x1f;

            if (type >= 1 && type <= 23) {
                nals.push(Buffer.from(p));
            } else if (type === 24) {
                let off = 1;
                while (off + 2 <= p.length) {
                    const size = p.readUInt16BE(off);
                    off += 2;
                    if (!size || off + size > p.length) break;
                    nals.push(Buffer.from(p.subarray(off, off + size)));
                    off += size;
                }
            } else if (type === 28 && p.length >= 2) {
                const fuHeader = p[1];
                const start = (fuHeader & 0x80) !== 0;
                const end = (fuHeader & 0x40) !== 0;
                const nalType = fuHeader & 0x1f;

                if (start) {
                    fu = Buffer.concat([
                        Buffer.from([(p[0] & 0xe0) | nalType]),
                        p.subarray(2)
                    ]);
                } else if (fu) {
                    fu = Buffer.concat([fu, p.subarray(2)]);
                }

                if (end && fu) {
                    nals.push(fu);
                    fu = null;
                }
            }
        }

        if (fu) return null;
        if (!nals.length) return null;

        return Buffer.concat(
            nals.map((nal) => Buffer.concat([
                Buffer.from([0, 0, 0, 1]),
                nal
            ]))
        );
    }

    function startUdp(ready) {
        videoPayloadTypes.clear();
        audioPayloadTypes.clear();
        rtxPayloadTypes.clear();
        for (const codec of ready?.codecs || []) {
            const pt = Number(codec?.payload_type);
            if (!Number.isInteger(pt) || pt < 0 || pt > 127) continue;
            const type = String(codec?.type || '').toLowerCase();
            if (type === 'video') videoPayloadTypes.add(pt);
            if (type === 'audio') audioPayloadTypes.add(pt);
            if (codec?.rtx_payload_type != null) rtxPayloadTypes.add(Number(codec.rtx_payload_type));
        }
        localRtcpSsrc = Number(ready?.ssrc || 0) >>> 0;
        writeLog(`READY codecs video=[${Array.from(videoPayloadTypes)}] audio=[${Array.from(audioPayloadTypes)}] rtx=[${Array.from(rtxPayloadTypes)}] localSSRC=${localRtcpSsrc}`);
        if (udp) {
            try { udp.close(); } catch (_) {}
        }

        udp = dgram.createSocket('udp4');

        udp.on('message', (msg) => {
            if (!Buffer.isBuffer(msg)) return;

            if (msg.length >= 74 && msg.readUInt16BE(0) === 2) {
                // Discovery response.
                streamIp = msg.subarray(8, 72).toString('utf8').replace(/\0.*$/, '');
                streamPort = msg.readUInt16BE(72);

                try {
                    encryptionMode = chooseTransportMode(ready.modes);
                } catch (e) {
                    emitStatus('error', { error: e.message });
                    return;
                }

                sendVoice(VoiceOp.SELECT_PROTOCOL, {
                    protocol: 'udp',
                    data: {
                        address: streamIp,
                        port: streamPort,
                        mode: encryptionMode
                    },
                    codecs: [
                        {
                            name: 'opus',
                            type: 'audio',
                            priority: 1000,
                            payload_type: 120,
                            encode: false,
                            decode: false
                        },
                        {
                            name: 'H264',
                            type: 'video',
                            priority: 1000,
                            payload_type: 103,
                            rtx_payload_type: 104,
                            encode: false,
                            decode: true
                        }
                    ],
                    max_dave_protocol_version: MAX_DAVE_VERSION
                });

                return;
            }

            if (udpReady) processRtp(msg);
        });

        udp.on('error', (err) => {
            writeLog(`UDP: ${err.message}`);
            emitStatus('error', { error: err.message });
        });

        const discovery = Buffer.alloc(74);
        discovery.writeUInt16BE(1, 0);
        discovery.writeUInt16BE(70, 2);

        // Stream connection has its own SSRC in READY. If Discord does not
        // provide one for a receive-only connection, zero is accepted for
        // discovery and the server still answers on current backends.
        discovery.writeUInt32BE(Number(ready.ssrc || 0) >>> 0, 4);

        udp.send(discovery, ready.port, ready.ip, (err) => {
            if (err) {
                emitStatus('error', { error: err.message });
            }
        });
    }

    function getDaveGroupId() {
        // Stream DAVE/MLS uses the media-session ID, which is rtc_server_id - 1.
        // Use BigInt because Discord snowflakes exceed Number.MAX_SAFE_INTEGER.
        try {
            return (BigInt(String(rtcServerId)) - 1n).toString();
        } catch (_) {
            return String(rtcServerId || '');
        }
    }

    function reinitDave() {
        if (!DAVESession || daveProtocolVersion <= 0) return;

        try {
            if (daveSession) {
                daveSession.reinit(
                    daveProtocolVersion,
                    typeof botUserId === 'function' ? botUserId() : botUserId,
                    getDaveGroupId()
                );
            } else {
                daveSession = new DAVESession(
                    daveProtocolVersion,
                    typeof botUserId === 'function' ? botUserId() : botUserId,
                    getDaveGroupId()
                );
            }

            sendVoiceBinary(
                VoiceOp.MLS_KEY_PACKAGE,
                daveSession.getSerializedKeyPackage()
            );
        } catch (e) {
            writeLog(`falha iniciando DAVE: ${e.message}`);
        }
    }

    function handleBinary(data) {
        if (!Buffer.isBuffer(data)) data = Buffer.from(data);
        if (data.length < 3) return;

        const op = data.readUInt8(2);
        const payload = data.subarray(3);

        switch (op) {
            case VoiceOp.MLS_EXTERNAL_SENDER:
                try { daveSession?.setExternalSender(payload); } catch (e) {
                    writeLog(`external sender: ${e.message}`);
                }
                break;

            case VoiceOp.MLS_PROPOSALS: {
                if (!daveSession || !payload.length) break;
                try {
                    const result = daveSession.processProposals(
                        payload.readUInt8(0),
                        payload.subarray(1),
                        Array.from(recognizedUserIds)
                    );

                    if (result?.commit) {
                        sendVoiceBinary(
                            VoiceOp.MLS_COMMIT_WELCOME,
                            result.welcome
                                ? Buffer.concat([result.commit, result.welcome])
                                : result.commit
                        );
                    }
                } catch (e) {
                    writeLog(`proposals: ${e.message}`);
                }
                break;
            }

            case VoiceOp.MLS_ANNOUNCE_COMMIT_TRANSITION: {
                if (payload.length < 2 || !daveSession) break;
                const transitionId = payload.readUInt16BE(0);
                try {
                    daveSession.processCommit(payload.subarray(2));
                    if (transitionId) {
                        pendingTransitions.set(transitionId, daveProtocolVersion);
                        sendVoice(VoiceOp.DAVE_TRANSITION_READY, {
                            transition_id: transitionId
                        });
                    }
                } catch (e) {
                    writeLog(`commit: ${e.message}`);
                    sendVoice(VoiceOp.MLS_INVALID_COMMIT_WELCOME, {
                        transition_id: transitionId
                    });
                    reinitDave();
                }
                break;
            }

            case VoiceOp.MLS_WELCOME: {
                if (payload.length < 2 || !daveSession) break;
                const transitionId = payload.readUInt16BE(0);
                try {
                    daveSession.processWelcome(payload.subarray(2));
                    writeLog(`DAVE Welcome processado transition=${transitionId} ready=${!!daveSession.ready} privacy=${daveSession.voicePrivacyCode || 'n/a'}`);
                    if (transitionId) {
                        pendingTransitions.set(transitionId, daveProtocolVersion);
                        sendVoice(VoiceOp.DAVE_TRANSITION_READY, {
                            transition_id: transitionId
                        });
                    }
                } catch (e) {
                    writeLog(`welcome: ${e.message}`);
                }
                break;
            }
        }
    }

    function handlePayload(payload) {
        const { op, d, seq } = payload || {};
        writeLog(`voice payload op=${op}`);
        if (typeof seq === 'number') lastSeq = seq;

        switch (op) {
            case 8:
                clearInterval(heartbeat);
                heartbeat = setInterval(() => {
                    sendVoice(VoiceOp.HEARTBEAT, {
                        t: Date.now(),
                        seq_ack: lastSeq
                    });
                }, d.heartbeat_interval);

                writeLog(`Voice Hello recebido interval=${d.heartbeat_interval}ms; enviando IDENTIFY server=${rtcServerId} channel=${rtcChannelId}`);
                sendVoice(VoiceOp.IDENTIFY, {
                    server_id: rtcServerId,
                    channel_id: rtcChannelId,
                    user_id: typeof botUserId === 'function' ? botUserId() : botUserId,
                    session_id: typeof sessionId === 'function' ? sessionId() : sessionId,
                    token: streamToken,
                    video: true,
                    streams: [
                        { type: 'screen', rid: '100', quality: 100 }
                    ],
                    max_dave_protocol_version: MAX_DAVE_VERSION
                });
                // Viewer-side subscription: request the stream media from the SFU.
                // 'any':100 is the broadest request and lets Discord choose the
                // primary video SSRC/layer for this stream.
                sendVoice(15, { any: 100 });
                writeLog('Media Sink Wants enviado: {any:100}');
                break;

            case 2:
                startUdp(d);
                break;

            case 4:
                daveProtocolVersion = Number(d.dave_protocol_version || 0);
                secretKey = d.secret_key ? Buffer.from(d.secret_key) : null;
                encryptionMode = d.mode || encryptionMode;
                negotiatedVideoCodec = String(d.video_codec || 'H264');
                negotiatedAudioCodec = String(d.audio_codec || 'opus');
                writeLog(`SESSION_DESCRIPTION codec video=${negotiatedVideoCodec} audio=${negotiatedAudioCodec} dave=${daveProtocolVersion} mode=${encryptionMode}`);
                reinitDave();
                udpReady = true;
                emitStatus('playing');
                startKeyframeRequests();
                break;

            case 11:
                for (const id of d?.user_ids || []) recognizedUserIds.add(String(id));
                recognizedUserIds.add(String(typeof botUserId === 'function' ? botUserId() : botUserId));
                recognizedUserIds.add(String(targetUserId));
                break;

            case 12: {
                // Video receive announcement. Cache primary/RTX SSRC ownership
                // and immediately request the highest layer for the stream.
                const userId = d?.user_id ? String(d.user_id) : String(targetUserId);
                for (const stream of d?.streams || []) {
                    const ssrc = Number(stream?.ssrc);
                    if (!Number.isInteger(ssrc) || ssrc <= 0) continue;
                    remoteVideoStreams.set(ssrc >>> 0, {
                        userId,
                        rtxSsrc: Number(stream?.rtx_ssrc || 0) >>> 0,
                        rid: stream?.rid,
                        quality: Number(stream?.quality ?? 100),
                        active: stream?.active !== false
                    });
                    writeLog(`VIDEO state user=${userId} ssrc=${ssrc >>> 0} rtx=${Number(stream?.rtx_ssrc || 0) >>> 0} rid=${stream?.rid || '?'} active=${stream?.active !== false}`);
                }
                // Target the concrete SSRCs instead of relying only on `any`.
                const wants = { any: 0 };
                for (const [ssrc, info] of remoteVideoStreams) {
                    if (info.active !== false) wants[String(ssrc)] = 100;
                }
                sendVoice(15, wants);
                writeLog(`Media Sink Wants atualizado SSRCs=${Object.keys(wants).filter(k => k !== 'any').join(',') || 'none'}`);
                startKeyframeRequests();
                break;
            }

            case 13:
                if (d?.user_id) recognizedUserIds.delete(String(d.user_id));
                break;

            case 21: {
                const transitionId = Number(d?.transition_id || 0);
                const version = Number(d?.protocol_version || 0);
                pendingTransitions.set(transitionId, version);

                if (transitionId === 0) {
                    daveProtocolVersion = version;
                    if (version === 0) {
                        try { daveSession?.setPassthroughMode(true, 120); } catch (_) {}
                    }
                    break;
                }

                if (version === 0) {
                    try { daveSession?.setPassthroughMode(true, 120); } catch (_) {}
                }

                sendVoice(VoiceOp.DAVE_TRANSITION_READY, {
                    transition_id: transitionId
                });
                break;
            }

            case 22: {
                const transitionId = Number(d?.transition_id || 0);
                const version = pendingTransitions.get(transitionId);
                if (version !== undefined) {
                    daveProtocolVersion = version;
                    pendingTransitions.delete(transitionId);
                    try {
                        daveSession?.setPassthroughMode(version === 0, 120);
                    } catch (_) {}
                }
                break;
            }

            case 24: {
                const epoch = Number(d?.epoch || 0);
                const version = Number(d?.protocol_version || 0);
                if (epoch === 1 || version !== daveProtocolVersion) {
                    daveProtocolVersion = version;
                    reinitDave();
                }
                break;
            }

            default:
                break;
        }
    }

    function connectVoice() {
        if (!streamEndpoint || !streamToken || !rtcServerId || !sessionId) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        intentionalStop = false;
        emitStatus('connecting');

        ws = new WebSocket(
            `wss://${String(streamEndpoint).replace(/^wss?:\/\//, '')}/?v=9&encoding=json`
        );

        ws.on('open', () => writeLog(`stream voice TCP conectado server=${rtcServerId} channel=${rtcChannelId}`));

        ws.on('message', (data, isBinary) => {
            try {
                // ws delivers text frames as Buffer by default. The previous
                // implementation tested Buffer.isBuffer(data), which caused
                // the JSON Voice Gateway HELLO/READY/SESSION_DESCRIPTION
                // messages to be misclassified as binary and silently ignored.
                // That produced exactly: TCP connected -> no Hello ->
                // permanently 'Conectando à transmissão'.
                if (isBinary) {
                    const b = Buffer.from(data);
                    // Server binary messages on v8+ have seq(2)+opcode(1).
                    if (b.length >= 3) {
                        writeLog(`voice binary op=${b.readUInt8(2)} bytes=${b.length}`);
                        handleBinary(b);
                    }
                } else {
                    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
                    handlePayload(JSON.parse(text));
                }
            } catch (e) {
                writeLog(`payload: ${e.message}`);
            }
        });

        ws.on('close', (code, reason) => {
            clearInterval(heartbeat);
            heartbeat = null;
            udpReady = false;
            if (!intentionalStop) emitStatus('stopped', {
                reason: `stream voice fechado (${code})`
            });
        });

        ws.on('error', (err) => {
            writeLog(`voice stream WS: ${err.message}`);
            emitStatus('error', { error: err.message });
        });
    }

    function handleGatewayEvent(type, data) {
        if (!data?.stream_key || data.stream_key !== targetStreamKey) return;

        if (type === 'STREAM_CREATE') {
            rtcServerId = data.rtc_server_id;
            rtcChannelId = data.rtc_channel_id || null;
            writeLog(`STREAM_CREATE media session server=${rtcServerId} channel=${rtcChannelId}`);
            streamEndpoint = data.endpoint || streamEndpoint;
            connectVoice();
        } else if (type === 'STREAM_SERVER_UPDATE') {
            streamToken = data.token;
            streamEndpoint = data.endpoint;
            connectVoice();
        } else if (type === 'STREAM_DELETE') {
            stop({ sendDelete: false });
            emitStatus('stopped', { reason: data.reason || 'stream encerrada' });
        }
    }

    function watch(streamKey, userId) {
        if (targetStreamKey && targetStreamKey !== streamKey) {
            stop({ sendDelete: true });
        }

        const parsed = parseStreamKey(streamKey);
        if (!parsed) throw new Error(`stream_key inválida: ${streamKey}`);

        targetStreamKey = streamKey;
        targetUserId = String(userId || parsed.userId);
        rtcServerId = null;
        rtcChannelId = null;
        streamToken = null;
        streamEndpoint = null;
        firstTimestamp = null;
        currentFrameTimestamp = null;
        currentNalUnits = [];
        currentFu = null;
        processRtp.daveFrames = new Map();
        remoteVideoStreams.clear();
        stopKeyframeRequests();
        rtcpNonce = 1;

        recognizedUserIds.clear();
        recognizedUserIds.add(String(typeof botUserId === 'function' ? botUserId() : botUserId));
        recognizedUserIds.add(String(targetUserId));

        sendGateway(20, { stream_key: streamKey });
        emitStatus('requested', { userId: targetUserId });
    }

    function stop({ sendDelete = true } = {}) {
        intentionalStop = true;

        if (sendDelete && targetStreamKey) {
            sendGateway(19, { stream_key: targetStreamKey });
        }

        clearInterval(heartbeat);
        heartbeat = null;

        try { udp?.close(); } catch (_) {}
        udp = null;

        try { ws?.close(); } catch (_) {}
        ws = null;

        running = false;
        udpReady = false;
        pendingTransitions.clear();
        remoteVideoStreams.clear();
        stopKeyframeRequests();
        daveSession = null;
        secretKey = null;
        targetStreamKey = null;
        targetUserId = null;
        rtcServerId = null;
        rtcChannelId = null;
        streamToken = null;
        streamEndpoint = null;

        emitStatus('stopped');
    }

    return {
        watch,
        handleGatewayEvent,
        stop,
        isWatching() {
            return Boolean(targetStreamKey);
        },
        getStreamKey() {
            return targetStreamKey;
        }
    };
}

module.exports = {
    createStreamViewer,
    parseStreamKey
};
