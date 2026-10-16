<?php
/**
 * Plugin Name: Hide Haven Agent Sync
 * Plugin URI: https://shop.hidehaven.me
 * Description: Real-time WooCommerce product and order synchronization to Hide Haven AI Agent.
 * Version: 2.0.0
 * Author: Hide Haven
 * Author URI: https://shop.hidehaven.me
 * Text Domain: hh-agent-sync
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) {
    exit;
}

class HHAgentSync {
    public function __construct() {
        // Trigger sync when WooCommerce product is saved or updated
        add_action('woocommerce_update_product', [$this, 'sync_product_on_save'], 10, 2);
        add_action('woocommerce_new_product', [$this, 'sync_product_on_save'], 10, 2);

        // A deleted/trashed product must be REMOVED from the agent's catalog, otherwise the
        // agent keeps offering (and can take orders for) a product you no longer sell.
        add_action('woocommerce_delete_product', [$this, 'sync_product_on_delete'], 10, 1);
        add_action('woocommerce_trash_product', [$this, 'sync_product_on_delete'], 10, 1);
        add_action('woocommerce_untrash_product', [$this, 'sync_product_on_save'], 10, 1);

        // Settings page in WP Admin
        add_action('admin_menu', [$this, 'register_settings_menu']);
        add_action('admin_init', [$this, 'register_settings']);
    }

    public function register_settings_menu() {
        add_options_page(
            'HH Agent Sync',
            'HH Agent Sync',
            'manage_options',
            'hh-agent-sync',
            [$this, 'render_settings_page']
        );
    }

    public function register_settings() {
        register_setting('hh_agent_sync_group', 'hh_agent_webhook_url');
        register_setting('hh_agent_sync_group', 'hh_agent_webhook_secret');
    }

    public function render_settings_page() {
        $default_url = 'https://agent.apigateway.live/api/webhook/product-sync';
        // No default: the shared secret must be entered here by an administrator, so the
        // plugin never ships a value that also works on the agent side.
        $default_secret = '';

        $url = get_option('hh_agent_webhook_url', $default_url);
        $secret = get_option('hh_agent_webhook_secret', $default_secret);
        ?>
        <div class="wrap">
            <h1>Hide Haven AI Agent Sync Settings</h1>
            <p>Automatically sends real-time product updates and stock levels to your self-hosted AI agent via Cloudflare tunnel.</p>
            <form method="post" action="options.php">
                <?php settings_fields('hh_agent_sync_group'); ?>
                <?php do_settings_sections('hh_agent_sync_group'); ?>
                <table class="form-table">
                    <tr valign="top">
                        <th scope="row">Agent Webhook URL</th>
                        <td>
                            <input type="url" name="hh_agent_webhook_url" value="<?php echo esc_attr($url); ?>" class="regular-text" style="width: 450px;" required />
                            <p class="description">Endpoint on your agent server (e.g. <code>https://agent.apigateway.live/api/webhook/product-sync</code>)</p>
                        </td>
                    </tr>
                    <tr valign="top">
                        <th scope="row">Webhook Secret</th>
                        <td>
                            <input type="text" name="hh_agent_webhook_secret" value="<?php echo esc_attr($secret); ?>" class="regular-text" style="width: 450px;" required />
                            <p class="description">Must match <code>WEBHOOK_SECRET</code> in your server's <code>.env</code> file.</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>
        </div>
        <?php
    }

    public function sync_product_on_save($product_id, $product = null) {
        if (!$product && function_exists('wc_get_product')) {
            $product = wc_get_product($product_id);
        }

        if (!$product) {
            return;
        }

        $webhook_url = get_option('hh_agent_webhook_url', 'https://agent.apigateway.live/api/webhook/product-sync');
        $webhook_secret = get_option('hh_agent_webhook_secret', '');

        if (empty($webhook_url)) {
            return;
        }

        // Collect gallery image URLs
        $images = [];
        $main_image_id = $product->get_image_id();
        if ($main_image_id) {
            $images[] = wp_get_attachment_url($main_image_id);
        }
        $gallery_ids = $product->get_gallery_image_ids();
        if (!empty($gallery_ids)) {
            foreach ($gallery_ids as $gid) {
                $url = wp_get_attachment_url($gid);
                if ($url && !in_array($url, $images)) {
                    $images[] = $url;
                }
            }
        }

        // Collect category names
        $categories = wp_get_post_terms($product_id, 'product_cat', ['fields' => 'names']);
        if (is_wp_error($categories)) {
            $categories = [];
        }

        $payload = [
            'event' => 'product.updated',
            'product' => [
                'id' => $product->get_id(),
                'name' => $product->get_name(),
                'slug' => $product->get_slug(),
                'sku' => $product->get_sku(),
                'price' => $product->get_price(),
                'regular_price' => $product->get_regular_price(),
                'stock_quantity' => $product->get_stock_quantity(),
                'stock_status' => $product->get_stock_status(),
                'description' => $product->get_description(),
                'short_description' => $product->get_short_description(),
                'permalink' => get_permalink($product_id),
                'categories' => $categories,
                'images' => $images,
            ],
            'timestamp' => current_time('mysql'),
        ];

        // Non-blocking asynchronous HTTP post to agent
        wp_remote_post($webhook_url, [
            'method' => 'POST',
            'timeout' => 5,
            'blocking' => false, // Non-blocking so customer/admin checkout is never slowed down!
            'headers' => [
                'Content-Type' => 'application/json',
                'X-Webhook-Secret' => $webhook_secret,
            ],
            'body' => wp_json_encode($payload),
        ]);
    }

    /**
     * Notify the agent that a product was deleted or trashed. Only the id is needed — the
     * agent removes the catalog row so the product can no longer be offered or ordered.
     */
    public function sync_product_on_delete($product_id) {
        $webhook_url = get_option('hh_agent_webhook_url', 'https://agent.apigateway.live/api/webhook/product-sync');
        $webhook_secret = get_option('hh_agent_webhook_secret', '');

        if (empty($webhook_url) || empty($product_id)) {
            return;
        }

        wp_remote_post($webhook_url, [
            'method' => 'POST',
            'timeout' => 5,
            'blocking' => false,
            'headers' => [
                'Content-Type' => 'application/json',
                'X-Webhook-Secret' => $webhook_secret,
            ],
            'body' => wp_json_encode([
                'event' => 'product.deleted',
                'product' => ['id' => (int) $product_id],
                'timestamp' => current_time('mysql'),
            ]),
        ]);
    }
}

new HHAgentSync();
