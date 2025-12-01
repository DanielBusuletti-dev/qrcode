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

// =====================
// Logger
// =====================
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// =====================
// Config .env
// =====================
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || './auth';

const WEBHOOK_URL = process.env.WEBHOOK_URL?.trim() || '';
const FORWARD_ALL =
  String(process.env.FORWARD_ALL || '').toLowerCase() === 'true';

const TAG_REGEX = process.env.TAG_REGEX
  ? new RegExp(process.env.TAG_REGEX, 'i')
  : null;

// NÃO usamos mais MY_PHONE – agora pegamos o número da sessão
// const MY_PHONE = process.env.MY_PHONE || '';

// =====================
// Estado global
// =====================
let sock;
let lastQrString = null;
let myJid = null; // ex: '5511963367878@s.whatsapp.net'

// =====================
// Helpers de mensagem
// =====================

// Desembrulha mensagens efêmeras / viewOnce etc.
function unwrapMessage(message) {
  if (!message) return {};
  if (message.ephemeralMessage) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  return message;
}

// Extrai o texto da mensagem (conversation, extended, caption, etc.)
function getTextFromContent(content) {
  if (!content) return '';

  if (content.conversation) return content.conversation;

  if (content.extendedTextMessage?.text) {
    return content.extendedTextMessage.text;
  }

  if (content.imageMessage?.caption) {
    return content.imageMessage.caption;
  }

  if (content.videoMessage?.caption) {
    return content.videoMessage.caption;
  }

  return '';
}

// Extrai contextInfo de vários lugares possíveis
function getContextInfoFrom(anyMsg) {
  if (!anyMsg) return undefined;

  // extendedTextMessage
  if (anyMsg.extendedTextMessage?.contextInfo) {
    return anyMsg.extendedTextMessage.contextInfo;
  }

  // mídia com contextInfo
  if (anyMsg.imageMessage?.contextInfo) return anyMsg.imageMessage.contextInfo;
  if (anyMsg.videoMessage?.contextInfo) return anyMsg.videoMessage.contextInfo;

  // fallback genérico
  if (anyMsg.contextInfo) return anyMsg.contextInfo;

  return undefined;
}

// Envia para o webhook do seu backend
async function sendWebhook(body) {
  if (!WEBHOOK_URL) {
    logger.warn(
      { body },
      'WEBHOOK_URL não configurada – mensagem não enviada ao backend'
    );
    return;
  }

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    logger.info(
      { status: res.status },
      'Webhook enviado com sucesso'
    );
  } catch (err) {
    logger.error({ err }, 'Erro ao enviar webhook');
  }
}

// =====================
// Handler de mensagens
// =====================
async function handleMessagesUpsert(upsert) {
  const { messages, type } = upsert;

  if (type !== 'notify') return;
  if (!messages?.length) return;

  for (const msg of messages) {
    try {
      const jid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;

      // Só grupos
      const isGroup = jid?.endsWith('@g.us');
      if (!isGroup) continue;

      // Ignora mensagens minhas
      if (fromMe) continue;

      const rawMessage = msg.message;
      if (!rawMessage) continue;

      const unwrapped = unwrapMessage(rawMessage);
      const text = getTextFromContent(unwrapped);
      const contextInfo =
        getContextInfoFrom(unwrapped) || getContextInfoFrom(rawMessage) || {};

      const sender =
        msg.participant ||
        msg.key.participant ||
        contextInfo.participant ||
        'unknown';

      const timestamp =
        (msg.messageTimestamp &&
          Number(msg.messageTimestamp.toString())) ||
        Date.now();

      // ============
      // DETECÇÃO DE MENÇÃO POR CONTEXTO (OFICIAL DO WHATSAPP)
      // ============
      const mentionedSet = new Set();

      if (Array.isArray(contextInfo.mentionedJid)) {
        for (const j of contextInfo.mentionedJid) {
          try {
            mentionedSet.add(jidNormalizedUser(j));
          } catch {
            // ignora erros de normalização
          }
        }
      }

      // Alguns formatos novos usam groupMentions
      if (Array.isArray(contextInfo.groupMentions)) {
        for (const m of contextInfo.groupMentions) {
          if (m?.userJid) {
            try {
              mentionedSet.add(jidNormalizedUser(m.userJid));
            } catch {}
          }
          if (m?.groupMember) {
            try {
              mentionedSet.add(jidNormalizedUser(m.groupMember));
            } catch {}
          }
        }
      }

      // participant também pode ser o mencionado em alguns casos
      if (contextInfo.participant) {
        try {
          mentionedSet.add(jidNormalizedUser(contextInfo.participant));
        } catch {}
      }

      const hasQuoted =
        !!contextInfo.quotedMessage || !!contextInfo.quotedStanzaID;

      const isMentionedByContext =
        myJid && mentionedSet.has(myJid);

      // ATENÇÃO:
      // Agora NÃO usamos mais texto “5511...”
      // Só considera menção real do WhatsApp (@ + selecionar o contato).
      const isMentioned = isMentionedByContext;

      // Log de debug forte (NÍVEL INFO pra aparecer no Render)
      logger.info(
        {
          messageId: msg.key.id,
          groupId: jid,
          from: sender,
          mentioned: isMentioned,
          mentionedByContext: isMentionedByContext,
          hasQuoted,
          myJid,
          mentionedJids: Array.from(mentionedSet),
          textPreview: text?.slice(0, 80),
        },
        'Debug de detecção de menção em grupo'
      );

      // =========================
      // Regra de encaminhamento
      // =========================
      let shouldForward = false;

      if (FORWARD_ALL) {
        // modo debug: manda tudo (se ativar no .env)
        shouldForward = true;
      } else {
        // Apenas quando sou realmente mencionado
        shouldForward = isMentioned && !hasQuoted;
      }

      if (!shouldForward) continue;

      // Opcional: filtro por TAG_REGEX se estiver configurado
      if (TAG_REGEX && !TAG_REGEX.test(text || '')) {
        logger.info(
          { messageId: msg.key.id },
          'Mensagem ignorada pelo TAG_REGEX'
        );
        continue;
      }

      const payload = {
        messageId: msg.key.id,
        groupId: jid,
        from: sender,
        text,
        timestamp,
        mentioned: isMentioned,
        hasQuoted,
      };

      logger.info(
        {
          messageId: payload.messageId,
          groupId: payload.groupId,
          from: payload.from,
          mentioned: payload.mentioned,
          hasQuoted: payload.hasQuoted,
          textPreview: payload.text?.slice(0, 80),
        },
        'Enviando webhook de mensagem'
      );

      await sendWebhook(payload);
    } catch (err) {
      logger.error({ err }, 'Erro no processamento de uma mensagem');
    }
  }
}

// =====================
// Baileys + conexão
// =====================
async function createSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info({ version, isLatest }, 'Usando versão do WhatsApp / Baileys');

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['BMP SLA Bot', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQrString = qr;
      logger.info('Novo QRCode gerado');
    }

    if (connection) {
      logger.info(
        { connection },
        'Estado da conexão atualizado'
      );
    }

    if (connection === 'open') {
      if (sock?.user?.id) {
        myJid = jidNormalizedUser(sock.user.id);
        logger.info(
          { myJid, user: sock.user },
          'Conectado ao WhatsApp'
        );
      }
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode || 0;

      logger.warn(
        { code: statusCode },
        'Conexão fechada'
      );

      if (statusCode === DisconnectReason.loggedOut) {
        logger.error(
          'Sessão foi deslogada, é preciso apagar auth/ e escanear novamente.'
        );
      } else {
        logger.info('Tentando reconectar ao WhatsApp...');
        setTimeout(() => {
          createSock().catch((err) =>
            logger.error({ err }, 'Erro ao tentar reconectar')
          );
        }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    handleMessagesUpsert(m).catch((err) =>
      logger.error({ err }, 'Erro no handler messages.upsert')
    );
  });
}

// =====================
// HTTP server (Render)
// =====================
const server = http.createServer(async (req, res) => {
  try {
    const { method, url } = req;

    if (method === 'GET' && url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      res.end('WA Group Collector rodando');
      return;
    }

    if (method === 'GET' && url === '/health') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          connected: !!sock?.user,
          myJid,
        })
      );
      return;
    }

    if (method === 'GET' && url === '/qrcode') {
      if (!lastQrString) {
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('QR Code ainda não gerado');
        return;
      }

      try {
        const dataUrl = await QRCode.toDataURL(lastQrString);
        const base64 = dataUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');

        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(buffer);
      } catch (err) {
        logger.error({ err }, 'Erro ao gerar QRCode em PNG');
        res.writeHead(500, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        res.end('Erro ao gerar QRCode');
      }
      return;
    }

    // Qualquer outra rota
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Not found');
  } catch (err) {
    logger.error({ err }, 'Erro no HTTP server');
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
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
