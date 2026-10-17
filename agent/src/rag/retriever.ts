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
   * 1. Vector similarity via match_products (recall)
   * 2. Token keyword search over the catalog (precision)
   * 3. One combined score, so a product whose name shares every query word always beats a
   *    merely "semantically nearby" one.
   *
   * Why the rewrite: the old version returned the vector results whenever it got 2+ rows and
   * only fell back to keywords below that. With Gemini's compressed similarity scores the
   * 0.50 threshold matches almost the whole catalog, so there were ALWAYS 2+ rows and the
   * keyword path was dead code. A customer asking for "dot moving belt" got five other belts
   * \u2014 "Dot Pattern Moving Belt" never appeared, and the bot told them it was not available.
   */
  async searchProducts(searchQuery: string, limit: number = 5): Promise<ProductSearchResult[]> {
    try {
      const phrase = String(searchQuery || '').toLowerCase().trim();
      const tokens = tokenize(phrase);

      // 1. Vector recall. A low threshold is deliberate \u2014 scoring below decides relevance;
      // this stage only has to avoid missing the right product.
      const embedding = await gemini.embedText(searchQuery);
      const vectorStr = `[${embedding.join(',')}]`;

      const vectorResult = await query<ProductSearchResult>(
        `SELECT id, name, sku, price, regular_price, stock_quantity, stock_status, short_description, permalink, images, similarity
         FROM match_products($1::vector, 0.35, 20)`,
        [vectorStr]
      );

      // 2. Keyword recall on individual words, not the whole phrase. The old whole-phrase
      // ILIKE could never match "Dot Pattern Moving Belt" for the query "dot moving belt"
      // because of the extra word in the middle.
      const patterns = [
        ...(phrase.length >= 2 ? [`%${phrase}%`] : []),
        ...tokens.map((t) => `%${t}%`),
      ];

      let keywordRows: ProductSearchResult[] = [];
      if (patterns.length > 0) {
        const keywordResult = await query<ProductSearchResult>(
          `SELECT id, name, sku, price, regular_price, stock_quantity, stock_status, short_description, permalink, images, 0 AS similarity
           FROM products
           WHERE name ILIKE ANY($1::text[])
              OR short_description ILIKE ANY($1::text[])
              OR sku ILIKE ANY($1::text[])
           LIMIT 50`,
          [patterns]
        );
        keywordRows = keywordResult.rows;
      }

      // 3. Merge, score, rank.
      const seen = new Map<number, ProductSearchResult>();
      for (const p of [...vectorResult.rows, ...keywordRows]) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }

      const scored = [...seen.values()]
        .map((p) => ({ product: p, score: relevanceScore(p, phrase, tokens) }))
        .sort((a, b) => b.score - a.score);

      logger.debug(
        { query: searchQuery, tokens, top: scored.slice(0, limit).map((s) => ({ id: s.product.id, name: s.product.name, score: s.score })) },
        'Hybrid product search'
      );

      return scored.slice(0, limit).map((s) => s.product);
    } catch (err: any) {
      logger.error({ err: err.message, query: searchQuery }, 'Failed to search products');
      return [];
    }
  }
}

/**
 * Words that carry no product signal. Kept small on purpose: dropping a real product word is
 * worse than keeping a useless one, because token coverage is the strongest ranking signal.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to', 'is', 'are',
  'do', 'does', 'you', 'your', 'have', 'has', 'any', 'this', 'that', 'it', 'me', 'my',
  'please', 'pls', 'want', 'need', 'show', 'give', 'get', 'koto', 'kotha', 'dam', 'daam',
  'price', 'taka', 'tk', 'ta', 'ti', 'ekta', 'ache', 'achhe', 'ase', 'chai', 'kemon',
  '\u0995\u09A4', '\u09A6\u09BE\u09AE', '\u099F\u09BE\u0995\u09BE', '\u0986\u099B\u09C7', '\u0995\u09BF', '\u098F\u09B0', '\u099F\u09BE', '\u099F\u09BF', '\u098F\u0995\u099F\u09BE', '\u099A\u09BE\u0987', '\u0995\u09C7\u09AE\u09A8',
]);

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .split(/[^\p{L}\p{N}]+/u)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
  )];
}

/**
 * Rank a catalog row against the customer's words.
 *
 * Signals, strongest first:
 *  - the whole phrase appears in the name;
 *  - every query word appears in the name (coverage), with a smaller credit for the
 *    description;
 *  - vector similarity as a tie-breaker.
 * A "combo"/"set" is pushed down unless the customer actually asked for one, so "dot moving
 * belt" surfaces the single belt rather than the belt+wallet bundles named after it.
 */
function relevanceScore(p: ProductSearchResult, phrase: string, tokens: string[]): number {
  const name = String(p.name || '').toLowerCase();
  const description = String(p.short_description || '').toLowerCase();
  const similarity = Number(p.similarity) || 0;

  let score = similarity * 1.5;

  if (phrase.length >= 3 && name.includes(phrase)) score += 4;

  if (tokens.length > 0) {
    let inName = 0;
    let inDescription = 0;
    for (const t of tokens) {
      if (name.includes(t)) inName++;
      else if (description.includes(t)) inDescription++;
    }
    score += (inName / tokens.length) * 3;
    score += (inDescription / tokens.length) * 0.5;
  }

  // A combo's name often *contains* the single product's name ("Mini Wallet and Dot Moving
  // Belt Combo"), so the phrase bonus otherwise pushes bundles above the item the customer
  // actually asked for. The penalty is larger than the phrase bonus on purpose: when someone
  // says "dot moving belt" they mean the belt, and bundles should only appear lower down.
  const asksForCombo = /combo|set|bundle/i.test(phrase);
  if (!asksForCombo && /combo|bundle|\bset\b/i.test(name)) score -= 5;

  return score;
}

export const ragRetriever = new RagRetriever();
