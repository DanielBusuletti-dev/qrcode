import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import http from 'http';
import { promises as fs } from 'fs';
import QRCode from 'qrcode';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const TAG = process.env.TAG_REGEX ? new RegExp(process.env.TAG_REGEX, 'i') : null;
const MY_JID = process.env.MY_PHONE
  ? jidNormalizedUser(process.env.MY_PHONE + '@s.whatsapp.net')
  : null;

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // optional header
const FORWARD_ALL = /^true$/i.test(process.env.FORWARD_ALL || 'false');

const AUTH_DIR = process.env.AUTH_DIR || './auth';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

let latestQR = null;
let connState = 'idle';
let sock = null;

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

const digits = (jidOrPhone) => (jidOrPhone || '').split('@')[0].replace(/\D/g, '');

const extractTags = (text) => {
  const tags = new Set();
  if (!text) return [];
  for (const m of text.matchAll(/@[\p{L}\p{N}_.-]+/giu)) tags.add(m[0]);
  for (const m of text.matchAll(/[\p{L}\p{N}_.-]+:[\p{L}\p{N}_./-]+/giu)) tags.add(m[0]);
  if (TAG && TAG.source) {
    const mt = text.match(TAG);
    if (mt) tags.add(mt[0]);
  }
  return Array.from(tags);
};

const groupNameCache = new Map();

const getGroupName = async (sock, jid) => {
  if (groupNameCache.has(jid)) return groupNameCache.get(jid);
  try {
    const meta = await sock.groupMetadata(jid);
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
      // conexão OK, limpa QR em memória
      latestQR = null;
    }

    if (connection === 'close') {
      // se fechou, vê se teve erro
      const error = lastDisconnect?.error;
      logger.warn(
        { err: error?.message || error, data: error?.data },
        'Connection closed, will restart process',
      );
      // dá um tempinho pra logs saírem e derruba o processo
      setTimeout(() => {
        process.exit(1);
      }, 2000);
    }
  }

  if (lastDisconnect?.error) {
    logger.warn({ err: lastDisconnect.error }, 'Last disconnect');
  }
});


  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue; // apenas grupos

        const id = msg.key.id;
        const text = toText(msg.message) || '';
        const mentionedList =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const mentioned = MY_JID ? mentionedList.includes(MY_JID) : false;
        const tagMatched = TAG ? TAG.test(text) : false;
        const matched = mentioned || tagMatched;

        if (!matched && !FORWARD_ALL) continue;

        const groupName = await getGroupName(sock, jid);
        const fromJid = msg.key.participant || msg.key.remoteJid;
        const fromPhone = digits(fromJid);
        const fromName = msg.pushName || fromPhone || fromJid;
        const tags = extractTags(text);

        const payload = {
          messageId: id,
          groupId: jid, // ajuste se precisar de outro formato
          groupName,
          fromName,
          from: fromPhone,
          text,
          tags,
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

// HTTP server para health e controle da instância
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

const applyCors = (req, res) => {
  let originToUse = '*';
  if (CORS_ORIGIN !== '*') {
    const incoming = req.headers.origin || '';
    const allowed = CORS_ORIGIN.split(',').map((s) => s.trim());
    originToUse = allowed.includes(incoming) ? incoming : allowed[0] || '';
    if (incoming) res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Origin', originToUse);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-admin-secret');
  res.setHeader('Access-Control-Max-Age', '600');
};
http
  .createServer(async (req, res) => {
    try {
      const { method, url } = req;

      // Garante que analisamos só o path, sem query string
      const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      applyCors(req, res);

      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      // Healthcheck
      if (pathname === '/health' && method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
        return;
      }

      // Página HTML do painel
      if ((pathname === '/' || pathname === '/index.html') && method === 'GET') {
        try {
          const html = await fs.readFile('./public/index.html', 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(html);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('Erro ao carregar index.html');
        }
        return;
      }

      // JS do painel
      if (pathname === '/app.js' && method === 'GET') {
        try {
          const js = await fs.readFile('./public/app.js', 'utf8');
          res.statusCode = 200;
          res.setHeader('content-type', 'application/javascript; charset=utf-8');
          res.end(js);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('Erro ao carregar app.js');
        }
        return;
      }

      // API do painel
      if (pathname === '/instance/status' && method === 'GET') {
        return sendJson(res, 200, { status: connState, hasQR: !!latestQR });
      }

      if (pathname === '/instance/qr' && method === 'GET') {
        if (!latestQR) return sendJson(res, 404, { error: 'no_qr' });
        return sendJson(res, 200, { qr: latestQR });
      }

      if (pathname === '/instance/qr.png' && method === 'GET') {
        if (!latestQR) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'no_qr' }));
          return;
        }
        try {
          const buf = await QRCode.toBuffer(latestQR, { width: 256 });
          res.statusCode = 200;
          res.setHeader('content-type', 'image/png');
          res.setHeader('x-qr', latestQR);
          res.setHeader('cache-control', 'no-store');
          res.end(buf);
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'qr_render_failed' }));
        }
        return;
      }

      if (pathname === '/instance/reset' && method === 'POST') {
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

      if (pathname === '/instance/restart' && method === 'POST') {
        sendJson(res, 202, { ok: true, action: 'restarting' });
        setTimeout(() => process.exit(0), 200);
        return;
      }

      // Qualquer outra rota cai aqui
      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      sendJson(res, 500, { error: 'internal_error' });
    }
  })
  .listen(PORT, () => logger.info({ port: PORT }, 'HTTP server listening'));
