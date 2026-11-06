'use strict';

// Chamadas de voz nativas do socket: estado em sock.calls, métodos diretos
// (sock.startCall/sock.startGroupCall/sock.joinCallLink/sock.endCall/
// sock.playCallAudio), reconexão automática sempre ligada.

import { startOutgoingCall, terminateCall } from './voip.js';
import { startOutgoingGroupCall } from './voipGroup.js';
import { joinCallLink } from './voipCallLink.js';
import { setupCallOrchestration } from './orchestrate.js';
import { makeCallLog } from './log.js';

/** Liga o sistema de chamadas num socket. Devolve uma função pra desligar tudo. */
export function setupVoip(sock) {
    sock.calls = sock.calls || {};
    const log = makeCallLog(sock);
    const stopOrchestration = setupCallOrchestration(sock);

    sock.startCall = (targetJid, originChatId) => startOutgoingCall(sock, targetJid, originChatId);
    sock.startGroupCall = (groupJid, originChatId) => startOutgoingGroupCall(sock, groupJid, originChatId);
    sock.joinCallLink = (tokenOrUrl, originChatId) => joinCallLink(sock, tokenOrUrl, originChatId);

    sock.endCall = async (callId) => {
        const entry = sock.calls[callId];
        if (!entry) return false;
        const to = entry.isGroup ? `${callId}@call` : entry.peer;
        await terminateCall(sock, callId, entry.callCreator, to).catch((e) => log(`[CALL] erro terminando ${callId}:`, e.message));
        if (entry.pc) { try { entry.pc.close(); } catch (_) {} }
        delete sock.calls[callId];
        return true;
    };

    sock.playCallAudio = (callId, pcmBuffer) => {
        const entry = sock.calls[callId];
        if (!entry || !entry.audio) return false;
        entry.audio.playPcm(pcmBuffer);
        return true;
    };

    sock.stopCallAudio = (callId) => {
        const entry = sock.calls[callId];
        if (!entry || !entry.audio) return false;
        entry.audio.stopTrack();
        return true;
    };

    /**
     * Toca mídia completa (áudio + vídeo sincronizados) em uma chamada ativa.
     * Suporta arquivos locais (MP4, MKV, etc.) e URLs diretas (YouTube/stream).
     *
     * @param {string} callId
     * @param {string} fonte - Caminho do arquivo ou URL
     * @param {object} [opcoes] - { preset: '360p'|'480p'|'720p', loop: false, audioOffsetMs: 350, onEnd: Function }
     */
    sock.playCallMedia = async (callId, fonte, opcoes = {}) => {
        const entry = sock.calls[callId];
        if (!entry || !entry.video) {
            log(`[CALL] playCallMedia falhou: chamada ${callId} não encontrada ou vídeo indisponível.`);
            return false;
        }

        const {
            audioOffsetMs = 350,
            onEnd,
            ...videoOpts
        } = opcoes;

        // 1. Extrair o áudio PCM (s16le 16kHz mono) da fonte
        let pcmAudio = null;
        try {
            pcmAudio = await entry.video.extrairAudioPcm(fonte);
        } catch (e) {
            log(`[CALL] playCallMedia: erro extraindo áudio de ${fonte}: ${e.message}`);
        }

        // 2. Parar qualquer mídia anterior
        if (entry.audio) entry.audio.stopTrack();
        entry.video.stop();

        // 3. Callback de término unificado
        let audioTimer = null;
        const cleanupMedia = (code) => {
            if (audioTimer) clearTimeout(audioTimer);
            if (entry.audio) entry.audio.stopTrack();
            if (typeof onEnd === 'function') {
                try { onEnd(code); } catch (_) {}
            }
        };

        // 4. Iniciar vídeo
        entry.video.start(fonte, {
            ...videoOpts,
            onEnd: cleanupMedia
        });

        // 5. Iniciar áudio sincronizado com compensação de latência do ffmpeg
        if (pcmAudio && entry.audio) {
            audioTimer = setTimeout(() => {
                if (sock.calls[callId] && entry.video.ativo()) {
                    entry.audio.playPcm(pcmAudio);
                }
            }, Math.max(0, audioOffsetMs));
        }

        return true;
    };

    /**
     * Interrompe tanto a transmissão de vídeo quanto o áudio de uma chamada.
     */
    sock.stopCallMedia = (callId) => {
        const entry = sock.calls[callId];
        if (!entry) return false;
        if (entry.audio) entry.audio.stopTrack();
        if (entry.video) entry.video.stop();
        return true;
    };

    return () => {
        stopOrchestration();
        for (const callId of Object.keys(sock.calls)) {
            const entry = sock.calls[callId];
            if (entry && entry.pc) { try { entry.pc.close(); } catch (_) {} }
        }
    };
}
