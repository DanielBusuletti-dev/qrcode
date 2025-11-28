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

// =====================
// Helpers WhatsApp
// =====================

// Extrai texto principal da mensagem
function extractText(msg) {
  const m = msg.message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return '';
}

// Converte JID em número "cru"
function jidToPhone(jid) {
  if (!jid) return null;
  return String(jid).replace(/[:@].*$/, '');
}

// Decide se deve encaminhar para o backend
function shouldForwardMessage({ text, fromJid }) {
  if (!text) return false;

  // modo "passa tudo"
  if (FORWARD_ALL) return true;

  // regex de tag no texto
  if (TAG && TAG.test(text)) return true;

  // menção por LID, ex: @1234567890
  if (MY_LID_BASE && text.includes('@' + MY_LID_BASE)) return true;

  // se veio do meu número (pra teste)
  const phone = jidToPhone(fromJid);
  if (MY_PHONE && phone && phone.includes(MY_PHONE)) return true;

  return false;
}

// Envia payload pro backend (Webhook)
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

        // Descobre o JID da instância
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
          // tenta reconectar
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

        // só grupos
        if (!jid || !jid.endsWith('@g.us')) continue;

        const text = extractText(msg);
        if (!text?.trim()) continue;

        if (!shouldForwardMessage({ text, fromJid })) continue;

        // nome do grupo
        let groupName = jid;
        try {
          const meta = await sock.groupMetadata(jid);
          if (meta?.subject) groupName = meta.subject;
        } catch {
          // ignore erro de metadata
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

      // Health simples
      if (path === '/health') {
        return sendJson(res, 200, { ok: true, connection: connState });
      }

      // Painel HTML
      if (path === '/' || path === '/index.html') {
        try {
          const html = await fs.readFile('./index.html', 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        } catch {
          return sendText(
            res,
            200,
            'WA Bot está rodando. (index.html não encontrado)',
          );
        }
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

      // reset / restart (opcionalmente protegido por ADMIN_SECRET)
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

      // 404 default
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
