import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, db, query, queryOne, SELECT, UPDATE } from '../src/db/index.js';
import { assessWithRules } from '../src/matching/rules.js';
import { normalizeJob } from '../src/normalize/index.js';
import { formatNotification } from '../src/notify/format.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { notify } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { ingestReview as ingest, reviewJob, reviewSender as sender, reviewRecord as strong } from './helpers/review.js';
beforeAll(useTempDb);
beforeEach(async () => { vi.unstubAllGlobals(); resetConfigCache(); await resetTestDb(); });
afterAll(async () => { vi.unstubAllGlobals(); resetConfigCache(); await closeTempDb(); });
describe("current notification eligibility", () => {
    it('skips queued Ignored delivery, excludes new candidates and retains sent history', async () => {
        const result = await ingest();
        await rank({ rulesOnly: true });
        await notify({ dryRun: true, client: sender() });
        await cds.run(UPDATE(db().Jobs).set({ status: 'Ignored' }).where({ ID: result.jobIds[0] }));
        const client = sender();
        expect(await notify({ client })).toMatchObject({ queued: 0, sent: 0 });
        expect(client.send).not.toHaveBeenCalled();
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Skipped' });
        await cds.run(UPDATE(db().Notifications).set({ status: 'Sent', telegramMessageId: 123 }));
        await notify({ client });
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Sent', telegramMessageId: 123 });
    });
    it('does not notify a weekly onsite schedule above the configured travel limit', async () => {
        await ingest({ description: `${strong.description}\nThree onsite days every week are required.` });
        const [result] = await rank({ rulesOnly: true });
        expect(result!.assessment.recommendation).toBe('Skip');
        const client = sender();
        expect((await notify({ client })).queued).toBe(0);
        expect(client.send).not.toHaveBeenCalled();
    });
    it('holds delivery if changed job content has not been reassessed yet', async () => {
        await ingest();
        await rank({ rulesOnly: true });
        await ingest({ max_amount: 15 });
        const client = sender();
        expect((await notify({ client })).queued).toBe(0);
        expect(client.send).not.toHaveBeenCalled();
    });
    it.each(['version', 'content'])('invalidates historical assessments after a scoring %s change', async (change) => {
        await ingest();
        await rank({ rulesOnly: true });
        const config = loadConfig();
        if (change === 'version')
            config.scoring.version = 'new-version';
        else
            config.scoring.hard_rejects.rules.push({ id: 'test', reason: 'New incompatibility', any: ['btp'], none: [] });
        const client = sender();
        expect((await notify({ client })).sent).toBe(0);
        await rank({ rulesOnly: true });
        const summary = await notify({ client });
        expect(summary.sent).toBe(change === 'version' ? 1 : 0);
    });
    it('cancels a queued preview when the job becomes a rejection before live delivery', async () => {
        await ingest();
        await rank({ rulesOnly: true });
        await notify({ dryRun: true, client: sender() });
        await ingest({ description: `${strong.description} No freelancers accepted.` });
        await rank({ rulesOnly: true });
        const client = sender();
        expect((await notify({ client })).skipped).toBe(1);
        expect(client.send).not.toHaveBeenCalled();
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Skipped' });
    });
    it('rebuilds a pending payload using current details before live delivery', async () => {
        await ingest();
        await rank({ rulesOnly: true });
        await notify({ dryRun: true, client: sender() });
        await ingest({ max_amount: 90 });
        const [current] = await rank({ rulesOnly: true });
        const client = sender();
        expect((await notify({ client })).sent).toBe(1);
        expect(client.send.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('90') });
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ assessment_ID: current!.assessmentId });
    });
    it('does not deliver fixture previews during a later live notification run', async () => {
        await ingest({}, 'linkedin', true);
        await rank({ rulesOnly: true });
        expect((await notify({ dryRun: true, client: sender() })).sent).toBe(1);
        const client = sender();
        expect((await notify({ client })).sent).toBe(0);
        expect(client.send).not.toHaveBeenCalled();
    });
    it('can queue a previously skipped vacancy once it has a current eligible assessment again', async () => {
        await ingest();
        await rank({ rulesOnly: true });
        await notify({ dryRun: true, client: sender() });
        await ingest({ description: `${strong.description} No freelancers accepted.` });
        await rank({ rulesOnly: true });
        await notify({ client: sender() });
        await ingest();
        await rank({ rulesOnly: true });
        expect((await notify({ client: sender() })).sent).toBe(1);
        expect(await query(SELECT.from(db().Notifications))).toHaveLength(1);
    });
});
describe("delivery claim recovery", () => {
    it('recovers an expired delivery claim and counts the recovery against the attempt limit', async () => {
        await ingest();
        await rank({ rulesOnly: true });
        await notify({ dryRun: true, client: sender() });
        await cds.run(UPDATE(db().Notifications).set({
            status: 'Sending', attempts: 1, claimToken: 'old-claim', claimUntil: '2020-01-01T00:00:00.000Z',
        }));
        const client = sender();
        expect((await notify({ client })).sent).toBe(1);
        expect(client.send).toHaveBeenCalledTimes(1);
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Sent', attempts: 2, claimToken: null });
    });
    it('releases the delivery claim when the sender throws, allowing a bounded retry', async () => {
        await ingest();
        await rank({ rulesOnly: true });
        const client = { send: vi.fn(async () => { throw new Error('connection reset'); }) };
        expect((await notify({ client })).failed).toBe(1);
        expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Failed', attempts: 1, claimToken: null });
        expect((await notify({ client: sender() })).sent).toBe(1);
    });
});
describe("Telegram call ceiling", () => {
    it('limits delivery calls to three, including failures and a larger explicit limit', async () => {
        for (let index = 0; index < 6; index++) {
            await ingestJobs([normalizeJob({ ...strong, id: `telegram-${index}`,
                    job_url: `https://www.linkedin.com/jobs/view/telegram-${index}` }, 'linkedin')!], { runId: null });
        }
        await rank({ rulesOnly: true });
        loadConfig().settings.telegram.retry_base_delay_seconds = 0;
        const client = { send: vi.fn(async () => ({ ok: false, retryable: true, error: 'Offline failure' })) };
        const summary = await notify({ client, limit: 99 });
        expect(client.send).toHaveBeenCalledTimes(3);
        expect(summary.failed).toBe(3);
        expect(summary.sent).toBe(0);
    });
});
describe('delivery outcomes and retries', () => {
    it.each(['transient', 'thrown', 'permanent'])('handles a %s error without duplicate delivery', async (kind) => {
        await ingest();
        await rank({ rulesOnly: true });
        loadConfig().settings.telegram.retry_base_delay_seconds = 0;
        const client = { send: vi.fn(async () => {
                if (kind === 'thrown')
                    throw new Error('connection reset');
                return { ok: false, error: 'Offline failure', retryable: kind !== 'permanent' };
            }) };
        expect((await notify({ client })).failed).toBe(1);
        const recovered = sender();
        expect((await notify({ client: recovered })).sent).toBe(kind === 'permanent' ? 0 : 1);
        await notify({ client: recovered });
        expect(recovered.send).toHaveBeenCalledTimes(kind === 'permanent' ? 0 : 1);
    });
    it.each([['Professional English required.', true], ['Fluent English required.', false]] as const)('uses the 75-point Telegram threshold for %s', async (language, eligible) => {
        await ingest({ description: strong.description + '\n' + language });
        await rank({ rulesOnly: true });
        const client = sender();
        expect((await notify({ client })).sent).toBe(eligible ? 1 : 0);
        expect(client.send).toHaveBeenCalledTimes(eligible ? 1 : 0);
    });
    it('formats unknown source values without inventing details', () => {
        const vacancy = reviewJob('', { company: null, datePosted: null, salaryMin: null, salaryMax: null, salaryCurrency: null });
        const message = formatNotification(loadConfig(), vacancy, assessWithRules(loadConfig(), vacancy), ['linkedin']);
        for (const text of ['LinkedIn', 'Rate: not stated', 'Published: unknown', 'Company: not stated'])
            expect(message.text).toContain(text);
        expect(message.url).toBe(vacancy.primaryUrl);
    });
});
