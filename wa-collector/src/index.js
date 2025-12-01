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

// Se não tiver WEBHOOK_URL no ambiente, usa direto o endpoint padrão
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || 'https://wpp-bmp-1.onrender.com/api/webhooks/zapi';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// =========================
// Helpers de env
// =========================

function parseBoolEnv(value, defaultValue = false) {
  if (!value) return defaultValue;
  const clean = String(value).split('#')[0].trim().toLowerCase();
  return ['true', '1', 'yes', 'y', 'on'].includes(clean);
}

// FORWARD_ALL=false -> só manda quando tiver mention oficial (@)
// FORWARD_ALL=true  -> manda TUDO (útil para debug)
const FORWARD_ALL = parseBoolEnv(process.env.FORWARD_ALL, false);

// =========================
// Estado global da instância
// =========================

let sock = null;
let connState = 'connecting';
let latestQR = null;
let myJid = null; // ex: 551199999999@s.whatsapp.net
let myDigits = null; // ex: 551199999999

// =========================
// Helpers
// =========================

function digits(str = '') {
  return (str || '').replace(/\D/g, '');
}

// helper para “normalizar” qualquer JID para apenas os dígitos
function normalizeJidToDigits(jid = '') {
  // tira parte de device (:X) e domínio (@s.whatsapp.net)
  const base = String(jid).split(':')[0].split('@')[0];
  return digits(base);
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

// =========================
// Webhook
// =========================

async function sendWebhook(bodyObj) {
  try {
    const url = new URL(WEBHOOK_URL);
    const isHttps = url.protocol === 'https:';
    const client = await import(isHttps ? 'https' : 'http');

    const payload = JSON.stringify(bodyObj);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };

    if (WEBHOOK_SECRET) {
      // Se quiser assinar o payload, pode implementar aqui (ex: HMAC)
      // headers['x-webhook-signature'] = ...
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    await new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const status = res.statusCode || 0;
          const text = data || '';
          if (status >= 200 && status < 300) {
            logger.info({ status }, 'Webhook enviado com sucesso');
          } else {
            logger.warn(
              { status, body: text.slice(0, 200) },
              'Erro ao enviar webhook'
            );
          }
          resolve();
        });
      });

      req.on('error', (err) => {
        logger.error({ err }, 'Erro na requisição para o webhook');
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  } catch (err) {
    logger.error({ err }, 'Erro inesperado em sendWebhook');
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
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connState = 'qr';
      logger.info('Novo QRCode gerado');
    }

    if (connection) {
      connState = connection;
      logger.info({ connection }, 'Estado da conexão atualizado');

      if (connection === 'open') {
        latestQR = null;
        if (sock.user?.id) {
          myJid = jidNormalizedUser(sock.user.id);
          myDigits = normalizeJidToDigits(myJid); // usa o número da instância (QRCode)
          logger.info({ myJid, myDigits }, 'Conectado como');
        }
      } else if (connection === 'close') {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode ||
          lastDisconnect?.error?.data?.statusCode;
        const code =
          statusCode ||
          lastDisconnect?.error?.data?.payload?.statusCode ||
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

  // logger cru de mensagens (debug)
  sock.ev.on('messages.upsert', (m) => {
    logger.debug(
      {
        type: m.type,
        messagesCount: m.messages?.length,
      },
      'DEBUG BRUTO messages.upsert'
    );
  });

  // handler filtrado
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') {
      logger.debug({ type }, 'Ignorando messages.upsert que não é notify');
      return;
    }

    for (const msg of messages) {
      try {
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

        const unwrapped = unwrapMessageContent(msg.message);
        const text = extractText(unwrapped) || '';

        const contextInfo = getContextInfo(unwrapped);
        const mentionedJids = contextInfo?.mentionedJid || [];
        const hasQuoted = !!contextInfo?.quotedMessage; // reply se tiver quotedMessage

        // Número da própria instância em dígitos (o número que leu o QR)
        const myNumberDigits =
          myDigits || normalizeJidToDigits(sock?.user?.id || '');

        // Debug pra ver mention
        logger.debug(
          {
            myJid,
            myNumberDigits,
            mentionedJids,
            hasQuoted,
            contextInfo,
            textPreview: text.slice(0, 120),
          },
          'Debug de mention (contextInfo + mentionedJid)'
        );

        // 1) Mention oficial do WhatsApp via mentionedJid (comparando só dígitos),
        //    e ignoramos se for reply (hasQuoted)
        let mentionedByContext = false;
        if (
          !hasQuoted &&
          Array.isArray(mentionedJids) &&
          mentionedJids.length > 0
        ) {
          for (const mj of mentionedJids) {
            const mjDigits = normalizeJidToDigits(mj);
            logger.debug(
              { mj, mjDigits, myNumberDigits },
              'Comparando mentionedJid com meu número'
            );
            if (myNumberDigits && mjDigits && mjDigits === myNumberDigits) {
              mentionedByContext = true;
              break;
            }
          }
        }

        // 2) Heurística antiga de procurar o número no texto (APENAS PARA DEBUG)
        //    Mas NÃO será usada para decidir se deve enviar ou não
        let mentionedByText = false;
        if (!hasQuoted && myNumberDigits && text) {
          const onlyDigits = text.replace(/\D/g, '');
          if (onlyDigits.includes(myNumberDigits)) {
            mentionedByText = true;
          }
        }

        // ✅ AGORA SÓ CONTA A MENÇÃO OFICIAL (@)
        const mentioned = mentionedByContext;

        logger.debug(
          {
            mentioned,
            mentionedByContext,
            mentionedByText,
            hasQuoted,
          },
          'Resultado final de detecção de mention'
        );

        // Regra final:
        // - se FORWARD_ALL=true -> manda tudo (debug)
        // - senão -> só se mention=true (mention oficial @)
        const shouldForward = FORWARD_ALL || mentioned;

        if (!shouldForward) {
          logger.debug(
            {
              messageId,
              jid,
              from: fromDigits,
              mentioned,
              mentionedByContext,
              mentionedByText,
              hasQuoted,
              textPreview: text.slice(0, 120),
            },
            'Mensagem ignorada (sem mention oficial e FORWARD_ALL=false)'
          );
          continue;
        }

        // Nome do grupo
        let groupName = jid;
        try {
          const meta = await sock.groupMetadata(jid);
          groupName = meta?.subject || jid;
        } catch (e) {
          logger.debug(
            { jid, err: String(e) },
            'Falha ao buscar metadata do grupo (seguindo mesmo assim)'
          );
        }

        // Payload no formato que seu backend espera
        const payload = {
          messageId,
          groupId: jid,
          groupName,
          from: fromDigits || null,
          fromName: msg.pushName || fromDigits || 'Cliente',
          text,
          // extras pra log/debug
          mentioned,
          mentionedByContext,
          mentionedByText,
          hasQuoted,
          ts: Date.now(),
        };

        logger.info(
          {
            messageId,
            groupId: jid,
            from: fromDigits,
            mentioned,
            mentionedByContext,
            mentionedByText,
            hasQuoted,
            textPreview: text.slice(0, 120),
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
// HTTP server (status + QR)
// =========================

const INDEX_HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <title>BMP - Bot WhatsApp</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI',
          sans-serif;
        background: #020617;
        color: #e5e7eb;
        margin: 0;
        padding: 24px;
        display: flex;
        justify-content: center;
      }
      .container {
        max-width: 420px;
        width: 100%;
        background: #020617;
        border-radius: 16px;
        padding: 20px 20px 16px;
        border: 1px solid #1f2937;
      }
      h1 {
        font-size: 18px;
        margin: 0 0 4px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      h1 span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        background: #22c55e22;
        border: 1px solid #22c55e55;
        color: #22c55e;
        font-size: 13px;
      }
      .subtitle {
        font-size: 12px;
        color: #9ca3af;
        margin-bottom: 12px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        border-radius: 999px;
        border: 1px solid #374151;
        padding: 4px 10px;
        margin-bottom: 12px;
      }
      .status-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
      }
      .status-dot-ok {
        background: #22c55e;
      }
      .status-dot-warn {
        background: #f97316;
      }
      .status-dot-err {
        background: #ef4444;
      }
      .card {
        border-radius: 14px;
        border: 1px solid #1f2937;
        background: radial-gradient(circle at top left, #0f172a, #020617);
        padding: 12px 12px 10px;
        margin-bottom: 10px;
      }
      .card-title {
        font-size: 12px;
        color: #9ca3af;
        margin-bottom: 4px;
      }
      .card-value {
        font-size: 13px;
      }
      .qr-box {
        border-radius: 12px;
        border: 1px dashed #374151;
        padding: 12px;
        text-align: center;
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
        background: #020617;
        color: #e5e7eb;
        font-size: 11px;
        cursor: pointer;
      }
      .btn:active {
        transform: scale(0.97);
      }
      code {
        font-size: 11px;
        background: #020617;
        padding: 2px 4px;
        border-radius: 4px;
        border: 1px solid #111827;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>
        <span>WA</span>
        BMP - Bot WhatsApp
      </h1>
      <div class="subtitle">
        Monitor de conexão da instância e QRCode para login.
      </div>
      <div id="status"></div>
      <div id="qr"></div>
      <div class="card">
        <div class="card-title">Webhook configurado</div>
        <div class="card-value"><code>${WEBHOOK_URL}</code></div>
      </div>
      <button class="btn" onclick="window.location.reload()">
        Atualizar página
      </button>
    </div>
    <script>
      async function loadStatus() {
        try {
          const res = await fetch('/status');
          const data = await res.json();

          const statusEl = document.getElementById('status');
          const qrEl = document.getElementById('qr');

          const connState = data.connState;
          let dotClass = 'status-dot-warn';
          let label = 'Conectando...';

          if (connState === 'open') {
            dotClass = 'status-dot-ok';
            label = 'Conectado ao WhatsApp';
          } else if (connState === 'close') {
            dotClass = 'status-dot-err';
            label = 'Desconectado';
          } else if (connState === 'qr') {
            dotClass = 'status-dot-warn';
            label = 'Aguardando leitura do QRCode';
          }

          statusEl.innerHTML = \`
            <div class="status-pill">
              <span class="status-dot \${dotClass}"></span>
              <span>\${label}</span>
            </div>
            <div class="card">
              <div class="card-title">Número conectado</div>
              <div class="card-value">\${data.myJid || '—'}</div>
            </div>
          \`;

          if (data.qr) {
            qrEl.innerHTML = \`
              <div class="qr-box">
                <img src="\${data.qr}" alt="QR Code" />
                <div class="hint">
                  Abra o WhatsApp &gt; Configurações &gt; Aparelhos conectados &gt;
                  Conectar um aparelho.
                </div>
              </div>
            \`;
          } else {
            qrEl.innerHTML = '';
          }
        } catch (e) {
          console.error(e);
          const statusEl = document.getElementById('status');
          statusEl.innerHTML = '<div class="status-pill"><span class="status-dot status-dot-err"></span><span>Erro ao carregar status</span></div>';
        }
      }

      loadStatus();
      setInterval(loadStatus, 5000);
    </script>
  </body>
</html>
`;

// =========================
// HTTP server
// =========================

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          connState,
          myJid,
          myDigits,
          hasQR: !!latestQR,
          qr: latestQR ? await QRCode.toDataURL(latestQR) : null,
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
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
