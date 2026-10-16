=== Hide Haven Agent Sync ===
Contributors: hidehaven
Tags: woocommerce, ai, sync, webhook
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 2.0.0
License: MIT

Synchronizes WooCommerce products and inventory in real-time to the Hide Haven AI Customer Support Agent.

== Description ==
This plugin connects your WooCommerce storefront to your self-hosted Hide Haven AI Agent. When any product is updated, published, or inventory changes, a lightweight asynchronous webhook pushes the updated details to your agent's vector database.

== Installation ==
1. Upload `hh-agent-sync` folder to `/wp-content/plugins/` directory, or upload the zip archive via WordPress Admin (`Plugins > Add New > Upload Plugin`).
2. Activate the plugin through the 'Plugins' menu in WordPress.
3. Navigate to `Settings > HH Agent Sync`.
4. Enter your Agent Webhook URL: `https://agent.apigateway.live/api/webhook/product-sync`
5. Enter your Webhook Secret: this must match WEBHOOK_SECRET in the agent's `.env`.
   There is no default — the plugin will not authenticate without it.
6. Click 'Save Settings'.
