WhatsApp Group Collector (Baileys) → Supabase
=============================================

Coletor local usando Baileys (API não-oficial) para ler mensagens de grupos, filtrar por tag/mention e enviar via webhook para seu endpoint (ex.: Render, Supabase, etc.). O payload enviado segue o formato:

{
  "messageId": "...",
  "groupId": "<jid do grupo>",
  "groupName": "...",
  "fromName": "...",
  "from": "<telefone>",
  "text": "...",
  "tags": ["@mencoes", "chave:valor"]
}

1) Pré-requisitos
- Node 18+ (com `fetch` global)
- Uma conta/telefone para parear (QR code)
- Projeto Supabase ativo

2) Configuração
- Copie `.env.example` para `.env` e configure:
  - `WEBHOOK_URL` → URL do seu endpoint (ex.: https://wpp-bmp-1.onrender.com/api/webhooks/zapi)
  - `WEBHOOK_SECRET` → opcional, se seu endpoint validar um header `x-webhook-secret`
  - `TAG_REGEX` → regex da sua tag, ex.: `#minhaTag`
  - `MY_PHONE` → opcional, para detectar mentions ao seu número (sem +)
  - `FORWARD_ALL` → `false` (padrão) envia só mensagens que casam com TAG/mention; `true` envia tudo

3) Instalar & Rodar
```bash
cd wa-collector
npm install
npm start
# escaneie o QR exibido no terminal
```

Sessão fica em `./auth`. Use `npm run clean-auth` para resetar o pareamento.

4) Endpoint de destino (exemplos)
- Render / API própria: use `WEBHOOK_URL` e, se quiser, `WEBHOOK_SECRET` para validar.
- Supabase Edge Function (opcional): código exemplo em `supabase/functions/ingest/index.ts` e SQL em `supabase/sql/messages.sql`.

6) Fluxo de filtragem
- Apenas mensagens de grupos (`remoteJid` termina com `@g.us`).
- `TAG_REGEX` aplicada no texto/caption da mensagem.
- `MY_PHONE` ativa detecção de mentions reais.

7) Observações
- `groupId` atualmente envia o JID do WhatsApp (ex.: `1203...@g.us`). Se você precisar de um formato específico (ex.: `5511...-group`), avise para ajustarmos a transformação.
- Risco: API não-oficial pode sofrer instabilidade/ban. Faça backup de `./auth`.
