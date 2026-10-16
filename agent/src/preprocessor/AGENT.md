# AGENT.md — `agent/src/preprocessor/` (multimodal input) — ✅ **LIVE**

> **Scope:** convert raw WhatsApp payloads (voice notes, images, text) into clean text for the
> brain.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## File

| File | Responsibility |
|---|---|
| `index.ts` | `MultimodalPreprocessor.process(payload)` → normalized text string. |

## Behaviour (`IncomingRawPayload` in, text out)

| `messageType` | Handling |
|---|---|
| `audio` | Base64 buffer → **Gemini** `transcribeAudio()` → `[Customer Voice Note]: "…"`. |
| `image` | Up to **3** images; each analyzed by **DeepSeek Vision (primary) → Gemini Vision (fallback)**; multi-image results are concatenated with any extra text. |
| `text` | Trimmed passthrough. |

- Failures **never throw past this layer** — they degrade to a readable marker such as
  `[Customer sent a voice note that could not be processed]`, so the brain still replies
  instead of leaving the customer in silence.
- Voice transcription uses Gemini even when DeepSeek is primary (Gemini also owns embeddings).

## Rules for agents working here

1. Always return a **non-empty string** for a real message; the worker drops jobs whose
   normalised text is empty.
2. Keep the `[…]: "…"` wrappers — the system prompt and escalation regexes understand them.
3. Media size is bounded upstream (bridge / 15 MB body limit). Do not introduce unbounded
   buffering.
4. Transcription/vision model lists are fallback chains with per-model cooldowns; preserve the
   "try next candidate" behaviour.

## Related

[`../brain/AGENT.md`](../brain/AGENT.md) · [`../queue/AGENT.md`](../queue/AGENT.md)
