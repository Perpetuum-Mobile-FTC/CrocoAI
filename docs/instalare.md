# Installing CrocoAI

This guide covers a production setup on one Linux host with Docker. The UI and the design documents are in Romanian,
and this guide is in English.

## 1. Requirements

- Docker with the Compose plugin.
- A domain with HTTPS in front of the app. We use a Cloudflare Tunnel, but any reverse proxy works. The app listens
  on `127.0.0.1:3001` only.
- Optional: a WhatsApp gateway (see §4), AI provider keys (§5) and a Groq key for meeting transcription.

## 2. Configure

```bash
git clone <this repo> crocoai && cd crocoai/app
cp .env.example .env && chmod 600 .env
```

At minimum, set these in `app/.env`:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Long random string (`openssl rand -hex 32`) |
| `ADMIN_INITIAL_PASSWORD` | Password of the first account, created once on an empty database. It must be changed at first login. |
| `ADMIN_USERNAME`, `ADMIN_FULL_NAME`, `ADMIN_PHONE` | The first account (team leader) |
| `APP_BASE_URL` | Public URL, used in links sent on WhatsApp (e.g. `https://crocoai.example.org`) |
| `ATTENDANCE_QR_SECRET` | Random string that signs the attendance QR codes (falls back to `JWT_SECRET`) |
| `WA_NETWORK` | Docker network shared with the WhatsApp gateway (§4) |

Everything else is optional and documented inline in `.env.example`.

## 3. Run

```bash
docker network create crocoai-wa       # once; use the same name in WA_NETWORK
docker compose up -d --build
curl -s localhost:3001/api/health      # {"ok":true,...}
```

All data lives in `app/data/`: the SQLite database, uploaded documents, meeting audio, photos and resources. Back up
that directory. The database is migrated automatically at start, and a copy is saved before each migration.

To update, run `git pull && docker compose up -d --build`.

## 4. WhatsApp gateway

CrocoAI does not talk to WhatsApp directly. It expects a small HTTP gateway built on
[whatsapp-web.js](https://wwebjs.dev) on the Docker network `WA_NETWORK`, reachable at `WA_GATEWAY_URL`.

The gateway must expose these endpoints, which CrocoAI calls:

| Endpoint | Body / result |
|---|---|
| `POST /send` | `{ to, text }`. `to` is digits (`407...`) or a group id (`...@g.us`) |
| `GET /resolve/:number` | `{ wid }`, or `{ wid: null }` / 404 if the number is not on WhatsApp; 503 when the gateway is not connected |
| `GET /groups` | `[{ id, name }]` for the groups the number is in |
| `POST /group/participants` | `{ groupId, phone, action: "add" \| "remove" }` → `{ ok, code, message }` |
| `GET /group/:id/invite` | `{ link }` |
| `GET /health` | 200 when connected |

If `LUCID_INTERNAL_KEY` is set, every call carries the header `X-Lucid-Key`.

The gateway must also forward incoming messages to CrocoAI:

- `POST /wa/incoming` with header `X-WA-Secret: <WA_SHARED_SECRET>` and the body
  `{ msgId, from, pushName, text, isGroup, groupId, groupName, mentioned, quotedFromMe, hasMedia, mediaType }`.
- `POST /wa/media` for photos and documents sent to the bot, with
  `{ msgId, from, groupId, mediaType, mimetype, filename, caption, data }`, where `data` is base64.

Both routes reject requests coming through Cloudflare (`cf-connecting-ip`), so they are reachable only on the
internal network.

Without a gateway the platform still works, but notifications are only shown in the app.

## 5. AI

Set any of the providers below. They are tried in this order, and a failed provider is skipped for
`AI_PROVIDER_COOLDOWN_MIN` minutes:

1. `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (the model is `AI_MODEL`)
2. `CLAUDE_CODE_OAUTH_TOKEN_BACKUP`
3. `QWEN_BASE_URL` + `QWEN_API_KEY` + `QWEN_MODEL`: any OpenAI-compatible endpoint
4. `GROQ_API_KEY` + `GROQ_CHAT_MODEL`

These limits keep costs under control: `AI_DAILY_LIMIT_MEMBER`, `AI_DAILY_TOKEN_BUDGET` and
`AI_DAILY_COST_ALERT_USD`. Measured costs with Claude Sonnet are about $0.01–0.06 per question.

## 6. Backups and monitoring (recommended)

- Back up `app/data/` and `app/.env` every day to another location. Use
  `sqlite3 crocoai.db ".backup ..."` or `VACUUM INTO` for a consistent copy of the database. Test a restore regularly.
- Monitor `GET /api/health` from outside the host.
- Rotate the logs of any cron jobs.

## 7. First steps after install

1. Log in with `ADMIN_USERNAME` / `ADMIN_INITIAL_PASSWORD` and change the password.
2. In **Admin**, check the deadlines, the WhatsApp groups (mark the ones the bot should follow) and the FTC manual.
3. Share the registration link (`/inscriere`) with the team. New members verify their phone with a WhatsApp
   code, and you approve the requested roles under **Admin → Cereri de rol**.
