# AGENT.md — `whatsapp_bridge/` (Baileys transport) — ✅ **LIVE**

> **Scope:** the WhatsApp transport. PM2 app `whatsapp-bridge`, HTTP on `127.0.0.1:3001`.
> Read the root [`AGENT.md`](../AGENT.md) first — § 7 "Landmines" is mostly about this folder.

## File

| File | Responsibility |
|---|---|
| `whatsapp-bridge.js` | The whole bridge (plain JS, **no build step**). Baileys socket + Express HTTP API + BullMQ producer. |
| `auth_info/` | **The store's WhatsApp account credentials.** ⚠️ Never delete, never commit; back it up. |
| `.env` | `BRIDGE_HTTP_PORT`, `REDIS_*`, `AUTH_DIR`, `LOG_LEVEL`. |

## What it does

1. Connects to WhatsApp Web (multi-device) via Baileys; prints a QR on first run (also shown at
   `/admin`).
2. On each inbound event: resolves **LID → real phone number** from
   `auth_info/lid-mapping-*_reverse.json`, unwraps disappearing/view-once messages, downloads
   media.
3. **Debounces 3 s per customer** (merges a photo + immediate text burst) and **de-duplicates by
   `msg.key.id`**.
4. Enqueues one **consolidated** job to Redis BullMQ `whatsapp-incoming` with
   `jobId = sha1(sorted message ids)` for idempotency.
5. Serves the HTTP control API for the agent/dashboard.

## HTTP API (loopback only, **no auth**)

`POST /send`, `POST /send-image`, `GET /qr`, `GET /status`, `POST /pause`, `POST /reset`.

## 🚨 Rules for agents working here

1. **Never delete `auth_info`.** It *is* the WhatsApp account. It is no longer `rmSync`'d on any
   disconnect; only 401/500/411/403 count as a logout, and even then the directory is
   **quarantined** to `auth_info.broken-<timestamp>` (restore by moving it back). Do not
   reintroduce deletion — a transient 503 once destroyed the live session.
2. **Redis password must match `agent/.env`.** If the two disagree, the bridge drops inbound
   messages and customers get no replies.
3. `sendWhatsAppMessage` (in the agent) calls `POST /send` — **that messages real customers.**
   Only call it in a deliberate test.
4. No build step: a change requires `pm2 restart whatsapp-bridge`.
5. Startup and restart are orchestrated by `scripts/boot-services.sh` (guards against duplicate
   PM2 apps).

## Related

[`../agent/src/queue/AGENT.md`](../agent/src/queue/AGENT.md) ·
[`../scripts/AGENT.md`](../scripts/AGENT.md) · [`../dashboard/AGENT.md`](../dashboard/AGENT.md)
