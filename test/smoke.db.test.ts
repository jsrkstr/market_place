import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client.js';
import { setupTestDb } from './helpers/db.js';

describe('database', () => {
  afterAll(() => pool.end());
  it('migrates with pgvector and HNSW indexes', async () => {
    await setupTestDb();
    const ext = await pool.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    expect(ext.rowCount).toBe(1);
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'listings_embedding_hnsw'`);
    expect(idx.rowCount).toBe(1);
  });
});
