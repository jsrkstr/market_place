/**
 * Background worker: processes pg-boss jobs (JOBS_MODE=queue) and schedules the periodic sweeps.
 * Run with `pnpm worker`. The web process only enqueues via dispatch().
 */
import type { Job, Queue } from 'pg-boss';
import { closeDb } from './db/client.js';
import { getBoss, stopBoss, type JobName, type JobPayloads } from './infra/jobs.js';
import { jobHandlers, registerAllHandlers } from './jobs/handlers.js';

/**
 * Queue options. `short` keeps at most one *queued* job per singletonKey, so bursts of edits to the same
 * listing collapse into one job while a running job can still be followed by one more. On the default
 * `standard` policy pg-boss v12 ignores singletonKey unless singletonSeconds is also given.
 */
const QUEUES: Record<JobName, Omit<Queue, 'name'>> = {
  'listing.changed': { policy: 'short', retryLimit: 3, retryDelay: 30, retryBackoff: true },
  'request.changed': { policy: 'short', retryLimit: 3, retryDelay: 30, retryBackoff: true },
  'sweep.maintenance': { policy: 'stately', retryLimit: 1 },
  'sweep.digest': { policy: 'stately', retryLimit: 1 },
};

async function main(): Promise<void> {
  // Create queues with explicit policies BEFORE registering handlers: getBoss() creates queues for
  // already-registered handlers with the default policy, and createQueue does not change an existing policy.
  const boss = await getBoss();
  for (const [name, opts] of Object.entries(QUEUES)) await boss.createQueue(name, opts);
  // Registered too so any dispatch() made from within a handler finds its queue.
  registerAllHandlers();

  for (const name of Object.keys(QUEUES) as JobName[]) {
    const handler = jobHandlers[name] as (p: JobPayloads[JobName]) => Promise<void>;
    // Throwing fails the job so pg-boss retries it per the queue's retry settings.
    await boss.work(name, { batchSize: 1 }, async (jobs: Job<JobPayloads[JobName]>[]) => {
      for (const job of jobs) await handler(job.data);
    });
  }

  await boss.schedule('sweep.maintenance', '0 * * * *', {}, { tz: 'Europe/Paris' });
  await boss.schedule('sweep.digest', '0 18 * * *', {}, { tz: 'Europe/Paris' });
  console.log('[worker] started; queues:', Object.keys(QUEUES).join(', '));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[worker] ${signal} received, draining…`);
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await stopBoss();
      await closeDb();
      process.exit(0);
    } catch (err) {
      console.error('[worker] shutdown error', err);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
