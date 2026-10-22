import { PgBoss } from 'pg-boss';
import { config } from '../config.js';

/**
 * Background job dispatch. Domain code calls `dispatch()` after committing a change; handlers are
 * registered once at startup (see src/jobs/handlers.ts).
 *
 * JOBS_MODE=inline runs the handler immediately (awaited) — used by tests and simple single-process dev.
 * JOBS_MODE=queue enqueues into pg-boss (same Postgres) and `pnpm worker` processes it.
 */
export interface JobPayloads {
  /** A listing was published/updated/status-changed. Re-evaluate it against active requests. */
  'listing.changed': { listingId: string; reason: 'published' | 'updated' | 'status_changed' };
  /** A buyer request was created/updated (immediate matching already ran synchronously). */
  'request.changed': { requestId: string; reason: 'created' | 'updated' | 'status_changed' };
  /** Periodic maintenance: expiry, availability checks, stale propagation. */
  'sweep.maintenance': Record<string, never>;
  /** Periodic email digest of unread inbox items. */
  'sweep.digest': Record<string, never>;
}
export type JobName = keyof JobPayloads;
type Handler<N extends JobName> = (payload: JobPayloads[N]) => Promise<void>;

const QUEUE_POLICIES: Record<JobName, 'short' | 'stately'> = {
  'listing.changed': 'short',
  'request.changed': 'short',
  'sweep.maintenance': 'stately',
  'sweep.digest': 'stately',
};

const handlers = new Map<JobName, Handler<any>>();
let boss: PgBoss | null = null;

export function registerHandler<N extends JobName>(name: N, handler: Handler<N>): void {
  handlers.set(name, handler);
}

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({ connectionString: config.DATABASE_URL, max: 2, ssl: config.databaseCa ? { ca: config.databaseCa } : undefined });
    boss.on('error', (err) => console.error('[pg-boss]', err));
    await boss.start();
    // Create every queue up front (senders may run in a process without handlers). 'short' makes
    // singletonKey collapse duplicate queued jobs; 'stately' keeps at most one queued+active sweep.
    for (const name of Object.keys(QUEUE_POLICIES) as JobName[]) {
      await boss.createQueue(name, { policy: QUEUE_POLICIES[name] });
    }
  }
  return boss;
}

export async function dispatch<N extends JobName>(name: N, payload: JobPayloads[N]): Promise<void> {
  if (config.JOBS_MODE === 'inline') {
    const h = handlers.get(name);
    if (!h) return; // no handler registered (e.g. unit tests of a single service)
    try {
      await h(payload);
    } catch (err) {
      console.error(`[jobs] inline ${name} failed`, err);
    }
    return;
  }
  const b = await getBoss();
  // singletonKey collapses bursts of updates to the same entity into one job.
  const key = 'listingId' in payload ? payload.listingId : 'requestId' in payload ? payload.requestId : name;
  await b.send(name, payload, { singletonKey: String(key), retryLimit: 3 });
}

export async function stopBoss(): Promise<void> {
  if (boss) await boss.stop({ graceful: true });
  boss = null;
}
