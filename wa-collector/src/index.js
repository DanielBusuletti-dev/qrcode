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

const TAG = process.env.TAG_REGEX ? new RegExp(process.env.TAG_REGEX, 'i') : null;
const MY_PHONE = process.env.MY_PHONE || null;
let MY_JID = MY_PHONE ? jidNormalizedUser(`${MY_PHONE}@s.whatsapp.net`) : null;

// LID configurável via .env (opcional)
const MY_LID_ENV = process.env.MY_LID_BASE || process.env.MY_LID || null;

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
    printQRInTerminal: false, // não imprime QR no terminal
    auth: state,
    logger,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      // guarda o QR mais recente em memória para o frontend
      latestQR = qr;
    }
    if (connection) {
      connState = connection;
      logger.info({ connection }, 'Connection update');

      if (connection === 'open') {
        latestQR = null;

        // Se nenhum número foi configurado manualmente em MY_PHONE,
        // detecta automaticamente o JID da instância conectada
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
          const mode = process.env.AUTORESTART_MODE || 'inprocess'; // 'exit' to rely on supervisor
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
              logger.info('Recreating WhatsApp socket (in-process)...');
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
              logger.info('Reconnecting WhatsApp socket...');
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

  // ============================
  //  TRATAMENTO DE MENSAGENS
  // ============================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue; // apenas grupos

        const id = msg.key.id;
        let text = toText(msg.message) || '';
        const contextInfo = getContextInfo(msg.message);
        const mentionedJids = contextInfo?.mentionedJid || [];
        const mentionedLids = contextInfo?.mentionedLid || [];

        // Identidade da instância logada
        const myJidForCompare =
          MY_JID || (sock?.user?.id ? jidNormalizedUser(sock.user.id) : null);
        const myDigits = myJidForCompare ? digits(myJidForCompare) : null;

        // LID base: se tiver no .env usa, senão pega do próprio user.lid
        const myLidBase =
          MY_LID_ENV
            ? baseLid(MY_LID_ENV)
            : sock?.user?.lid
              ? baseLid(sock.user.lid)
              : null;

        const myDisplayName =
          sock?.user?.name ||
          sock?.user?.pushname ||
          myDigits ||
          '';

        // 1) Menção pelo JID (quando usa @clicando no contato)
        const mentionedByJid = myDigits
          ? mentionedJids.some((m) => {
              try {
                const norm = jidNormalizedUser(m);
                return digits(norm) === myDigits;
              } catch {
                return digits(m) === myDigits;
              }
            })
          : false;

        // 2) Menção pelo LID (multi-device)
        const mentionedByLid = myLidBase
          ? mentionedJids.some((m) => baseLid(m) === myLidBase) ||
            mentionedLids.some((m) => baseLid(m) === myLidBase)
          : false;

        // 3) Menção “visual” pelo nome (@NomeDoBot ou NomeDoBot)
        const lowerText = text.toLowerCase();
        const mentionedByName = myDisplayName
          ? lowerText.includes(`@${myDisplayName.toLowerCase()}`) ||
            lowerText.includes(myDisplayName.toLowerCase())
          : false;

        const mentioned = mentionedByJid || mentionedByLid || mentionedByName;

        // Também considera quando o número da instância aparece em texto puro
        const textDigits = text.replace(/\D/g, '');
        const numberInText =
          myDigits && textDigits ? textDigits.includes(myDigits) : false;

        // Qualquer @ no texto (fallback pra garantir menções)
        const hasAtSign = text.includes('@');

        const tagMatched = TAG ? TAG.test(text) : false;

        // 🔥 REGRA FINAL: qualquer uma dessas dispara o forward
        const matched = mentioned || tagMatched || numberInText || hasAtSign;

        // 🔁 Se a mensagem menciona esta instância, converte @LID/@0:... em @<telefone_da_instancia>
        if (mentioned && myDigits) {
          const myNumberText = myDigits || digits(sock?.user?.id || '');
          const mentionTokens = new Set([
            baseLid(sock?.user?.lid || ''),
            sock?.user?.lid || '',
            myNumberText,
          ]);

          text = text.replace(/@([0-9:@a-zA-Z]+)/g, (full, inner) => {
            const cleaned = inner.replace(/[^0-9:@a-zA-Z]/g, '');
            const base = baseLid(cleaned);
            if (
              mentionTokens.has(cleaned) ||
              mentionTokens.has(base)
            ) {
              // 👇 aqui forçamos a menção a virar @<telefone>
              return `@${myDigits}`;
            }
            return full;
          });
        }

        if (!matched && !FORWARD_ALL) {
          // Log de debug quando tem @ ou contextInfo mas não deu match
          if (text.includes('@') || mentionedJids.length || mentionedLids.length) {
            logger.info(
              {
                id,
                text,
                contextInfo,
                mentionedJids,
                mentionedLids,
                myJidForCompare,
                myDigits,
                myLidBase,
                user: sock?.user,
                mentionedByJid,
                mentionedByLid,
                mentionedByName,
                mentioned,
                numberInText,
                hasAtSign,
                tagMatched,
              },
              'mention-debug'
            );
          }
          continue;
        }

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

      // Painel simples em /
      if ((path === '/' || path === '/index.html') && method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const html = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Controle WhatsApp</title>
  <style>
    body{
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu;
      max-width:760px;
      margin:24px auto;
      padding:0 16px;
      color:#222
    }
    h1{font-size:20px;margin:0 0 12px}
    .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    label{font-size:14px}
    input[type=text],input[type=password]{
      padding:8px 10px;
      border:1px solid #ccc;
      border-radius:6px;
      min-width:260px
    }
    button{
      padding:8px 12px;
      border:1px solid #555;
      background:#fff;
      border-radius:6px;
      cursor:pointer
    }
    button.primary{
      background:#111;
      color:#fff;
      border-color:#111
    }
    button:disabled{opacity:.6;cursor:not-allowed}
    .card{
      border:1px solid #eee;
      border-radius:10px;
      padding:16px;
      margin:14px 0
    }
    .muted{color:#666}
    img{
      border-radius:8px;
      border:1px solid #eee
    }
    .status{font-weight:600}
  </style>
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
      async qrPng(){
        const r = await fetch('/instance/qr.png?ts=' + Date.now());
        if(!r.ok) throw new Error('no_qr_png');
        return r;
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

    async function renderSimple(){
      const elStatus = document.getElementById('status');
      const elHasQR = document.getElementById('hasqr');
      const img = document.getElementById('qrimg');
      const copy = document.getElementById('copy');
      try {
        const s = await api.status();
        elStatus.textContent = s.status;
        elHasQR.textContent = s.hasQR ? 'sim' : 'não';
        if (s.hasQR) {
          try {
            const { qr } = await api.qr();
            copy.value = qr;
          } catch (_) {
            copy.value = '';
          }
          try {
            const resp = await api.qrPng();
            const blob = await resp.blob();
            img.src = URL.createObjectURL(blob);
            img.style.display = 'block';
          } catch (_) {
            img.style.display = 'none';
            img.src = '';
          }
        } else {
          img.style.display = 'none';
          img.src = '';
          copy.value = '';
        }
      } catch (e) {
        elStatus.textContent = 'erro';
      }
    }

    function startPolling(){
      stopPolling();
      polling=setInterval(renderSimple, 2000);
    }
    function stopPolling(){
      if(polling) clearInterval(polling);
      polling=null;
    }

    window.addEventListener('DOMContentLoaded',()=>{
      document.getElementById('btn-refresh').addEventListener('click',renderSimple);
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
      renderSimple();
      startPolling();
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
    <div class="row">
      <img id="qrimg" width="256" height="256" style="display:none" alt="QR Code" />
    </div>
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

      if (path === '/instance/status' && method === 'GET') {
        return sendJson(res, 200, { status: connState, hasQR: !!latestQR });
      }

      if (path === '/instance/qr' && method === 'GET') {
        if (!latestQR) return sendJson(res, 404, { error: 'no_qr' });
        return sendJson(res, 200, { qr: latestQR });
      }

      if (path === '/instance/qr.png' && method === 'GET') {
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