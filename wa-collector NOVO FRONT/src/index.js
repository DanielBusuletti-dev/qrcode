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

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // optional header

const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// ✅ FRONT no Vercel (redirect do Render -> Vercel)
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

// ✅ Se TRUE, permite considerar "@SeuNome" mesmo sem menção nativa.
// Por padrão fica FALSE (somente menção nativa).
const ALLOW_TEXT_MENTION = /^true$/i.test(process.env.ALLOW_TEXT_MENTION || 'false');

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
      const t = await res.text().catch(() => '');
      logger.warn({ status: res.status, t }, 'Webhook not OK');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to POST to webhook');
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
        logger.info(
          { myId: sock?.user?.id, myLid: sock?.user?.lid },
          'Bot identity (for mention matching)'
        );
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

    if (lastDisconnect?.error) {
      logger.warn({ err: lastDisconnect.error }, 'Last disconnect');
    }
  });

  // ✅ Só processa mensagens onde VOCÊ foi mencionado
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue; // somente grupos

        const id = msg.key.id;
        const text = toText(msg.message) || '';

        const contextInfo = getContextInfo(msg.message);
        const mentionedJids = contextInfo?.mentionedJid || [];
        const mentionedLids = contextInfo?.mentionedLid || [];

        // IDENTIDADE DO BOT
        const myJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
        const myDigits = myJid ? digits(myJid) : null;

        // LID do bot (quando WhatsApp usa LID em menções)
        const myLidBase =
          (sock?.user?.lid && baseLid(sock.user.lid)) ||
          (sock?.authState?.creds?.me?.lid && baseLid(sock.authState.creds.me.lid)) ||
          (process.env.MY_LID_BASE ? baseLid(process.env.MY_LID_BASE) : null) ||
          (process.env.MY_LID ? baseLid(process.env.MY_LID) : null) ||
          null;

        const mentionCandidates = [...mentionedJids, ...mentionedLids].filter(Boolean);

        // ✅ Menção NATIVA (preferida)
        const mentionedMeByNative = mentionCandidates.some((m) => {
          // 1) JID (normal)
          try {
            if (myJid && areJidsSameUser(jidNormalizedUser(m), myJid)) return true;
          } catch {}

          // 2) LID base
          if (myLidBase && baseLid(m) === myLidBase) return true;

          // 3) fallback por dígitos (raro)
          if (myDigits && digits(m) === myDigits) return true;

          return false;
        });

        // ✅ Opcional: permitir "@SeuNome" digitado sem selecionar contato (DESLIGADO por padrão)
        let mentionedMeByTextName = false;
        if (!mentionedMeByNative && ALLOW_TEXT_MENTION) {
          const botNames = [sock?.user?.name, sock?.user?.pushname]
            .filter(Boolean)
            .map((n) => String(n).trim())
            .filter(Boolean);

          mentionedMeByTextName =
            botNames.length > 0 &&
            botNames.some((name) => {
              const raw = name.replace(/\s+/g, ' ').trim();
              const compact = name.replace(/\s+/g, '').trim();
              return text.includes(`@${raw}`) || (compact && text.includes(`@${compact}`));
            });
        }

        const mentionedMe = mentionedMeByNative || mentionedMeByTextName;

        // ✅ REGRA DE OURO: se não mencionou VOCÊ, ignora
        if (!mentionedMe) continue;

        const groupName = await getGroupName(sock, jid);

        // ✅ Aqui é a mudança: capturar o TELEFONE REAL de quem te mencionou
        const fromJidRaw = msg.key.participant || msg.key.remoteJid;

        // telefone real quando o WhatsApp envia JID normal
        let fromPhone = null;
        if (fromJidRaw?.includes('@s.whatsapp.net')) {
          const d = digits(fromJidRaw);
          // validação simples (evita lixo vindo de ID interno)
          if (d.length >= 10 && d.length <= 15) fromPhone = d;
        }

        // se vier LID, não inventa telefone
        const fromLid = fromJidRaw?.includes('@lid') ? baseLid(fromJidRaw) : null;

        const fromName = msg.pushName || fromPhone || fromJidRaw;

        const payload = {
          messageId: id,
          groupId: jid,
          groupName,

          senderName: fromName,

          // ✅ O que você quer armazenar:
          senderNumber: fromPhone, // string OU null (quando vier só LID)

          // ✅ Extras úteis (pra rastrear quando vier LID)
          senderJid: fromJidRaw,
          senderLid: fromLid,

          text,

          // debug/auditoria
          mentionedJid: mentionedJids,
          mentionedLid: mentionedLids,
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

// HTTP server
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
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-secret');
  res.setHeader('Access-Control-Max-Age', '600');
};

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

      // Render NÃO serve mais o front: redireciona pro Vercel
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
        if (!latestQR) return sendJson(res, 404, { error: 'no_qr' });
        try {
          const buf = await QRCode.toBuffer(latestQR, { width: 256 });
          res.statusCode = 200;
          res.setHeader('content-type', 'image/png');
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
    } catch {
      sendJson(res, 500, { error: 'internal_error' });
    }
  })
  .listen(PORT, () => logger.info({ port: PORT }, 'HTTP server listening'));
