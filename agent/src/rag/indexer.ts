import { query } from '../data/db';
import { gemini } from '../brain/gemini';
import { wooClient, WooProduct } from '../data/woo-client';
import { logger } from '../utils/logger';

/** Safety cap on catalog pagination, so a misbehaving store API cannot loop forever. */
const MAX_SYNC_PAGES = 100;

export class RagIndexer {
  /**
   * Index a knowledge base item (FAQ, policy, guide)
   */
  async indexDocument(content: string, metadata: Record<string, any> = {}): Promise<void> {
    const embedding = await gemini.embedText(content);
    const vectorStr = `[${embedding.join(',')}]`;

    await query(
      `INSERT INTO documents (content, metadata, embedding, updated_at)
       VALUES ($1, $2, $3::vector, NOW())`,
      [content, JSON.stringify(metadata), vectorStr]
    );
  }

  /**
   * Index or update a product from WooCommerce
   */
  async indexProduct(p: WooProduct | any): Promise<void> {
    const rawDesc = (p.description || p.short_description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    const images = Array.isArray(p.images) ? p.images.map((img: any) => typeof img === 'string' ? img : img.src) : [];
    const categories = Array.isArray(p.categories) ? p.categories.map((c: any) => typeof c === 'string' ? c : c.name) : [];

    // Extract image filenames as visual cues for vector matching
    const imageHints = images.map((imgUrl: string) => {
      const parts = imgUrl.split('/');
      return parts[parts.length - 1].replace(/[-_]/g, ' ').replace(/\.[a-zA-Z]+$/, '');
    }).join(', ');

    // Create rich text description for semantic embedding
    const embedText = `Product: ${p.name}. SKU: ${p.sku || 'N/A'}. Price: ${p.price || p.regular_price} BDT. Categories: ${categories.join(', ')}. Visual & Design Features: ${imageHints}. Description: ${rawDesc}`;

    const embedding = await gemini.embedText(embedText);
    const vectorStr = `[${embedding.join(',')}]`;

    // Reject thin/incomplete payloads (e.g. a webhook carrying only an id). Indexing them
    // would overwrite good catalog data with a "0 BDT" price and a false "in stock", both
    // of which the agent would then quote to real customers.
    if (!p.id || !p.name) {
      logger.warn({ id: p.id, hasName: !!p.name }, 'Skipping product index: incomplete payload (missing id or name)');
      return;
    }

    const price = parseFloat(p.price) || parseFloat(p.regular_price) || 0;
    if (!Number.isFinite(price) || price <= 0) {
      logger.warn({ id: p.id, name: p.name, price: p.price, regularPrice: p.regular_price },
        'Skipping product index: no valid price (previous catalog row kept)');
      return;
    }

    const regularPrice = parseFloat(p.regular_price) || price;

    await query(
      `INSERT INTO products (
        id, name, slug, sku, price, regular_price, stock_quantity, stock_status,
        description, short_description, permalink, categories, images, embedding, synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::vector, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        slug = EXCLUDED.slug,
        sku = EXCLUDED.sku,
        price = EXCLUDED.price,
        regular_price = EXCLUDED.regular_price,
        stock_quantity = EXCLUDED.stock_quantity,
        stock_status = EXCLUDED.stock_status,
        description = EXCLUDED.description,
        short_description = EXCLUDED.short_description,
        permalink = EXCLUDED.permalink,
        categories = EXCLUDED.categories,
        images = EXCLUDED.images,
        embedding = EXCLUDED.embedding,
        synced_at = NOW()`,
      [
        p.id,
        p.name,
        p.slug || '',
        p.sku || '',
        price,
        regularPrice,
        p.stock_quantity,
        // Never assume "in stock" from a missing field — an unknown status is treated as
        // not sellable until a full sync confirms it.
        (p.stock_status || '').toLowerCase() || 'unknown',
        rawDesc,
        p.short_description ? p.short_description.replace(/<[^>]*>/g, '').trim() : rawDesc.substring(0, 200),
        p.permalink || '',
        JSON.stringify(categories),
        JSON.stringify(images),
        vectorStr,
      ]
    );

    logger.debug({ id: p.id, name: p.name }, 'Indexed product into Supabase pgvector');
  }

  /**
   * Remove a product that no longer exists in the store. Without this, a deleted or
   * renamed product stays in the index forever and the agent keeps offering it (and can
   * take an order for it) at a price the store no longer sells.
   */
  async deleteProduct(id: number): Promise<boolean> {
    try {
      const result = await query('DELETE FROM products WHERE id = $1', [id]);
      const removed = (result.rowCount || 0) > 0;
      if (removed) logger.info({ id }, 'Removed deleted product from catalog index');
      return removed;
    } catch (err: any) {
      logger.error({ err: err.message, id }, 'Failed to remove product from catalog index');
      return false;
    }
  }

  /**
   * Sync the full product catalog from WooCommerce.
   *
   * After a COMPLETE walk, rows whose synced_at predates this run are products that no
   * longer exist in the store, and are pruned. Any page failure aborts the run WITHOUT
   * pruning — otherwise a store outage would look like "everything was deleted" and wipe
   * the catalog.
   */
  async syncAllWooCommerceProducts(): Promise<{ indexed: number; removed: number }> {
    const syncStartedAt = new Date();
    logger.info('Starting full WooCommerce product catalog sync...');

    let page = 1;
    let totalIndexed = 0;
    let reachedEnd = false;

    while (page <= MAX_SYNC_PAGES) {
      let products: any[];
      try {
        products = await wooClient.getProducts({ per_page: 20, page }, { throwOnError: true });
      } catch (err: any) {
        logger.error({ err: err.message || String(err), page },
          'Catalog sync page failed — aborting sync WITHOUT pruning (catalog left untouched)');
        return { indexed: totalIndexed, removed: 0 };
      }

      if (!products || products.length === 0) {
        reachedEnd = true;
        break;
      }

      for (const prod of products) {
        try {
          await this.indexProduct(prod);
          totalIndexed++;
        } catch (err: any) {
          logger.error({ err: err.message, id: prod.id }, 'Failed to index product');
        }
      }

      logger.info({ page, count: products.length, totalIndexed }, 'Synced page of products');
      if (products.length < 20) {
        reachedEnd = true;
        break;
      }
      page++;
    }

    let removed = 0;
    if (!reachedEnd) {
      logger.warn({ maxPages: MAX_SYNC_PAGES },
        'Catalog sync hit the page cap — skipping prune so unseen products are never deleted');
    } else {
      try {
        // Products indexed by this run have synced_at >= syncStartedAt; anything older was
        // not returned by the store any more.
        const pruned = await query('DELETE FROM products WHERE synced_at < $1 RETURNING id', [
          syncStartedAt,
        ]);
        removed = pruned.rowCount || 0;
        if (removed > 0) {
          logger.warn({ removed }, 'Pruned products that no longer exist in the store');
        }
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to prune stale products from the catalog index');
      }
    }

    logger.info({ totalIndexed, removed }, 'Finished full WooCommerce product catalog sync');
    return { indexed: totalIndexed, removed };
  }
}

export const ragIndexer = new RagIndexer();
