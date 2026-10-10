import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { recoverInterruptedRuns, startRunHeartbeat } from '../src/collector/lifecycle.js';
import { cds, db, DELETE, INSERT, SELECT, query } from '../src/db/index.js';
import { closeTempDb, useTempDb } from './helpers/db.js';

beforeAll(async () => { await useTempDb(); });
beforeEach(async () => {
  for (const entity of [db().CollectionErrors, db().CollectionRuns]) await cds.run(DELETE.from(entity));
});
afterAll(closeTempDb);

describe('collection run recovery', () => {
  it('recovers stale heartbeats and old legacy runs while preserving live and recent runs', async () => {
    const now = new Date('2026-10-09T20:00:00Z');
    const records = [
      { ID: 'old-legacy', startedAt: '2026-10-09T10:00:00Z', heartbeatAt: null },
      { ID: 'recent-legacy', startedAt: '2026-10-09T19:00:00Z', heartbeatAt: null },
      { ID: 'stale', startedAt: '2026-10-09T10:00:00Z', heartbeatAt: '2026-10-09T19:54:00Z' },
      { ID: 'active', startedAt: '2026-10-09T10:00:00Z', heartbeatAt: '2026-10-09T19:59:30Z' },
    ];
    await cds.run(INSERT.into(db().CollectionRuns).entries(records.map((row) => ({ ...row, batchKey: 'btp-core', status: 'Running' }))));
    expect(await recoverInterruptedRuns(loadConfig(), now)).toBe(2);
    expect(await recoverInterruptedRuns(loadConfig(), now)).toBe(0);
    const runs = await query<any>(SELECT.from(db().CollectionRuns));
    expect(runs.filter((run) => run.status === 'Failed').map((run) => run.ID).sort()).toEqual(['old-legacy', 'stale']);
    expect(runs.filter((run) => run.status === 'Running').map((run) => run.ID).sort()).toEqual(['active', 'recent-legacy']);
    expect(await query(SELECT.from(db().CollectionErrors))).toHaveLength(2);
  });

  it('updates active heartbeats and stops its timer after completion', async () => {
    const id = randomUUID();
    await cds.run(INSERT.into(db().CollectionRuns).entries({ ID: id, status: 'Running',
      startedAt: '2026-10-09T10:00:00Z', heartbeatAt: '2026-10-09T10:00:00Z' }));
    vi.useFakeTimers();
    const stop = startRunHeartbeat(id);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await stop();
      const [row] = await query<any>(SELECT.from(db().CollectionRuns).where({ ID: id }));
      expect(row.heartbeatAt).not.toBe('2026-10-09T10:00:00Z');
      const timestamp = row.heartbeatAt;
      await vi.advanceTimersByTimeAsync(60_000);
      const [unchanged] = await query<any>(SELECT.from(db().CollectionRuns).where({ ID: id }));
      expect(unchanged.heartbeatAt).toBe(timestamp);
    } finally { await stop(); vi.useRealTimers(); }
  });
});
