/** HTTP entrypoint: loads config, registers job handlers (needed in-process for JOBS_MODE=inline) and listens. */
import { config } from './config.js';
import { closeDb } from './db/client.js';
import { stopBoss } from './infra/jobs.js';
import { registerAllHandlers } from './jobs/handlers.js';
import { createApp } from './http.js';

registerAllHandlers();

const server = createApp().listen(config.PORT, () => {
  console.log(`marketplace listening on :${config.PORT} (MCP at ${config.PUBLIC_BASE_URL}/mcp, jobs: ${config.JOBS_MODE})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close();
  await stopBoss().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
