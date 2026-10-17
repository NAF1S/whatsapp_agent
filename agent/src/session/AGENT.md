# AGENT.md — `agent/src/session/` (state + handoff) — ✅ **LIVE**

> **Scope:** per-customer session state, conversation history, and the human-handoff lock.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## File

| File | Responsibility |
|---|---|
| `manager.ts` | `SessionManager` singleton: sessions + messages tables, handoff lock/unlock/refresh. |

## Tables touched

- `sessions` — `phone` (PK), `customer_name`, `is_human_controlled`, `handoff_reason`,
  `handoff_at`, `last_message_at`, `metadata`.
- `messages` — `phone`, `role` (`user`/`assistant`/`human`/`system`), `content`, `metadata`,
  `created_at`.

## Key methods

| Method | Behaviour |
|---|---|
| `getOrCreateSession(phone)` | Creates the row if absent. **Auto-releases a stale handoff** if `handoff_at` is older than `HUMAN_HANDOFF_TIMEOUT_MINUTES`. |
| `addMessage(phone, role, content, meta)` | Appends to history. |
| `getRecentMessages(phone, limit=8)` | Oldest→newest window used to build the prompt. |
| `lockForHuman(phone, reason)` | Sets `is_human_controlled = true`, stamps `handoff_at`. |
| `unlockSession(phone)` | Returns the chat to the bot. |
| `refreshHandoff(phone)` | Bumps `handoff_at` — called whenever a **human replies**, so an active admin is never cut off. |
| `updateSessionMetadata(phone, meta)` | Merges JSONB (pending order data). |

## Rules for agents working here

1. **Phone normalisation:** every method strips to digits (`replace(/[^\d+]/g, '')`). Keep this
   consistent — the `sessions.phone` key must match everywhere.
2. The handoff lease is measured **from last human activity**, not lock creation. Do not change
   that without updating `index.ts`'s sweeper (`index.ts` bulk-releases expired locks) and
   `refreshHandoff`.
3. **A locked session must never stay locked forever.** It releases via (a) an admin
   close-ticket, (b) `getOrCreateSession` on next inbound, or (c) the background sweeper.
4. All writes go through `query()` in `../data/db.ts` (parameterised SQL only).

## Related

[`../escalation/AGENT.md`](../escalation/AGENT.md) · [`../brain/AGENT.md`](../brain/AGENT.md) ·
[`../data/AGENT.md`](../data/AGENT.md)
