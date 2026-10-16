# AGENT.md — `wordpress-plugin/hh-agent-sync/` (plugin source) — ✅ **LIVE (store host)**

> **Scope:** the WooCommerce → agent catalog-sync plugin source.
> Read [`../AGENT.md`](../AGENT.md) and the root [`AGENT.md`](../../AGENT.md) first.

## Files

| File | Responsibility |
|---|---|
| `hh-agent-sync.php` | The plugin: hooks + settings page. |
| `readme.txt` | WordPress plugin readme. |
| `../hh-agent-sync.zip` | Packaged copy for upload to WordPress. |

## Hooks

| WooCommerce hook | Callback | Effect |
|---|---|---|
| `woocommerce_new_product`, `woocommerce_update_product`, `woocommerce_untrash_product` | `sync_product_on_save` | POST the product to `/api/webhook/product-sync`. |
| `woocommerce_delete_product`, `woocommerce_trash_product` | `sync_product_on_delete` | POST a delete/trash event so the agent **prunes** the product. |

## Settings (WP Admin → Settings → HH Agent Sync)

- **Agent Webhook URL** — default `https://agent.apigateway.live/api/webhook/product-sync`.
- **Webhook Secret** — must match `WEBHOOK_SECRET` in `agent/.env`. Ships with **no default**.

## Rules for agents working here

1. **Upload to the store host to deploy** — editing here changes nothing on its own.
2. Keep the delete/trash hooks: they are what stop the agent from offering deleted products.
3. Never hardcode a working webhook secret. The secret is entered by the admin in WP.
4. `requires Plugins: woocommerce`, `if (!defined('ABSPATH')) exit;` and `manage_options`
   capability checks must stay.
5. If you change `hh-agent-sync.php`, rebuild/replace `hh-agent-sync.zip` and note the re-upload
   requirement.

## Related

[`../AGENT.md`](../AGENT.md) · [`../../agent/AGENT.md`](../../agent/AGENT.md) ·
[`../../agent/src/rag/AGENT.md`](../../agent/src/rag/AGENT.md)
