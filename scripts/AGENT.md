# AGENT.md — `scripts/` (ops helpers) — ✅ **LIVE ops**

> **Scope:** shell scripts and SQL that operate the live stack.
> Read the root [`AGENT.md`](../AGENT.md) first — this folder is referenced heavily there.

## Files

| File | Responsibility |
|---|---|
| `boot-services.sh` | **Idempotent** startup: starts Redis (loopback + auth + AOF, data in `/var/lib/hh-redis`), ensures the PM2 apps run **without duplicating** them, then verifies. Add one line to the host boot script. |
| `healthcheck.sh` | Exits non-zero with `FAIL` lines: Redis, agent `/health`, DB, WhatsApp link, queue backlog, failed jobs, stuck handoffs, provider failovers. **Run after every deploy / reboot.** |
| `backup.sh` | Tars WhatsApp session (`auth_info`), `.env`, source and a `pg_dump` into `/backups/hh-agent`. **Copy off-box** — a backup on the dying box is not a backup. |
| `setup-supabase.sql` | Schema for Supabase Postgres: `documents`, `sessions`, `messages`, `products`, `customer_orders`, `agent_settings`, pgvector indexes and the `match_documents` / `match_products` RPCs. |
| `smoke_test.py` | ⚠️ **Legacy Python-era** test — not part of the live TypeScript stack. Do not treat its results as coverage. |

## Rules for agents working here

1. **Redis must always start with `--bind 127.0.0.1 --requirepass … --appendonly yes`.** Never
   run bare `redis-server`; use `boot-services.sh`. It was previously `0.0.0.0`, no password,
   root — that is the fixed vulnerability; do not regress it.
2. `boot-services.sh` is idempotent by design and guards against `pm2 resurrect` duplicating
   apps (two workers → double replies/orders). Keep it that way.
3. `healthcheck.sh` must stay non-zero on failure so cron/CI can gate on it.
4. Scripts read `REDIS_PASSWORD` from `agent/.env` and export `REDISCLI_AUTH` (never put the
   password on the command line).
5. Deployment lives outside this folder: `cd agent && npx tsc && pm2 restart hh-agent` (root
   AGENT.md § 4).

## Related

[`../agent/AGENT.md`](../agent/AGENT.md) · [`../whatsapp_bridge/AGENT.md`](../whatsapp_bridge/AGENT.md)
