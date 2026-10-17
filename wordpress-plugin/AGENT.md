# AGENT.md — `wordpress-plugin/` (WooCommerce integration) — ✅ **LIVE (on the store host)**

> **Scope:** the WordPress plugin that pushes catalog changes from the store to the agent.
> Read the root [`AGENT.md`](../AGENT.md) first.

## What this folder is

- `hh-agent-sync/` — the plugin source (see its own [`AGENT.md`](hh-agent-sync/AGENT.md)).
- `hh-agent-sync.zip` — packaged build for uploading to WordPress.

⚠️ **This runs on the store host (`shop.hidehaven.me`), not on this box.** Editing the files
here does nothing until the updated plugin is uploaded to WordPress.

## How it connects

The plugin POSTs to the agent's webhook
`POST /api/webhook/product-sync` (agent `src/index.ts`) with the `x-webhook-secret` header,
which must equal `WEBHOOK_SECRET` in `agent/.env`. Events: product created/updated, and
**delete / trash / untrash** (so removed products are pruned from the agent's catalog).

## Rules for agents working here

1. **Deploying = uploading the new plugin to the store host.** Changing `hh-agent-sync.php`
   here has zero effect until that upload happens — always call it out.
2. The webhook secret is **entered by the admin in WP settings**; it ships with **no default**
   on purpose. Never hardcode a working secret in the plugin.
3. Keep catalog **deletion** hooks intact — without them the agent keeps selling deleted
   products (root AGENT.md § 6).
4. Keep the plugin dependency-light and guarded by `if (!defined('ABSPATH')) exit;`.

## Related

[`hh-agent-sync/AGENT.md`](hh-agent-sync/AGENT.md) · [`../agent/AGENT.md`](../agent/AGENT.md)
