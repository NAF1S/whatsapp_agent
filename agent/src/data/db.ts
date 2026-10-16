import { Pool, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

export const pool = new Pool(config.db);

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database client error on idle connection');
});

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const res = await pool.query<T>(text, params);
    const duration = Date.now() - start;
    logger.debug({ text: text.substring(0, 80), duration, rows: res.rowCount }, 'Executed DB query');
    return res;
  } catch (err: any) {
    logger.error({ err: err.message, query: text.substring(0, 100), params }, 'DB query error');
    throw err;
  }
}

export async function checkDbConnection(): Promise<boolean> {
  try {
    const res = await pool.query('SELECT NOW() as current_time, version()');
    logger.info({ time: res.rows[0]?.current_time }, 'Supabase PostgreSQL connected successfully');
    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to connect to Supabase PostgreSQL');
    return false;
  }
}
