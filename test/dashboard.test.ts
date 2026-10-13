import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, disconnectDb, INSERT, query, queryOne, SELECT, UPDATE } from '../src/db/index.js';
import { listJobs, readCollectionStatus, readJob, updateTracking } from '../src/dashboard/store.js';
import { assessmentCacheKey, findCurrentAssessment, rank } from '../src/pipeline/rank.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { ingestReview, reviewRecord } from './helpers/review.js';

let file: string;
beforeAll(async () => { file = await useTempDb(); });
beforeEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetConfigCache();
  vi.stubEnv('OPENAI_API_KEY', 'offline-dashboard-key');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Dashboard must not make network requests'); }));
  await resetTestDb();
});
afterAll(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetConfigCache(); await closeTempDb(); });

async function storedJob() {
  const result = await ingestReview();
  return queryOne<any>(SELECT.from(db().Jobs).where({ ID: result.jobIds[0] }));
}

describe('personal dashboard stored data', () => {
  it('includes older, low-score, closed and unassessed jobs, with filters and stable pagination', async () => {
    const job = await storedJob();
    await rank({ rulesOnly: true });
    await cds.run(UPDATE(db().Assessments).set({ fitScore: 0, recommendation: 'Skip' }).where({ job_ID: job.ID }));
    // A secondary source remains one deduplicated job.
    await ingestReview({ id: 'secondary', job_url: 'https://indeed.com/viewjob?jk=secondary' }, 'indeed');
    await cds.run(UPDATE(db().SourceListings).set({ activityState: 'Closed' }).where({ job_ID: job.ID }));
    await ingestReview({ id: 'unassessed', title: 'Different unassessed job', description: null,
      job_url: 'https://glassdoor.com/job-listing/unassessed' }, 'glassdoor');
    const list = await listJobs();
    expect(list.total).toBe(2);
    expect(list.items.find((row) => row.ID === job.ID)).toMatchObject({ sources: ['indeed', 'linkedin'],
      activity: 'Closed', fitScore: 0, assessmentState: 'rules', datePosted: null });
    expect(list.items.find((row) => row.ID !== job.ID)).toMatchObject({ fitScore: null, assessmentState: 'unassessed' });
    expect((await listJobs(new URLSearchParams({ minScore: '0' }))).items.map((row) => row.ID)).toEqual([job.ID]);
    expect((await listJobs(new URLSearchParams({ minScore: '1' }))).total).toBe(0);
    expect((await listJobs(new URLSearchParams({ source: 'indeed', activity: 'Closed', status: 'New' }))).total).toBe(1);
    const sources = new URLSearchParams([['source', 'indeed'], ['source', 'glassdoor']]);
    expect((await listJobs(sources)).total).toBe(2);
    sources.append('source', 'linkedin'); // A merged vacancy must still appear only once.
    expect((await listJobs(sources)).total).toBe(2);
    expect((await listJobs(new URLSearchParams({ source: 'indeed,glassdoor' }))).total).toBe(2);
    expect((await listJobs(new URLSearchParams({ source: 'linkedin' }))).items.map((row) => row.ID)).toEqual([job.ID]);
    expect((await listJobs(new URLSearchParams({ source: 'missing-source' }))).total).toBe(0);
    expect((await listJobs(new URLSearchParams({ q: 'review client' }))).total).toBe(2);
    for (const direction of ['asc', 'desc']) {
      expect((await listJobs(new URLSearchParams({ sort: 'fitScore', direction }))).items[0]!.fitScore).toBe(0);
    }
    const first = await listJobs(new URLSearchParams({ pageSize: '1', page: '1' }));
    const second = await listJobs(new URLSearchParams({ pageSize: '1', page: '2' }));
    expect(first.items[0]!.ID).not.toBe(second.items[0]!.ID);
    expect((await listJobs(new URLSearchParams({ page: '99', pageSize: '1' }))).page).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('labels saved rules, pending AI, current AI, fallback and outdated history without doing AI work', async () => {
    const job = await storedJob();
    await rank({ rulesOnly: true });
    const rules = await queryOne<any>(SELECT.from(db().Assessments).where({ job_ID: job.ID }));
    expect(await readJob(job.ID)).toMatchObject({ assessmentState: 'rules', aiPending: true,
      currentAssessment: { createdAt: rules.createdAt, strongMatches: expect.any(Array), suggestedCvVariant: rules.suggestedCvVariant } });
    const aiId = randomUUID();
    await cds.run(INSERT.into(db().Assessments).entries({ ...rules, ID: aiId, engine: 'llm', model: 'offline-model',
      cacheKey: assessmentCacheKey(loadConfig(), job, 'llm'), fitScore: 91, createdAt: '2099-01-01T00:00:00.000Z' }));
    expect(await readJob(job.ID)).toMatchObject({ assessmentState: 'ai', fitScore: 91, aiPending: false });
    vi.stubEnv('OPENAI_API_KEY', '');
    const disabled = loadConfig();
    disabled.settings.llm.enabled = false;
    disabled.llmAvailable = false;
    expect(await findCurrentAssessment(disabled, job)).toMatchObject({ ID: aiId });
    expect(await readJob(job.ID)).toMatchObject({ assessmentState: 'ai', fitScore: 91, currentAssessment: { ID: aiId } });
    expect((await listJobs()).items[0]).toMatchObject({ assessmentState: 'ai', fitScore: 91 });
    await cds.run(UPDATE(db().Assessments).set({ engine: 'rules', model: null, explanation: 'AI request failed; rules fallback used.' }).where({ ID: aiId }));
    expect(await readJob(job.ID)).toMatchObject({ assessmentState: 'ai-fallback', currentAssessment: { engine: 'rules' }, aiPending: false });
    await cds.run(UPDATE(db().Jobs).set({ description: `${job.description}\nChanged requirements.` }).where({ ID: job.ID }));
    const outdated = await readJob(job.ID);
    expect(outdated).toMatchObject({ fitScore: null, recommendation: null, currentAssessment: null, assessmentState: 'outdated', aiPending: false });
    expect(outdated.assessmentHistory).toHaveLength(2);
    expect(outdated.assessmentHistory.every((row) => !row.current)).toBe(true);
    expect((await listJobs(new URLSearchParams({ minScore: '0' }))).total).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supersedes pending work when Ignored is saved without removing assessments or tracking', async () => {
    const job = await storedJob();
    await rank({ rulesOnly: true });
    await cds.run(INSERT.into(db().Notifications).entries({ ID: randomUUID(), job_ID: job.ID,
      channel: 'telegram', status: 'Pending', attempts: 0 }));
    await updateTracking(job.ID, { status: 'Ignored', personalNotes: 'Keep this history', cvSent: true, cvSentAt: '2026-10-12T09:00:00Z' });
    expect(await queryOne(SELECT.from(db().AiAssessmentQueue).where({ job_ID: job.ID }))).toMatchObject({ status: 'Superseded' });
    expect(await queryOne(SELECT.from(db().Notifications).where({ job_ID: job.ID }))).toMatchObject({ status: 'Skipped' });
    expect(await readJob(job.ID)).toMatchObject({ status: 'Ignored', personalNotes: 'Keep this history', cvSent: true,
      aiPending: false, currentAssessment: { engine: 'rules' } });
  });

  it('invalidates AI assessments when effective model configuration changes on the running dashboard', async () => {
    const job = await storedJob();
    await rank({ rulesOnly: true });
    const rules = await queryOne<any>(SELECT.from(db().Assessments).where({ job_ID: job.ID }));
    await cds.run(INSERT.into(db().Assessments).entries({ ...rules, ID: randomUUID(), engine: 'llm',
      cacheKey: assessmentCacheKey(loadConfig(), job, 'llm'), createdAt: '2099-01-01T00:00:00.000Z' }));
    expect((await readJob(job.ID)).assessmentState).toBe('ai');
    vi.stubEnv('OPENAI_MODEL', 'changed-offline-model');
    const changed = await readJob(job.ID);
    expect(changed.assessmentState).toBe('rules');
    expect(changed.assessmentHistory[0]).toMatchObject({ kind: 'ai', current: false });
  });

  it('preserves personal edits through collection enrichment, reassessment and database restart', async () => {
    const job = await storedJob();
    const personal = { status: 'Applied', personalNotes: 'Contact Alex; follow up Friday.',
      applicationDate: '2026-10-12', cvSent: false, cvSentAt: null, sentCvLabel: 'BTP-v3.pdf' };
    expect(await updateTracking(job.ID, personal)).toEqual(personal);
    await ingestReview({ description: `${reviewRecord.description}\nNew project information.` });
    await rank({ rulesOnly: true });
    await disconnectDb(); await connectDb(file);
    expect(await readJob(job.ID)).toMatchObject(personal);
    expect((await listJobs(new URLSearchParams({ q: 'follow up' }))).total).toBe(1);
    for (const status of ['Interview', 'Rejected']) {
      expect(await updateTracking(job.ID, { status, cvSent: true, cvSentAt: '2026-10-12T09:00:00Z' }))
        .toMatchObject({ ...personal, status, cvSent: true, cvSentAt: '2026-10-12T09:00:00.000Z' });
    }
    expect(await readJob(job.ID)).toMatchObject({ sentCvLabel: 'BTP-v3.pdf', currentAssessment: { suggestedCvVariant: expect.any(String) } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects vacancy/assessment writes and invalid tracking values without partial changes', async () => {
    const job = await storedJob();
    for (const patch of [{ title: 'Changed', status: 'Applied' }, { fitScore: 100 }, { description: 'Changed' },
      { status: 'Closed' }, { cvSent: 'yes' }, { applicationDate: '2026-02-30' }, { personalNotes: 'x'.repeat(20_001) }, {}]) {
      await expect(updateTracking(job.ID, patch)).rejects.toMatchObject({ status: 400 });
    }
    expect(await readJob(job.ID)).toMatchObject({ title: job.title, status: 'New', cvSent: false, personalNotes: '' });
    await expect(updateTracking('missing', { status: 'Applied' })).rejects.toMatchObject({ status: 404 });
  });

  it('reads explicit expiry and mixed-source activity independently from application status without mutating observations', async () => {
    const job = await storedJob();
    await ingestReview({ id: 'secondary', job_url: 'https://indeed.com/viewjob?jk=secondary' }, 'indeed');
    await updateTracking(job.ID, { status: 'Interview', personalNotes: 'Interview booked', cvSent: true, cvSentAt: '2026-10-12T09:00:00Z' });
    await cds.run(UPDATE(db().SourceListings).set({ activityState: 'Closed' }).where({ source: 'linkedin' }));
    expect((await readJob(job.ID)).activity).toBe('Unknown');
    await cds.run(UPDATE(db().SourceListings).set({ activityState: 'Active' }).where({ source: 'indeed' }));
    expect((await readJob(job.ID)).activity).toBe('Active');
    await cds.run(UPDATE(db().SourceListings).set({ validThrough: '2000-01-01T00:00:00.000Z' }).where({ source: 'indeed' }));
    expect(await readJob(job.ID)).toMatchObject({ activity: 'Closed', status: 'Interview', personalNotes: 'Interview booked', cvSent: true });
    expect(await queryOne(SELECT.from(db().SourceListings).where({ source: 'indeed' }))).toMatchObject({ activityState: 'Active' });
    expect(await query(SELECT.from(db().ListingActivityEvents))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns stored latest collection counts, errors and cooldowns without recovery or external calls', async () => {
    expect(await readCollectionStatus()).toMatchObject({ latestRun: null, sources: [], linkedinCoverage: { combinations: 98, slotsPerSequence: 66, checkedWithinWindow: 0 } });
    const runId = randomUUID();
    await cds.run(INSERT.into(db().CollectionRuns).entries([
      { ID: randomUUID(), startedAt: '2000-01-01T00:00:00.000Z', batchKey: 'older', status: 'Completed' },
      { ID: runId, startedAt: '2000-01-02T00:00:00.000Z', batchKey: 'btp-core', status: 'Running', jobsFound: 0, jobsNew: 0, jobsUpdated: 0 },
    ]));
    await cds.run(INSERT.into(db().CollectionTasks).entries({ ID: randomUUID(), run_ID: runId,
      source: 'indeed', status: 'Failed', resultCount: 0, message: 'Rate limited' }));
    await cds.run(INSERT.into(db().CollectionErrors).entries({ ID: randomUUID(), run_ID: runId,
      source: 'indeed', kind: 'rate_limit', message: 'HTTP 429', occurredAt: '2000-01-02T00:01:00.000Z' }));
    await cds.run(INSERT.into(db().SourceHealth).entries({ source: 'indeed', consecutiveFailures: 1,
      cooldownUntil: '2099-01-01T00:00:00.000Z', blocked: true, lastStatus: 'rate_limit' }));
    const status = await readCollectionStatus();
    expect(status.latestRun).toMatchObject({ ID: runId, status: 'Running', batchKey: 'btp-core', jobsFound: 0,
      tasks: [expect.objectContaining({ source: 'indeed', status: 'Failed' })],
      errors: [expect.objectContaining({ kind: 'rate_limit', message: 'HTTP 429' })] });
    expect(status.sources).toEqual([expect.objectContaining({ source: 'indeed', cooldownUntil: '2099-01-01T00:00:00.000Z', blocked: true })]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
