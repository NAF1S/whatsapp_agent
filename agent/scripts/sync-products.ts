import { ragIndexer } from '../src/rag/indexer';
import { logger } from '../src/utils/logger';

async function syncProducts() {
  logger.info('Starting full WooCommerce product synchronization...');
  try {
    const result = await ragIndexer.syncAllWooCommerceProducts();
    logger.info({ indexed: result.indexed, removed: result.removed },
      'Product catalog sync completed successfully');
    process.exit(0);
  } catch (err: any) {
    logger.error({ err: err.message }, 'Product catalog sync failed');
    process.exit(1);
  }
}

syncProducts();
