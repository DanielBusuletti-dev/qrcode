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
      if (connection === 'open') latestQR = null;
    }
    if (lastDisconnect?.error) logger.warn({ err: lastDisconnect.error }, 'Last disconnect');
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
      applyCors(req, res);

      if (method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
        return;
      }

      if ((url === '/' || url === '/index.html') && method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Controle WhatsApp</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;max-width:760px;margin:24px auto;padding:0 16px;color:#222}
    h1{font-size:20px;margin:0 0 12px}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    label{font-size:14px}
    input[type=text],input[type=password]{padding:8px 10px;border:1px solid #ccc;border-radius:6px;min-width:260px}
    button{padding:8px 12px;border:1px solid #555;background:#fff;border-radius:6px;cursor:pointer}
    button.primary{background:#111;color:#fff;border-color:#111}
    button:disabled{opacity:.6;cursor:not-allowed}
    .card{border:1px solid #eee;border-radius:10px;padding:16px;margin:14px 0}
    .muted{color:#666}
    canvas{border:1px solid #eee;border-radius:8px}
    .status{font-weight:600}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
  <script>
    const api = {
      async status(){
        const r = await fetch('/instance/status');
        if(!r.ok) throw new Error('status');
        return r.json();
      },
      async qr(){
        const r = await fetch('/instance/qr');
        if(!r.ok) throw new Error('no_qr');
        return r.json();
      },
      async reset(secret){
        const r = await fetch('/instance/reset',{method:'POST',headers:{'x-admin-secret':secret||''}});
        if(!r.ok) throw new Error('reset_failed');
        return r.json();
      },
      async restart(){
        const r = await fetch('/instance/restart',{method:'POST'});
        if(!r.ok) throw new Error('restart_failed');
        return r.json();
      }
    };
    let polling=null;
    async function render(){
      const elStatus=document.getElementById('status');
      const elHasQR=document.getElementById('hasqr');
      const canvas=document.getElementById('qr');
      const copy=document.getElementById('copy');
      try{
        const s=await api.status();
        elStatus.textContent=s.status;
        elHasQR.textContent=s.hasQR?'sim':'não';
        if(s.hasQR){
          const {qr}=await api.qr();
          await QRCode.toCanvas(canvas, qr, { width: 256 });
          copy.value=qr;
          canvas.style.display='block';
        }else{
          canvas.style.display='none';
          copy.value='';
        }
      }catch(e){
        elStatus.textContent='erro';
      }
    }
    function startPolling(){
      stopPolling();
      polling=setInterval(render, 3000);
    }
    function stopPolling(){ if(polling) clearInterval(polling); polling=null; }
    window.addEventListener('DOMContentLoaded',()=>{
      document.getElementById('btn-refresh').addEventListener('click',render);
      document.getElementById('btn-start').addEventListener('click',startPolling);
      document.getElementById('btn-stop').addEventListener('click',stopPolling);
      document.getElementById('btn-reset').addEventListener('click',async()=>{
        const secret=document.getElementById('secret').value||'';
        if(!confirm('Resetar sessão? Você terá que escanear QR novamente.')) return;
        try{ await api.reset(secret); alert('Reset solicitado. O serviço vai reiniciar.'); }
        catch{ alert('Falha ao resetar. Verifique o segredo.'); }
      });
      document.getElementById('btn-restart').addEventListener('click',async()=>{
        if(!confirm('Reiniciar serviço agora? Sessão será mantida.')) return;
        try{ await api.restart(); alert('Reinício solicitado.'); }
        catch{ alert('Falha ao reiniciar.'); }
      });
      render();
    });
  </script>
</head>
<body>
  <h1>Controle do WhatsApp</h1>
  <div class="card">
    <div class="row">
      <div>Status: <span class="status" id="status">...</span></div>
      <div class="muted">QR disponível: <span id="hasqr">...</span></div>
    </div>
    <div class="row" style="margin-top:8px;">
      <button id="btn-refresh">Atualizar</button>
      <button id="btn-start">Auto-atualizar</button>
      <button id="btn-stop">Parar auto</button>
    </div>
  </div>
  <div class="card">
    <div class="row"><canvas id="qr" width="256" height="256" style="display:none"></canvas></div>
    <div class="row" style="margin-top:8px;">
      <label class="muted">Conteúdo do QR:</label>
      <input type="text" id="copy" readonly>
    </div>
  </div>
  <div class="card">
    <div class="row">
      <input type="password" id="secret" placeholder="ADMIN_SECRET para reset" />
      <button class="primary" id="btn-reset">Resetar sessão</button>
      <button id="btn-restart">Reiniciar serviço</button>
    </div>
  </div>
</body>
</html>`;
        res.end(html);
        return;
      }

      if (url === '/instance/status' && method === 'GET') {
        return sendJson(res, 200, { status: connState, hasQR: !!latestQR });
      }

      if (url === '/instance/qr' && method === 'GET') {
        if (!latestQR) return sendJson(res, 404, { error: 'no_qr' });
        return sendJson(res, 200, { qr: latestQR });
      }

      if (url === '/instance/reset' && method === 'POST') {
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

      if (url === '/instance/restart' && method === 'POST') {
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
