import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveBatchPlan } from '../src/collector/rotation.js';
import { listingActivitySchema, type ListingActivity } from '../src/collector/types.js';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, disconnectDb, query, queryOne, SELECT, UPDATE } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { applyListingActivity, expireListingDeadlines, isJobClosed } from '../src/persist/activity.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { notify } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { enableReviewAi, reviewAiResponse, reviewRecord } from './helpers/review.js';
let file: string;
beforeAll(async () => { file = await useTempDb(); });
beforeEach(async () => {
    vi.unstubAllGlobals();
    resetConfigCache();
    await resetTestDb();
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
    it.each([null, '2026-10-14T12:00:00.000Z'])('honors a newly removed or extended expiry: %s', async (deadline) => {
        await seed();
        await applyListingActivity([observation({ status: 'active', reason: undefined, evidence: 'Initial deadline',
            checked_at: '2026-10-10T10:00:00.000Z', valid_through: '2026-10-11T12:00:00.000Z' })]);
        await applyListingActivity([observation({ status: 'active', reason: undefined, evidence: 'Fresh page deadline',
            checked_at: '2026-10-10T13:00:00.000Z', valid_through: deadline })]);
        await expireListingDeadlines(new Date('2026-10-12T12:00:00Z'));
        expect(await queryOne(SELECT.from(db().SourceListings))).toMatchObject({ activityState: 'Active' });
        expect(await query(SELECT.from(db().ListingActivityEvents))).toHaveLength(2);
    });
    it('persists a future expiry and closes an enriched listing after restart without search or HTTP', async () => {
        const seeded = await seed();
        await rank({ rulesOnly: true });
        const client = sender();
        await notify({ client, dryRun: true });
        await applyListingActivity([observation({ status: 'active', reason: undefined, evidence: 'Listing has a description',
                checked_at: '2026-10-10T10:00:00.000Z', valid_through: '2026-10-11T12:00:00.000Z' })]);
        await disconnectDb();
        await connectDb(file);
        // A sparse observation must not erase a previously confirmed deadline.
        await applyListingActivity([observation({ status: 'active', reason: undefined, evidence: 'Fresh listing without expiry metadata',
            checked_at: '2026-10-10T13:00:00.000Z' })]);
        await expireListingDeadlines(new Date('2026-10-11T11:59:59Z'));
        expect(await queryOne(SELECT.from(db().SourceListings))).toMatchObject({ activityState: 'Active' });
        await expireListingDeadlines(new Date('2026-10-11T12:00:00Z'));
        expect(await queryOne(SELECT.from(db().SourceListings))).toMatchObject({ activityState: 'Closed', closureReason: 'valid_through' });
        client.send.mockClear();
        expect((await notify({ client })).sent).toBe(0);
        expect(client.send).not.toHaveBeenCalled();
        expect(await rank({ jobIds: seeded.jobIds, includePendingAi: true })).toEqual([]);
        expect(await query(SELECT.from(db().ListingActivityEvents))).toHaveLength(3);
    });
    it.each(['linkedin', 'nextventures', 'remotive'])('refreshes stale enriched %s listings within existing slots and delays failed attempts', async (source) => {
        const at = new Date('2026-10-10T12:00:00Z');
        const job = normalizeJob({ ...reviewRecord, id: 'stale', date_posted: '2000-01-01',
            job_url: `https://example.com/${source}/stale` }, source)!;
        await ingestJobs([job], { runId: null, seenAt: new Date('2026-01-01') });
        const config = loadConfig();
        const plan = await reserveBatchPlan(config, { enrichOnly: true, onlySources: [source], resultsWanted: 2, at });
        const tasks = [...plan.tasksBySource.values()].flat();
        expect(tasks.length).toBeLessThanOrEqual(2);
        expect(tasks.flatMap((task) => task.detail_jobs ?? [])).toEqual([
            expect.objectContaining({ id: 'stale', activity_refresh: true }),
        ]);
        // Reserving before I/O also survives transport/parse failures and restarts.
        await disconnectDb();
        await connectDb(file);
        expect((await reserveBatchPlan(config, { enrichOnly: true, onlySources: [source], at: new Date(at.getTime() + 3600000) })).tasksBySource.size).toBe(0);
        expect((await reserveBatchPlan(config, { enrichOnly: true, onlySources: [source], at: new Date(at.getTime() + 24 * 3600000) })).tasksBySource.size).toBe(1);
    });
    it('persists closure across restart and excludes the job from AI work and description enrichment', async () => {
        const seeded = await seed();
        await rank({ rulesOnly: true });
        await cds.run(UPDATE(db().Jobs).set({ status: 'Interested' }).where({ ID: seeded.jobIds[0] }));
        await applyListingActivity([observation()]);
        await seed(null); // A stale search result cannot reopen a confirmed closed listing.
        await disconnectDb();
        await connectDb(file);
        enableReviewAi();
        const request = vi.fn(async () => reviewAiResponse());
        vi.stubGlobal('fetch', request);
        expect(await rank({ jobIds: [], includePendingAi: true })).toEqual([]);
        expect(request).not.toHaveBeenCalled();
        const job = await queryOne<any>(SELECT.from(db().Jobs));
        expect(job.status).toBe('Interested');
        expect(await isJobClosed(job.ID)).toBe(true);
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
        const seeded = await seed();
        await rank({ rulesOnly: true });
        const client = sender();
        await notify({ client, dryRun: true });
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Pending' });
        await cds.run(UPDATE(db().Jobs).set({ status: 'Applied' }).where({ ID: seeded.jobIds[0] }));
        await applyListingActivity([observation({ reason: 'valid_through', evidence: 'validThrough: 2026-10-01' })]);
        client.send.mockClear();
        const summary = await notify({ client });
        expect(summary.sent).toBe(0);
        expect(summary.skipped).toBe(1);
        expect(client.send).not.toHaveBeenCalled();
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Skipped', lastError: 'All source listings are confirmed closed' });
        expect(await queryOne(SELECT.from(db().Jobs))).toMatchObject({ status: 'Applied' });
        expect(await query(SELECT.from(db().Assessments))).toHaveLength(1);
    });
    it('keeps a merged job active through another listing and links only to an available source', async () => {
        const seeded = await seed();
        const secondary = { ...reviewRecord, id: 'indeed-active', job_url: 'https://indeed.com/viewjob?jk=active' };
        const merged = await ingestJobs([normalizeJob(secondary, 'indeed')!], { runId: null });
        expect(merged.jobIds).toEqual(seeded.jobIds);
        expect(merged.mergedAcrossSources).toBe(1);
        await applyListingActivity([observation(), observation({ source: 'indeed', source_job_id: secondary.id,
                job_url: secondary.job_url, status: 'active', reason: undefined, evidence: 'Public API listing has a description' })]);
        expect(await isJobClosed(seeded.jobIds[0]!)).toBe(false);
        await rank({ rulesOnly: true });
        const client = sender();
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
});
