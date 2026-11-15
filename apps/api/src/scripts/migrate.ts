import { db, transaction } from '../core/db.js';
import { schema } from './schema.js';
try {
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(721344)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const existing = await client.query('SELECT version FROM schema_migrations WHERE version=1');
    if (existing.rowCount === 0) {
      await client.query(schema);
      await client.query('INSERT INTO schema_migrations(version) VALUES(1)');
    }
  });
  console.info('Migração 1 aplicada.');
} finally {
  await db.end();
}
