# AGENT.md — `agent/src/rag/` (retrieval + indexing) — ✅ **LIVE**

> **Scope:** pgvector-backed indexing and retrieval for the product catalog and the FAQ/policy
> knowledge base.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## Files

| File | Responsibility |
|---|---|
| `indexer.ts` | `RagIndexer`: `indexDocument()`, `indexProduct()` (upsert), `deleteProduct()`, `syncAllWooCommerceProducts()` (+ prune). |
| `retriever.ts` | `RagRetriever`: `searchKnowledgeBase()` and `searchProducts()` (hybrid vector + keyword). |

## Facts

- **Embeddings:** Gemini `gemini-embedding-2`, **768 dimensions** (`config.gemini.embeddingDimension`).
- **Tables:** `documents` (FAQ/policy) and `products` (catalog mirror), both `VECTOR(768)`
  with HNSW cosine indexes.
- **RPCs:** `match_documents(vector, threshold 0.55, limit)` and `match_products(vector, threshold 0.50, limit)`.
- **Hybrid search:** `searchProducts` falls back to a fuzzy `ILIKE` keyword scan when vector
  results are thin, then merges and de-duplicates by id.
- **Full sync** paginates WooCommerce (20/page, **cap 100 pages**) with `throwOnError: true`, so
  a store outage **aborts without pruning** the catalog. Only a complete successful read prunes
  products that no longer exist in the store.

## Rules for agents working here

1. **Never lower the guard rails on incoming product data:**
   - Skip payloads missing `id`/`name`.
   - Skip payloads with no valid positive price (keeps the previous row).
   - A missing/unknown `stock_status` is stored as `unknown` → treated as **not sellable**
     (conservative by design).
   These prevent quoting "0 BDT / in stock" to real customers.
2. **Embedding dimension is a hard contract** with the SQL schema and the RPCs. Changing it
   requires a migration, a re-index, and matching RPC signatures.
3. Pruning only happens after a **complete** store read — preserve the abort-without-prune path.
4. FAQ re-seeding is idempotent and deletes rows where `metadata ? 'question'` (see
   `../../scripts/AGENT.md`).

## Related

[`../brain/AGENT.md`](../brain/AGENT.md) · [`../data/AGENT.md`](../data/AGENT.md) ·
[`../../scripts/AGENT.md`](../../scripts/AGENT.md) · [`../../../scripts/AGENT.md`](../../../scripts/AGENT.md)
