# AGENT.md — Hide Haven WhatsApp Support Agent

> **This is a LIVE production system serving real paying customers.** Read this file before
> changing anything. Last updated: 2026-10-15 (after a full audit + remediation session).

---

## 1. What is live right now (read this first)

There are **three** implementations in this repo. Only ONE is live:

| Implementation | Status |
|---|---|
| **`agent/` — TypeScript** (PM2 `hh-agent`, port 3000) | ✅ **LIVE — this is the real one** |
| **`whatsapp_bridge/` — Node/Baileys** (PM2 `whatsapp-bridge`, 127.0.0.1:3001) | ✅ **LIVE transport** |
| `app/*.py` — old Ollama/Flask Python agent | ❌ Dead. Not running, not scheduled. Ignore it. |

**Legacy traps — do NOT treat as truth:**
- `README.md` describes the **old Python** architecture. It is misleading.
- `data/product_data.csv` is a **stale 2026-10-11 export**. Its price columns are
  regular-vs-sale and disagree with the live store. **Never use it as the source of truth.**
  (It caused a false "the prompt invents products" finding during the audit.)
- `logs/+*.json` are **Python-era conversation dumps from 2026-05**, not current traffic.
- `app/agent.py:171` contains old canned dead-end replies ("I can't help with that right
  now…") — if you see those in `logs/*.json`, that is history, not current behaviour.
- `dashboard/**` **IS live** (served by the agent at `/admin`).
- The WordPress plugin runs on the **store host** (`shop.hidehaven.me`), not this box.

---

## 2. Architecture and data flow

```
Customer WhatsApp
   └─> whatsapp_bridge/whatsapp-bridge.js   (Baileys; 3s debounce buffer; dedupe by msg.key.id)
        └─> Redis BullMQ queue "whatsapp-incoming"  (127.0.0.1:6379, password-protected)
             └─> agent/src/queue/worker.ts      (concurrency 3; per-customer mutex)
                  └─> agent/src/preprocessor    (voice→text, image→text)
                       └─> agent/src/brain/agent.ts  (tool loop, max 3 iterations)
                            ├─ DeepSeek-V4.1-Flash  = PRIMARY brain (AI_PRIMARY_PROVIDER=deepseek)
                            ├─ Gemini               = fallback (FREE TIER — see §7)
                            ├─ WooCommerce REST     = catalog, orders
                            └─ Supabase Postgres    = sessions, messages, products, documents
                       └─> reply back via bridge  POST 127.0.0.1:3001/send
```

Redis is **also** the queue *and* session/handoff cache path. If Redis is down, the whole
pipeline stalls silently (WhatsApp stays connected but no message is ever processed).

---

## 3. Operating it

```sh
pm2 list                      # filebrowser, cloudflare-tunnel, hh-agent, whatsapp-bridge
pm2 logs hh-agent             # app log (pino-pretty, all levels → stdout)
pm2 restart hh-agent          # ⚠️ ask the owner before restarting in production
```

- **Agent**: `http://127.0.0.1:3000` — `/health` (unauthenticated), `/admin` (dashboard).
- **Bridge**: `http://127.0.0.1:3001` — `/qr`, `/send`, `/send-image`, `/pause`, `/reset`
  (no auth; loopback-bound).
- Public: `agent.apigateway.live` → agent. Also tunnels ttyd (root shell), filebrowser, ssh.

**Two helper scripts exist — use them:**

```sh
sh scripts/healthcheck.sh     # exit 0 = healthy. Checks Redis, agent, DB, WhatsApp link,
                              # queue backlog, failed jobs, stuck handoffs, provider failovers.
sh scripts/backup.sh          # WhatsApp session + .env + source + pg_dump → /backups/hh-agent
sh scripts/boot-services.sh   # idempotent: starts Redis (loopback+auth), ensures PM2 apps. Idempotent.
```

Cron (`crond` + `/etc/periodic/daily`, installed 2026-10-15):
`hh-agent-backup` (02:00 daily) and `hh-agent-logrotate`.

**Backups are local only** — copy `/backups/hh-agent/*` off this machine. A backup on the
box that dies is not a backup.

---

## 4. Deploying a change (important)

`dist/` is what runs, not `src/`:

```sh
cd agent
npx tsc --noEmit          # typecheck
npx tsc                   # BUILD — required before restart, or your change does nothing
pm2 restart hh-agent
```

The bridge needs **no build step** (plain JS) — but it does need a `pm2 restart whatsapp-bridge`.

⚠️ A rebuild changes what the *next* restart will run even before you restart. Mention it.

**There is no git repository and no CI.** Nothing protects you from a bad deploy, and there
is no testsuite for the live TypeScript agent (existing tests target the dead Python app).

---

## 5. Environment

- Alpine Linux inside a **chroot**. `/sbin/openrc` **does not exist**, so `/etc/inittab`'s
  `openrc` lines are no-ops. Boot is driven by a **host-side script outside the chroot**
  (keeps cloudflare/ssh/pm2 up) — it cannot be edited from in here.
- ⚠️ **Add this line to that host boot script**: `/bin/sh /projects/HH-agent/scripts/boot-services.sh`
  It is currently unknown whether Redis starts at boot at all; before 2026-10-15 it was
  started **by hand**, and would have been missing after any reboot (bot silently dead).
- `pm2 save` has been run, so `dump.pm2` holds all four apps with `autostart: true`.

---

## 6. Current status (2026-10-15)

### Fixed, deployed and verified this session

| Area | Change |
|---|---|
| Orders | `product_id \|\| 234` fallback removed (it silently ordered the wrong product). Unresolved products now **fail loudly**. Catalog is authoritative for price. |
| Orders | A failed WooCommerce call used to report **success with an invented `HH-xxxxxx` order number**. Now reports failure + escalates. |
| Stock | `place_order` refuses `outofstock`; prompt requires verifying stock via `search_products` before offering/ordering. |
| Brain | Cross-provider 400 cascade fixed (DeepSeek parts poisoned Gemini's `contents`) — this caused the "temporarily experiencing high traffic" dead-ends. Empty-response retry loop stopped. |
| Media | Video/document/sticker/location/buttons no longer dropped. **Disappearing-messages & view-once are now unwrapped** (previously *every* message from such a customer was dropped). Failed media download now yields a reply, not silence. |
| Identity | LID→phone resolved from `auth_info/lid-mapping-*_reverse.json`; sessions/orders/escalations use a real contactable number. |
| Dedupe | `msg.key.id` in-memory dedupe + BullMQ `jobId` idempotency (no double replies / duplicate COD orders). |
| Catalog | Deleted/trashed products pruned (indexer reconcile + WP delete/trash/untrash hooks; abort-without-prune on store outage). |
| Handoff | `HUMAN_HANDOFF_TIMEOUT_MINUTES` **now actually works** (it was read nowhere → a locked session stayed locked **forever**). Lease refreshes when a human replies; plus a sweeper. |
| FAQ | 20 placeholder US docs (PayPal, $100 free shipping, credit cards) replaced with real policy (COD, 60/100 BDT, 30-day exchange). Re-seeding is now idempotent. |
| Redis | Was `0.0.0.0:6379`, **no password**, running as root. Now `bind 127.0.0.1` + `requirepass` + AOF, data in `/var/lib/hh-redis`. |
| Ops | `boot-services.sh`, `healthcheck.sh`, `backup.sh`, nightly backup + log rotation cron, `pm2 save`, file modes tightened. |
| Policy | 2-year warranty + free delivery over 2000 BDT added to the prompt, the FAQ (24 docs) and `place_order` (free delivery is actually applied). New-customer coupon `comeback10` documented and applied to orders; the coupon had **expired** on 2026-10-11 and was re-dated to 2030-12-31 in WooCommerce. |

### ⚠️ NOT yet done — these need the owner

1. **WhatsApp re-pairing.** On 2026-10-15 at 21:36 a transient 503 wiped
   `whatsapp_bridge/auth_info` (see §7). The session must be re-created by scanning a QR at
   `/admin` with the store's phone. Until then `isConnected:false` and **customers get no
   replies**. The bridge fix that prevents recurrence **is** deployed.
2. **Leaked credentials not rotated.** `agent/src/config.ts` hardcodes working fallbacks for
   the DB password, admin dashboard password and webhook secret — and **`.env` uses those same
   values**, while `dist/config.js` ships them. The dashboard is internet-exposed.
   **This is the biggest open risk.**
3. **Dashboard stored XSS** — `dashboard/app.js:476` puts `conv.last_message` (customer text)
   into `innerHTML`. A customer can run JS in the admin's browser and steal the admin token.
   Fixed only for the message bubbles, not the sidebar.
4. **WP plugin re-upload** — `wordpress-plugin/hh-agent-sync/hh-agent-sync.php` gained
   delete/trash hooks; must be uploaded to the store host to take effect.
5. **Untested:** a successful `place_order` has never been exercised (would create a real COD
   order). Also unverified: whether the admin's reply to a LID after a bridge restart routes
   correctly.
6. Smaller, not approved: Shopify-style items in the audit that were left alone — admin API
   has no rate limiting, `cors()` is wildcard, 15 MB JSON body parsed before auth, PM2 logs
   and `escalations.jsonl` hold PII in plaintext, `ttyd` exposes a root shell via the tunnel,
   logrotate is not installed (custom cron used instead).

---

## 7. Landmines / operational gotchas

- **Redis now needs a password.** `REDIS_PASSWORD` is in *both* `agent/.env` and
  `whatsapp_bridge/.env`. A bare `redis-cli` returns `NOAUTH` — that is expected, not broken.
  Use: `REDISCLI_AUTH=$(grep -m1 '^REDIS_PASSWORD=' agent/.env | cut -d= -f2-) redis-cli …`
  **Never** start `redis-server` without `--bind 127.0.0.1 --requirepass …`; use
  `boot-services.sh`. If Redis and the apps disagree on the password, everything stalls.
- **Never delete `auth_info`.** It is the store's whole WhatsApp account credential. It used
  to be `fs.rmSync`'d on *any* unrecognised disconnect — a transient 503 destroyed the live
  session on 2026-10-15 with no backup. Now only 401/500/411/403 count as a logout, and even
  then the directory is **quarantined** to `auth_info.broken-<timestamp>` (restorable by
  moving it back). Do not reintroduce deletion.
- **Gemini is on the FREE TIER** (20 requests/day/model). It is only the *fallback*; DeepSeek
  is primary. The 429 storm of 2026-10-15 came from Gemini being primary — check
  `AI_PRIMARY_PROVIDER` before blaming latency. Provider failovers appear in the log as
  `trying next candidate`.
- **Latency expectations:** median ~9 s, p90 23–37 s per message (multi-step tool loop +
  provider calls). This is normal, not a bug, though it is slow for WhatsApp.
- **Handoff semantics:** a session locks on escalation and **auto-releases 30 minutes after
  the last human activity** (tunable via `HUMAN_HANDOFF_TIMEOUT_MINUTES`). A human reply
  refreshes the lease.
- **Out-of-stock gating is deliberate:** `search_products` returns `available:false` for
  anything whose `stock_status != 'instock'`, and `place_order` refuses those. A product whose
  `stock_status` is unknown (thin webhook payload) is treated as **not sellable** until a full
  sync — conservative by design.
- **`pm2 resurrect` duplicates apps** if they are already running (→ two queue workers → double
  replies/orders). `boot-services.sh` guards against this; do the same if you script it.
- **`logs/*.json`, `dump.rdb` in the project dir, and `data/*.csv`** are stale artifacts.
- **PII everywhere:** customer phone numbers, addresses, message text and base64 media live in
  Supabase, `escalations.jsonl`, PM2 logs and (previously) `dump.rdb`. Treat all of it as
  sensitive; do not print it into transcripts.
- **Do not** call `/send` or `/send-image` on the bridge, `place_order`, or the admin reply
  endpoint except in a deliberate test — they message **real customers**. 8801999999998/9 and
  8801234567890 in the data are test numbers.
- **Store policy facts** (confirmed by the owner 2026-10-15, and now enforced in code):
  Inside Dhaka 60 BDT (2–3 days), Outside Dhaka 100 BDT (3–5 days), **Cash on Delivery
  nationwide**, 30-day exchange/return for unused goods in original condition,
  **2-year warranty on all leather products**, and **free delivery on orders of 2000 BDT or
  more** (threshold applies to the product total before discount).
  Plus the **new-customer coupon `comeback10`** — 10% off, max order 3000 BDT, one use per
  customer; `place_order` attaches it to the WooCommerce order itself (see below).
  Do **not** state cards, bKash or PayPal — still unconfirmed.
  The live catalog is **23 named products / 30 SKU rows**, and `agent/src/brain/prompt.ts`
  matches the DB (verified).
- **Discounts are policy, not free-form.** `place_order` takes
  `apply_new_customer_discount`; the server verifies "new customer" against
  `customer_orders` and silently skips the coupon for repeat customers or subtotals above
  3000 BDT (WooCommerce would otherwise reject the entire order). If you change the coupon,
  change `NEW_CUSTOMER_COUPON` in `agent/src/brain/tools.ts`, the promo section of
  `agent/src/brain/prompt.ts`, and `data/faq.json` together, then re-seed.

---

## 8. Where things live

```
agent/src/config.ts            all config + model IDs (⚠ hardcoded secret fallbacks here)
agent/src/index.ts             HTTP API, admin routes, webhook, handoff sweeper
agent/src/brain/agent.ts       tool loop, provider fallback, escalation triggers
agent/src/brain/tools.ts       the 6 tools; place_order safety lives here
agent/src/brain/prompt.ts      system prompt + catalog + stock/order rules
agent/src/brain/deepseek.ts    primary provider (+ formatMessages id reconciliation)
agent/src/brain/gemini.ts      fallback provider, vision, transcription, embeddings
agent/src/queue/worker.ts      BullMQ worker, per-customer mutex, outbound send
agent/src/session/manager.ts   sessions, human-handoff lock + expiry
agent/src/rag/indexer.ts       product/document indexing + stale-product pruning
agent/src/preprocessor/        media → text
whatsapp_bridge/whatsapp-bridge.js   Baileys: ingest, dedupe, LID→PN, reconnect, auth quarantine
dashboard/app.js               admin UI (⚠ stored XSS at :476)
scripts/{boot-services,healthcheck,backup}.sh
```

Provider models in use: `DEEPSEEK_MODEL=deepseek-flash` (primary), Gemini fallback chain
(`gemini-2.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`), embeddings
`gemini-embedding-2` (768-dim — the pgvector columns are `VECTOR(768)`).
