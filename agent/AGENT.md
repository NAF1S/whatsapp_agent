# AGENT.md — `agent/` (TypeScript service) — ✅ **LIVE**

> **Scope:** the live TypeScript customer-support agent. PM2 app `hh-agent`, HTTP on
> `127.0.0.1:3000` (dashboard at `/admin`).
> Read the root [`AGENT.md`](../AGENT.md) first for the live/legacy map, deploy steps and
> landmines, and [`ARCHITECTURE.md`](../ARCHITECTURE.md) for the system-wide design.

## What this folder is

The brain of the product. It receives debounced WhatsApp messages from Redis (BullMQ
`whatsapp-incoming`), normalizes voice/photo input, runs a tool-calling LLM loop, talks to
WooCommerce and Supabase, and posts the reply back through the WhatsApp bridge.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Entrypoint: Express HTTP API, `/admin` dashboard hosting, `/health`, admin routes, starts the queue worker and the handoff sweeper. |
| `src/config.ts` | Loads `.env` and validates it. **Secrets have no fallback — boot fails loudly if missing.** |
| `src/` (subfolders) | Feature modules — see `src/AGENT.md` and each subfolder's `AGENT.md`. |
| `scripts/` | One-shot CLI jobs (`sync:faq`, `sync:products`) — see `scripts/AGENT.md`. |
| `dist/` | **Compiled output. This is what actually runs.** Never edit by hand. |
| `.env` | Live secrets (not committed). Template: `.env.example`. |

## Build / run / deploy

```sh
npm install
npx tsc --noEmit     # typecheck only
npx tsc              # BUILD -> dist/   (REQUIRED before restart)
pm2 restart hh-agent # or: sh ../scripts/boot-services.sh
```

- **⚠️ Editing `src/` changes nothing until you rebuild and restart.** A rebuild also changes
  what the *next* restart will run, even before you restart.
- `npm run dev` runs `src/index.ts` directly via ts-node (dev only, not the live path).
- `npm run sync:faq` / `npm run sync:products` re-seed data (see `scripts/AGENT.md`).

## Rules for agents working in this folder

1. **`dist/` is truth at runtime.** Verify changes with `sh ../scripts/healthcheck.sh`.
2. **No tests, no git, no CI.** Nothing catches a bad deploy — be conservative in production.
3. `src/config.ts` requires `DB_HOST`, `DB_PASSWORD`, `ADMIN_PASSWORD`, `WEBHOOK_SECRET`;
   missing values throw at startup (intentionally).
4. **Single-instance by design** — the per-customer lock in `src/queue/worker.ts` is
   in-process. Never run two `hh-agent` workers.
5. `src/index.ts` exposes an **unauthenticated** `/health` and a **15 MB JSON body parser on
   all routes** (parsed before auth). Do not widen these without a security review.
6. Keep imports pointing **inward**: `index → queue/brain → {session, rag, data, escalation,
   preprocessor} → utils/config`. Do not create cycles.

## Related

- [`src/AGENT.md`](src/AGENT.md) · [`scripts/AGENT.md`](scripts/AGENT.md) ·
  [`../whatsapp_bridge/AGENT.md`](../whatsapp_bridge/AGENT.md) ·
  [`../dashboard/AGENT.md`](../dashboard/AGENT.md)
