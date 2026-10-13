import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { loadConfig, PROJECT_ROOT, resetConfigCache } from '../src/config/index.js';
import { db, query, SELECT } from '../src/db/index.js';
import { loadFixture } from '../src/fixtures/load.js';
import { collect } from '../src/pipeline/collect.js';
import { notify } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, useTempDb } from './helpers/db.js';
import { reviewSender } from './helpers/review.js';
beforeAll(async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    resetConfigCache();
    await useTempDb();
});
afterAll(async () => {
    await closeTempDb();
    vi.unstubAllEnvs();
    resetConfigCache();
});
it('collects, deduplicates, caches and previews an offline demo cycle safely', async () => {
    expect(loadConfig().llmAvailable).toBe(false);
    const fixture = loadFixture(path.join(PROJECT_ROOT, 'fixtures', 'demo-jobs.jsonl'));
    const first = await collect({ fixture });
    expect(first.ingest).toMatchObject({ created: 4, mergedAcrossSources: 1, accepted: 5, filtered: 2 });
    const ranked = await rank({ rulesOnly: true });
    const client = reviewSender();
    expect((await notify({ client, dryRun: true })).sent).toBeGreaterThan(0);
    const calls = client.send.mock.calls.length;
    expect((await collect({ fixture })).ingest.created).toBe(0);
    expect((await rank({ rulesOnly: true })).every((entry) => entry.cached)).toBe(true);
    expect((await notify({ client })).sent).toBe(0);
    expect(client.send).toHaveBeenCalledTimes(calls);
    const notifications = await query<any>(SELECT.from(db().Notifications));
    for (const entry of ranked.filter((row) => row.assessment.hardReject)) {
        expect(notifications.map((row) => row.job_ID)).not.toContain(entry.job.ID);
    }
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(4);
    expect((await query<any>(SELECT.from(db().CollectionRuns))).every((run) => run.status === 'Completed' && run.finishedAt)).toBe(true);
});
