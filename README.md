# Hide Haven WhatsApp Support Agent

Production WhatsApp customer-support agent for **Hide Haven** (Bangladesh, genuine leather
goods). Customers message the store's WhatsApp number; the agent answers product, price,
delivery and order questions in Bengali / Banglish / English, shows product photos, and
places **Cash on Delivery** orders directly into WooCommerce.

Runs self-hosted behind a private Cloudflare tunnel and serves live paying customers.

> 🔧 **Working on this codebase? Read [AGENT.md](AGENT.md) first.** It documents which code is
> live, the deployment procedure, known landmines and the current open risks.

---

## Features

- 💬 **WhatsApp native** — Baileys (WhatsApp Web multi-device); text, voice notes, photos,
  documents, stickers, locations and button taps are all handled.
- 🧠 **Tool-calling LLM brain** — DeepSeek-V4.1-Flash primary with a Gemini fallback chain.
- 🛍️ **Live catalog** — searches the real WooCommerce catalog; prices and stock always come
  from the store, never from the model's memory.
- 📸 **Sends real product photos** over WhatsApp on request.
- 🗣️ **Multimodal input** — voice notes transcribed, images analysed (product photos, payment
  screenshots, defect photos).
- 📦 **COD order placement** — collects name / phone / address / area and creates the order in
  WooCommerce, with delivery charges applied (Inside Dhaka 60৳ / Outside Dhaka 100৳).
- 🚚 **Order tracking** — by order ID or phone number (WooCommerce, falling back to the local
  order cache).
- 📚 **Knowledge base (RAG)** — policy/FAQ answers via pgvector semantic search.
- 🙋 **Human handoff** — escalates to the store admin with full context over WhatsApp; the bot
  pauses for that customer and resumes automatically after a period of human inactivity.
- 🔁 **Reliability** — de-duplicated inbound messages, idempotent queue jobs, per-customer
  serialisation, and automatic pruning of products deleted from the store.
- 📊 **Admin dashboard** — live conversations, escalations, human replies, catalog sync and
  WhatsApp connection control.

---

## Architecture

```
Customer WhatsApp
      │
┌─────▼──────────────────────────────┐
│ whatsapp_bridge/  (Baileys, :3001) │  decrypts media, debounces bursts,
│                                    │  de-duplicates, resolves LID → phone
└─────┬──────────────────────────────┘
      │ BullMQ job (Redis :6379, password-protected, loopback only)
┌─────▼──────────────────────────────┐
│ agent/  (TypeScript service, :3000)│
│  ├─ preprocessor   voice → text,   │
│  │                 image → text    │
│  ├─ brain          tool-calling    │
│  │                 loop (max 3)    │
│  ├─ rag            pgvector search │
│  └─ session        handoff locks   │
└─────┬──────────────────────────────┘
      ├──────────────┬───────────────┬────────────────┐
┌─────▼─────┐  ┌─────▼──────┐  ┌─────▼──────┐  ┌──────▼──────┐
│ DeepSeek  │  │  Gemini    │  │ WooCommerce│  │  Supabase   │
│ (primary) │  │ (fallback) │  │  REST API  │  │  Postgres   │
└───────────┘  └────────────┘  └────────────┘  └─────────────┘
```

Redis is both the job queue and the live pipeline's backbone — **if Redis is down the system
looks healthy but answers nobody.** See AGENT.md § "Landmines".

---

## Requirements

- **Node.js 18+** (this host runs v24) — for both services
- **Redis 6+** — message queue
- **PostgreSQL with pgvector** (Supabase) — sessions, messages, catalog, FAQ
- **WooCommerce REST API** credentials (WooCommerce ≥ 5)
- **API keys**: a DeepSeek key (primary brain) and a Gemini key (fallback brain, transcription,
  vision, embeddings)
- Python is **not** required for the live system (the legacy `app/` folder is unused)

---

## Repository layout

| Path | Role |
|---|---|
| `agent/` | **Live** TypeScript agent service (source in `src/`, build in `dist/`) |
| `whatsapp_bridge/` | **Live** Baileys WhatsApp transport |
| `dashboard/` | **Live** admin web UI (served by the agent at `/admin`) |
| `scripts/` | Ops helpers: `boot-services.sh`, `healthcheck.sh`, `backup.sh` |
| `data/faq.json` | FAQ knowledge base source (seeded into the database) |
| `wordpress-plugin/` | WooCommerce plugin that pushes catalog changes to the agent |
| `app/`, `tests/`, `test_*.py`, `logs/`, `data/*.csv` | **Legacy Python-era code and artifacts — not live** |
| `.env.example` (repo root), `requirements.txt`, `start_all.*`, `setup.*` | **Legacy** Python-era setup files — the live services use `agent/.env.example` and `whatsapp_bridge/.env.example` |

---

## Setup

```bash
# 1. Agent
cd agent
npm install
cp .env.example .env        # then fill in the values listed below
npx tsc                     # build → dist/  (the services run from dist/)

# 2. WhatsApp bridge
cd ../whatsapp_bridge
npm install
cp .env.example .env        # REDIS_PASSWORD must match the value in agent/.env
```

Every value marked `REQUIRED` in the templates must be filled in. In particular
`REDIS_PASSWORD` has to be **identical in both** `.env` files — if the two processes disagree,
the bridge drops inbound messages and the worker cannot pick them up.

Create the database schema:

```bash
psql "$DATABASE_URL" -f scripts/setup-supabase.sql
```

Seed the knowledge base and catalog:

```bash
cd agent
npm run sync:faq            # FAQ documents (idempotent — replaces the previous set)
npm run sync:products       # full catalog from WooCommerce (prunes deleted products)
```

---

## Configuration

`agent/.env`:

| Key | Purpose |
|---|---|
| `AI_PRIMARY_PROVIDER` | `deepseek` (primary brain) or `gemini` |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_EFFORT` | primary model |
| `GEMINI_API_KEY` | fallback brain, transcription, vision, **embeddings** |
| `GEMINI_BRAIN_MODEL`, `GEMINI_CHAT_MODEL`, `GEMINI_CHAT_FALLBACK_MODEL`, `GEMINI_TRANSCRIBE_MODEL`, `GEMINI_EMBEDDING_MODEL` | Gemini model selection |
| `DATABASE_URL` / `DB_*` | Supabase Postgres (session pooler) |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | queue; **the password is mandatory** |
| `WOOCOMMERCE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET` | store REST API |
| `WHATSAPP_BRIDGE_URL`, `WHATSAPP_ADMIN_PHONE` | bridge URL and escalation recipient |
| `AGENT_PORT`, `ADMIN_PASSWORD`, `WEBHOOK_SECRET` | HTTP service, dashboard auth, plugin auth |
| `HUMAN_HANDOFF_TIMEOUT_MINUTES` | minutes of human silence before the bot resumes (default 30) |
| `LOG_LEVEL` | `info` / `debug` |

`whatsapp_bridge/.env`: `BRIDGE_HTTP_PORT`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`,
`AUTH_DIR`, `LOG_LEVEL`.

⚠️ **Never commit `.env` files.** They hold the WhatsApp session, database and admin secrets.

---

## Running

All processes are managed by PM2 (`ecosystem.config.js` defines the two app services):

```bash
pm2 start ecosystem.config.js     # hh-agent + whatsapp-bridge
pm2 logs hh-agent
pm2 restart hh-agent              # after a rebuild of dist/
```

**First run:** the bridge prints a QR code (also shown at `/admin`). Scan it with the store's
phone → WhatsApp → *Linked devices*. Credentials are then stored in
`whatsapp_bridge/auth_info/` — that directory is the store's WhatsApp account. Back it up and
never delete it.

> **Redis is not managed by PM2.** `pm2 resurrect` / `pm2 start` will *not* start it. To bring
> the whole stack up (Redis included), use:
>
> ```bash
> sh scripts/boot-services.sh
> ```
>
> It is idempotent, starts Redis with the correct flags, makes sure the PM2 apps are running
> without duplicating them, and verifies everything afterwards.

---

## Operations

```bash
sh scripts/healthcheck.sh    # exit 0 = healthy; checks Redis, agent, DB, WhatsApp link,
                             # queue backlog, failed jobs, stuck handoffs, provider failovers
sh scripts/backup.sh         # session + secrets + source + DB dump → /backups/hh-agent
```

- Nightly cron jobs live in `/etc/periodic/daily/` (`hh-agent-backup`, `hh-agent-logrotate`).
- Backups are **local** — copy them off the machine; a backup on the box that dies is not a backup.
- Logs: `pm2 logs` (application logs), `/root/.pm2/logs/*.log`, `logs/escalations.jsonl`.

---

## Admin dashboard and API

Dashboard: `http://<host>:3000/admin` (bearer token = `ADMIN_PASSWORD`).

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | service + database status (unauthenticated) |
| POST | `/api/webhook/product-sync` | WooCommerce plugin → catalog sync / delete (secret header) |
| POST | `/api/admin/login` | validate admin password |
| GET | `/api/admin/conversations` | conversation list (and escalations) |
| GET | `/api/admin/conversation/:phone` | full thread for one customer |
| POST | `/api/admin/reply` | send a message to a customer **as the store** |
| POST | `/api/admin/lock-ticket` · `/api/admin/close-ticket` | take over / release a conversation |
| POST | `/api/admin/sync-catalog` | full catalog re-sync |
| GET/POST | `/api/admin/settings` | runtime settings |
| GET | `/api/admin/whatsapp/status` | bridge + connection state |
| POST | `/api/admin/whatsapp/reset` · `/toggle-pause` | re-pair / pause the bot |
| POST | `/api/admin/test-alert` | send a test escalation to the admin phone |

**Bridge API** (loopback only, no auth): `POST /send`, `POST /send-image`, `GET /qr`,
`GET /status`, `POST /pause`, `POST /reset`.

**Agent tools** the model can call: `search_products`, `send_product_images`,
`search_knowledge_base`, `lookup_order`, `place_order`, `request_human_escalation`.

---

## Data model

| Table | Contents |
|---|---|
| `sessions` | per-customer state: handoff lock, reason, metadata |
| `messages` | full conversation transcript (user / assistant / human / system) |
| `products` | catalog mirror with `VECTOR(768)` embeddings |
| `documents` | FAQ / policy knowledge base with embeddings |
| `customer_orders` | local order cache for tracking |
| `agent_settings` | dashboard-editable runtime settings |

Queue: BullMQ `whatsapp-incoming` (worker concurrency 3, serialised per customer).

---

## Managing content

- **FAQ / policy** — edit `data/faq.json`, then `cd agent && npm run sync:faq`. Re-seeding
  replaces the previous FAQ set, so stale answers do not linger.
- **Catalog** — WooCommerce is the source of truth. Either `npm run sync:products`, hit
  `POST /api/admin/sync-catalog`, or let the WordPress plugin push changes. Products deleted
  from the store are removed from the agent's catalog.
- **Delivery charges / order wording** — `agent/src/brain/prompt.ts` and
  `agent/src/brain/tools.ts`: Inside Dhaka 60৳, Outside Dhaka 100৳, **free delivery on orders
  of 2000৳ or more**, Cash on Delivery, 2-year warranty on leather products.
- **Discounts** — the welcome coupon `comeback10` (10% off, max order 3000৳, one use per
  customer) is described in `agent/src/brain/prompt.ts` and is **applied to the WooCommerce
  order** by `place_order` when the customer asks for it and is genuinely new (checked against
  order history). The coupon itself lives in WooCommerce → Marketing → Coupons.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| PM2 all green but no replies | Redis is down or the app/Redis passwords disagree. Run `sh scripts/healthcheck.sh`; start Redis via `scripts/boot-services.sh` (never bare `redis-server`). |
| `NOAUTH Authentication required` from redis-cli | Expected — Redis requires a password. Use `REDISCLI_AUTH=$(grep -m1 '^REDIS_PASSWORD=' agent/.env \| cut -d= -f2-) redis-cli ping`. |
| Dashboard shows a QR code | The WhatsApp session was logged out. Re-pair by scanning from the store's phone. |
| Replies are slow (tens of seconds) | Normal range (p50 ≈ 9 s, p90 ≈ 23–37 s) — the multi-step tool loop plus provider calls. Spikes usually mean provider failovers (`trying next candidate` in the logs). |
| Customer complaints about no reply after escalation | The bot pauses for escalated chats and resumes after `HUMAN_HANDOFF_TIMEOUT_MINUTES` of human silence. |
| `Failed to enqueue consolidated message` | Redis unreachable — messages are being dropped. Fix Redis immediately. |
| A change to `agent/src` had no effect | `dist/` is what runs: `npx tsc && pm2 restart hh-agent`. |

---

## Notes

- This is a **private, single-tenant deployment** for one store; there is no CI, no git
  repository and no automated test suite for the live services. Verify changes with
  `scripts/healthcheck.sh` after deploying.
- The services are single-instance by design: the per-customer queue lock is in-process, so
  running more than one `hh-agent` worker would allow concurrent jobs for the same customer
  (duplicate replies or orders).

**Version**: 2.0.0 · **Status**: live in production
