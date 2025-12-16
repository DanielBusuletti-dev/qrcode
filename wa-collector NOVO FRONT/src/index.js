import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
  areJidsSameUser,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import http from 'http';
import { promises as fs } from 'fs';
import QRCode from 'qrcode';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const TAG = process.env.TAG_REGEX ? new RegExp(process.env.TAG_REGEX, 'i') : null;
const MY_PHONE = process.env.MY_PHONE || null;
const MY_LID_ENV = process.env.MY_LID_BASE || process.env.MY_LID || null;
let MY_JID = MY_PHONE ? jidNormalizedUser(`${MY_PHONE}@s.whatsapp.net`) : null;

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // optional header
const FORWARD_ALL = /^true$/i.test(process.env.FORWARD_ALL || 'false');

const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// ✅ FRONT no Vercel (para redirecionar /)
const FRONT_URL =
  process.env.FRONT_URL ||
  'https://qrcode-7ktlm86ov-daniel-busulettis-projects.vercel.app';

// ✅ CORS (permitir seu domínio e também previews *.vercel.app)
const CORS_ORIGIN = process.env.CORS_ORIGIN || FRONT_URL;
// você pode colocar vários separados por vírgula em CORS_ORIGIN
const ALLOWED_ORIGINS = (CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let latestQR = null;
let connState = 'idle';
let sock = null;
let isReconnecting = false;

if (!WEBHOOK_URL) {
  logger.error('Missing WEBHOOK_URL in .env');
  process.exit(1);
}

const post = async (payload) => {
  try {
    const headers = { 'content-type': 'application/json' };
    if (WEBHOOK_SECRET) headers['x-webhook-secret'] = WEBHOOK_SECRET;
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text();
      logger.warn({ status: res.status, t }, 'Ingest not OK');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to POST to ingest');
  }
};

const toText = (m) =>
  m?.conversation ||
  m?.extendedTextMessage?.text ||
  m?.imageMessage?.caption ||
  m?.videoMessage?.caption ||
  '';

const getContextInfo = (m) =>
  m?.extendedTextMessage?.contextInfo ||
  m?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
  m?.viewOnceMessageV2?.message?.extendedTextMessage?.contextInfo ||
  m?.viewOnceMessageV2Extension?.message?.extendedTextMessage?.contextInfo ||
  m?.editedMessage?.message?.extendedTextMessage?.contextInfo ||
  m?.contextInfo ||
  m?.ephemeralMessage?.message?.contextInfo ||
  m?.viewOnceMessageV2?.message?.contextInfo ||
  m?.viewOnceMessageV2Extension?.message?.contextInfo ||
  m?.editedMessage?.message?.contextInfo ||
  null;

const digits = (jidOrPhone) => (jidOrPhone || '').split('@')[0].replace(/\D/g, '');

const baseLid = (lidOrJid) => {
  const beforeAt = (lidOrJid || '').split('@')[0];
  return beforeAt.split(':')[0];
};

const groupNameCache = new Map();

const getGroupName = async (sockInst, jid) => {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  try {
    const meta = await sockInst.groupMetadata(jid);
    const name = meta?.subject || jid;
    groupNameCache.set(jid, name);
    return name;
  } catch {
    return jid;
  }
};

const main = async () => {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const credsLid = state?.creds?.me?.lid || null;
  if (credsLid) logger.info({ credsLid }, 'Detected LID from creds');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      latestQR = qr;
      qrcode.generate(qr, { small: true });
    }
    if (connection) {
      connState = connection;
      logger.info({ connection }, 'Connection update');

      if (connection === 'open') {
        latestQR = null;
        if (!MY_JID && sock?.user?.id) {
          MY_JID = jidNormalizedUser(sock.user.id);
          logger.info({ MY_JID }, 'Detected instance JID for mentions');
        }
      }

      if (connection === 'close') {
        const code =
          lastDisconnect?.error?.output?.statusCode ??
          lastDisconnect?.error?.data?.attrs?.code;

        logger.warn({ code }, 'Connection closed');

        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        const restartRequired =
          code === DisconnectReason.restartRequired || code === 515;

        if (restartRequired) {
          const mode = process.env.AUTORESTART_MODE || 'inprocess';
          logger.warn({ mode }, 'Restart required by WhatsApp');

          if (mode === 'exit') {
            setTimeout(() => process.exit(0), 100);
            return;
          }

          if (!isReconnecting) {
            isReconnecting = true;
            try {
              sock?.end?.();
            } catch {}
            setTimeout(() => {
              logger.info('Recreating WhatsApp socket (in-process).');
              main()
                .catch((err) => logger.error({ err }, 'Reconnect failed'))
                .finally(() => (isReconnecting = false));
            }, 1000);
          }
          return;
        }

        if (!loggedOut) {
          if (!isReconnecting) {
            isReconnecting = true;
            setTimeout(() => {
              logger.info('Reconnecting WhatsApp socket.');
              main()
                .catch((err) => logger.error({ err }, 'Reconnect failed'))
                .finally(() => (isReconnecting = false));
            }, 1000);
          }
        } else {
          latestQR = null;
          logger.warn('Logged out. Reset auth to get a new QR.');
        }
      }
    }
    if (lastDisconnect?.error) logger.warn({ err: lastDisconnect.error }, 'Last disconnect');
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue; // only group messages

        const id = msg.key.id;
        let text = toText(msg.message) || '';
        const contextInfo = getContextInfo(msg.message);
        const mentionedJids = contextInfo?.mentionedJid || [];
        const mentionedLids = contextInfo?.mentionedLid || [];

        const myJidForCompare =
          MY_JID || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
        const myJidNormalized = myJidForCompare ? jidNormalizedUser(myJidForCompare) : null;
        const myDigits = myJidNormalized ? digits(myJidNormalized) : null;

        const myLidBase =
          (sock?.user?.lid && baseLid(sock.user.lid)) ||
          (sock?.user?.id ? baseLid(sock.user.id) : null) ||
          (sock?.authState?.creds?.me?.lid ? baseLid(sock.authState.creds.me.lid) : null) ||
          (MY_LID_ENV ? baseLid(MY_LID_ENV) : null);

        const mentionedByJid = mentionedJids.some((m) => {
          try {
            const norm = jidNormalizedUser(m);
            if (myJidNormalized && areJidsSameUser(norm, myJidNormalized)) return true;
            return myDigits ? digits(norm) === myDigits : false;
          } catch {
            if (myJidNormalized && areJidsSameUser(m, myJidNormalized)) return true;
            return myDigits ? digits(m) === myDigits : false;
          }
        });

        const mentionedByLid =
          !!myLidBase &&
          (mentionedJids.some((m) => baseLid(m) === myLidBase) ||
            mentionedLids.some((m) => baseLid(m) === myLidBase));

        const mentionedByText = !!myDigits && text.replace(/\D/g, '').includes(myDigits);

        let mentioned = mentionedByJid || mentionedByLid || mentionedByText;

        if (mentioned) {
          const myNumberText = myDigits || digits(sock?.user?.id || '');
          const myDisplay = myNumberText || sock?.user?.name || sock?.user?.pushname || '';

          if (myDisplay) {
            const mentionTokens = new Set([
              baseLid(sock?.user?.lid || ''),
              sock?.user?.lid || '',
              myNumberText,
            ]);

            text = text.replace(/@([0-9:@a-zA-Z]+)/g, (full, inner) => {
              const cleaned = inner.replace(/[^0-9:@a-zA-Z]/g, '');
              if (mentionTokens.has(cleaned) || mentionTokens.has(baseLid(cleaned))) {
                return `@${myDisplay}`;
              }
              return full;
            });
          }
        }

        const tagMatched = TAG ? TAG.test(text) : false;
        const matched = FORWARD_ALL || mentioned || tagMatched;

        if (!matched) continue;

        const groupName = await getGroupName(sock, jid);
        const fromJid = msg.key.participant || msg.key.remoteJid;
        const fromPhone = digits(fromJid);
        const fromName = msg.pushName || fromPhone || fromJid;

        const payload = {
          messageId: id,
          groupId: jid,
          groupName,
          senderName: fromName,
          senderNumber: fromPhone,
          text,
        };

        await post(payload);
      } catch (err) {
        logger.error({ err }, 'Failed processing message');
      }
    }
  });
};

main().catch((err) => {
  logger.error({ err }, 'Fatal error in main');
  process.exit(1);
});

// HTTP server for health/control
const sendJson = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const authAdmin = (req) => {
  if (!ADMIN_SECRET) return true;
  const got = req.headers['x-admin-secret'];
  return got === ADMIN_SECRET;
};

// ✅ CORS robusto (domínio fixo + previews *.vercel.app)
const isOriginAllowed = (origin) => {
  if (!origin) return true; // server-to-server / sem Origin
  if (ALLOWED_ORIGINS.includes('*')) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/.*\.vercel\.app$/.test(origin)) return true; // previews
  return false;
};

const applyCors = (req, res) => {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      // sem origin: não precisa definir Allow-Origin
    }
  } else {
    // Não libera CORS para origens não permitidas
    // (o browser vai bloquear — melhor do que liberar errado)
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-secret');
  res.setHeader('Access-Control-Max-Age', '600');
};

const readBody = async (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

http
  .createServer(async (req, res) => {
    try {
      const { method, url } = req;
      const path = url.split('?')[0];

      applyCors(req, res);

      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (path === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
        return;
      }

      // ✅ Agora o Render NÃO é mais seu front:
      // ao abrir / ele manda para o Vercel
      if ((path === '/' || path === '/index.html') && method === 'GET') {
        res.statusCode = 302;
        res.setHeader('Location', FRONT_URL);
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Redirecting to front…');
        return;
      }

      if (path === '/instance/status' && method === 'GET') {
        return sendJson(res, 200, { status: connState, hasQR: !!latestQR });
      }

      if (path === '/instance/qr' && method === 'GET') {
        if (!latestQR) return sendJson(res, 404, { error: 'no_qr' });
        return sendJson(res, 200, { qr: latestQR });
      }

      if (path === '/instance/qr.png' && method === 'GET') {
        if (!latestQR) {
          return sendJson(res, 404, { error: 'no_qr' });
        }
        try {
          const buf = await QRCode.toBuffer(latestQR, { width: 256 });
          res.statusCode = 200;
          res.setHeader('content-type', 'image/png');
          res.setHeader('x-qr', latestQR);
          res.setHeader('cache-control', 'no-store');
          res.end(buf);
        } catch (e) {
          sendJson(res, 500, { error: 'qr_render_failed' });
        }
        return;
      }

      if (path === '/instance/reset' && method === 'POST') {
        if (!authAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });
        try {
          await sock?.logout?.();
        } catch {}
        try {
          await fs.rm(AUTH_DIR, { recursive: true, force: true });
        } catch {}
        sendJson(res, 202, { ok: true, action: 'resetting' });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      if (path === '/instance/restart' && method === 'POST') {
        sendJson(res, 202, { ok: true, action: 'restarting' });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      sendJson(res, 500, { error: 'internal_error' });
    }
  })
  .listen(PORT, () => logger.info({ port: PORT }, 'HTTP server listening'));
