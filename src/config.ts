import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

if (existsSync('.env') && !process.env.SKIP_DOTENV) process.loadEnvFile('.env');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),

  PORT: z.coerce.number().int().default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  APP_SECRET: z.string().min(8).default('dev-secret-change-me'),

  DEV_AUTH_TOKENS: z.string().default(''),

  EMBEDDINGS_PROVIDER: z.enum(['openai', 'fake']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),

  GEOCODER: z.enum(['nominatim', 'fake']).default('nominatim'),
  GEOCODER_USER_AGENT: z.string().default('market-place-dev'),

  STORAGE_DIR: z.string().default('./data/blobs'),

  MAILER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('Marketplace <no-reply@example.com>'),

  JOBS_MODE: z.enum(['queue', 'inline']).default('inline'),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  /** Embedding dimension is fixed by the DB column; providers must return vectors of this size. */
  EMBEDDING_DIMENSIONS: 1536,
  databaseCa: parsed.DATABASE_CA_CERT ? readFileSync(parsed.DATABASE_CA_CERT, 'utf8') : undefined,
  devTokens: new Map(
    parsed.DEV_AUTH_TOKENS.split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [token, email] = pair.split(':');
        return [token, email] as const;
      }),
  ),
};

export type Config = typeof config;
