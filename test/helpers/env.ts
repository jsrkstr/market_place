// Test environment: offline providers, inline jobs, dedicated test database.
process.env.SKIP_DOTENV = '1';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://market:market@localhost:5544/market_test';
process.env.EMBEDDINGS_PROVIDER = 'fake';
process.env.GEOCODER = 'fake';
process.env.MAILER = 'console';
process.env.JOBS_MODE = 'inline';
process.env.STORAGE_DIR = './data/test-blobs';
process.env.PUBLIC_BASE_URL = 'http://localhost:3999';
process.env.APP_SECRET = 'test-secret-123456';
process.env.DEV_AUTH_TOKENS = 'tok-seller:seller@test.dev,tok-buyer:buyer@test.dev,tok-buyer2:buyer2@test.dev,tok-seller2:seller2@test.dev';
