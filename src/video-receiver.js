'use strict';

const crypto = require('crypto');

let Davey = null;
try { Davey = require('@snazzah/davey'); } catch (_) {}

const MediaType = Davey?.MediaType;

function createCameraVideoReceiver({
    log,
    onFrame,
    onStatus,
    getDaveSession,
    getProtocolVersion,
    getSecretKey,
    getEncryptionMode,
    getUdpSocket,
    getRemoteIp,
    getRemotePort,
    getUserId
}) {
    const videoPayloadTypes = new Set([103]);
    const rtxPayloadTypes = new Set([104]);
    const streams = new Map(); // primary SSRC -> {userId, rtxSsrc, rid, quality, active}
    const rtxToPrimary = new Map();
    const frameStates = new Map();
    const watchingUsers = new Set();
    let firstTimestamp = null;
    let timestampBase = 0;
    let rtcpNonce = 1;
    let pliTimer = null;
    let rtpPacketCount = 0;
    let videoPacketCount = 0;
    let decryptErrorCount = 0;

    const writeLog = (m) => { try { log?.(`[Camera] ${m}`); } catch (_) {} };
    const status = (s, extra={}) => {
        try { onStatus?.({ status:s, ...extra }); } catch (_) {}
    };

    function decryptAesGcm(packet) {
        const key = getSecretKey?.();
        if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Secret key AES inválida.');
        let headerLen = 12;
        const csrc = packet[0] & 0x0f;
        headerLen += csrc * 4;
        let extLen = 0;
        if (packet[0] & 0x10) {
            if (packet.length < headerLen + 4) throw new Error('RTP extension truncada.');
            extLen = packet.readUInt16BE(headerLen + 2) * 4;
            headerLen += 4;
            if (packet.length < headerLen + extLen + 20) throw new Error('RTP extension truncada.');
        }
        const aad = packet.subarray(0, headerLen);
        const encrypted = packet.subarray(headerLen, packet.length - 4);
        const tag = encrypted.subarray(encrypted.length - 16);
        const ciphertext = encrypted.subarray(0, encrypted.length - 16);
        const nonce = Buffer.alloc(12);
        packet.subarray(packet.length - 4).copy(nonce, 0);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(tag);
        return {
            plaintext: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
            extensionDataLen: extLen,
            hasPadding: Boolean(packet[0] & 0x20)
        };
    }

    function removePadding(buf, hasPadding) {
        if (!hasPadding) return buf;
        const n = buf[buf.length - 1];
        if (!n || n > buf.length) throw new Error('Padding RTP inválido.');
        return buf.subarray(0, buf.length - n);
    }

    function addNal(nals, nal) {
        if (nal?.length) nals.push(Buffer.from(nal));
    }

    // DAVE encrypts the encoded video frame BEFORE RTP packetization.
    // Therefore the RTP payloads must be joined first and only then passed
    // to dave.decrypt(). Parsing H264 FU-A before DAVE decryption corrupts
    // the ciphertext and produces permanent black/loading video.
    function joinEncryptedFrame(parts) {
        if (!parts?.length) return null;
        const ordered = parts.slice().sort((a, b) => {
            const diff = (a.sequence - b.sequence) & 0xffff;
            return diff === 0 ? 0 : (diff < 0x8000 ? 1 : -1);
        });
        return Buffer.concat(ordered.map(p => p.media || Buffer.alloc(0)));
    }

    function reconstruct(parts) {
        const nals = [];
        let fu = null;
        for (const part of parts) {
            const p = part.media;
            if (!p?.length) continue;
            const type = p[0] & 0x1f;
            if (type >= 1 && type <= 23) {
                addNal(nals, p);
            } else if (type === 24) {
                let off = 1;
                while (off + 2 <= p.length) {
                    const size = p.readUInt16BE(off); off += 2;
                    if (!size || off + size > p.length) break;
                    addNal(nals, p.subarray(off, off + size)); off += size;
                }
            } else if (type === 28 && p.length >= 2) {
                const h = p[1];
                const start = Boolean(h & 0x80);
                const end = Boolean(h & 0x40);
                const nalType = h & 0x1f;
                const header = Buffer.from([(p[0] & 0xe0) | nalType]);
                if (start) {
                    fu = { nal: Buffer.concat([header, p.subarray(2)]) };
                } else if (fu) {
                    fu.nal = Buffer.concat([fu.nal, p.subarray(2)]);
                }
                if (end && fu) {
                    addNal(nals, fu.nal);
                    fu = null;
                }
            }
        }
        if (!nals.length) return null;
        return Buffer.concat(nals.map(n => Buffer.concat([Buffer.from([0,0,0,1]), n])));
    }

    function isKeyframe(frame) {
        for (let i=0;i+4<frame.length;i++) {
            let start = -1;
            if (frame[i]===0 && frame[i+1]===0 && frame[i+2]===1) start=i+3;
            else if (frame[i]===0 && frame[i+1]===0 && frame[i+2]===0 && frame[i+3]===1) start=i+4;
            if (start >= 0 && (frame[start] & 0x1f) === 5) return true;
        }
        return false;
    }

    function codecString(frame) {
        for (let i=0;i+8<frame.length;i++) {
            let start=-1;
            if (frame[i]===0&&frame[i+1]===0&&frame[i+2]===1) start=i+3;
            else if (frame[i]===0&&frame[i+1]===0&&frame[i+2]===0&&frame[i+3]===1) start=i+4;
            if (start>=0 && (frame[start]&0x1f)===7 && start+3<frame.length) {
                return `avc1.${frame[start+1].toString(16).padStart(2,'0')}${frame[start+2].toString(16).padStart(2,'0')}${frame[start+3].toString(16).padStart(2,'0')}`;
            }
        }
        return 'avc1.42e01e';
    }

    function emitFrame(frame, timestamp, ssrc) {
        if (!frame?.length) return;
        const key = isKeyframe(frame);
        if (firstTimestamp === null) {
            firstTimestamp = timestamp >>> 0;
            timestampBase = Date.now() * 1000;
        }
        let delta = (timestamp >>> 0) - (firstTimestamp >>> 0);
        if (delta < -0x80000000) delta += 0x100000000;
        if (delta > 0x80000000) delta -= 0x100000000;
        const ts = Math.max(0, Math.round(timestampBase + delta * 1000000 / 90000));
        onFrame?.({
            streamKey: null,
            userId: String(streams.get(ssrc)?.userId || ''),
            codec: codecString(frame),
            key,
            timestamp: ts,
            data: frame
        });
        if (key) status('playing');
    }

    function flush(ssrc, state) {
        frameStates.delete(ssrc);
        if (!state?.parts?.length) return;

        const mapped = streams.get(ssrc);
        const userId = String(mapped?.userId || '');
        if (!userId) return;

        const dave = getDaveSession?.();
        const version = Number(getProtocolVersion?.() || 0);
        let frame;

        try {
            if (version > 0 && dave) {
                if (!dave.ready) {
                    writeLog(`DAVE vídeo ainda não está pronto; descartando frame de ${userId}`);
                    return;
                }

                // DAVEy receives the encoded access unit, so depacketize
                // H264 (FU-A/STAP-A) first and then decrypt the complete
                // encoded frame. This matches the working screen-share
                // receiver in this project.
                const encodedFrame = reconstruct(state.parts);
                if (!encodedFrame?.length) return;
                const decrypted = dave.decrypt(
                    userId,
                    MediaType?.VIDEO ?? 1,
                    encodedFrame
                );
                if (!decrypted?.length) return;
                frame = Buffer.from(decrypted);
            } else {
                // Legacy/transport-only video: reconstruct H264 from RTP.
                frame = reconstruct(state.parts);
            }
        } catch (e) {
            writeLog(`DAVE vídeo falhou para ${userId}: ${e.message}`);
            return;
        }

        emitFrame(frame, state.timestamp, ssrc);
    }

    function sendPli(ssrc) {
        const udp = getUdpSocket?.();
        const ip = getRemoteIp?.();
        const port = getRemotePort?.();
        const key = getSecretKey?.();
        if (!udp || !ip || !port || !Buffer.isBuffer(key)) return;
        const pli = Buffer.alloc(12);
        pli[0]=0x81; pli[1]=206; pli.writeUInt16BE(2,2);
        pli.writeUInt32BE(0,4);
        pli.writeUInt32BE(Number(ssrc)>>>0,8);
        try {
            const aad=pli.subarray(0,4);
            const nonce=Buffer.alloc(12); nonce.writeUInt32BE(rtcpNonce++>>>0,8);
            const cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
            cipher.setAAD(aad);
            const ct=Buffer.concat([cipher.update(pli.subarray(4)),cipher.final()]);
            udp.send(Buffer.concat([aad,ct,cipher.getAuthTag(),nonce.subarray(8)]),port,ip);
        } catch (e) { writeLog(`PLI falhou: ${e.message}`); }
    }

    function preferredSsrcForUser(userId) {
        let best = 0;
        let bestQuality = -1;
        for (const [ssrc, info] of streams) {
            if (String(info.userId) !== String(userId) || info.active === false) continue;
            const quality = Number(info.quality || 0);
            if (quality > bestQuality) {
                bestQuality = quality;
                best = ssrc;
            }
        }
        return best;
    }

    function requestKeyframes() {
        for (const [ssrc, info] of streams) {
            if (watchingUsers.has(String(info.userId)) && info.active !== false && preferredSsrcForUser(info.userId) === ssrc) sendPli(ssrc);
        }
    }

    function startPli() {
        clearInterval(pliTimer);
        requestKeyframes();
        pliTimer=setInterval(requestKeyframes,1200);
    }

    function stopPli() {
        clearInterval(pliTimer); pliTimer=null;
    }

    function updateVideoState(d) {
        const userId=String(d?.user_id || '');
        if (!userId) return;
        for (const [ssrc, info] of streams) {
            if (info.userId === userId) {
                rtxToPrimary.delete(info.rtxSsrc);
                streams.delete(ssrc);
            }
        }
        const list=Array.isArray(d?.streams)?d.streams:[];
        writeLog(`VIDEO recebido: user=${userId}, streams=${list.length}`);
        for (const st of list) {
            const ssrc=Number(st?.ssrc)>>>0;
            if (!ssrc) continue;
            const rtx=Number(st?.rtx_ssrc || (ssrc+1))>>>0;
            const info={userId,rid:st?.rid,quality:Number(st?.quality??0),active:st?.active!==false,rtxSsrc:rtx};
            streams.set(ssrc,info);
            writeLog(`VIDEO state user=${userId} ssrc=${ssrc} rtx=${rtx} rid=${st?.rid || '?'} quality=${info.quality} active=${info.active}`);
            rtxToPrimary.set(rtx,ssrc);
        }
        if (watchingUsers.has(userId)) {
            const active = list.some(x=>x.active!==false);
            onStatus?.({ status:active?'playing':'paused', userId });
            writeLog(`Streams da câmera atualizados: ${list.map(x => `${x.ssrc}/${x.rtx_ssrc || '-'} q=${x.quality ?? '-'} active=${x.active !== false}`).join(', ') || 'nenhuma'}`);
            startPli();
        }
    }

    function removeUser(userId) {
        for (const [ssrc, info] of streams) {
            if (info.userId===String(userId)) {
                rtxToPrimary.delete(info.rtxSsrc);
                streams.delete(ssrc);
            }
        }
    }

    function processRtp(packet) {
        if (!Buffer.isBuffer(packet)||packet.length<12||(packet[0]>>6)!==2) return;
        rtpPacketCount++;
        const second=packet[1];
        if (second>=192 && second<=223) return;
        const pt=second&0x7f;
        if (!videoPayloadTypes.has(pt) && !rtxPayloadTypes.has(pt)) return;
        videoPacketCount++;
        const ssrc=packet.readUInt32BE(8)>>>0;
        let primary=ssrc;
        if (rtxPayloadTypes.has(pt)) {
            primary=rtxToPrimary.get(ssrc);
            if (!primary) return;
        }
        const info=streams.get(primary);
        if (!info || !watchingUsers.has(String(info.userId)) || info.active===false) return;
        if (preferredSsrcForUser(info.userId) !== primary) return;
        if (videoPacketCount <= 3 || videoPacketCount % 120 === 0) writeLog(`RTP vídeo recebido: pt=${pt}, ssrc=${ssrc}, primary=${primary}, len=${packet.length}`);

        let transport;
        try {
            if (getEncryptionMode?.()!=='aead_aes256_gcm_rtpsize') return;
            transport=decryptAesGcm(packet);
        } catch (e) {
            decryptErrorCount++;
            if (decryptErrorCount <= 3) writeLog(`Falha no transporte RTP vídeo: ${e.message}`);
            return;
        }
        let media=transport.plaintext;
        if (transport.extensionDataLen) {
            if (media.length<transport.extensionDataLen) return;
            media=media.subarray(transport.extensionDataLen);
        }
        try { media=removePadding(media,transport.hasPadding); } catch (_) { return; }

        // RTX payload begins with the original sequence number. Reuse its media payload.
        let sequence=packet.readUInt16BE(2);
        if (rtxPayloadTypes.has(pt)) {
            if (media.length<2) return;
            sequence=media.readUInt16BE(0);
            media=media.subarray(2);
        }
        const timestamp=packet.readUInt32BE(4)>>>0;
        let state=frameStates.get(primary);
        if (!state || state.timestamp!==timestamp) {
            state={timestamp,parts:[]};
            frameStates.set(primary,state);
        }
        state.parts.push({media,sequence});
        if (second&0x80) flush(primary,state);
    }

    return {
        updateVideoState,
        removeUser,
        processRtp,
        watch(userId) {
            const id=String(userId||'');
            if (!id) return;
            watchingUsers.add(id);
            firstTimestamp=null; timestampBase=0;
            frameStates.clear();
            onStatus?.({ status:'connecting', userId:id });
            startPli();
        },
        stop(userId=null) {
            if (userId == null) watchingUsers.clear();
            else watchingUsers.delete(String(userId));
            if (!watchingUsers.size) {
                stopPli();
                frameStates.clear();
            } else {
                startPli();
            }
        },
        isWatching(userId=null) {
            return userId == null ? watchingUsers.size > 0 : watchingUsers.has(String(userId));
        },
        getWants(userId) {
            const id = String(userId || '');
            if (!watchingUsers.has(id)) return null;
            const preferred = preferredSsrcForUser(id);
            // Discord expects MEDIA_SINK_WANTS as { any, pixelCounts } for
            // video.  `any:100` requests a video layer before the VIDEO
            // opcode gives us the concrete SSRC; afterwards pixelCounts
            // selects the preferred simulcast layer.
            if (!preferred) return { any: 100 };
            return {
                any: 100,
                pixelCounts: { [String(preferred >>> 0)]: 0 }
            };
        }
    };
}

module.exports={createCameraVideoReceiver};
