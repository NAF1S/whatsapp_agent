import { query } from '../data/db';
import { gemini } from '../brain/gemini';
import { logger } from '../utils/logger';

export interface DocSearchResult {
  id: string;
  content: string;
  metadata: any;
  similarity: number;
}

export interface ProductSearchResult {
  id: number;
  name: string;
  sku: string;
  price: number;
  regular_price: number;
  stock_quantity: number | null;
  stock_status: string;
  short_description: string;
  permalink: string;
  images: any;
  similarity?: number;
}

export class RagRetriever {
  /**
   * Search knowledge base documents (FAQ, policies, delivery info) using vector similarity
   */
  async searchKnowledgeBase(searchQuery: string, limit: number = 4): Promise<DocSearchResult[]> {
    try {
      const embedding = await gemini.embedText(searchQuery);
      const vectorStr = `[${embedding.join(',')}]`;

      const result = await query<DocSearchResult>(
        `SELECT id, content, metadata, similarity 
         FROM match_documents($1::vector, 0.55, $2)`,
        [vectorStr, limit]
      );

      return result.rows;
    } catch (err: any) {
      logger.error({ err: err.message, query: searchQuery }, 'Failed to search knowledge base');
      return [];
    }
  }

  /**
   * Search products using hybrid search:
   * 1. Vector similarity search via match_products
   * 2. Full-text / keyword fallback if vector score is below threshold or yields few items
   */
  async searchProducts(searchQuery: string, limit: number = 5): Promise<ProductSearchResult[]> {
    try {
      // 1. Vector similarity search
      const embedding = await gemini.embedText(searchQuery);
      const vectorStr = `[${embedding.join(',')}]`;

      const vectorResult = await query<ProductSearchResult>(
        `SELECT id, name, sku, price, regular_price, stock_quantity, stock_status, short_description, permalink, images, similarity
         FROM match_products($1::vector, 0.50, $2)`,
        [vectorStr, limit]
      );

      if (vectorResult.rows.length >= 2) {
        return vectorResult.rows;
      }

      // 2. Keyword fallback search (fuzzy ILIKE across name and description)
      const cleanTerm = searchQuery.replace(/[^\w\s\u0980-\u09FF]/gi, '').trim();
      const keywordResult = await query<ProductSearchResult>(
        `SELECT id, name, sku, price, regular_price, stock_quantity, stock_status, short_description, permalink, images, 0.5 as similarity
         FROM products
         WHERE name ILIKE $1 OR short_description ILIKE $1 OR sku ILIKE $1
         LIMIT $2`,
        [`%${cleanTerm}%`, limit]
      );

      // Merge and deduplicate
      const seen = new Set<number>();
      const combined: ProductSearchResult[] = [];

      for (const p of [...vectorResult.rows, ...keywordResult.rows]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          combined.push(p);
        }
      }

      return combined.slice(0, limit);
    } catch (err: any) {
      logger.error({ err: err.message, query: searchQuery }, 'Failed to search products');
      return [];
    }
  }
}

export const ragRetriever = new RagRetriever();
