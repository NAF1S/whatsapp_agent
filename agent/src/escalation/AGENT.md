# AGENT.md — `agent/src/escalation/` (human handoff alerts) — ✅ **LIVE**

> **Scope:** notify the store admin on WhatsApp when a conversation needs a human.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../../AGENT.md) first.

## File

| File | Responsibility |
|---|---|
| `notifier.ts` | `EscalationNotifier.sendAdminEscalationAlert()` and `sendTestAlert()`. |

## What an alert contains

- Customer phone + name, escalation reason, and a **recent-chat snippet** (last ~6 messages,
  truncated per line).
- Any recent order found for the customer.
- Timestamp formatted in **Asia/Dhaka** (`getDhakaTime()`).
- Appends a JSON line to **`logs/escalations.jsonl`**.

## Destination

The alert goes to the **admin WhatsApp number**, resolved at runtime from
`agent_settings.admin_whatsapp_phone` (fallback `WHATSAPP_ADMIN_PHONE`). It is sent through the
same bridge `sendWhatsAppMessage()` helper used for customer replies.

## Rules for agents working here

1. Escalation alerts are **real WhatsApp messages to a real person** — never trigger them in a
   test loop. Use `POST /api/admin/test-alert` for a single deliberate test.
2. ⚠️ **PII:** chat snippets, phone numbers and order data are written to `logs/escalations.jsonl`
   and to PM2 logs in plaintext. Never print these into a transcript or a new sink.
3. If no admin phone is configured the notifier returns `{ success:false }` and logs a warning —
   it must not throw into the caller.
4. The notifier depends on `settingsService`, `sessionManager` and the queue's send helper;
   keep those as the single sources of truth.

## Related

[`../brain/AGENT.md`](../brain/AGENT.md) · [`../session/AGENT.md`](../session/AGENT.md) ·
[`../queue/AGENT.md`](../queue/AGENT.md) · [`../../../dashboard/AGENT.md`](../../../dashboard/AGENT.md)
