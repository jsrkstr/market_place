import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { pool } from '../../src/db/client.js';
import { findOrCreateUserByEmail } from '../../src/domain/users.service.js';
import type { UserContext } from '../../src/domain/types.js';

let migrated = false;

/** Creates the test database if needed and applies migrations once per process. */
export async function setupTestDb(): Promise<void> {
  if (migrated) return;
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  await runMigrations();
  migrated = true;
}

/** Wipes all application data between tests. */
export async function resetDb(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '__drizzle%'`,
  );
  if (rows.length) await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
}

export async function makeUser(email: string): Promise<UserContext> {
  const u = await findOrCreateUserByEmail(email);
  return { userId: u.id };
}
