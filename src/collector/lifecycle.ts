import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/index.js';
import { cds, db, INSERT, SELECT, UPDATE, query } from '../db/index.js';
import { log } from '../util/log.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_HEARTBEAT_MS = 5 * 60_000;

/** Recover abandoned runs without expiring an active long-running collector. */
export async function recoverInterruptedRuns(config: AppConfig, now = new Date()): Promise<number> {
  const runs = await query<{ ID: string; batchKey: string; startedAt: string; heartbeatAt: string | null }>(
    SELECT.from(db().CollectionRuns).where({ status: 'Running' }));
  let recovered = 0;
  for (const run of runs) {
    const batch = config.searches.rotation.batches.find((candidate) => candidate.key === run.batchKey);
    // Pre-heartbeat runs may still be executing older code. Give them the full
    // worst-case process/retry allowance for their recorded batch.
    const sources = batch ? Object.keys(batch.targets).length : Object.keys(config.searches.sources).length;
    const legacyBudget = sources * (config.searches.resilience.process_timeout_seconds *
      (1 + config.searches.resilience.max_retries_per_task) + config.searches.resilience.retry_delay_seconds) * 1000;
    const timestamp = new Date(run.heartbeatAt ?? run.startedAt).getTime();
    if (!Number.isFinite(timestamp) || now.getTime() - timestamp <= (run.heartbeatAt ? STALE_HEARTBEAT_MS : legacyBudget)) continue;
    await cds.tx(async (tx: any) => {
      const changed = await tx.run(UPDATE(db().CollectionRuns).set({ status: 'Failed', finishedAt: now.toISOString() })
        .where({ ID: run.ID, status: 'Running', heartbeatAt: run.heartbeatAt ?? null }));
      if (!changed) return;
      await tx.run(INSERT.into(db().CollectionErrors).entries({ ID: randomUUID(), run_ID: run.ID,
        kind: 'interrupted', message: 'Collection stopped without completing; its heartbeat or legacy execution allowance expired.',
        occurredAt: now.toISOString() }));
      recovered += 1;
    });
  }
  if (recovered) log.warn(`Recovered ${recovered} interrupted collection run(s)`);
  return recovered;
}

export function startRunHeartbeat(runId: string): () => Promise<void> {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      await cds.run(UPDATE(db().CollectionRuns).set({ heartbeatAt: new Date().toISOString() })
        .where({ ID: runId, status: 'Running' }));
    }).catch((error) => log.warn('Could not update collection heartbeat', { message: String(error) }));
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}
