import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import http from 'http';
import QRCode from 'qrcode';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || './auth';

// Se não tiver WEBHOOK_URL no ambiente, usa direto o endpoint que você passou
const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  'https://wpp-bmp-1.onrender.com/api/webhooks/zapi';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// =========================
// Helpers de env
// =========================

function parseBoolEnv(value, defaultValue = false) {
  if (!value) return defaultValue;
  const clean = String(value).split('#')[0].trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on'].includes(clean);
}

// FORWARD_ALL=false -> só manda quando tiver mention
// FORWARD_ALL=true  -> manda TUDO (debug)
const FORWARD_ALL = parseBoolEnv(process.env.FORWARD_ALL, false);

// =========================
// Estado global
// =========================

let sock = null;
let connState = 'close';
let latestQR = null;
let myJid = null; // ex: 551199999999@s.whatsapp.net
let myDigits = null; // ex: 551199999999

// =========================
// Helpers
// =========================

function digits(str = '') {
  return (str || '').replace(/\D/g, '');
}

// AJUSTE: helper para “normalizar” qualquer JID para apenas os dígitos
function normalizeJidToDigits(jid = '') {
  // tira parte de device (:X) e domínio (@s.whatsapp.net)
  const base = String(jid).split(':')[0].split('@')[0];
  return digits(base);
}

// Desempacota mensagens efêmeras / viewOnce
function unwrapMessageContent(message) {
  if (!message) return message;

  if (message?.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }

  if (message?.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }

  if (message?.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }

  if (message?.documentMessage && message.documentMessage.caption) {
    return message;
  }
  if (message?.imageMessage && message.imageMessage.caption) {
    return message;
  }
  if (message?.videoMessage && message.videoMessage.caption) {
    return message;
  }

  return message;
}

// Extrai texto de diferentes tipos de mensagem
function extractText(msg) {
  if (!msg) return '';
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  if (msg.documentMessage?.caption) return msg.documentMessage.caption;
  return '';
}

function getContextInfo(msg) {
  if (!msg) return null;
  return (
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
    null
  );
}

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WEBHOOK_SECRET ? { 'X-Webhook-Secret': WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
    });

    logger.info({ status: res.status }, 'Webhook enviado com sucesso');
  } catch (err) {
    logger.error({ err }, 'Erro ao enviar webhook');
  }
}

// =========================
// HTML da página de QRCode
// =========================

const INDEX_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>WA Bot – BMP</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e5e7eb;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: #020617;
      border-radius: 18px;
      padding: 24px 24px 20px;
      border: 1px solid #1f2937;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.75);
      max-width: 420px;
      width: 100%;
      box-sizing: border-box;
      text-align: center;
    }
    .title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .title span.badge {
      font-size: 10px;
      font-weight: 600;
      color: #22c55e;
      border: 1px solid rgba(34,197,94,0.5);
      border-radius: 999px;
      padding: 2px 7px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      background: rgba(22,163,74,0.12);
    }
    .subtitle {
      font-size: 13px;
      color: #9ca3af;
      margin-bottom: 14px;
    }
    .status {
      font-size: 12px;
      padding: 6px 10px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(15,23,42,0.8);
      border: 1px solid #111827;
      margin-bottom: 14px;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #f97316;
      box-shadow: 0 0 0 4px rgba(248, 113, 113, 0.15);
    }
    .dot.connected {
      background: #22c55e;
      box-shadow: 0 0 0 4px rgba(34,197,94,0.2);
    }
    .dot.disconnected {
      background: #ef4444;
      box-shadow: 0 0 0 4px rgba(239,68,68,0.2);
    }
    .status span {
      font-size: 12px;
    }
    .qr-box {
      margin-top: 10px;
      margin-bottom: 10px;
      border-radius: 16px;
      padding: 10px;
      background: radial-gradient(circle at top, #0b1120 0, #020617 55%);
      border: 1px solid #1f2937;
    }
    .qr-box img {
      border-radius: 12px;
      background: white;
      padding: 8px;
    }
    .hint {
      font-size: 11px;
      color: #9ca3af;
      margin-bottom: 16px;
    }
    .btn {
      all: unset;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 13px;
      border-radius: 999px;
      border: 1px solid #374151;
      background: transparent;
      color: #e5e7eb;
      cursor: pointer;
      font-size: 12px;
    }
    .btn:hover {
      background: #111827;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">WA Bot – BMP <span class="badge">GRUPOS</span></div>
    <div class="subtitle">Conecte o número do WhatsApp para capturar menções em grupos.</div>
    <div id="status" class="status">Carregando status...</div>
    <div id="qr-box" class="qr-box" style="display:none;">
      <img id="qr-img" alt="QRCode WhatsApp" width="260" height="260" />
    </div>
    <div class="hint">
      Abra o WhatsApp &gt; Menu &gt; Dispositivos conectados &gt; Conectar aparelho.
    </div>
    <button class="btn" onclick="reloadQR()">Atualizar QR</button>
  </div>
  <script>
    async function fetchJSON(url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      return r.json();
    }

    async function loadStatus() {
      const el = document.getElementById('status');
      try {
        const status = await fetchJSON('/instance/status');
        const dotClass =
          status.connection === 'open' ? 'dot connected' :
          status.connection === 'connecting' ? 'dot' :
          'dot disconnected';

        const label =
          status.connection === 'open'
            ? 'Conectado em ' + (status.myPhone || status.myJid || 'desconhecido')
            : status.connection === 'connecting'
            ? 'Conectando ao WhatsApp...'
            : 'Desconectado';

        el.innerHTML = '<span class="' + dotClass + '"></span><span>' + label + '</span>';
      } catch (e) {
        el.innerHTML = '<span class="dot disconnected"></span><span>Erro ao carregar status</span>';
      }
    }

    async function loadQR() {
      try {
        const q = await fetchJSON('/instance/qr');
        if (q && q.qr) {
          const img = document.getElementById('qr-img');
          img.src = '/instance/qr.png?ts=' + Date.now();
          document.getElementById('qr-box').style.display = 'block';
        } else {
          document.getElementById('qr-box').style.display = 'none';
        }
      } catch (e) {
        document.getElementById('qr-box').style.display = 'none';
      }
    }

    async function reloadQR() {
      await loadStatus();
      await loadQR();
    }

    reloadQR();
    setInterval(() => {
      loadStatus();
    }, 5000);
  </script>
</body>
</html>
`;

// =========================
// Socket / Baileys
// =========================

async function createSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Usando versão do WhatsApp / Baileys');

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // vamos desenhar nós mesmos no terminal
    auth: state,
    browser: ['BMP SLA Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      logger.info('Novo QRCode gerado (backend)');

      // Também mostra o QRCode no terminal (logs do Render)
      try {
        const qrStr = await QRCode.toString(qr, {
          type: 'terminal',
          small: true,
        });
        // console.log puro porque o ASCII é grande
        console.log(qrStr);
      } catch (err) {
        logger.error({ err }, 'Erro ao gerar QRCode em modo terminal');
      }
    }

    if (connection) {
      connState = connection;
      logger.info({ connection }, 'Estado da conexão atualizado');

      if (connection === 'open') {
        latestQR = null;
        if (sock.user?.id) {
          myJid = jidNormalizedUser(sock.user.id);
          myDigits = normalizeJidToDigits(myJid); // AJUSTE
          logger.info({ myJid, myDigits }, 'Instância conectada como');
        }
      }
    }

    if (lastDisconnect?.error) {
      const shouldReconnect =
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      logger.warn(
        { shouldReconnect, error: lastDisconnect.error },
        'Conexão fechada'
      );

      if (!shouldReconnect) {
        logger.error(
          'Sessão foi deslogada, é preciso apagar o diretório de auth e escanear novamente.'
        );
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const { messages, type } = m;
    if (!messages?.length) return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;

      // Ignora mensagens enviadas pela própria instância
      if (msg.key.fromMe) {
        logger.debug(
          { jid },
          'Ignorando mensagem enviada pela própria instância'
        );
        continue;
      }

      logger.debug(
        {
          jid,
          fromMe: msg.key.fromMe,
          id: msg.key.id,
          participant: msg.key.participant,
        },
        'Mensagem recebida em messages.upsert (handler filtrado)'
      );

      // Apenas grupos
      if (!jid?.endsWith('@g.us')) {
        logger.debug({ jid }, 'Ignorando mensagem que não é de grupo');
        continue;
      }

      const messageId = msg.key.id;
      const senderJid = msg.key.participant || msg.key.remoteJid;
      const fromDigits = normalizeJidToDigits(senderJid || '');

      // Desempacotar mensagem & extrair texto
      const rawMessage = unwrapMessageContent(msg.message);
      const text = extractText(rawMessage).trim();

      // Pega context-info para descobrir se é reply
      const contextInfo = getContextInfo(rawMessage);
      const hasQuoted = !!contextInfo?.stanzaId;

      // Detectar menção por texto (@) e por contextInfo.mentionedJid
      const mentionedJids = contextInfo?.mentionedJid || [];
      const mentionedByContext =
        Array.isArray(mentionedJids) &&
        myJid &&
        mentionedJids.includes(myJid);

      const mentionedByText =
        !!myDigits && !!text && text.replace(/\D/g, '').includes(myDigits);

      const mentioned = mentionedByContext || mentionedByText;

      logger.info(
        {
          messageId,
          groupId: jid,
          from: fromDigits,
          mentioned,
          mentionedByContext,
          mentionedByText,
          hasQuoted,
          textPreview: text.slice(0, 80),
        },
        'Debug detecção de menção'
      );

      // Regra de envio:
      // - Se FORWARD_ALL = true => manda tudo
      // - Se FORWARD_ALL = false => só manda se mentioned = true
      if (!FORWARD_ALL && !mentioned) {
        logger.info(
          { messageId, groupId: jid },
          'Mensagem ignorada pois não menciona a instância'
        );
        continue;
      }

      const payload = {
        messageId,
        groupId: jid,
        from: fromDigits,
        mentioned,
        mentionedByContext,
        mentionedByText,
        hasQuoted,
        text,
        timestamp: msg.messageTimestamp,
        type,
      };

      logger.info(payload, 'Enviando webhook de mensagem');
      await sendWebhook(payload);
    }
  });

  return sock;
}

// =========================
// HTTP Server
// =========================

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (req.url === '/instance/status' && req.method === 'GET') {
      const status = {
        connection: connState,
        hasQR: !!latestQR,
        myJid,
        myPhone: myDigits,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (req.url?.startsWith('/instance/qr') && req.method === 'GET') {
      if (!latestQR) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ qr: null }));
        return;
      }

      if (req.url.startsWith('/instance/qr.png')) {
        try {
          const pngBuffer = await QRCode.toBuffer(latestQR, {
            type: 'png',
            margin: 1,
            width: 260,
          });

          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': pngBuffer.length,
          });
          res.end(pngBuffer);
        } catch (err) {
          logger.error({ err }, 'Erro ao gerar PNG do QR');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          }
          if (!res.writableEnded) {
            res.end('Erro ao gerar QRCode');
          }
        }
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ qr: latestQR ? true : null }));
      return;
    }

    // healthcheck simples
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          conn: connState,
          hasQR: !!latestQR,
        })
      );
      return;
    }

    // rota padrão
    if (!res.writableEnded) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  } catch (err) {
    logger.error({ err }, 'Erro no HTTP server');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'WA Bot HTTP server iniciado');
  createSock().catch((err) =>
    logger.error({ err }, 'Erro ao iniciar Baileys')
  );
});
