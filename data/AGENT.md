# AGENT.md — `data/` (knowledge base source) — ✅ **LIVE data**

> **Scope:** editable content that gets seeded into the database.
> Read the root [`AGENT.md`](../AGENT.md) first.

## Files

| File | Responsibility |
|---|---|
| `faq.json` | The FAQ / store-policy knowledge base — the **source of truth** for RAG documents. |

## How it is used

`agent/scripts/seed-faq.ts` (`npm run sync:faq`) reads `data/faq.json`, wipes the previous FAQ
rows from Supabase `documents` (`metadata ? 'question'`) and re-indexes each entry with a
Gemini embedding. The agent then answers policy questions via `search_knowledge_base` (vector
search, threshold 0.55).

Format — an object with a top-level `faqs` array:

```json
{
  "faqs": [
    { "category": "delivery", "question": "How much is the delivery charge?", "answer": "…" }
  ]
}
```

## Content facts (keep consistent with `agent/src/brain/prompt.ts`)

- Delivery: Inside Dhaka **60 BDT** (2–3 days), Outside Dhaka **100 BDT** (3–5 days),
  **FREE over 2000 BDT** (product total before discount).
- Payment: **Cash on Delivery** nationwide. Do **not** claim cards, bKash or PayPal (unconfirmed).
- Returns: 30-day exchange/return for unused goods in original condition.
- Warranty: **2-year** on all leather products.

## Rules for agents working here

1. Edit the JSON, then run `cd agent && npm run sync:faq`. **Seeding is idempotent and replaces
   the whole FAQ set** — that is intentional (no stale/contradictory answers).
2. Keep answers in the same language mix the customers use (Bengali / Banglish / English).
3. Any price/policy change must be reflected **in both** this file and
   `agent/src/brain/prompt.ts`, or the FAQ and the prompt will disagree.
4. ⚠️ CSV exports such as `data/product_data.csv` (if present) are **stale** — never use them as
   product data. The live catalog comes from WooCommerce.

## Related

[`../agent/scripts/AGENT.md`](../agent/scripts/AGENT.md) ·
[`../agent/src/rag/AGENT.md`](../agent/src/rag/AGENT.md)
