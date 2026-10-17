# AGENT.md — `agent/src/brain/` (LLM orchestration) — ✅ **LIVE**

> **Scope:** the reasoning layer — the tool-calling loop, the two LLM providers, the system
> prompt and the tool implementations.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## Files

| File | Responsibility |
|---|---|
| `agent.ts` | `AgentBrain.processCustomerMessage()`. Pre-filter escalation check → build `contents` from history → **tool loop (max 3 iterations)** → post-filter escalation → persist reply. |
| `gemini.ts` | `GeminiClient`: chat, `callWithTools`, `embedText` (768-d), `transcribeAudio`, `analyzeImage`. Multi-key pool + per-model cooldowns on 429/503. |
| `deepseek.ts` | `DeepSeekClient`: the **primary** provider. `callWithTools`, `generateChat`, `analyzeImage`. Translates Gemini-style tools/contents → OpenAI/DeepSeek format. |
| `prompt.ts` | `SYSTEM_PROMPT` — brand facts, the verified 30-product catalog, brevity rules, store policy. |
| `tools.ts` | `TOOL_DECLARATIONS` + `executeTool()`: `search_products`, `send_product_images`, `search_knowledge_base`, `lookup_order`, `place_order`, `request_human_escalation`. |

## Provider order

1. **DeepSeek-V4.1-Flash** is primary when `AI_PRIMARY_PROVIDER=deepseek` (the live setting).
2. **Gemini** is the fallback (FREE TIER — 20 req/day/model; it is *not* the primary).
3. `gemini.generateChat()` is the last-resort text synthesizer if the loop produced nothing.

Provider failovers appear in logs as `trying next candidate`.

## 🚨 The shared `contents` array (read before editing)

`contents` is **one array replayed to whichever provider answers next**. `toSharedModelTurn()`
in `agent.ts` strips provider-specific fields and keeps only `text` and
`functionCall{name,args}`.

- **Never push a raw provider candidate** (with `reasoning_content`, function-call `id`, etc.)
  into `contents`. DeepSeek-specific parts make Gemini return **HTTP 400** ("Unknown name…"),
  which used to poison every fallback ("temporarily experiencing high traffic" dead-ends).
- `deepseek.ts` emits tool-call ids for its own request but **never writes them back** into
  `contents`, for the same reason.

## Other invariants

- **Tool failures are data, not exceptions.** `executeTool` errors are returned to the model as
  a `functionResponse` so it can apologise / offer a human — do not `throw` out of the loop.
- **Empty model turn = stop.** If a response has no text and no tool calls, break the loop
  instead of re-sending the identical request (that burned quota for nothing).
- **Escalation is checked twice:** a regex pre-filter on the incoming text (`detectEscalationTrigger`)
  and a post-filter on the generated reply. Both lock the session and alert the admin.
- **Catalog is authoritative.** Prices/stock come from `tools.ts` hitting WooCommerce /
  Supabase — never from the model's memory (per `prompt.ts`).
- Model names are environment-driven via `config.ts`; do not hardcode.

## Related

[`../../tools/`](../AGENT.md) · [`../session/AGENT.md`](../session/AGENT.md) ·
[`../escalation/AGENT.md`](../escalation/AGENT.md) · [`../rag/AGENT.md`](../rag/AGENT.md)
