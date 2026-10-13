import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, disconnectDb, query, queryOne, SELECT, UPDATE } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { notify } from '../src/pipeline/notify.js';
import { rank, readTop } from '../src/pipeline/rank.js';
import { requeueAssessment } from '../src/dashboard/assessment-retry.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { enableReviewAi, ingestReview as ingest, reviewAiResponse as llmResponse, reviewAiResponse, reviewRecord, reviewSender as sender, reviewRecord as strong } from './helpers/review.js';
let file: string;
beforeAll(async () => { file = await useTempDb(); });
beforeEach(async () => {
    resetConfigCache();
    vi.unstubAllGlobals();
    vi.stubEnv('OPENAI_API_KEY', 'offline-test-key');
    await resetTestDb();
});
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetConfigCache(); await closeTempDb(); });
async function seed(key: string, description = reviewRecord.description!) {
    return ingestJobs([normalizeJob({ ...reviewRecord, id: key, title: `${reviewRecord.title} ${key}`,
            job_url: `https://www.linkedin.com/jobs/view/${key}`, description }, 'linkedin')!], { runId: null });
}
async function seedJobs() {
    for (let index = 0; index < 3; index++)
        await seed(`budget-${index}`);
}
describe('durable AI work across collection cycles', () => {
    it('excludes Ignored jobs from paid work and supersedes their queue history', async () => {
        const result = await seed('ignored');
        await rank({ rulesOnly: true });
        await cds.run(UPDATE(db().Jobs).set({ status: 'Ignored' }).where({ ID: result.jobIds[0] }));
        enableReviewAi();
        const request = vi.fn(async () => reviewAiResponse());
        vi.stubGlobal('fetch', request);
        await rank({ force: true, includePendingAi: true });
        expect(request).not.toHaveBeenCalled();
        expect(await queryOne(SELECT.from(db().AiAssessmentQueue))).toMatchObject({ status: 'Superseded' });
        expect(await readTop()).toHaveLength(1);
    });
    it.each(['RAP is required.', 'German is mandatory.'])('rejects known mandatory gaps before spending an AI call: %s', async (requirement) => {
        await seed('rejected', `${reviewRecord.description}\n${requirement}`);
        enableReviewAi();
        const request = vi.fn(async () => reviewAiResponse());
        vi.stubGlobal('fetch', request);
        const [result] = await rank();
        expect(result!.assessment.recommendation).toBe('Skip');
        expect(request).not.toHaveBeenCalled();
    });
    it('shares five requests between new jobs and backlog, including an empty collection after restart', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 12; i++)
            ids.push(...(await seed(`original-${i}`)).jobIds);
        enableReviewAi();
        const request = vi.fn(async () => reviewAiResponse());
        vi.stubGlobal('fetch', request);
        const first = await rank({ jobIds: ids, includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(5);
        expect(first.filter((row) => row.assessment.engine === 'llm')).toHaveLength(5);
        expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(7);
        await disconnectDb();
        resetConfigCache();
        await connectDb(file);
        enableReviewAi();
        const added = [...(await seed('new-1')).jobIds, ...(await seed('new-2')).jobIds];
        await rank({ jobIds: added, includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(10);
        expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(4);
        await rank({ jobIds: [], includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(14);
        expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(0);
        await rank({ jobIds: [], includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(14);
    });
    it('ages a lower rules score ahead of newly arrived stronger candidates with stable ties', async () => {
        const old = await seed('old', 'SAP BTP CAP Node.js. Fully remote B2B within the EU.');
        await rank({ jobIds: old.jobIds, rulesOnly: true });
        await cds.run(UPDATE(db().AiAssessmentQueue).set({ queuedAt: '2020-01-01T00:00:00.000Z' }));
        const fresh = await seed('fresh');
        enableReviewAi(loadConfig(), 1);
        const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
            const messages = JSON.parse(String(init?.body)).messages;
            expect(messages.at(-1).content).toContain('Senior SAP BTP Developer old');
            return reviewAiResponse();
        });
        vi.stubGlobal('fetch', request);
        await rank({ jobIds: fresh.jobIds, includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(1);
        expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(1);
    });
    it.each(['provider error', 'rejected output'])('holds a %s across restart and preserves its fallback when explicitly retried', async (failure) => {
        const seeded = await seed('fallback');
        enableReviewAi();
        const request = vi.fn(async () => failure === 'provider error' ? new Response('Unavailable', { status: 503 })
            : new Response(JSON.stringify({ choices: [] }), { status: 200 }));
        vi.stubGlobal('fetch', request);
        await rank({ jobIds: seeded.jobIds, includePendingAi: true });
        const fallback = await queryOne<any>(SELECT.from(db().Assessments));
        expect(fallback).toMatchObject({ engine: 'rules', aiOutcome: failure === 'provider error' ? 'ProviderFailure' : 'RejectedOutput', aiReason: expect.any(String) });
        expect(await queryOne(SELECT.from(db().AiAssessmentQueue))).toMatchObject({ status: failure === 'provider error' ? 'Failed' : 'Rejected', attempts: 1 });
        await disconnectDb(); resetConfigCache(); await connectDb(file); enableReviewAi();
        await rank({ jobIds: [], includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(1);
        expect(await requeueAssessment(seeded.jobIds[0]!)).toMatchObject({ queued: true, alreadyQueued: false });
        expect(await requeueAssessment(seeded.jobIds[0]!)).toMatchObject({ queued: true, alreadyQueued: true });
        expect(request).toHaveBeenCalledTimes(1); // Requeue itself never calls the provider.
        request.mockImplementation(async () => llmResponse());
        await rank({ jobIds: [], includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(2);
        expect(await queryOne(SELECT.from(db().AiAssessmentQueue))).toMatchObject({ status: 'Completed', attempts: 2 });
        expect(await queryOne(SELECT.from(db().Assessments).where({ ID: fallback.ID }))).toMatchObject({ aiReason: fallback.aiReason, explanation: fallback.explanation });
        await rank({ includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(2);
    });
    it('caps unchanged-input retries without losing failed attempt history', async () => {
        const seeded = await seed('retry-cap'); enableReviewAi();
        const request = vi.fn(async () => new Response('Unavailable', { status: 503 }));
        vi.stubGlobal('fetch', request);
        await rank();
        for (let attempt = 0; attempt < 2; attempt++) {
            await requeueAssessment(seeded.jobIds[0]!); await rank({ includePendingAi: true });
        }
        expect(request).toHaveBeenCalledTimes(3);
        await expect(requeueAssessment(seeded.jobIds[0]!)).rejects.toMatchObject({ status: 409 });
        await rank({ includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(3);
        expect(await query(SELECT.from(db().Assessments))).toHaveLength(3);
    });
    it('shares the hard five-call ceiling between explicit retries and fresh pending work', async () => {
        for (let i = 0; i < 6; i++) await seed(`ceiling-${i}`);
        enableReviewAi(loadConfig(), 8);
        const request = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
        vi.stubGlobal('fetch', request);
        await rank({ includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(5);
        const failed = await query<any>(SELECT.from(db().AiAssessmentQueue).where({ status: 'Rejected' }));
        expect(failed).toHaveLength(5);
        for (const row of failed) await requeueAssessment(row.job_ID);
        enableReviewAi(loadConfig(), 8);
        request.mockClear(); request.mockImplementation(async () => llmResponse());
        await rank({ includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(5);
        expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: { in: ['Pending', 'RetryPending'] } }))).toHaveLength(1);
    });
    it('uses a stable job-ID tie break for a same-score arrival batch rather than SELECT iteration order', async () => {
        for (const key of ['tie-c', 'tie-a', 'tie-b'])
            await seed(key);
        await rank({ rulesOnly: true });
        const waiting = await query<any>(SELECT.from(db().AiAssessmentQueue));
        expect(new Set(waiting.map((row) => row.queuedAt)).size).toBe(1);
        const [expected] = await query<any>(SELECT.from(db().Jobs).orderBy('ID asc'));
        enableReviewAi(loadConfig(), 1);
        const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body)).messages.at(-1).content).toContain(`title: ${expected.title}`);
            return reviewAiResponse();
        });
        vi.stubGlobal('fetch', request);
        await rank({ jobIds: [], includePendingAi: true });
        expect(request).toHaveBeenCalledTimes(1);
    });
});
import { directionCounters } from '../src/pipeline/coverage.js';
const enableLlm = (budget: number) => enableReviewAi(loadConfig(), budget);
describe("ranking views and explicit scope", () => {
    it('filters UI5 titles before applying the top limit without re-scoring', async () => {
        await ingest({ description: `${strong.description} REST APIs, OAuth and Destinations.` });
        await ingest({ id: 'ui5-title', title: 'SAPUI5 Developer',
            job_url: 'https://www.linkedin.com/jobs/view/ui5-title',
            description: 'Build SAPUI5 and SAP Fiori apps with JavaScript, TypeScript and OData. Fully remote freelance contract.' });
        await rank({ rulesOnly: true });
        const before = await query(SELECT.from(db().Assessments));
        const [first] = await readTop(1);
        expect(first!.job.title).toBe(strong.title);
        const filtered = await readTop(1, 'ui5');
        expect(filtered).toHaveLength(1);
        expect(filtered[0]!.job.title).toBe('SAPUI5 Developer');
        expect(await query(SELECT.from(db().Assessments))).toEqual(before);
    });
    it('top reads the current LLM assessment without writing a rules assessment', async () => {
        await ingest();
        enableLlm(1);
        const request = vi.fn(async () => llmResponse());
        vi.stubGlobal('fetch', request);
        const [ranked] = await rank();
        const before = await query(SELECT.from(db().Assessments));
        const [shown] = await readTop();
        expect(shown!.assessmentId).toBe(ranked!.assessmentId);
        expect(shown!.assessment.engine).toBe('llm');
        expect(await query(SELECT.from(db().Assessments))).toEqual(before);
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('an explicit empty job list does not assess the whole database', async () => {
        await ingest();
        enableLlm(5);
        const request = vi.fn(async () => llmResponse());
        vi.stubGlobal('fetch', request);
        expect(await rank({ jobIds: [] })).toEqual([]);
        expect(await query(SELECT.from(db().Assessments))).toEqual([]);
        expect(request).not.toHaveBeenCalled();
    });
});
describe("AI budgets and cached assessments", () => {
    it('counts current LLM and notification eligibility without using obsolete assessments', async () => {
        await ingest();
        enableLlm(1);
        const request = vi.fn(async () => llmResponse());
        vi.stubGlobal('fetch', request);
        await rank();
        expect((await directionCounters()).find((row) => row.direction === 'CAP/CAPM'))
            .toMatchObject({ collected: 1, described: 1, prescreened: 1, llm: 1, notify: 1 });
        await ingest({ description: `${strong.description}\nClient project changed.` });
        expect((await directionCounters()).find((row) => row.direction === 'CAP/CAPM'))
            .toMatchObject({ collected: 1, described: 1, prescreened: 1, llm: 0, notify: 0 });
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('stops further provider calls after a transient failure', async () => {
        await seedJobs();
        enableLlm(3);
        const request = vi.fn(async () => new Response('provider unavailable', { status: 503 }));
        vi.stubGlobal('fetch', request);
        const results = await rank();
        expect(request).toHaveBeenCalledTimes(1);
        expect(results).toHaveLength(3);
        expect(results.every((row) => row.assessment.engine === 'rules')).toBe(true);
    });
    it('reuses cached LLM results after the call budget is exhausted', async () => {
        await seedJobs();
        enableLlm(3);
        const request = vi.fn(async () => llmResponse());
        vi.stubGlobal('fetch', request);
        await rank();
        loadConfig().settings.llm.max_jobs_per_run = 1;
        // Budget is operational configuration, not an evaluation input.
        request.mockClear();
        const results = await rank();
        expect(request).not.toHaveBeenCalled();
        expect(results.every((row) => row.cached && row.assessment.engine === 'llm')).toBe(true);
    });
    it('persists a forced reassessment instead of returning the old cached recommendation', async () => {
        await ingest();
        enableLlm(1);
        const request = vi.fn().mockResolvedValueOnce(llmResponse()).mockResolvedValueOnce(llmResponse('Skip', 20));
        vi.stubGlobal('fetch', request);
        const [original] = await rank();
        const [updated] = await rank({ force: true });
        expect(updated!.assessmentId).toBe(original!.assessmentId);
        expect(await queryOne(SELECT.from(db().Assessments))).toMatchObject({ recommendation: 'Skip', fitScore: 20 });
        const client = sender();
        expect((await notify({ client })).sent).toBe(0);
    });
    it('never calls the provider for demo records', async () => {
        await ingest({}, 'linkedin', true);
        enableLlm(3);
        const request = vi.fn(async () => llmResponse());
        vi.stubGlobal('fetch', request);
        await rank();
        expect(request).not.toHaveBeenCalled();
    });
});
