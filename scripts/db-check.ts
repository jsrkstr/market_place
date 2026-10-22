// Verifies the configured database (e.g. Aiven) is reachable and has pgvector + the vector indexes.
import { closeDb, pool } from '../src/db/client.js';

const version = await pool.query<{ version: string }>('select version()');
const ext = await pool.query<{ extversion: string }>(`select extversion from pg_extension where extname = 'vector'`);
const idx = await pool.query<{ indexname: string }>(`select indexname from pg_indexes where indexname like '%embedding_hnsw'`);
const tables = await pool.query<{ n: number }>(`select count(*)::int as n from pg_tables where schemaname = 'public'`);
const listings = tables.rows[0].n ? await pool.query<{ n: number }>('select count(*)::int as n from listings').catch(() => null) : null;
console.log(`server:   ${version.rows[0].version.split(',')[0]}`);
console.log(`pgvector: ${ext.rows[0]?.extversion ?? 'NOT INSTALLED'}`);
console.log(`hnsw:     ${idx.rows.map((r) => r.indexname).join(', ') || 'none'}`);
console.log(`tables:   ${tables.rows[0].n}${listings ? ` (listings: ${listings.rows[0].n})` : ''}`);
await closeDb();
