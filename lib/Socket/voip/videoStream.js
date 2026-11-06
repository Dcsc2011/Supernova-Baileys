'use strict';

// Sessão de VÍDEO de uma call (EXPERIMENTAL): ffmpeg -> H.264 Annex-B -> RTP (RFC 6184)
// -> SRTP ponta-a-ponta -> DataChannel. Mesmo esquema do audioStream.js, só que no SSRC do
// slot 2 (vídeo, "stream 1 / subtipo 0" nos descriptors do Allocate) e payload type 97,
// que é o que o celular usa no vídeo dele.

import { spawn } from 'child_process';
import { encodeRtpHeader } from './rtpFrame.js';
import { deriveE2eKeys, cryptPayload, computeWarpMiTag } from './e2eSrtp.js';

export const RTP_PAYLOAD_TYPE_VIDEO = 97;
const CLOCK_RATE = 90000;
const WARP_MI_TAG_LEN = 4;
const MAX_PAYLOAD = 900; // o celular manda até ~990 B por pacote

const NAL_START_CODE = Buffer.from([0, 0, 0, 1]);

/** Argumentos do ffmpeg. `fonte`: 'teste' (padrão de teste), imagem (png/jpg/...) ou vídeo/URL. */
const FPS_PADRAO = Number(process.env.CALL_VIDEO_FPS) || 10;
const KBPS_PADRAO = Number(process.env.CALL_VIDEO_KBPS) || 80;
const KEYINT_SEG = Number(process.env.CALL_VIDEO_KEYINT) || 2;   // segundos entre keyframes
const INTRA_REFRESH = process.env.CALL_VIDEO_INTRA === '1';        // experimento: sem keyframes grandes

export function ffmpegArgs(fonte, { largura = 320, altura = 240, fps = FPS_PADRAO, kbps = KBPS_PADRAO, loop = true } = {}) {
    let entrada;
    if (!fonte || fonte === 'teste') {
        entrada = ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${largura}x${altura}:rate=${fps}`];
    } else if (/\.(png|jpe?g|webp|bmp|gif)$/i.test(fonte)) {
        entrada = ['-re', '-loop', '1', '-i', fonte];
    } else {
        entrada = loop ? ['-re', '-stream_loop', '-1', '-i', fonte] : ['-re', '-i', fonte];
    }
    return [
        '-hide_banner', '-loglevel', 'error',
        ...entrada,
        '-an',
        '-vf', `scale=${largura}:${altura}:force_original_aspect_ratio=decrease,pad=${largura}:${altura}:(ow-iw)/2:(oh-ih)/2,fps=${fps},hqdn3d=2:1.5:3:3,format=yuv420p`,
        // Main + veryfast: ~25% mais eficiente que baseline/ultrafast no mesmo bitrate (o celular também manda Main).
        '-c:v', 'libx264', '-profile:v', 'main',
        '-preset', 'veryfast', '-tune', 'zerolatency',
        // aud=1 delimita cada quadro; repeat-headers=1 põe SPS/PPS em todo keyframe;
        // 1 slice por quadro e sem B-frames; keyframe a cada 2 s (o celular pode pedir antes).
        '-x264-params', `threads=1:slices=1:aud=1:repeat-headers=1:keyint=${Math.round(fps * KEYINT_SEG)}:min-keyint=${Math.round(fps * KEYINT_SEG)}:scenecut=0:bframes=0:ref=1${INTRA_REFRESH ? ':intra-refresh=1' : ''}`,
        '-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.2)}k`, '-bufsize', `${Math.round(kbps * 1.5)}k`,
        '-f', 'h264', 'pipe:1',
    ];
}

// Áudio pro Opus de 16 kHz: corta graves/agudos que o codec não leva (evita chiado de aliasing),
// nivela o volume (som baixo no codec vira chiado) e limita o pico. CALL_AUDIO_FILTRO= troca/desliga.
const AUDIO_FILTRO = process.env.CALL_AUDIO_FILTRO !== undefined
    ? (process.env.CALL_AUDIO_FILTRO || 'anull')
    : 'highpass=f=80,lowpass=f=7000,loudnorm=I=-18:TP=-3:LRA=9,aresample=16000,alimiter=limit=0.8:level=0';

/** Uma tentativa de extração com um filtro. Resolve { pcm, code, erro }. */
function extrairUmaVez(fonte, filtro, segundosMax) {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-i', fonte, '-vn', '-t', String(segundosMax),
            '-af', filtro,
            '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        const partes = [];
        let erro = '';
        proc.stdout.on('data', (d) => partes.push(d));
        proc.stderr.on('data', (d) => { if (erro.length < 1500) erro += String(d); });
        proc.on('error', (e) => resolve({ pcm: null, code: -1, erro: e.code === 'ENOENT' ? 'ffmpeg não encontrado no PATH' : e.message }));
        proc.on('close', (code) => resolve({ pcm: Buffer.concat(partes), code, erro: erro.trim() }));
    });
}

/** Pico e RMS (dBFS) de um PCM s16le. */
function estatisticasPcm(pcm) {
    const n = pcm.length >> 1;
    if (!n) return { seg: 0, picoDb: -Infinity, rmsDb: -Infinity };
    let pico = 0; let soma = 0; let estouros = 0;
    for (let i = 0; i < n; i++) {
        const v = pcm.readInt16LE(i * 2);
        const a = v < 0 ? -v : v;
        if (a > pico) pico = a;
        if (a >= 32767) estouros++;
        soma += v * v;
    }
    const db = (x) => (x > 0 ? 20 * Math.log10(x / 32768) : -Infinity);
    return { seg: n / 16000, picoDb: db(pico), rmsDb: db(Math.sqrt(soma / n)), estouros };
}

/**
 * Extrai o áudio de uma fonte como PCM s16le mono 16 kHz (até 20 min).
 * Tenta o filtro completo e, se o resultado vier com erro ou mudo, cai pro áudio cru.
 * Devolve Buffer (com .info = { seg, picoDb, rmsDb, filtro, erro, tentativas }) ou null se não houver áudio.
 */
export async function extrairAudioPcm(fonte, { segundosMax = 1200 } = {}) {
    const filtros = AUDIO_FILTRO === 'anull' ? ['anull'] : [AUDIO_FILTRO, 'anull'];
    const tentativas = [];
    let melhor = null;
    for (const filtro of filtros) {
        const r = await extrairUmaVez(fonte, filtro, segundosMax);
        const est = r.pcm && r.pcm.length >= 3200 ? estatisticasPcm(r.pcm) : { seg: 0, picoDb: -Infinity, rmsDb: -Infinity };
        const nomeFiltro = filtro === 'anull' ? 'cru' : 'completo';
        tentativas.push({ filtro: nomeFiltro, code: r.code, seg: Number(est.seg.toFixed(1)), rmsDb: Number(est.rmsDb.toFixed(1)), erro: r.erro.slice(0, 200) });
        if (r.pcm && r.pcm.length >= 3200) {
            const ok = r.code === 0 && est.rmsDb > -60;
            if (!melhor || ok) melhor = { pcm: r.pcm, est, filtro: nomeFiltro, erro: r.erro, code: r.code };
            if (ok) break;
        }
    }
    if (!melhor) return null;

    // Guarda final: se o pico encostou em 0 dBFS (estouro = chiado/distorção), baixa o ganho até -3 dBFS.
    let ganhoDb = 0;
    const estOriginal = melhor.est;
    if (estOriginal.picoDb > -2) {
        ganhoDb = -3 - estOriginal.picoDb;
        const g = Math.pow(10, ganhoDb / 20);
        const n = melhor.pcm.length >> 1;
        for (let i = 0; i < n; i++) {
            const v = Math.round(melhor.pcm.readInt16LE(i * 2) * g);
            melhor.pcm.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
        }
        melhor.est = estatisticasPcm(melhor.pcm);
    }
    melhor.pcm.info = {
        seg: melhor.est.seg, picoDb: melhor.est.picoDb, rmsDb: melhor.est.rmsDb, estouros: estOriginal.estouros,
        ganhoDb: Number(ganhoDb.toFixed(1)), filtro: melhor.filtro, code: melhor.code, erro: melhor.erro, tentativas,
    };
    return melhor.pcm;
}

/** Separa um fluxo Annex-B em NALs (sem start code). Chame push() com os pedaços; ele devolve NALs completos. */
export class NalSplitter {
    constructor() { this.buf = Buffer.alloc(0); }

    push(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        const posicoes = [];
        for (let i = 0; i + 3 <= this.buf.length; i++) {
            if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) { posicoes.push(i); i += 2; }
        }
        const nals = [];
        for (let j = 0; j + 1 < posicoes.length; j++) {
            let fim = posicoes[j + 1];
            if (fim > 0 && this.buf[fim - 1] === 0) fim--; // start code de 4 bytes
            nals.push(this.buf.subarray(posicoes[j] + 3, fim));
        }
        if (posicoes.length > 0) this.buf = this.buf.subarray(posicoes[posicoes.length - 1]);
        return nals;
    }

    /** Último NAL pendente (fim do fluxo). */
    flush() {
        const p = this.buf.length >= 3 && this.buf[0] === 0 && this.buf[1] === 0 && this.buf[2] === 1 ? 3 : 0;
        const nal = this.buf.subarray(p);
        this.buf = Buffer.alloc(0);
        return nal.length ? nal : null;
    }
}

/**
 * Transforma um quadro (lista de NALs, sem start code) em payloads RTP:
 * SPS+PPS num STAP-A; NAL de imagem em pacote único ou FU-A. Descarta SEI (6) e AUD (9).
 */
export function empacotarQuadro(nals, maxPayload = MAX_PAYLOAD) {
    const tipo = (n) => n[0] & 0x1f;
    const ps = nals.filter((n) => tipo(n) === 7 || tipo(n) === 8);
    const vcl = nals.filter((n) => tipo(n) === 1 || tipo(n) === 5);
    const payloads = [];

    if (ps.length) {
        const partes = [Buffer.from([0x60 | 24])]; // STAP-A, NRI 3
        for (const n of ps) {
            const len = Buffer.alloc(2);
            len.writeUInt16BE(n.length, 0);
            partes.push(len, n);
        }
        payloads.push(Buffer.concat(partes));
    }
    for (const n of vcl) {
        if (n.length <= maxPayload) { payloads.push(Buffer.from(n)); continue; }
        const indicador = (n[0] & 0xe0) | 28;
        const nalTipo = n[0] & 0x1f;
        const dados = n.subarray(1);
        const tam = maxPayload - 2;
        for (let off = 0; off < dados.length; off += tam) {
            const fim = Math.min(off + tam, dados.length);
            const cab = Buffer.from([indicador, (off === 0 ? 0x80 : 0) | (fim === dados.length ? 0x40 : 0) | nalTipo]);
            payloads.push(Buffer.concat([cab, dados.subarray(off, fim)]));
        }
    }
    return payloads;
}

/** `log` é opcional. `getCallKey` devolve a callKey atual (muda num rekey). */
export function createVideoSession(callId, dc, { callKey, getCallKey, ssrc, selfParticipantId, log }) {
    const say = (m) => { if (log) log(`[CALL] [VIDEO ${callId}] ${m}`); };
    let chaveAtual = callKey;
    let keys = deriveE2eKeys(chaveAtual, selfParticipantId);
    if (!keys) {
        say('callKey inválida, vídeo desativado.');
        return { start() { throw new Error('callKey inválida'); }, stop() {}, close() {}, ativo: () => false };
    }

    let seq = 1;
    let roc = 0;
    let timestamp = Math.floor(Math.random() * 0x100000000) >>> 0;
    let ffmpeg = null;
    let fpsAtual = 10;
    let quadros = 0;
    let pacotes = 0;
    let fechado = false;
    let ultimoResumo = Date.now();

    function garantirChaves() {
        const k = getCallKey ? getCallKey() : chaveAtual;
        if (k && !(Buffer.isBuffer(chaveAtual) && Buffer.isBuffer(k) && k.equals(chaveAtual))) {
            const nova = deriveE2eKeys(k, selfParticipantId);
            if (nova) { keys = nova; chaveAtual = k; say('chave atualizada (epoch nova).'); }
        }
    }

    function enviarPacote(payload, marker) {
        const header = encodeRtpHeader({ marker, payloadType: RTP_PAYLOAD_TYPE_VIDEO, sequenceNumber: seq, timestamp, ssrc, extensionWord: null });
        const cifrado = cryptPayload(keys, ssrc, seq, roc, payload);
        const semTag = Buffer.concat([header, cifrado]);
        const tag = computeWarpMiTag(keys.authKey, semTag, roc, WARP_MI_TAG_LEN);
        dc.sendMessageBinary(Buffer.concat([semTag, tag]));
        seq = (seq + 1) & 0xffff;
        if (seq === 0) roc++;
        pacotes++;
    }

    function enviarQuadro(nals) {
        if (fechado || !dc.isOpen()) return;
        try {
            garantirChaves();
            const payloads = empacotarQuadro(nals);
            payloads.forEach((p, i) => enviarPacote(p, i === payloads.length - 1));
            timestamp = (timestamp + Math.round(CLOCK_RATE / fpsAtual)) >>> 0;
            quadros++;
            if (Date.now() - ultimoResumo > 5000) {
                say(`${quadros} quadro(s), ${pacotes} pacote(s) enviados até agora.`);
                ultimoResumo = Date.now();
            }
        } catch (e) {
            say(`erro enviando quadro: ${e.message}`);
        }
    }

    function stop() {
        if (ffmpeg) {
            try { ffmpeg.kill('SIGKILL'); } catch (_) {}
            ffmpeg = null;
            say(`vídeo parado (${quadros} quadro(s), ${pacotes} pacote(s)).`);
        }
    }

    function start(fonte, opcoes = {}) {
        if (fechado) throw new Error('sessão fechada');
        stop();
        fpsAtual = opcoes.fps || FPS_PADRAO;
        quadros = 0; pacotes = 0;
        const args = ffmpegArgs(fonte, { fps: fpsAtual, ...opcoes });
        say(`iniciando ffmpeg (${fonte || 'teste'}).`);
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        ffmpeg = proc;

        const splitter = new NalSplitter();
        let atual = [];
        const tratarNal = (nal) => {
            if (!nal || nal.length === 0) return;
            const t = nal[0] & 0x1f;
            if (t === 9) { // AUD: começa um quadro novo, o anterior está completo
                if (atual.length) enviarQuadro(atual);
                atual = [];
            } else {
                atual.push(nal);
            }
        };
        proc.stdout.on('data', (chunk) => { for (const n of splitter.push(chunk)) tratarNal(n); });
        proc.stderr.on('data', (d) => say(`ffmpeg: ${String(d).trim().slice(0, 300)}`));
        proc.on('error', (e) => {
            say(e.code === 'ENOENT' ? 'ffmpeg não encontrado no PATH (instale e abra um PowerShell novo).' : `erro no ffmpeg: ${e.message}`);
            if (ffmpeg === proc) ffmpeg = null;
        });
        proc.on('close', (code) => {
            tratarNal(splitter.flush());
            if (atual.length) enviarQuadro(atual);
            atual = [];
            say(`ffmpeg terminou (código ${code}).`);
            if (ffmpeg === proc) ffmpeg = null;
        });
    }

    function close() {
        fechado = true;
        stop();
    }

    say(`sessão de vídeo pronta (ssrc=${ssrc}, pt=${RTP_PAYLOAD_TYPE_VIDEO}). Use start(fonte) pra enviar.`);
    return { start, stop, close, ativo: () => !!ffmpeg, extrairAudioPcm };
}
