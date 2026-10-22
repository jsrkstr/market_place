import { config } from '../config.js';
import { registerHandler, type JobName, type JobPayloads } from '../infra/jobs.js';
import { handleListingChanged } from './listingChanged.js';
import { runDigestSweep, runMaintenanceSweep } from './sweeps.js';

export { handleListingChanged } from './listingChanged.js';
export { runDigestSweep, runMaintenanceSweep } from './sweeps.js';

const log = (...args: unknown[]) => {
  if (config.NODE_ENV !== 'test') console.log(...args);
};

/** The handler for every job. Errors propagate so pg-boss can retry in queue mode. */
export const jobHandlers: { [N in JobName]: (payload: JobPayloads[N]) => Promise<void> } = {
  'listing.changed': async ({ listingId }) => {
    await handleListingChanged(listingId);
  },
  'request.changed': async () => {
    // Intentionally light: requests.service runs matching synchronously on create/update (so the buyer
    // sees results immediately) and stale-marks no-longer-qualifying matches itself. This is the hook
    // for future work, e.g. telling sellers of strongly matching listings about new demand.
  },
  'sweep.maintenance': async () => {
    log('[sweep.maintenance]', JSON.stringify(await runMaintenanceSweep()));
  },
  'sweep.digest': async () => {
    log('[sweep.digest]', JSON.stringify(await runDigestSweep()));
  },
};

/** Register every background job handler. Call once at startup (server, worker and tests). */
export function registerAllHandlers(): void {
  for (const name of Object.keys(jobHandlers) as JobName[]) {
    registerHandler(name, jobHandlers[name] as (p: JobPayloads[typeof name]) => Promise<void>);
  }
}
