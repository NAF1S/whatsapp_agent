# AGENT.md — `agent/src/data/` (data access) — ✅ **LIVE**

> **Scope:** the three data-access clients the agent depends on: Postgres, runtime settings,
> and WooCommerce.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## Files

| File | Responsibility |
|---|---|
| `db.ts` | `pg` `Pool` (max 10, SSL `rejectUnauthorized:false`), `query<T>()` wrapper (parameterised, timed, logged), `checkDbConnection()` (used by `/health`). |
| `settings.ts` | `settingsService` over the `agent_settings` KV table; `normalizePhoneNumber()` (BD `01…` → `88…`). Drives the escalation target phone. |
| `woo-client.ts` | `WooCommerceClient`: `getProducts`, `getProductById`, order search, `placeOrder`… Basic-auth REST against `WOOCOMMERCE_URL`. |

## Rules for agents working here

1. **Only parameterised SQL.** Never interpolate values into a query string (`$1, $2, …`).
2. **`query()` throws on error** and logs it — callers must handle failures. Some Woo methods
   intentionally swallow errors and return `[]`; the **full catalog sync** passes
   `{ throwOnError: true }` so it can tell "no more products" apart from "store unreachable".
   Preserve that distinction.
3. `data/*.csv` exports are **stale** — never treat them as the source of truth (see root
   AGENT.md). Live catalog data comes from the WooCommerce API.
4. `settings.ts` normalises Bangladeshi numbers (`01XXXXXXXXX` → `88…`) and rejects
   obviously invalid input; keep that validation.
5. `pool` is a shared singleton — do not create additional pools.

## Related

[`../rag/AGENT.md`](../rag/AGENT.md) · [`../session/AGENT.md`](../session/AGENT.md) ·
[`../brain/AGENT.md`](../brain/AGENT.md) · [`../../scripts/AGENT.md`](../../scripts/AGENT.md)
