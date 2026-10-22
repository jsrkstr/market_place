import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, db, pool } from './client.js';

export async function runMigrations(): Promise<void> {
  // pgvector must exist before tables with vector columns are created. On Aiven this is allowed for avnadmin.
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
      return closeDb();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
