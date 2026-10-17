# AGENT.md — `dashboard/` (admin UI) — ✅ **LIVE**

> **Scope:** the store admin's web dashboard (conversations, escalations, human replies,
> WhatsApp connection control).
> Read the root [`AGENT.md`](../AGENT.md) first.

## What this folder is

A **static** front-end (no build step) served by the agent at **`/admin`** — `index.ts` mounts
this directory with `express.static` and a no-cache header, and serves `index.html` at `/admin`.

| File | Responsibility |
|---|---|
| `index.html` | Markup: login overlay, conversation list, chat pane, WhatsApp status/QR modal, settings. |
| `app.js` | All client logic: auth, polling, sending admin replies, lock/close ticket, catalog sync, WhatsApp reset/pause, test alert. |
| `style.css` | Styling. |

## How it talks to the backend

- `API_BASE = '/api/admin'`, same origin as the agent.
- Auth: the admin password is kept in `localStorage('hh_admin_pwd')` and sent as
  `Authorization: Bearer <password>` on every call (`getAuthHeader()`).
- Polls conversation/escalation state and the WhatsApp status; the QR modal polls the bridge
  (via the agent) to show the pairing code.

Backend endpoints live in [`../agent/src/index.ts`](../agent/src/index.ts) / root
[`AGENT.md`](../AGENT.md) § *Admin dashboard and API*.

## ⚠️ Known open issues (do not "fix" silently — see root AGENT.md § 6)

1. **Stored XSS:** `app.js` injects `conv.last_message` (customer-controlled text) via
   `innerHTML` in the **sidebar** — fixed for message bubbles only. A customer can run JS in the
   admin's browser and steal the admin token. **Sanitise / use `textContent`.**
2. The dashboard is **internet-exposed** and its password currently has a weak, hardcoded
   fallback in `config.ts` (root AGENT.md § open risks).
3. `cors()` is wildcard and the JSON body limit is 15 MB before auth.

## Rules for agents working here

1. **Never** put customer text into `innerHTML`. Use `textContent` / build DOM nodes.
2. No build step: keep it plain HTML/CSS/JS, same-origin relative URLs.
3. Any new admin action must call an existing `requireAdminAuth`-protected route; do not add
   unauthenticated endpoints.
4. This UI can **send messages as the store** and **re-pair WhatsApp** — treat every button as a
   production action with real customer impact.

## Related

[`../agent/AGENT.md`](../agent/AGENT.md) · [`../whatsapp_bridge/AGENT.md`](../whatsapp_bridge/AGENT.md)
