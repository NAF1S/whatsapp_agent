# AGENT.md — `agent/src/utils/` (shared helpers) — ✅ **LIVE**

> **Scope:** cross-cutting helpers with no business logic.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## Files

| File | Responsibility |
|---|---|
| `logger.ts` | `pino` logger, level from `LOG_LEVEL`, pretty-printed to stdout (PM2 captures it) via `pino-pretty`. |

## Rules for agents working here

1. **Leaf module.** `utils` must not import `brain`, `queue`, `session`, `data`, `rag` or
   `escalation` — only `config`. Anything else risks import cycles.
2. Use `logger` **everywhere** instead of `console.log`, so levels/formatting stay uniform.
3. Never add a sink that prints secrets or customer PII (see root AGENT.md § PII).
4. Keep it dependency-light: a new library here is paid for by every import site.

## Related

[`../AGENT.md`](../AGENT.md) · [`../config.ts`](../config.ts) (not this folder, but the only
module `utils` may depend on)
