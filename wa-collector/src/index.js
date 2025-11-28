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

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// =========================
// Helpers de env
// =========================

function parseBoolEnv(value, defaultValue = false) {
  if (!value) return defaultValue;
  // corta qualquer comentário inline depois de '#'
  const clean = String(value).split('#')[0].trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on'].includes(clean);
}

// AGORA: por padrão manda TODAS as mensagens de grupo
const FORWARD_ALL = parseBoolEnv(process.env.FORWARD_ALL, true);

if (!WEBHOOK_URL) {
  logger.warn('WEBHOOK_URL não definido no .env — nada será enviado ao backend!');
}

// Estado global da instância
let sock = null;
let connState = 'connecting';
let latestQR = null;
let myJid = null;      // ex: 551199999999@s.whatsapp.net
let myDigits = null;   // ex: 551199999999

// =========================
// Helpers
// =========================

function digits(str = '') {
  return (str || '').replace(/\D/g, '');
}

// Desempacota mensagens efêmeras / viewOnce
function unwrapMessageContent(message) {
  if (!message) return message;
  if (message.ephemeralMessage?.message) {
    return message.ephemeralMessage.message;
  }
  if (message.viewOnceMessage?.message) {
    return message.viewOnceMessage.message;
  }
  return message;
}

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

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      logger.warn(
        { status: res.status, body: text.slice(0, 200) },
        'Erro ao enviar webhook'
      );
    } else {
      logger.info({ status: res.status }, 'Webhook enviado com sucesso');
    }
  } catch (err) {
    logger.error({ err }, 'Falha na chamada do webhook');
  }
}

// =========================
// Baileys
// =========================

async function createSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Usando versão do WhatsApp / Baileys');

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: ['BMP SLA Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      logger.info('Novo QRCode gerado');
    }

    if (connection) {
      connState = connection;
      logger.info({ connection }, 'Estado da conexão atualizado');

      if (connection === 'open') {
        latestQR = null;
        if (sock.user?.id) {
          myJid = jidNormalizedUser(sock.user.id);
          myDigits = digits(myJid);
          logger.info({ myJid, myDigits }, 'Conectado como');
        }
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.data?.attrs?.code;
        logger.warn({ code }, 'Conexão fechada');

        const loggedOut =
          code === DisconnectReason.loggedOut || code === 401;
        if (loggedOut) {
          logger.error(
            'Sessão foi deslogada, é preciso apagar auth/ e escanear novamente.'
          );
          return;
        }

        logger.info('Tentando reconectar...');
        setTimeout(() => {
          createSock().catch((err) =>
            logger.error({ err }, 'Erro ao reconectar')
          );
        }, 3000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Só queremos novas notificações, não histórico/replace
    if (type !== 'notify') {
      logger.debug({ type }, 'Ignorando messages.upsert que não é notify');
      return;
    }

    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;

        // Log bruto pra debug
        logger.debug(
          {
            jid,
            fromMe: msg.key.fromMe,
            id: msg.key.id,
            participant: msg.key.participant,
          },
          'Mensagem recebida em messages.upsert'
        );

        // Apenas grupos
        if (!jid?.endsWith('@g.us')) {
          logger.debug({ jid }, 'Ignorando mensagem que não é de grupo');
          continue;
        }

        const messageId = msg.key.id;
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const fromDigits = digits(senderJid || '');

        // Desempacota conteúdo (ephemeral, viewOnce, etc)
        const unwrapped = unwrapMessageContent(msg.message);
        let text = extractText(unwrapped) || '';

        const contextInfo = getContextInfo(unwrapped);
        const mentionedJids = contextInfo?.mentionedJid || [];

        // Quem está logado
        const myJidForCompare =
          myJid || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);

        // Detecta se a instância foi mencionada no WhatsApp
        const mentioned =
          !!myJidForCompare &&
          Array.isArray(mentionedJids) &&
          mentionedJids.map(jidNormalizedUser).includes(myJidForCompare);

        // Regra final:
        // - se FORWARD_ALL=true -> manda tudo
        // - senão -> só se foi realmente mencionado
        const shouldForward = FORWARD_ALL || mentioned;

        if (!shouldForward) {
          logger.debug(
            { messageId, jid, fromDigits, mentioned },
            'Mensagem ignorada (sem mention e FORWARD_ALL=false)'
          );
          continue;
        }

        // Tenta buscar o nome do grupo
        let groupName = jid;
        try {
          const meta = await sock.groupMetadata(jid);
          groupName = meta?.subject || jid;
        } catch {
          // ignore
        }

        const payload = {
          // Campos esperados pelo seu backend /api/webhooks/zapi
          messageId,
          groupId: jid,
          groupName,
          fromName: msg.pushName || fromDigits || 'Cliente',
          sender: fromDigits || null,
          text,
          tags: [],

          // Extras úteis
          mentioned,
          ts: Date.now(),
        };

        logger.info(
          {
            messageId,
            groupId: jid,
            from: fromDigits,
            mentioned,
            textPreview: text.slice(0, 80),
          },
          'Enviando webhook de mensagem'
        );

        await sendWebhook(payload);
      } catch (err) {
        logger.error({ err }, 'Erro ao processar mensagem');
      }
    }
  });
}

// =========================
// HTTP server (QR + status)
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
      border-radius: 16px;
      padding: 20px 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      max-width: 380px;
      width: 100%;
      text-align: center;
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .subtitle {
      font-size: 12px;
      color: #9ca3af;
      margin-bottom: 14px;
    }
    .status {
      font-size: 12px;
      margin-bottom: 16px;
    }
    .status span {
      font-weight: 600;
    }
    .qr-box {
      background: #020617;
      border-radius: 12px;
      padding: 12px;
      border: 1px solid #1f2937;
      margin-bottom: 12px;
    }
    .qr-box img {
      display: block;
      margin: 0 auto;
    }
    .hint {
      font-size: 11px;
      color: #9ca3af;
    }
    .btn {
      margin-top: 12px;
      padding: 8px 14px;
      border-radius: 999px;
      border: 1px solid #4b5563;
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
    <div class="title">WA Bot – BMP</div>
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
      try {
        const s = await fetchJSON('/instance/status');
        const el = document.getElementById('status');
        el.innerHTML = 'Conexão: <span>' + s.connection + '</span>' +
          (s.myPhone ? ' · Número: <span>' + s.myPhone + '</span>' : '');
        if (s.connection === 'open') {
          document.getElementById('qr-box').style.display = 'none';
        } else {
          loadQR();
        }
      } catch (e) {
        document.getElementById('status').textContent = 'Erro ao carregar status';
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

    function reloadQR() {
      loadQR();
      loadStatus();
    }

    loadStatus();
    setInterval(loadStatus, 5000);
  </script>
</body>
</html>
`;

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

      // Rota da imagem PNG do QR
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

      // Rota JSON simples com a string do QR
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ qr: latestQR }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
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
