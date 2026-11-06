# AGENTS.md — Guia de Implementação para Agentes de IA

Este documento foi projetado especificamente para agentes de codificação de IA (**Google Antigravity**, **Claude Code**, **Cursor**, **Windsurf**, **GitHub Copilot**, etc.) e desenvolvedores que utilizam assistentes de IA para construir ou integrar bots de WhatsApp com o **`supernova-baileys`**.

---

## 1. Visão Geral do Pacote

O **`supernova-baileys`** é um fork avançado, moderno e auditado da biblioteca Baileys (WhatsApp Web API).

- **Nome no NPM:** `supernova-baileys`
- **Repositório GitHub:** `https://github.com/Dcsc2011/Supernova-Baileys`
- **Requisitos de runtime:** Node.js `>= 20.0.0` e `ffmpeg` instalado no sistema (com suporte a `libx264` e `libopus`).
- **Diferenciais exclusivos:**
  1. **Chamadas de voz e VÍDEO nativas (H.264):** Envio de vídeo em tempo real (teste, imagem ou arquivo MP4) empacotado em RTP/RFC 6184 e cifrado com SRTP ponta a ponta.
  2. **MessageBuilder nativo:** Criação facilitada de Botões, Botões V2, Listas, Carrosséis e Respostas Ricas (AI Rich).
  3. **Sistema avançado de LID/JID:** Cache bidirecional e resolução automática de telefones para LIDs (evita rejeições em chamadas e canais).
  4. **Código 100% limpo e auditado:** Sem backdoors, telemetrias ou conexões externas desconhecidas.

---

## 2. Instalação e Configuração

### 2.1. Instalação no projeto do usuário

```bash
npm i supernova-baileys
```

*(Se o usuário preferir usar o alias `@supernova/baileys` no código):*
```bash
npm i @supernova/baileys@npm:supernova-baileys
```

### 2.2. Dependências opcionais
- `sharp` (para criação de sticker pack a partir de imagens que não sejam WebP).
- `fluent-ffmpeg` (se for usar manipulações avançadas no `lib/MB.cjs`).
- `opusscript` (para decodificação/tocar áudio em chamadas VoIP).

---

## 3. Padrões de Importação

### ES Modules (Recomendado)
```javascript
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason 
} from 'supernova-baileys'
```

### CommonJS
```javascript
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason 
} = require('supernova-baileys')
```

---

## 4. Inicialização Padrão do Bot

Instrução para a IA: Sempre utilize `useMultiFileAuthState` para persistir a sessão de forma segura.

```javascript
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'supernova-baileys'
import pino from 'pino'

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session')

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        // Configurações recomendadas:
        browser: ['Supernova', 'Chrome', '1.2.0'],
        syncFullHistory: false
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('Conexão encerrada. Reconectar:', shouldReconnect)
            if (shouldReconnect) startBot()
        } else if (connection === 'open') {
            console.log('Bot conectado com sucesso!')
        }
    })

    return sock
}
```

---

## 5. Chamadas de Voz e Chamadas de Vídeo (VoIP)

Esta é a principal novidade e funcionalidade do `supernova-baileys`.

### 5.1. Regras Críticas que toda IA deve seguir:
1. **LID Obrigatório para Iniciar Chamada 1:1:** O servidor do WhatsApp rejeita com erro `439` chamadas iniciadas diretamente para números de telefone `@s.whatsapp.net`. **Sempre resolva para `@lid` antes de chamar `sock.startCall(lid)`**.
   - Para resolver: utilize `await sock.onWhatsApp(numero)` e use a propriedade `.lid`, ou `sock.signalRepository.lidMapping.getLIDForPN(jid)`.
2. **Disponibilidade do objeto `video`:** O objeto `sock.calls[callId].video` só fica disponível **após a chamada ser atendida/conectada**. Antes disso, ele é `undefined`. Sempre cheque se `sock.calls[callId]?.video` existe antes de chamar `.start()`.
3. **Formato do Áudio na Chamada:** O áudio deve ser estritamente **PCM s16le, mono (1 canal), 16000Hz**. Use `call.video.extrairAudioPcm(caminho)` para extrair do próprio vídeo ou use o ffmpeg.

### 5.2. Iniciar Chamada 1:1 com Transmissão de Vídeo

```javascript
// 1. Iniciar chamada (usando LID resolvido)
const targetLid = "12345678901234@lid"
const { callId } = await sock.startCall(targetLid)

// 2. Aguardar a chamada conectar
sock.ev.on('call', async (calls) => {
    for (const call of calls) {
        if (call.id === callId && call.status === 'accept') {
            console.log('Chamada atendida! Iniciando vídeo...')

            const activeCall = sock.calls[callId]
            if (activeCall?.video) {
                // Opção A: Enviar vídeo com áudio sincronizado
                const videoPath = './midia/video.mp4'
                const pcmAudio = await activeCall.video.extrairAudioPcm(videoPath)

                activeCall.video.start(videoPath, {
                    fps: 15,
                    kbps: 100,
                    largura: 320,
                    altura: 240,
                    loop: false
                })

                if (pcmAudio) {
                    setTimeout(() => {
                        sock.playCallAudio(callId, pcmAudio)
                    }, 400) // 400ms de atraso casa perfeitamente o áudio com o vídeo
                }

                // Opção B: Enviar imagem estática
                // activeCall.video.start('./banner.png', { loop: true })

                // Opção C: Enviar padrão de teste do ffmpeg
                // activeCall.video.start('teste')
            }
        }
    }
})
```

### 5.3. Atender Chamadas Recebidas e Transmitir Vídeo

```javascript
sock.ev.on('call', async (calls) => {
    for (const call of calls) {
        if (call.status === 'offer') {
            // Rejeitar se necessário:
            // await sock.rejectCall(call.id, call.from)

            console.log(`Recebendo chamada de: ${call.from}`)
        }
    }
})
```

### 5.4. Métodos Disponíveis em `call.video`
- `call.video.start(fonte, options)`: Inicia a transmissão de vídeo H.264.
  - `fonte`: `'teste'`, caminho de arquivo de imagem (`.png`, `.jpg`, etc.) ou arquivo de vídeo (`.mp4`, `.mkv`, etc.).
  - `options`: `{ fps: 10, kbps: 80, largura: 320, altura: 240, loop: true }`.
- `call.video.stop()`: Interrompe o envio de pacotes de vídeo sem derrubar a chamada.
- `call.video.ativo()`: Retorna `boolean` indicando se há transmissão ativa no momento.
- `call.video.extrairAudioPcm(fonte)`: Extrai áudio da fonte em formato PCM 16kHz compatível com `sock.playCallAudio`.

### 5.5. Encerrar Chamada
```javascript
await sock.endCall(callId)
```

---

## 6. MessageBuilder: Botões, Carrosséis e Listas

Para enviar botões interativos e mensagens ricas em qualquer versão do WhatsApp:

```javascript
// Importar o MessageBuilder
const { Button, ButtonV2, Carousel, AIRich } = require('supernova-baileys/lib/MB.cjs')

// 1. Mensagem com Botões de Resposta Rápida (Quick Reply)
const btn = new Button()
btn.setText('Escolha uma das opções abaixo:')
btn.setFooter('Supernova Bot')
btn.addReply('Opção 1', 'id_opcao_1')
btn.addReply('Opção 2', 'id_opcao_2')
btn.addUrl('Visitar Site', 'https://github.com/Dcsc2011/Supernova-Baileys')
await sock.sendMessage(jid, btn.build(), { quoted: msg })

// 2. Carrossel de Cards Interativos
const carousel = new Carousel()
carousel.setText('Confira nossos produtos:')
carousel.addCard({
    title: 'Produto 1',
    description: 'Descrição do primeiro produto',
    image: './produto1.jpg',
    buttons: [
        { type: 'reply', text: 'Comprar', id: 'buy_1' },
        { type: 'url', text: 'Ver Detalhes', url: 'https://exemplo.com/1' }
    ]
})
await sock.sendMessage(jid, carousel.build(), { quoted: msg })
```

---

## 7. Melhores Práticas e Solução de Problemas para IAs

1. **Erro de áudio mudo na chamada:** Verifique se o `opusscript` está instalado e se o áudio foi convertido para `16000Hz` mono.
2. **Chamada caindo após alguns segundos:** Mantenha o silêncio da chamada fluindo. A biblioteca já cuida disso automaticamente, mas não bloqueie a event loop do Node com processos síncronos pesados.
3. **Resolução de JID vs LID:**
   - Para envio de mensagens normais de chat: utilize JID (`5511999999999@s.whatsapp.net`).
   - Para chamadas VoIP 1:1: utilize sempre LID (`12345678901234@lid`).
4. **Armazenamento de Sessão:** Nunca versione a pasta de autenticação (`auth_session` ou `.auth`) no Git. O `.gitignore` do repositório já protege essas pastas.

---

Este arquivo serve como contexto de primeira ordem para qualquer tarefa de implementação em bots WhatsApp.
