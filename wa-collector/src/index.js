import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import http from 'http';
import { promises as fs } from 'fs';
import QRCode from 'qrcode';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// =====================
// Config (.env)
// =====================
const TAG = process.env.TAG_REGEX ? new RegExp(process.env.TAG_REGEX, 'i') : null;
const MY_PHONE = process.env.MY_PHONE || null;
const MY_LID_BASE = process.env.MY_LID_BASE || null;

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const FORWARD_ALL =
  String(process.env.FORWARD_ALL || 'false').toLowerCase() === 'true';

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// =====================
// Estado em memória
// =====================
let latestQR = null;   // texto do QR mais recente
let connState = 'close';
let MY_JID = null;     // jid da instância conectada
let sock = null;       // socket Baileys

// =====================
// Helpers HTTP
// =====================
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// HTML embutido para o painel de QR
const EMBEDDED_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <title>WhatsApp Bot – QRCode</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e5e7eb;
      margin: 0;
      padding: 0;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: 100vh;
    }
    .container {
      margin-top: 40px;
      background: #020617;
      border-radius: 16px;
      padding: 20px 24px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 25px 50px -12px rgba(15,23,42,0.7);
      border: 1px solid #1e293b;
    }
    h1 {
      font-size: 1.1rem;
      margin: 0 0 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h1 span.icon {
      font-size: 1.4rem;
    }
    p.desc {
      font-size: 0.8rem;
      margin: 0 0 12px;
      color: #9ca3af;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.7rem;
      gap: 4px;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #22c55e;
    }
    .badge-dot.warn {
      background: #f97316;
    }
    .badge-dot.err {
      background: #ef4444;
    }
    .section {
      margin-top: 16px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #020617;
      border: 1px solid #1e293b;
    }
    .section-title {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #6b7280;
      margin-bottom: 8px;
    }
    .qr-wrapper {
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 12px 0;
      min-height: 240px;
    }
    .qr-wrapper img {
      border-radius: 12px;
      border: 1px solid #1f2937;
      background: #fff;
    }
    .hint {
      font-size: 0.8rem;
      color: #9ca3af;
      text-align: center;
      margin-top: 4px;
    }
    .small {
      font-size: 0.7rem;
      color: #6b7280;
      margin-top: 6px;
      text-align: center;
    }
    .status-row {
      font-size: 0.8rem;
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 4px;
    }
    .status-key {
      color: #9ca3af;
    }
    .status-val {
      font-weight: 500;
    }
    button {
      border-radius: 999px;
      border: 1px solid #4b5563;
      background: #020617;
      color: #e5e7eb;
      padding: 6px 12px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    button:hover {
      background: #111827;
    }
    .btn-row {
      margin-top: 10px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1><span class="icon">💬</span> WhatsApp Bot – Conexão</h1>
    <p class="desc">
      Escaneie o QRCode abaixo com o WhatsApp para conectar este bot à sua conta.
    </p>

    <div class="section" id="status-section">
      <div class="section-title">Status da instância</div>
      <div class="status-row">
        <div class="status-key">Conexão</div>
        <div class="status-val" id="conn-label">–</div>
      </div>
      <div class="status-row">
        <div class="status-key">Meu JID</div>
        <div class="status-val" id="jid-label">–</div>
      </div>
      <div class="status-row">
        <div class="status-key">Meu número (env)</div>
        <div class="status-val" id="phone-label">–</div>
      </div>
      <div class="btn-row">
        <button id="btn-refresh">Atualizar status</button>
        <button id="btn-reset" title="Apaga sessão e reinicia (necessário ADMIN_SECRET, se configurado)">
          Resetar sessão
        </button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">QRCode</div>
      <div class="qr-wrapper" id="qr-wrapper">
        <span style="font-size:0.85rem;color:#9ca3af;">Carregando QRCode...</span>
      </div>
      <p class="hint">
        No WhatsApp: <strong>Menu &gt; Dispositivos conectados &gt; Conectar dispositivo</strong>.
      </p>
      <p class="small">
        Se o QRCode não aparecer, clique em <strong>Resetar sessão</strong> e atualize esta página.
      </p>
    </div>
  </div>

  <script>
    async function getJSON(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function refreshStatus() {
      try {
        const data = await getJSON('/instance/status');
        const conn = data.connection || 'desconhecido';
        const badge = document.createElement('span');
        badge.className = 'badge';

        const dot = document.createElement('span');
        dot.className = 'badge-dot';
        if (conn === 'open') dot.classList.add('ok');
        if (conn === 'connecting') dot.classList.add('warn');
        if (conn === 'close') dot.classList.add('err');

        const label = document.createElement('span');
        label.textContent = conn;

        badge.appendChild(dot);
        badge.appendChild(label);

        const connLabel = document.getElementById('conn-label');
        connLabel.innerHTML = '';
        connLabel.appendChild(badge);

        document.getElementById('jid-label').textContent = data.myJid || '–';
        document.getElementById('phone-label').textContent = data.myPhone || '–';
      } catch (e) {
        document.getElementById('conn-label').textContent = 'Erro ao buscar status';
      }
    }

    async function refreshQR() {
      const wrapper = document.getElementById('qr-wrapper');
      wrapper.innerHTML = '<span style="font-size:0.85rem;color:#9ca3af;">Carregando QRCode...</span>';
      try {
        const data = await getJSON('/instance/qr');
        if (!data.qr) {
          wrapper.innerHTML = '<span style="font-size:0.85rem;color:#f97316;">Nenhum QRCode disponível. Aguarde alguns segundos ou resete a sessão.</span>';
          return;
        }
        const img = document.createElement('img');
        img.src = '/instance/qr.png';
        img.alt = 'QRCode WhatsApp';
        img.width = 256;
        img.height = 256;
        wrapper.innerHTML = '';
        wrapper.appendChild(img);
      } catch (e) {
        wrapper.innerHTML = '<span style="font-size:0.85rem;color:#ef4444;">Erro ao carregar QRCode.</span>';
      }
    }

    async function resetSession() {
      const adminSecret = prompt('Se houver ADMIN_SECRET configurado, digite aqui (ou deixe vazio):', '');
      const headers = {};
      if (adminSecret) headers['x-admin-secret'] = adminSecret;
      try {
        await fetch('/instance/reset', {
          method: 'POST',
          headers
        });
        alert('Sessão será resetada. O processo pode reiniciar, recarregue a página depois de alguns segundos.');
      } catch (e) {
        alert('Erro ao resetar sessão: ' + e.message);
      }
    }

    document.getElementById('btn-refresh').addEventListener('click', () => {
      refreshStatus();
      refreshQR();
    });

    document.getElementById('btn-reset').addEventListener('click', () => {
      resetSession();
    });

    // auto refresh ao abrir
    refreshStatus();
    refreshQR();
    setInterval(refreshStatus, 10000);
    setInterval(refreshQR, 15000);
  </script>
</body>
</html>`;

// =====================
// Helpers WhatsApp
// =====================

function extractText(msg) {
  const m = msg.message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return '';
}

function jidToPhone(jid) {
  if (!jid) return null;
  return String(jid).replace(/[:@].*$/, '');
}

function shouldForwardMessage({ text, fromJid }) {
  if (!text) return false;

  if (FORWARD_ALL) return true;
  if (TAG && TAG.test(text)) return true;

  if (MY_LID_BASE && text.includes('@' + MY_LID_BASE)) return true;

  const phone = jidToPhone(fromJid);
  if (MY_PHONE && phone && phone.includes(MY_PHONE)) return true;

  return false;
}

async function forwardToWebhook(payload) {
  if (!WEBHOOK_URL) {
    logger.warn({ payload }, 'WEBHOOK_URL não configurado, ignorando envio');
    return;
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (WEBHOOK_SECRET) {
      headers['x-webhook-secret'] = WEBHOOK_SECRET;
    }

    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(
        { status: res.status, text: text.slice(0, 300) },
        'Erro ao enviar webhook',
      );
    } else {
      logger.debug(
        { messageId: payload.messageId },
        'Webhook enviado com sucesso',
      );
    }
  } catch (e) {
    logger.error({ err: e, payload }, 'Erro ao chamar WEBHOOK_URL');
  }
}

// =====================
// Loop de conexão Baileys
// =====================
async function startSocket() {
  await fs.mkdir(AUTH_DIR, { recursive: true }).catch(() => {});

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    logger,
    printQRInTerminal: true,
    auth: state,
    version,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      logger.info('Novo QRCode disponível');
    }

    if (connection) {
      connState = connection;
      logger.info({ connection }, 'Connection update');

      if (connection === 'open') {
        latestQR = null;

        if (!MY_JID && sock?.user?.id) {
          MY_JID = jidNormalizedUser(sock.user.id);
          logger.info({ MY_JID }, 'Detected instance JID');
        }
      }

      if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.statusCode;

        logger.warn({ statusCode }, 'Conexão fechada');

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            startSocket().catch((e) =>
              logger.error({ err: e }, 'Erro ao tentar reconectar'),
            );
          }, 3000);
        } else {
          logger.error(
            'Sessão deslogada (logged out). Apague o diretório de auth para refazer o pareamento.',
          );
        }
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    try {
      const { messages, type } = m;
      if (type !== 'notify') return;

      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        const fromJid = msg.key.participant || msg.key.remoteJid;

        if (!jid || !jid.endsWith('@g.us')) continue;

        const text = extractText(msg);
        if (!text?.trim()) continue;

        if (!shouldForwardMessage({ text, fromJid })) continue;

        let groupName = jid;
        try {
          const meta = await sock.groupMetadata(jid);
          if (meta?.subject) groupName = meta.subject;
        } catch {
          // ignore
        }

        const fromName = msg.pushName || 'Cliente';
        const fromPhone = jidToPhone(fromJid);
        const messageId = msg.key.id || `${Date.now()}`;

        const payload = {
          messageId,
          groupId: jid,
          groupName,
          fromName,
          senderName: fromName,
          from: fromPhone,
          sender: fromPhone,
          senderNumber: fromPhone,
          text,
          instanceJid: MY_JID,
          raw: {
            key: msg.key,
            message: msg.message,
          },
        };

        await forwardToWebhook(payload);
      }
    } catch (e) {
      logger.error({ err: e }, 'Erro em messages.upsert');
    }
  });
}

// =====================
// HTTP server (painel QR)
// =====================
const server = http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      if (path === '/health') {
        return sendJson(res, 200, { ok: true, connection: connState });
      }

      // Painel HTML – agora sempre usa EMBEDDED_HTML
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(EMBEDDED_HTML);
      }

      if (path === '/instance/status' && method === 'GET') {
        return sendJson(res, 200, {
          connection: connState,
          hasQR: !!latestQR,
          myJid: MY_JID,
          myPhone: MY_PHONE,
        });
      }

      if (path === '/instance/qr' && method === 'GET') {
        return sendJson(res, 200, { qr: latestQR });
      }

      if (path === '/instance/qr.png' && method === 'GET') {
        if (!latestQR) {
          res.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
          });
          return res.end('QR code not available');
        }
        const png = await QRCode.toBuffer(latestQR, {
          type: 'png',
          margin: 1,
          width: 256,
        });
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(png);
      }

      if (
        (path === '/instance/reset' || path === '/instance/restart') &&
        method === 'POST'
      ) {
        if (ADMIN_SECRET) {
          const headerSecret = req.headers['x-admin-secret'];
          if (headerSecret !== ADMIN_SECRET) {
            return sendJson(res, 401, { error: 'unauthorized' });
          }
        }

        if (path === '/instance/reset') {
          try {
            await fs.rm(AUTH_DIR, { recursive: true, force: true });
            logger.warn({ AUTH_DIR }, 'Auth dir apagado, reiniciando processo');
          } catch (e) {
            logger.error({ err: e }, 'Erro ao apagar AUTH_DIR');
          }
        }

        sendJson(res, 202, {
          ok: true,
          action: path === '/instance/reset' ? 'reset' : 'restart',
        });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      logger.error({ err: e }, 'Erro no HTTP server');
      sendJson(res, 500, { error: 'internal_error' });
    }
  })
  .listen(PORT, () => logger.info({ port: PORT }, 'HTTP server listening'));

// =====================
// Start
// =====================
startSocket().catch((e) => {
  logger.error({ err: e }, 'Erro inicial ao conectar no WhatsApp');
});
