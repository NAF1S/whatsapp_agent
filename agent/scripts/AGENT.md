# AGENT.md — `agent/scripts/` (data seeding CLIs) — ✅ **LIVE tooling**

> **Scope:** one-shot TypeScript jobs that seed/refresh the Supabase knowledge base and catalog.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../AGENT.md) first.

These are **developer/ops tools**, not part of the running service. They import the same
`src/` modules and use `agent/.env`.

## Files

| File | npm script | Responsibility |
|---|---|---|
| `seed-faq.ts` | `npm run sync:faq` | Reads `../../data/faq.json`, **deletes** existing FAQ docs (`metadata ? 'question'`) then re-indexes each with embeddings. Idempotent. |
| `sync-products.ts` | `npm run sync:products` | Calls `ragIndexer.syncAllWooCommerceProducts()` — full catalog upsert **+ prune** of products deleted from the store. |

## Usage

```sh
cd agent
npm run sync:faq         # after editing ../../data/faq.json
npm run sync:products    # after catalog changes (or use the WP plugin / /api/admin/sync-catalog)
```

## Rules for agents working here

1. Both scripts call `process.exit(0/1)` — they are meant to be run in a terminal, not imported.
2. **FAQ re-seed replaces the whole FAQ set** on purpose (old, contradictory answers must not
   linger). Do not switch it back to append-only.
3. `sync-products` prunes; it must never run against a store it cannot fully read (the indexer
   aborts without pruning in that case — keep it that way).
4. Keep `../../data/faq.json` as the single source of truth for FAQ text; edit the JSON, then
   run `npm run sync:faq`.

## Related

[`../src/rag/AGENT.md`](../src/rag/AGENT.md) · [`../../data/AGENT.md`](../../data/AGENT.md)
