import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '../src/config/index.js';
import { db, query, queryOne, SELECT } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { ingestReview as ingest, reviewRecord as strong } from './helpers/review.js';
import { enableReviewAi, reviewAiResponse } from './helpers/review.js';
import { readJob } from '../src/dashboard/store.js';
beforeAll(useTempDb);
beforeEach(async () => { vi.unstubAllGlobals(); resetConfigCache(); await resetTestDb(); });
afterAll(async () => { vi.unstubAllGlobals(); resetConfigCache(); await closeTempDb(); });
describe("vacancy identity and refresh", () => {
    it.each([false, true])('retains same-run description and rates regardless of sparse-result order (%s)', async (reverse) => {
        const sparse = normalizeJob({ ...strong, description: null, currency: null, min_amount: null, max_amount: null }, 'linkedin')!;
        const full = normalizeJob(strong, 'linkedin')!;
        const result = await ingestJobs(reverse ? [full, sparse] : [sparse, full], { runId: null });
        expect(result.created).toBe(1);
        expect(result.jobIds).toHaveLength(1);
        const stored = await queryOne<any>(SELECT.from(db().Jobs));
        expect(stored.description).toBe(strong.description);
        expect(Number(stored.salaryMin)).toBe(60);
        await ingest({ description: null });
        const listing = await queryOne<any>(SELECT.from(db().SourceListings));
        expect(listing.hasDescription).toBeTruthy();
        expect(JSON.parse(listing.rawRecord).description).toBe(strong.description);
    });
    it.each([
        ['Berlin, Germany', 'Austin, TX, US'],
        ['Berlin, Germany', 'Munich, Germany'],
    ])('does not merge recruiter boilerplate across conflicting locations: %s / %s', async (first, second) => {
        await ingest({ location: first });
        const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', location: second }, 'indeed');
        expect(result.created).toBe(1);
        expect(result.mergedAcrossSources).toBe(0);
    });
    it.each(['Client', 'Project ID', 'Duration', 'Start date'])('does not merge different recruiter projects with conflicting %s', async (label) => {
        await ingest({ description: `${strong.description}\n${label}: European client project` });
        const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', description: `${strong.description}\n${label}: US client project` }, 'indeed');
        expect(result.created).toBe(1);
        expect(result.mergedAcrossSources).toBe(0);
    });
    it.each([strong.description, null])('keeps distinct same-board IDs separate with description %s', async (description) => {
        await ingest({ description });
        const result = await ingest({ id: 'regression-2', description, location: description ? strong.location : 'Munich, Germany', job_url: 'https://www.linkedin.com/jobs/view/regression-2' });
        expect(result.created).toBe(1);
        expect(await query(SELECT.from(db().Jobs))).toHaveLength(2);
    });
    it.each([
        ['Berlin, Germany', 'Munich, Germany'],
        [null, null],
        ['Germany', 'Germany'],
        ['Remote, Germany, DE', 'Remote, Germany, DE'],
    ])('keeps uncertain cross-board duplicates separate: %s / %s', async (first, second) => {
        await ingest({ description: null, location: first });
        const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', description: null, location: second }, 'indeed');
        expect(result.created).toBe(1);
        expect(result.mergedAcrossSources).toBe(0);
    });
    it('still merges a cross-board vacancy with the same specific city and near-identical title', async () => {
        await ingest({ description: null });
        const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', description: null }, 'indeed');
        expect(result.created).toBe(0);
        expect(result.mergedAcrossSources).toBe(1);
    });
    it('refreshes known details and invalidates the assessment without changing job identity', async () => {
        const first = await ingest();
        const [original] = await rank({ rulesOnly: true });
        const before = await queryOne<any>(SELECT.from(db().Jobs));
        const updated = await ingest({
            title: 'SAP BTP Architect', description: `${strong.description} No freelancers accepted.`,
            min_amount: 30, max_amount: 40, is_remote: false, job_type: 'fulltime', location: 'Munich, Germany',
        });
        const after = await queryOne<any>(SELECT.from(db().Jobs));
        expect(updated.updated).toBe(1);
        expect(updated.jobIds).toEqual(first.jobIds);
        expect(after).toMatchObject({ title: 'SAP BTP Architect', isRemote: false, jobType: 'fulltime', location: 'Munich, Germany', firstSeenAt: before.firstSeenAt });
        expect(Number(after.salaryMin)).toBe(30);
        expect(Number(after.salaryMax)).toBe(40);
        expect(after.descriptionHash).not.toBe(before.descriptionHash);
        const [reranked] = await rank({ rulesOnly: true });
        expect(reranked!.cached).toBe(false);
        expect(reranked!.assessmentId).not.toBe(original!.assessmentId);
        expect(reranked!.assessment.recommendation).toBe('Skip');
    });
    it('preserves known details when the next observation omits them', async () => {
        await ingest();
        await ingest({ description: null, location: null, min_amount: null, max_amount: null, is_remote: null, job_type: null });
        const current = await queryOne<any>(SELECT.from(db().Jobs));
        expect(current).toMatchObject({ description: strong.description, location: strong.location, isRemote: true, jobType: 'contract' });
        expect(Number(current.salaryMax)).toBe(75);
    });
    it('uses a new cross-board listing only to fill missing information', async () => {
        await ingest();
        await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', max_amount: 20, is_remote: false }, 'indeed');
        const current = await queryOne<any>(SELECT.from(db().Jobs));
        expect(current.isRemote).toBe(true);
        expect(Number(current.salaryMax)).toBe(75);
    });
    it('keeps equivalent primary observations and conflicting secondary facts stable across repeated AI ranks', async () => {
        const id = (await ingest()).jobIds[0]!;
        enableReviewAi();
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse()));
        const [original] = await rank();
        const secondary = { id: 'secondary', job_url: 'https://indeed.com/viewjob?jk=secondary',
            description: `${strong.description} Optional onsite visits.`, max_amount: 80, is_remote: false };
        for (let visit = 0; visit < 3; visit++) {
            await ingest(secondary, 'indeed');
            expect((await rank())[0]!.assessmentId).toBe(original!.assessmentId);
            await ingest({ description: strong.description!.replaceAll(' ', '  '), job_url: strong.job_url + '?utm_source=repeat' });
            const [cached] = await rank();
            expect(cached!.assessmentId).toBe(original!.assessmentId);
            expect(cached!.cached).toBe(true);
        }
        expect(fetch).toHaveBeenCalledTimes(1);
        const current = await queryOne<any>(SELECT.from(db().Jobs));
        expect(current.description).toBe(strong.description);
        expect(current.isRemote).toBe(true);
        expect(Number(current.salaryMax)).toBe(75);
        const details = await readJob(id);
        expect(details.listings.find(listing => listing.source === 'indeed')!.conflicts)
            .toContainEqual({ field: 'salaryMax', value: '80' });
    });
    it('keeps secondary-filled facts when subsequent secondary observations conflict', async () => {
        await ingest({ description: null, is_remote: null, max_amount: null });
        const secondary = { id: 'secondary', job_url: 'https://indeed.com/viewjob?jk=secondary' };
        await ingest(secondary, 'indeed');
        await ingest({ ...secondary, description: `${strong.description} No freelancers accepted.`, is_remote: false, max_amount: 30 }, 'indeed');
        const current = await queryOne<any>(SELECT.from(db().Jobs));
        expect(current.description).toBe(strong.description);
        expect(current.isRemote).toBe(true);
        expect(Number(current.salaryMax)).toBe(75);
    });
    it('does not attach a secondary currency to a conflicting primary amount', async () => {
        await ingest({ min_amount: null, max_amount: 30, currency: null });
        await ingest({ id: 'secondary', job_url: 'https://indeed.com/viewjob?jk=secondary' }, 'indeed');
        const current = await queryOne<any>(SELECT.from(db().Jobs));
        expect(current.salaryCurrency).toBeNull();
        expect(Number(current.salaryMax)).toBe(30);
        expect((await rank({ rulesOnly: true }))[0]!.assessment.hardReject).toBe(false);
    });
    it('does not report an update when stored decimal values are unchanged', async () => {
        await ingest();
        expect((await ingest()).updated).toBe(0);
    });
});
describe('deduplication boundaries', () => {
    it.each([
        [{}, 'linkedin', false],
        [{ id: null, job_url: strong.job_url + '?utm_source=other' }, 'linkedin', false],
        [{ id: 'secondary', job_url: 'https://indeed.com/viewjob?jk=secondary' }, 'indeed', false],
        [{ id: 'other-company', company: 'Another Client', job_url: 'https://indeed.com/viewjob?jk=other' }, 'indeed', true],
        [{ id: 'other-role', description: 'Permanent ABAP logistics support in Hamburg.', job_url: 'https://indeed.com/viewjob?jk=other' }, 'indeed', true],
    ] as const)('retains or separates listing identity: %s', async (overrides, source, separate) => {
        await ingest();
        await ingest(overrides, source);
        expect(await query(SELECT.from(db().Jobs))).toHaveLength(separate ? 2 : 1);
    });
    it('fills missing details while preserving first-seen time', async () => {
        await ingest({ description: null, date_posted: null });
        const before = await queryOne<any>(SELECT.from(db().Jobs));
        await ingest({ date_posted: '2026-10-05' });
        expect(await queryOne(SELECT.from(db().Jobs))).toMatchObject({ description: strong.description,
            datePosted: '2026-10-05', firstSeenAt: before.firstSeenAt });
    });
});
