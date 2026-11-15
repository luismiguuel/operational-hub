import pg from 'pg';
import { config } from './config.js';
import { HttpError } from './errors.js';
export { HttpError } from './errors.js';
export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export function found<T>(value: T | undefined): T {
  if (value === undefined) throw new HttpError(404, 'Recurso não encontrado.');
  return value;
}
