'use strict';

// Conecta o transporte de mídia com o relay via DTLS+SCTP direto num socket
// UDP, sem ICE/SDP/PeerConnection. Portado com werift-dtls (DTLS 1.2
// cliente) + werift-sctp (SCTP puro-JS).

import crypto from 'crypto';
import { createRequire } from 'module';
import * as stun from './stun.js';
import * as demux from './demux.js';
import * as rtcp from './rtcp.js';
import { createAudioSession } from './audioStream.js';
import { createVideoSession } from './videoStream.js';
import fs from 'fs';
import path from 'path';
import { deriveE2eKeys, cryptPayload, computeWarpMiTag } from './e2eSrtp.js';

const require = createRequire(import.meta.url);

let cachedClientCert = null;
async function getClientCertificate() {
    if (cachedClientCert) return cachedClientCert;
    const { webcrypto } = await import('crypto');
    const { X509CertificateGenerator } = await import('@peculiar/x509');
    const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await X509CertificateGenerator.createSelfSigned({
        serialNumber: '01',
        name: 'CN=baileys',
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 3600 * 1000),
        signingAlgorithm: alg,
        keys,
    });
    const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
    const b64 = Buffer.from(pkcs8).toString('base64');
    const keyPem = '-----BEGIN PRIVATE KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n';
    cachedClientCert = { certPem: cert.toString('pem'), keyPem, signatureHash: { hash: 4, signature: 1 } };
    return cachedClientCert;
}

const AUDIO_CLOCK_RATE = 16000;
const SCTP_PORT = 5000;
const ALLOCATE_KEEPALIVE_MS = 1_000;
const TRANSPORT_TIMEOUT_MS = 15_000;
const OVERALL_GIVE_UP_MS = 45_000;
const DIAG_INTERVAL_MS = 5_000;
const DATACHANNEL_STREAM_ID = 0;

function createDcShim() {
    const handlers = { open: [], message: [], error: [], closed: [] };
    let isOpenFlag = false;
    let openFired = false;
    let closedFired = false;
    let sendImpl = () => { throw new Error('sendMessageBinary chamado antes do transporte conectar'); };
    return {
        onOpen(cb) { handlers.open.push(cb); if (openFired) cb(); },
        onMessage(cb) { handlers.message.push(cb); },
        onError(cb) { handlers.error.push(cb); },
        onClosed(cb) { handlers.closed.push(cb); if (closedFired) cb(); },
        isOpen() { return isOpenFlag; },
        sendMessageBinary(buf) { sendImpl(buf); },
        _setSend(fn) { sendImpl = fn; },
        _fireOpen() { if (openFired) return; openFired = true; isOpenFlag = true; handlers.open.forEach((cb) => { try { cb(); } catch (_) {} }); },
        _fireMessage(buf) { handlers.message.forEach((cb) => { try { cb(buf); } catch (_) {} }); },
        _fireError(e) { handlers.error.forEach((cb) => { try { cb(e); } catch (_) {} }); },
        _fireClosed() { if (closedFired) return; closedFired = true; isOpenFlag = false; handlers.closed.forEach((cb) => { try { cb(); } catch (_) {} }); },
    };
}

/** Shim de `pc` só pro que o resto do código (status/diagnóstico, rtt()) precisa. */
function createPcShim() {
    const handlers = { state: [], iceState: [] };
    const data = { state: 'new', bytesSent: 0, bytesReceived: 0, rttMs: 0 };
    let onCloseFn = () => {};
    return {
        state() { return data.state; },
        iceState() { return data.state; },
        bytesSent() { return data.bytesSent; },
        bytesReceived() { return data.bytesReceived; },
        rtt() { return data.rttMs / 1000; },
        close() { try { onCloseFn(); } catch (_) {} },
        onStateChange(cb) { handlers.state.push(cb); },
        onIceStateChange(cb) { handlers.iceState.push(cb); },
        onGatheringStateChange() {},
        _setState(s) { data.state = s; handlers.state.forEach((cb) => cb(s)); handlers.iceState.forEach((cb) => cb(s)); },
        _addBytesSent(n) { data.bytesSent += n; },
        _addBytesReceived(n) { data.bytesReceived += n; },
        _setRtt(ms) { data.rttMs = ms; },
        _onClose(fn) { onCloseFn = fn; },
    };
}

function safeCall(fn) {
    try { return fn(); } catch { return '?'; }
}

// ── INSPETOR DE RTP (debug) ─────────────────────────────────────────────────
// Só liga com CALL_RTP_DUMP=1. Escreve ./debug-rtp.log com SSRC/slot, payload type,
// cabeçalho e o payload decifrado. Pra achar a chave certa, tenta derivar com o id
// do outro lado e VALIDA a tag WARP de 4 bytes: se bater, a derivação está certa.
function nomeNal(b0, b1) {
    const t = b0 & 0x1f;
    if (t === 28 || t === 29) return `FU-${t === 28 ? 'A' : 'B'}(S=${(b1 >> 7) & 1},E=${(b1 >> 6) & 1},nal=${b1 & 0x1f})`;
    const nomes = { 1: 'P', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD', 24: 'STAP-A' };
    return nomes[t] ? `${nomes[t]}(nal=${t})` : `nal=${t}`;
}

function criarInspetorRtp(callId, entry, callKeyInicial) {
    if (process.env.CALL_RTP_DUMP !== '1') return null;
    const arquivo = path.join(process.cwd(), 'debug-rtp.log');
    const out = (s) => { try { fs.appendFileSync(arquivo, `[${new Date().toISOString()}] ${s}\n`); } catch (_) {} };

    const peerJid = String((entry && entry.peer) || '').split('/')[0];
    const [peerUserDev = '', peerServer = ''] = peerJid.split('@');
    const peerUser = peerUserDev.split(':')[0];
    const candidatos = peerUser && peerServer
        ? [...new Set([`${peerUser}:0@${peerServer}`, `${peerUser}@${peerServer}`, peerJid])]
        : [];
    out(`inspetor ligado pra ${callId}. peer=${peerJid || '(desconhecido)'} candidatos=${JSON.stringify(candidatos)}`);

    const slotPorSsrc = new Map();
    for (const id of candidatos) {
        for (let slot = 0; slot < 9; slot++) {
            try { slotPorSsrc.set(Number(stun.deriveWasmParticipantSsrc(callId, id, slot)) >>> 0, `${id}#slot${slot}`); } catch (_) {}
        }
    }

    const gravarVideo = process.env.CALL_VIDEO_DUMP === '1';
    const arquivoVideo = path.join(process.cwd(), 'debug-video.bin');
    if (gravarVideo) out(`CALL_VIDEO_DUMP ligado: pacotes de vídeo decifrados vão pra ${arquivoVideo}`);
    const stats = new Map();
    let validada = null; // { id, tagLen }
    let ultimoResumo = Date.now();

    const derivar = (id) => {
        try { return deriveE2eKeys((entry && entry.callKey) || callKeyInicial, id); } catch (_) { return null; }
    };

    function decifrar(buf, hdrLen) {
        const seq = buf.readUInt16BE(2);
        const ssrc = buf.readUInt32BE(8);
        const combos = validada ? [validada] : candidatos.flatMap((id) => [4, 10].map((tagLen) => ({ id, tagLen })));
        for (const c of combos) {
            const keys = derivar(c.id);
            if (!keys) continue;
            const fim = buf.length - c.tagLen;
            if (fim <= hdrLen) continue;
            const tag = computeWarpMiTag(keys.authKey, buf.subarray(0, fim), 0, c.tagLen);
            if (!tag.equals(buf.subarray(fim))) continue;
            if (!validada) { validada = c; out(`>>> CHAVE VALIDADA: id=${c.id} tagLen=${c.tagLen}`); }
            return { verificado: true, c, dec: cryptPayload(keys, ssrc, seq, 0, buf.subarray(hdrLen, fim)) };
        }
        return { verificado: false };
    }

    return {
        inspect(buf) {
            if (buf.length < 16 || (buf[0] >> 6) !== 2) {
                out(`pacote não-RTP? ${buf.length}B ${buf.subarray(0, 24).toString('hex')}`);
                return;
            }
            const cc = buf[0] & 0x0f;
            const temExt = (buf[0] >> 4) & 1;
            const pt = buf[1] & 0x7f;
            const marker = buf[1] >> 7;
            const seq = buf.readUInt16BE(2);
            const ts = buf.readUInt32BE(4);
            const ssrc = buf.readUInt32BE(8);
            let hdrLen = 12 + cc * 4;
            let ext = '';
            if (temExt && buf.length >= hdrLen + 4) {
                const extProfile = buf.readUInt16BE(hdrLen);
                const extWords = buf.readUInt16BE(hdrLen + 2);
                ext = `0x${extProfile.toString(16)}:${buf.subarray(hdrLen + 4, hdrLen + 4 + extWords * 4).toString('hex')}`;
                hdrLen += 4 + extWords * 4;
            }
            let st = stats.get(ssrc);
            if (!st) {
                st = { n: 0, bytes: 0, pts: new Set(), ultimoN: 0 };
                stats.set(ssrc, st);
                out(`NOVO SSRC ${ssrc} (0x${ssrc.toString(16)}) -> ${slotPorSsrc.get(ssrc) || 'slot desconhecido'} pt=${pt} len=${buf.length}`);
            }
            st.n++; st.bytes += buf.length; st.pts.add(pt);

            // captura binária do vídeo: [u32 tamanho][u16 seq][u32 ts][u8 marker][payload]
            if (gravarVideo && (pt === 97 || String(slotPorSsrc.get(ssrc) || '').endsWith('#slot2'))) {
                const d = decifrar(buf, hdrLen);
                if (d.verificado) {
                    const cab = Buffer.alloc(4 + 2 + 4 + 1);
                    cab.writeUInt32BE(2 + 4 + 1 + d.dec.length, 0);
                    cab.writeUInt16BE(seq, 4);
                    cab.writeUInt32BE(ts, 6);
                    cab.writeUInt8(marker, 10);
                    try { fs.appendFileSync(arquivoVideo, Buffer.concat([cab, d.dec])); } catch (_) {}
                }
            }

            if (st.n <= 5 || st.n % 100 === 0) {
                const d = decifrar(buf, hdrLen);
                let desc;
                if (d.verificado) {
                    const p = d.dec;
                    const h264 = p.length >= 2 && (p[0] & 0x80) === 0 ? ` h264?=${nomeNal(p[0], p[1])}` : '';
                    desc = `tag=OK(${d.c.id},${d.c.tagLen}B) payload[${p.length}B]=${p.subarray(0, 32).toString('hex')}${h264}`;
                } else {
                    desc = `tag=FALHOU bruto[0:40]=${buf.subarray(0, 40).toString('hex')} fim[-12]=${buf.subarray(Math.max(0, buf.length - 12)).toString('hex')}`;
                }
                out(`ssrc=${ssrc} pt=${pt} M=${marker} seq=${seq} ts=${ts} len=${buf.length} hdr=${hdrLen}B ext=${ext || '-'} ${desc}`);
            }

            const agora = Date.now();
            if (agora - ultimoResumo >= 3000) {
                const linhas = [...stats.entries()].map(([s, x]) =>
                    `ssrc=${s} [${slotPorSsrc.get(s) || '?'}] pt=${[...x.pts].join('/')} pacotes=${x.n} (+${x.n - x.ultimoN}) medio=${Math.round(x.bytes / x.n)}B`);
                stats.forEach((x) => { x.ultimoN = x.n; });
                out(`RESUMO: ${linhas.join(' | ')}`);
                ultimoResumo = agora;
            }
        },
    };
}

/**
 * Abre o canal de mídia com o relay via DTLS+SCTP direto (sem ICE/SDP),
 * usando as credenciais do <relay> pra assinar o Allocate. `calls` é o mapa
 * de estado das chamadas do socket (`sock.calls`); `log` é o logger do
 * socket.
 */
export function attemptDataChannelConnect(callId, selfParticipantId, relayData, media, addr, callKey, { calls, log }) {
    const authToken = relayData.authTokens[media.authTokenId];
    if (!authToken || authToken.length === 0) {
        log(`[CALL] Sem auth_token válido (id ${media.authTokenId}) pra ${callId} — não dá pra montar o Allocate.`);
        return;
    }
    if (!relayData.relayKey || relayData.relayKey.length === 0) {
        log(`[CALL] Sem <key> decodificada pra ${callId}.`);
        return;
    }
    const relayToken = relayData.relayTokens[media.tokenId];
    if (!relayToken || relayToken.length === 0) {
        log(`[CALL] Sem relay_token válido (id ${media.tokenId}) pra ${callId} — não dá pra montar o Allocate.`);
        return;
    }
    if (!relayData.relayKeyAscii) {
        log(`[CALL] Sem <key> em texto (relayKeyAscii) pra ${callId} — não dá pra assinar o Allocate.`);
        return;
    }

    let DtlsClient, UdpTransport, SCTP, WEBRTC_PPID;
    try {
        ({ DtlsClient } = require('werift-dtls/lib/dtls/src/index'));
        ({ UdpTransport } = require('werift-dtls/lib/common/src/index'));
        ({ SCTP, WEBRTC_PPID } = require('werift-sctp'));
    } catch (e) {
        log(`[CALL] werift-dtls/werift-sctp não estão disponíveis pra ${callId}:`, e.message);
        return;
    }

    const entry = calls && calls[callId];
    const inBurst = () => !!(entry && entry.logBurstUntil && Date.now() < entry.logBurstUntil);

    const pc = createPcShim();
    if (entry) entry.pc = pc;

    let settled = false;
    let transportConnected = false;
    let dc = createDcShim();

    function status() {
        return `pc=${safeCall(() => pc.state())} ice=${safeCall(() => pc.iceState())} dcOpen=${safeCall(() => dc.isOpen())} ` +
            `bytesSent=${safeCall(() => pc.bytesSent())} bytesRecv=${safeCall(() => pc.bytesReceived())} rtt=${safeCall(() => pc.rtt())}`;
    }

    function closeForGood(reason) {
        if (settled) return;
        settled = true;
        clearTimeout(transportTimer);
        clearTimeout(giveUpTimer);
        clearInterval(diagTimer);
        clearInterval(vivaTimer);
        if (audioSession) audioSession.close();
        if (videoSession) videoSession.close();
        if (rtcpSession) rtcpSession.close();
        log(`[CALL] [DC ${callId}] ${reason} (${status()})`);
        try { pc.close(); } catch (_) {}
        dc._fireClosed();
        // Se a reconexão automática estiver em andamento (entry.reconnecting),
        // o registro sobrevive — é o mesmo registro que a call reconectada usa.
        if (calls && !(entry && entry.reconnecting)) delete calls[callId];
    }

    const transportTimer = setTimeout(() => {
        if (transportConnected || settled) return;
        closeForGood(`transporte (DTLS+SCTP) não conectou em ${TRANSPORT_TIMEOUT_MS}ms — desistindo`);
    }, TRANSPORT_TIMEOUT_MS);

    // Se a call foi encerrada localmente (.endCall apaga calls[callId]) enquanto o transporte
    // ainda conectava, a mídia sobe sozinha e fica mandando áudio/RTCP pra uma call morta.
    const vivaTimer = setInterval(() => {
        if (settled) { clearInterval(vivaTimer); return; }
        if (calls && entry && !calls[callId] && !entry.reconnecting) {
            closeForGood('call já encerrada localmente — fechando a mídia');
        }
    }, 2000);

    const giveUpMs = OVERALL_GIVE_UP_MS;
    const giveUpTimer = setTimeout(() => {
        closeForGood(`${giveUpMs}ms se passaram sem o DataChannel abrir — desistindo (mas o transporte chegou a conectar: ${transportConnected})`);
    }, giveUpMs);

    const diagTimer = setInterval(() => {
        if (settled) return;
        log(`[CALL] [DC ${callId}] status: ${status()}`);
    }, DIAG_INTERVAL_MS);

    (async () => {
        let udpTransport, dtlsClient, sctp;
        try {
            log(`[CALL] [DC ${callId}] abrindo socket UDP e iniciando DTLS direto com o relay (sem ICE), ${addr.ip}:${addr.port}...`);
            udpTransport = await UdpTransport.init('udp4');
            udpTransport.rinfo = { address: addr.ip, port: addr.port };

            const clientCert = await getClientCertificate();
            dtlsClient = new DtlsClient({
                transport: udpTransport,
                cert: clientCert.certPem,
                key: clientCert.keyPem,
                signatureHash: clientCert.signatureHash,
            });
            dtlsClient.onError.subscribe((e) => {
                log(`[CALL] [DC ${callId}] erro DTLS: ${e && e.stack ? e.stack : e}`);
            });
            dtlsClient.onClose.subscribe(() => {
                if (!settled) closeForGood('transporte DTLS fechou');
            });

            const sctpTransport = {
                send: (buf) => dtlsClient.send(buf),
                onData: undefined,
                close: () => {},
            };
            dtlsClient.onData.subscribe((buf) => {
                if (sctpTransport.onData) sctpTransport.onData(buf);
            });

            pc._setState('connecting');
            dtlsClient.connect();
            await dtlsClient.onConnect.asPromise(TRANSPORT_TIMEOUT_MS);
            if (settled) return;
            transportConnected = true;
            pc._setState('connected');
            log(`[CALL] [DC ${callId}] handshake DTLS completo. Iniciando SCTP...`);

            sctp = SCTP.client(sctpTransport);
            sctp.onReceive.subscribe((streamId, ppId, data) => {
                if (streamId !== DATACHANNEL_STREAM_ID) return;
                pc._addBytesReceived(data.length);
                dc._fireMessage(data);
            });
            const sctpConnected = sctp.stateChanged.connected.asPromise(TRANSPORT_TIMEOUT_MS);
            await sctp.start(SCTP_PORT);
            await sctpConnected;
            if (settled) return;

            dc._setSend((buf) => {
                pc._addBytesSent(buf.length);
                sctp.send(DATACHANNEL_STREAM_ID, WEBRTC_PPID.BINARY, buf).catch((e) => {
                    log(`[CALL] [DC ${callId}] erro mandando pelo SCTP:`, e.message);
                });
            });
            pc._onClose(() => {
                try { sctp.stop(); } catch (_) {}
                try { udpTransport.close(); } catch (_) {}
                dc._fireClosed();
            });

            clearTimeout(transportTimer);
            clearTimeout(giveUpTimer);
            clearInterval(diagTimer);
            log(`[CALL] [DC ${callId}] DATACHANNEL ABERTO (DTLS+SCTP direto) — conexão de mídia estabelecida com o relay! (${status()})`);
            dc._fireOpen();
        } catch (e) {
            if (!settled) closeForGood(`erro conectando transporte cru (DTLS/SCTP): ${e.stack || e.message}`);
        }
    })();

    dc.onOpen(() => {
        const endpointXor = stun.encodeXorRelayEndpoint(addr.ip, addr.port);
        if (!endpointXor) {
            log(`[CALL] [DC ${callId}] IPv4 inválido no endpoint (${addr.ip}), não dá pra montar o Allocate.`);
            return;
        }
        let allocatesSent = 0;
        let lastAllocateKind = null;
        // O keepalive não monta um Allocate novo a cada tick, só reenvia o
        // mesmo pacote em cache com o mesmo transaction-id. Um Allocate novo
        // só é montado quando os pids ou o material do relay mudam.
        let cachedPacket = null;
        let cachedPidsKey = null;
        const sendAllocate = () => {
            try {
                if (!dc.isOpen()) return;
                const liveEntry = calls && calls[callId];
                const livePids = liveEntry && liveEntry.pids ? Array.from(liveEntry.pids) : [];
                const pidsKey = livePids.slice().sort((a, b) => a - b).join(',');
                if (!cachedPacket || pidsKey !== cachedPidsKey) {
                    const tx = crypto.randomBytes(12);
                    // A chave de assinatura (MESSAGE-INTEGRITY) do Allocate é o
                    // texto base64 bruto da <key> (relayKeyAscii), não os bytes
                    // decodificados.
                    if (livePids.length > 0) {
                        lastAllocateKind = 'grupo';
                        // Só os 6 primeiros SSRCs (áudio+vídeo) são determinísticos;
                        // os 3 últimos (hbh FEC tx/rx + app-data) são sorteados uma
                        // vez por sessão de grupo e reaproveitados.
                        const appDataSsrc = stun.deriveWasmParticipantSsrc(callId, selfParticipantId, stun.APP_DATA_SSRC_SLOT_WORD);
                        if (liveEntry && !liveEntry.groupStreamSsrcs) {
                            liveEntry.groupStreamSsrcs = stun.prepareGroupStreamAuxSsrcs(callId, selfParticipantId, appDataSsrc);
                        }
                        const streamSsrcs = (liveEntry && liveEntry.groupStreamSsrcs)
                            || stun.prepareGroupStreamAuxSsrcs(callId, selfParticipantId, appDataSsrc);
                        const hbhFecSsrcs = [
                            stun.deriveWasmParticipantSsrc(callId, selfParticipantId, stun.HBH_FEC_TX_SSRC_SLOT_WORD),
                            stun.deriveWasmParticipantSsrc(callId, selfParticipantId, stun.HBH_FEC_RX_SSRC_SLOT_WORD),
                        ];
                        cachedPacket = stun.buildWasmGroupStunAllocateRequest({
                            transactionId: tx,
                            relayToken,
                            endpointXor,
                            integrityKey: relayData.relayKeyAscii,
                            streamSsrcs,
                            appDataSsrc,
                            hbhFecSsrcs,
                            participantPids: livePids,
                        });
                    } else {
                        lastAllocateKind = '1:1';
                        cachedPacket = stun.buildWasmStunAllocateRequest(tx, relayToken, endpointXor, relayData.relayKeyAscii, callId, selfParticipantId);
                    }
                    cachedPidsKey = pidsKey;
                    log(`[CALL] [DC ${callId}] Allocate (${lastAllocateKind}) NOVO montado (pids mudaram: [${cachedPidsKey}]) — reenviado como keepalive até mudar de novo.`);
                }
                dc.sendMessageBinary(cachedPacket);
                allocatesSent++;
                if (allocatesSent === 1 || allocatesSent % 30 === 0 || inBurst()) {
                    log(`[CALL] [DC ${callId}] Allocate (${lastAllocateKind}) reenviado pelo DataChannel (${cachedPacket.length} bytes, ${allocatesSent}º envio, pids=[${livePids.join(',')}]).`);
                }
                // Consent ping (RFC 7675) mandado junto com cada reenvio do
                // Allocate, com transaction-id novo a cada vez.
                try {
                    const pingTx = crypto.randomBytes(12);
                    const ping = stun.buildWhatsappPing(pingTx);
                    dc.sendMessageBinary(ping);
                    if (allocatesSent === 1 || allocatesSent % 30 === 0 || inBurst()) {
                        log(`[CALL] [DC ${callId}] WhatsApp consent ping mandado (${ping.length} bytes, ${allocatesSent}º envio).`);
                    }
                } catch (e) {
                    log(`[CALL] [DC ${callId}] erro mandando WhatsApp consent ping:`, e.message);
                }
            } catch (e) {
                log(`[CALL] [DC ${callId}] erro montando/mandando Allocate (${lastAllocateKind}):`, e.stack || e.message);
            }
        };
        sendAllocate();
        const keepaliveTimer = setInterval(() => {
            if (!dc.isOpen()) { clearInterval(keepaliveTimer); return; }
            sendAllocate();
        }, ALLOCATE_KEEPALIVE_MS);
        dc.onClosed(() => clearInterval(keepaliveTimer));
    });

    let audioSession = null;
    let videoSession = null;
    let rtcpSession = null;
    let allocated = false;
    const rtpInspector = criarInspetorRtp(callId, entry, callKey);
    let inboundCount = 0;
    let forwardedCount = 0;
    let rtcpInboundCount = 0;
    let droppedEnvelopeCount = 0;
    dc.onMessage((msg) => {
        const raw = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
        const unwrapped = demux.unwrapGroupForwardingPacket(raw);
        if (!unwrapped) {
            droppedEnvelopeCount++;
            log(`[CALL] [DC ${callId}] DESCARTADO: envelope 0x09 malformado ou payload inválido (${droppedEnvelopeCount}º descarte, ${raw.length}B, primeiros bytes=${raw.subarray(0, Math.min(16, raw.length)).toString('hex')}).`);
            return;
        }
        const buf = unwrapped.payload;
        if (unwrapped.groupForwarded) {
            forwardedCount++;
            if (forwardedCount === 1 || forwardedCount % 250 === 0 || inBurst()) {
                log(`[CALL] [DC ${callId}] mídia encaminhada de outro participante (${forwardedCount} pacote(s) até agora, ${buf.length}B, hdrLen=${unwrapped.forwardingHeaderLen}).`);
            }
        }
        if (stun.isStunPacket(buf)) {
            const msgType = stun.stunMessageType(buf);
            if (msgType === stun.MSG_ALLOCATE_SUCCESS) {
                if (!allocated) log(`[CALL] [DC ${callId}] Allocate ACEITO pelo relay! (${buf.length} bytes)`);
                else if (inBurst()) log(`[CALL] [DC ${callId}] Allocate re-confirmado pelo relay (${buf.length} bytes).`);
                if (!allocated && callKey) {
                    allocated = true;
                    if (entry && entry.pids instanceof Set && entry.pids.size > 0) entry.groupModeStartedAt = Date.now();
                    const ssrc = stun.deriveWasmParticipantSsrc(callId, selfParticipantId, 0);
                    // Prefere entry.callKey no instante atual: um reconnect pode
                    // ser seguido de um enc_rekey com epoch nova antes do
                    // Allocate confirmar, e a sessão de áudio não pode ficar
                    // presa na chave velha.
                    const liveCallKey = (entry && entry.callKey) || callKey;
                    // Só reaproveita seq/timestamp/roc se a epoch (callKey)
                    // continua a mesma de antes do reconnect.
                    const rtpStateToUse = (entry && entry.pendingRtpState && entry.pendingRtpKey === liveCallKey)
                        ? entry.pendingRtpState
                        : null;
                    rtcpSession = rtcp.createRtcpSession({
                        callId, localSsrc: ssrc, callKey: liveCallKey, hbhKey: relayData.hbhKey, selfParticipantId,
                        clockRate: AUDIO_CLOCK_RATE,
                        sendRaw: (packet) => dc.sendMessageBinary(packet),
                        log,
                        isBurst: inBurst,
                    });
                    rtcpSession.start();
                    audioSession = createAudioSession(callId, dc, {
                        callKey: liveCallKey, ssrc, selfParticipantId,
                        onSent: (payloadLength, timestamp) => rtcpSession.recordSent(payloadLength, timestamp),
                        isBurst: inBurst,
                        rtpState: rtpStateToUse,
                        log,
                    });
                    if (entry) entry.audio = audioSession;
                    // Vídeo (experimental): fica parado até alguém chamar entry.video.start(fonte).
                    videoSession = createVideoSession(callId, dc, {
                        callKey: liveCallKey,
                        getCallKey: () => (entry && entry.callKey) || liveCallKey,
                        ssrc: stun.deriveWasmParticipantSsrc(callId, selfParticipantId, 2),
                        selfParticipantId,
                        log,
                    });
                    if (entry) entry.video = videoSession;
                    if (entry && entry.pendingAudioResume) {
                        const resume = entry.pendingAudioResume;
                        entry.pendingAudioResume = null;
                        audioSession.resumeTrack(resume.track, resume.cursor);
                    }
                    if (entry) {
                        entry.pendingRtpState = null;
                        entry.pendingRtpKey = null;
                    }
                }
            } else if (msgType === stun.MSG_ALLOCATE_ERROR) {
                const attrs = stun.parseStunAttributes(buf);
                log(`[CALL] [DC ${callId}] Allocate REJEITADO. attrs=${JSON.stringify(attrs.map((a) => ({ type: a.attrType.toString(16), len: a.value.length })))}`);
            } else if (msgType === 0x0802) {
                if (inBurst()) log(`[CALL] [DC ${callId}] WhatsApp consent pong recebido (${buf.length} bytes).`);
            } else {
                log(`[CALL] [DC ${callId}] mensagem STUN recebida, tipo=0x${(msgType || 0).toString(16)}, ${buf.length} bytes`);
            }
        } else if (rtcp.isRtcpPacket(buf)) {
            rtcpInboundCount++;
            if (rtcpInboundCount === 1 || rtcpInboundCount % 250 === 0 || inBurst()) {
                log(`[CALL] [DC ${callId}] RTCP recebido de outro participante (${rtcpInboundCount}º, ${buf.length}B, pt=${buf[1]}).`);
            }
        } else {
            if (rtpInspector) { try { rtpInspector.inspect(buf); } catch (_) {} }
            if (rtcpSession) rtcpSession.recordReceived(buf, Date.now());
            inboundCount++;
            if (inboundCount === 1 || inboundCount % 250 === 0) {
                log(`[CALL] [DC ${callId}] recebendo mídia do outro lado (${inboundCount} pacote(s) até agora, ${buf.length}B o último).`);
            } else if (inBurst()) {
                const hdr = rtcp.parseRtpHeaderBasics(buf);
                log(`[CALL] [DC ${callId}] RTP recebido #${inboundCount}: ${buf.length}B ssrc=${hdr ? hdr.ssrc : '?'} seq=${hdr ? hdr.sequenceNumber : '?'} ts=${hdr ? hdr.timestamp : '?'}`);
            }
        }
    });
    dc.onError((e) => closeForGood(`erro no DataChannel: ${e && e.stack ? e.stack : e}`));
    dc.onClosed(() => {
        if (audioSession) audioSession.close();
        if (videoSession) videoSession.close();
        if (rtcpSession) rtcpSession.close();
        if (!settled) closeForGood('DataChannel fechou antes de abrir');
    });
}
