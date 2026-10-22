import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

function sslOptions(): pg.PoolConfig['ssl'] {
  if (config.databaseCa) return { ca: config.databaseCa, rejectUnauthorized: true };
  // Aiven URIs carry sslmode=require; without a CA we still encrypt but cannot verify.
  if (/sslmode=require/.test(config.DATABASE_URL)) return { rejectUnauthorized: false };
  return undefined;
}

export const pool = new pg.Pool({
  // pg would otherwise parse sslmode itself and override our ssl object.
  connectionString: config.DATABASE_URL.replace(/[?&]sslmode=[^&]+/, ''),
  ssl: sslOptions(),
  max: config.DATABASE_POOL_MAX,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
/** A transaction handle or the db itself; services accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export async function closeDb(): Promise<void> {
  await pool.end();
}
