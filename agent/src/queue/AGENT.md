# AGENT.md — `agent/src/queue/` (job worker) — ✅ **LIVE**

> **Scope:** the BullMQ consumer that drives the whole message pipeline, plus the outbound
> send helper.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## File

| File | Responsibility |
|---|---|
| `worker.ts` | `startQueueWorker()` — consumes `whatsapp-incoming`; `sendWhatsAppMessage(toJid, text)` — POSTs to the bridge. |

## Behaviour

- **Queue:** `whatsapp-incoming` on Redis `127.0.0.1:6379`, **password required**
  (`REDIS_PASSWORD`, no fallback in this module — passed only if present).
- **Concurrency 3**, plus a **per-customer in-process mutex** (`customerLocks` Map) so the same
  customer's jobs run strictly one at a time. ⚠️ This is why the service must stay
  **single-instance** — a second worker would double replies/orders.
- **Order of checks per job:**
  1. `getOrCreateSession()` — if `isHumanControlled`, store the message for human review and stop.
  2. `multimodalPreprocessor.process()` — empty result → drop the job.
  3. `isBotPaused` → store message, skip AI.
  4. `agentBrain.processCustomerMessage()` → if a reply comes back, `sendWhatsAppMessage()`.
- **Job idempotency:** the bridge sets `jobId` from a hash of the message ids, so a redelivered
  job does not double-reply.
- **`worker.on('error')` is mandatory.** With no `error` listener, an ioredis connection error
  makes the EventEmitter throw and kills the process (unexplained PM2 restarts). Keep it.

## Rules for agents working here

1. Never increase concurrency without re-thinking the per-customer lock and the single-instance
   assumption.
2. If Redis is down, jobs are dropped and customers get **no reply** — surface this loudly
   (`Failed to enqueue…` / `Queue worker error`), never swallow it.
3. `sendWhatsAppMessage` returns `false` on failure (never throws); callers rely on that.
4. Do not call the bridge's `/send` outside a deliberate test — it messages **real customers**.

## Related

[`../preprocessor/AGENT.md`](../preprocessor/AGENT.md) · [`../brain/AGENT.md`](../brain/AGENT.md) ·
[`../session/AGENT.md`](../session/AGENT.md) · [`../../../whatsapp_bridge/AGENT.md`](../../../whatsapp_bridge/AGENT.md)
