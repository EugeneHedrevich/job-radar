import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, DELETE, disconnectDb, SELECT, UPDATE, query, queryOne } from '../src/db/index.js';
import { listingActivitySchema, type ListingActivity } from '../src/collector/types.js';
import { reserveBatchPlan } from '../src/collector/rotation.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { applyListingActivity, isJobClosed } from '../src/persist/activity.js';
import { normalizeJob } from '../src/normalize/index.js';
import { rank } from '../src/pipeline/rank.js';
import { notify } from '../src/pipeline/notify.js';
import { closeTempDb, useTempDb } from './helpers/db.js';
import { enableReviewAi, reviewAiResponse, reviewRecord } from './helpers/review.js';

let file: string;
beforeAll(async () => { file = await useTempDb(); });
beforeEach(async () => {
  vi.unstubAllGlobals(); resetConfigCache();
  for (const entity of [db().ListingActivityEvents, db().AiAssessmentQueue, db().Notifications, db().Assessments,
    db().SourceListings, db().Jobs, db().DescriptionRotation]) await cds.run(DELETE.from(entity));
});
afterAll(async () => { vi.unstubAllGlobals(); resetConfigCache(); await closeTempDb(); });

function observation(overrides: Partial<ListingActivity> = {}): ListingActivity {
  return { source: 'linkedin', source_job_id: reviewRecord.id, job_url: reviewRecord.job_url!, status: 'closed',
    reason: 'http_404', evidence: 'HTTP 404 for listing detail', checked_at: '2026-10-10T12:00:00.000Z', ...overrides };
}
async function seed(description = reviewRecord.description) {
  return ingestJobs([normalizeJob({ ...reviewRecord, description }, 'linkedin')!], { runId: null });
}
function sender() { return { send: vi.fn(async () => ({ ok: true, messageId: 123, retryable: false })) }; }

describe('confirmed activity is separate from user status and matching history', () => {
  it('persists closure across restart and excludes the job from AI work and description enrichment', async () => {
    const seeded = await seed();
    await rank({ rulesOnly: true });
    await cds.run(UPDATE(db().Jobs).set({ status: 'Interested' }).where({ ID: seeded.jobIds[0] }));
    await applyListingActivity([observation()]);
    await seed(null); // A stale search result cannot reopen a confirmed closed listing.
    await disconnectDb(); await connectDb(file); enableReviewAi();
    const request = vi.fn(async () => reviewAiResponse()); vi.stubGlobal('fetch', request);
    expect(await rank({ jobIds: [], includePendingAi: true })).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    const job = await queryOne<any>(SELECT.from(db().Jobs));
    expect(job.status).toBe('Interested'); expect(await isJobClosed(job.ID)).toBe(true);
    expect(await query(SELECT.from(db().ListingActivityEvents))).toHaveLength(1);
    const plan = await reserveBatchPlan(loadConfig(), { enrichOnly: true, onlySources: ['linkedin'] });
    expect(plan.tasksBySource.size).toBe(0);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(0);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Superseded' }))).toHaveLength(1);
  });

  it('excludes a closed incomplete listing even when its merged job has another open source', async () => {
    const seeded = await seed(null);
    await ingestJobs([normalizeJob({ ...reviewRecord, id: 'indeed-incomplete', description: null,
      job_url: 'https://indeed.com/viewjob?jk=incomplete' }, 'indeed')!], { runId: null });
    await applyListingActivity([observation()]);
    expect(await isJobClosed(seeded.jobIds[0]!)).toBe(false);
    const plan = await reserveBatchPlan(loadConfig(), { enrichOnly: true, onlySources: ['linkedin'] });
    expect(plan.tasksBySource.size).toBe(0);
  });

  it('revalidates a previously queued notification after closure, preserving its history', async () => {
    const seeded = await seed(); await rank({ rulesOnly: true });
    const client = sender();
    await notify({ client, dryRun: true });
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Pending' });
    await cds.run(UPDATE(db().Jobs).set({ status: 'Applied' }).where({ ID: seeded.jobIds[0] }));
    await applyListingActivity([observation({ reason: 'valid_through', evidence: 'validThrough: 2026-10-01' })]);
    client.send.mockClear();
    const summary = await notify({ client });
    expect(summary.sent).toBe(0); expect(summary.skipped).toBe(1); expect(client.send).not.toHaveBeenCalled();
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Skipped', lastError: 'All source listings are confirmed closed' });
    expect(await queryOne(SELECT.from(db().Jobs))).toMatchObject({ status: 'Applied' });
    expect(await query(SELECT.from(db().Assessments))).toHaveLength(1);
  });

  it('keeps a merged job active through another listing and links only to an available source', async () => {
    const seeded = await seed();
    const secondary = { ...reviewRecord, id: 'indeed-active', job_url: 'https://indeed.com/viewjob?jk=active' };
    const merged = await ingestJobs([normalizeJob(secondary, 'indeed')!], { runId: null });
    expect(merged.jobIds).toEqual(seeded.jobIds); expect(merged.mergedAcrossSources).toBe(1);
    await applyListingActivity([observation(), observation({ source: 'indeed', source_job_id: secondary.id,
      job_url: secondary.job_url, status: 'active', reason: undefined, evidence: 'Public API listing has a description' })]);
    expect(await isJobClosed(seeded.jobIds[0]!)).toBe(false);
    await rank({ rulesOnly: true }); const client = sender();
    expect((await notify({ client })).sent).toBe(1);
    expect(JSON.parse((await queryOne<any>(SELECT.from(db().Notifications))).payload).url).toBe(secondary.job_url);
    expect(JSON.parse((await queryOne<any>(SELECT.from(db().Notifications))).payload).text).not.toContain('LinkedIn');
  });

  it('only reopens on a newer active observation and keeps all observation history', async () => {
    const seeded = await seed();
    await cds.run(UPDATE(db().Jobs).set({ status: 'Ignored' }).where({ ID: seeded.jobIds[0] }));
    await applyListingActivity([observation()]);
    await applyListingActivity([observation({ status: 'active', reason: undefined, evidence: 'Public detail has a description',
      checked_at: '2026-10-10T11:00:00.000Z' })]);
    expect(await isJobClosed(seeded.jobIds[0]!)).toBe(true);
    await applyListingActivity([observation({ status: 'active', reason: undefined, evidence: 'Public detail has a description',
      checked_at: '2026-10-10T13:00:00.000Z' })]);
    expect(await isJobClosed(seeded.jobIds[0]!)).toBe(false);
    expect(await query(SELECT.from(db().ListingActivityEvents))).toHaveLength(2);
    expect(await queryOne(SELECT.from(db().Jobs))).toMatchObject({ status: 'Ignored' });
  });

  it('requires a recognized closure reason in the collector contract', () => {
    expect(listingActivitySchema.safeParse(observation({ reason: undefined })).success).toBe(false);
    for (const reason of ['timeout', 'rate_limit', 'blocked', 'parse', 'old_date_posted', 'not_in_search']) {
      expect(listingActivitySchema.safeParse({ ...observation(), reason }).success).toBe(false);
    }
  });

  it('limits delivery calls to three, including failures and a larger explicit limit', async () => {
    for (let index = 0; index < 6; index++) {
      await ingestJobs([normalizeJob({ ...reviewRecord, id: `telegram-${index}`,
        job_url: `https://www.linkedin.com/jobs/view/telegram-${index}` }, 'linkedin')!], { runId: null });
    }
    await rank({ rulesOnly: true });
    loadConfig().settings.telegram.retry_base_delay_seconds = 0;
    const client = { send: vi.fn(async () => ({ ok: false, retryable: true, error: 'Offline failure' })) };
    const summary = await notify({ client, limit: 99 });
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(summary.failed).toBe(3); expect(summary.sent).toBe(0);
  });
});
