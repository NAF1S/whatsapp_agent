# AGENT.md — `agent/src/` (agent source) — ✅ **LIVE**

> **Scope:** all TypeScript source for the live agent service.
> Read [`../AGENT.md`](../AGENT.md) (the `agent/` service) and the root
> [`AGENT.md`](../../AGENT.md) first.

This folder **compiles to `agent/dist/`** (`tsc`, `rootDir: ./src`, `outDir: ./dist`).
`dist/` is what runs — rebuilding without restarting has no effect, and restarting without
rebuilding runs stale code.

## Modules

| Path | Responsibility |
|---|---|
| `index.ts` | Express app: static dashboard, `/health`, `/api/webhook/product-sync`, `/api/admin/*`; boots the queue worker + handoff sweeper. |
| `config.ts` | Env loading + validation (secrets are mandatory, no fallbacks). |
| `brain/` | LLM orchestration: tool loop, providers (DeepSeek/Gemini), system prompt, tool implementations. |
| `queue/` | BullMQ worker + outbound `sendWhatsAppMessage()` to the bridge. |
| `preprocessor/` | Turns voice notes / images / text into clean text before the brain. |
| `session/` | Per-customer session state, message history, human-handoff lock. |
| `rag/` | pgvector indexing + hybrid retrieval (products, FAQ/policy docs). |
| `data/` | Postgres pool, runtime settings, WooCommerce REST client. |
| `escalation/` | Admin WhatsApp alerting on handoff. |
| `utils/` | Shared pino logger. |

## Runtime flow inside `src/`

```
queue/worker  →  preprocessor  →  brain/agent  →  brain/tools  →  {rag, data, escalation}
      │                                   │
      │                                   └─ brain/{deepseek,gemini}  (providers)
      └─ session/manager  (lock, history)                    utils/logger (everywhere)
```

## Rules for agents working in this folder

1. **Import direction matters.** `index` is the outermost layer; `utils` and `config` are the
   innermost. Never import "up" the stack (e.g. `utils` must not import `brain`). Avoid cycles.
2. **One shared conversation array** (`contents`) is replayed across providers — see
   `brain/AGENT.md`. Never push provider-specific fields into it.
3. `config.ts` is imported by nearly everything; keep it side-effect free beyond env loading.
4. Every module exports a singleton instance (`sessionManager`, `agentBrain`, `logger`, …) —
   reuse those instead of constructing new clients (API keys, pool, Redis connections).
5. TypeScript is `strict`. `npx tsc --noEmit` must pass before any deploy.

## Related

[`brain/AGENT.md`](brain/AGENT.md) · [`queue/AGENT.md`](queue/AGENT.md) ·
[`preprocessor/AGENT.md`](preprocessor/AGENT.md) · [`session/AGENT.md`](session/AGENT.md) ·
[`rag/AGENT.md`](rag/AGENT.md) · [`data/AGENT.md`](data/AGENT.md) ·
[`escalation/AGENT.md`](escalation/AGENT.md) · [`utils/AGENT.md`](utils/AGENT.md)
