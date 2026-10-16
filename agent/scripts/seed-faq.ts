import fs from 'fs';
import path from 'path';
import { ragIndexer } from '../src/rag/indexer';
import { logger } from '../src/utils/logger';
import { query } from '../src/data/db';

async function seedFaq() {
  const faqPath = path.resolve(__dirname, '../../data/faq.json');
  logger.info({ path: faqPath }, 'Reading FAQ file...');

  const content = fs.readFileSync(faqPath, 'utf-8');
  const data = JSON.parse(content);
  const faqs = data.faqs || [];

  logger.info({ count: faqs.length }, 'Seeding FAQs into Supabase documents table...');

  // indexDocument() only ever INSERTs, so re-running this script would leave old
  // answers retrievable next to the new ones — including contradictory policy text.
  // Replace the FAQ set instead (FAQ rows are exactly those carrying a 'question' key).
  const removed = await query(`DELETE FROM documents WHERE metadata ? 'question' RETURNING id`);
  logger.info({ removed: removed.rowCount }, 'Removed previous FAQ documents before re-seeding');

  for (const faq of faqs) {
    const docText = `Category: ${faq.category}\nQuestion: ${faq.question}\nAnswer: ${faq.answer}`;
    try {
      await ragIndexer.indexDocument(docText, {
        category: faq.category,
        question: faq.question,
      });
      logger.info({ question: faq.question }, 'Indexed FAQ item');
    } catch (err: any) {
      logger.error({ err: err.message, question: faq.question }, 'Failed to index FAQ');
    }
  }

  logger.info('Finished seeding FAQ data!');
  process.exit(0);
}

seedFaq().catch((err) => {
  logger.error(err);
  process.exit(1);
});
