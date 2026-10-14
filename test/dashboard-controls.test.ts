import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { claimCollection, readOperation, updateOperation } from '../src/collector/lease.js';
import { runCollector } from '../src/collector/run.js';
import { loadConfig, PROJECT_ROOT, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, disconnectDb, INSERT, query, queryOne, SELECT, UPDATE } from '../src/db/index.js';
import { importVacancy, type ImportMetadata } from '../src/dashboard/import.js';
import { listReminders, updateReminder } from '../src/dashboard/reminders.js';
import { listJobs, readJob, updateTracking } from '../src/dashboard/store.js';
import { collect } from '../src/pipeline/collect.js';
import { withCollectionOperation } from '../src/pipeline/collection-operation.js';
import { rank } from '../src/pipeline/rank.js';
import { claimImportSource, claimSourceRequests, recordOutcomes, settleSourceRequests } from '../src/collector/health.js';
import { planBatch } from '../src/collector/plan.js';
import { reserveBatchPlan } from '../src/collector/rotation.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { enableReviewAi, ingestReview, reviewRecord } from './helpers/review.js';
import { startTestWorker, type TestWorker } from './helpers/worker.js';

vi.mock('../src/collector/run.js', async (original) => ({
  ...await original<typeof import('../src/collector/run.js')>(), runCollector: vi.fn(),
}));
let file: string;
const workers: TestWorker<{ type: string; acquired?: boolean; operationId?: string; message?: string }>[] = [];
beforeAll(async () => { file = await useTempDb(); });
beforeEach(async () => {
  vi.stubEnv('OPENAI_API_KEY', ''); resetConfigCache(); vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline regression'); }));
  await resetTestDb();
});
afterEach(() => { for (const worker of workers.splice(0)) if (worker.child.exitCode === null) worker.child.kill(); });
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetConfigCache(); await closeTempDb(); });

describe('local dashboard controls', () => {
  it('checks canonical URLs across sources before lookup and retains personal notes', async () => {
    const existing = await ingestReview({}, 'indeed');
    const id = existing.jobIds[0]!;
    await updateTracking(id, { personalNotes: 'Keep this contact', status: 'Interested' });
    const lookup = vi.fn(async (): Promise<ImportMetadata> => { throw new Error('Duplicate must not fetch'); });
    const result = await importVacancy({ url: 'https://www.linkedin.com/jobs/view/sap-role-123456/?trk=import&utm_source=manual' }, lookup);
    expect(result).toMatchObject({ result: 'Already tracked', job: { ID: id, personalNotes: 'Keep this contact', status: 'Interested' } });
    expect(lookup).not.toHaveBeenCalled();
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(1);
  });

  it('inserts once when imports overlap and keeps lookup failure separate from closure', async () => {
    const lookup = vi.fn(async (): Promise<ImportMetadata> => ({ job: null, activity: null, message: 'Lookup timed out' }));
    const url = 'https://www.linkedin.com/jobs/view/223344';
    const draft = await importVacancy({ url }, lookup);
    expect(draft).toMatchObject({ result: 'Needs details', availability: 'Could not verify', job: null });
    const input = { url, title: reviewRecord.title!, description: reviewRecord.description!, detailsToken: draft.detailsToken };
    const results = await Promise.all([importVacancy(input, lookup), importVacancy(input, lookup)]);
    expect(results.map((row) => row.result).sort()).toEqual(['Added', 'Already tracked']);
    expect(new Set(results.map((row) => row.job!.ID)).size).toBe(1);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(1);
    expect(await query(SELECT.from(db().SourceListings))).toHaveLength(1);
    expect((await listJobs(new URLSearchParams({ view: 'imports', minScore: '100' }))).total).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains verified closure when the user supplies details after a failed metadata lookup', async () => {
    const url = 'https://www.linkedin.com/jobs/view/334455';
    const lookup = vi.fn(async (): Promise<ImportMetadata> => ({ job: { job_url: url }, message: 'HTTP 410',
      activity: { source: 'linkedin', job_url: url, status: 'closed', reason: 'http_410',
        evidence: 'HTTP 410 for listing detail', checked_at: '2026-10-13T10:00:00Z' } }));
    const draft = await importVacancy({ url }, lookup);
    expect(draft.availability).toBe('Closed');
    const added = await importVacancy({ url, title: 'Saved closed vacancy', description: 'Keep this application history', detailsToken: draft.detailsToken }, lookup);
    expect(added).toMatchObject({ result: 'Added', availability: 'Closed', job: { activity: 'Closed' } });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it.each([429, 403])('persists import HTTP %s, honours Retry-After and keeps later imports off the source', async (status) => {
    const began = new Date(Date.now() - 1000);
    const delay = 18 * 3600;
    const lookup = vi.fn(async (): Promise<ImportMetadata> => ({ job: null, activity: null, requests: 1,
      message: `HTTP ${status}`, failure: { kind: status === 429 ? 'rate_limit' : 'blocked',
        httpStatus: status, message: `HTTP ${status}`, retryAfterSeconds: delay } }));
    expect(await importVacancy({ url: 'https://www.linkedin.com/jobs/view/445566' }, lookup))
      .toMatchObject({ availability: 'Could not verify', failure: { httpStatus: status, retryAfterSeconds: delay } });
    await disconnectDb(); await connectDb(file);
    const health = await queryOne<any>(SELECT.from(db().SourceHealth).where({ source: 'linkedin' }));
    expect(health).toMatchObject({ detailRequests: 1, reservedDetail: 0, lastHttpStatus: status, lastRetryAfterSeconds: delay });
    expect(new Date(health.cooldownUntil).getTime()).toBeGreaterThanOrEqual(Date.now() + (delay - 10) * 1000);
    // A success from an older in-flight collection cannot clear the newer import failure.
    await recordOutcomes(loadConfig(), [{ taskId: 'older', source: 'linkedin', searchTerm: 'SAP',
      location: undefined, countryIndeed: undefined, status: 'Succeeded', resultCount: 1, durationMs: 1 }], new Date(), began);
    // A later timeout from that older collection cannot shorten the import cooldown either.
    await recordOutcomes(loadConfig(), [{ taskId: 'older-timeout', source: 'linkedin', searchTerm: 'SAP',
      location: undefined, countryIndeed: undefined, status: 'Failed', resultCount: 0, durationMs: 1,
      errorKind: 'timeout', message: 'Timed out' }], new Date(), began);
    expect(await importVacancy({ url: 'https://www.linkedin.com/jobs/view/556677' }, lookup))
      .toMatchObject({ availability: 'Could not verify', message: expect.stringContaining('cooldown') });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect((await queryOne<any>(SELECT.from(db().SourceHealth).where({ source: 'linkedin' }))).cooldownUntil).toBe(health.cooldownUntil);
    await cds.run(UPDATE(db().SourceHealth).set({ cooldownUntil: '2000-01-01T00:00:00Z', windowStartedAt: '2000-01-01T00:00:00Z' }).where({ source: 'linkedin' }));
    await importVacancy({ url: 'https://www.linkedin.com/jobs/view/667788' }, lookup);
    expect(lookup).toHaveBeenLastCalledWith('linkedin', expect.any(String), 1); // One bounded recovery request.
    expect((await queryOne<any>(SELECT.from(db().SourceHealth).where({ source: 'linkedin' }))).detailRequests).toBe(1);
    await importVacancy({ url: 'https://www.linkedin.com/jobs/view/778899' }, lookup);
    expect(lookup).toHaveBeenCalledTimes(2); // Another 429/403 reopens the shared cooldown.
  });

  it('shares persistent LinkedIn allowances between collection/CLI claims and imports', async () => {
    const allowance = await claimSourceRequests('linkedin', 6, 5);
    if (!allowance.token) throw new Error('Expected request claim');
    const lookup = vi.fn(async (): Promise<ImportMetadata> => { throw new Error('Must not perform another request'); });
    await importVacancy({ url: 'https://www.linkedin.com/jobs/view/112233' }, lookup);
    expect(lookup).not.toHaveBeenCalled(); // Shared source lease while collection is running.
    await settleSourceRequests('linkedin', allowance.token, 6, 5);
    await disconnectDb(); await connectDb(file);
    expect((await collect({ onlySources: ['linkedin'] })).outcome).toBe('NoSources');
    await importVacancy({ url: 'https://www.linkedin.com/jobs/view/223355' }, lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(runCollector).not.toHaveBeenCalled();
    expect(await claimSourceRequests('linkedin', 6, 5)).toMatchObject({ searchLimit: 0, detailLimit: 0 });
  });

  it.each([false, true])('keeps the fresh head and skipped query when the actual allowance is one (recovery: %s)', async (recovery) => {
    const config = loadConfig(), options = { batchKey: 'cap-broad', onlySources: ['linkedin'] };
    const first = planBatch(config, options).tasksBySource.get('linkedin')![0]!;
    await cds.run(INSERT.into(db().SearchProgress).entries({ taskKey: first.task_id, state: '{"offset":20}',
      sweepStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    if (recovery) await recordOutcomes(config, [{ taskId: 'previous', source: 'linkedin', searchTerm: 'SAP',
      location: undefined, countryIndeed: undefined, status: 'Failed', resultCount: 0, durationMs: 1,
      errorKind: 'rate_limit' }], new Date(Date.now() - 3 * 3600000));
    else {
      const claim = await claimSourceRequests('linkedin', 5, 0);
      await settleSourceRequests('linkedin', claim.token!, 5, 0);
    }
    vi.mocked(runCollector).mockImplementation(async (_config, { tasks }) => ({ jobspyVersion: 'offline', jobs: [], activities: [], malformedLines: 0,
      outcomes: tasks.map(task => ({ taskId: task.task_id, source: task.source, searchTerm: task.search_term,
        location: task.location, countryIndeed: task.country_indeed, status: 'Succeeded', resultCount: 0,
        durationMs: 1, searchRequests: 1, detailRequests: 0, headChecked: true })) }));
    const result = await collect(options);
    const tasks = vi.mocked(runCollector).mock.calls[0]![1].tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ offset: 20, head_only: true, search_request_limit: 1 });
    if (recovery) expect(tasks[0]).toMatchObject({ fetch_description: false, detail_request_limit: 0 });
    const skipped = result.outcomes.find(row => row.status === 'Skipped')!;
    expect((await reserveBatchPlan(config, options)).tasksBySource.get('linkedin')![0]!.task_id).toBe(skipped.taskId);
  });

  it.each(Object.keys(loadConfig().searches.sources))('shares the %s lease between collection and manual lookup', async (source) => {
    const config = loadConfig();
    const batchKey = config.searches.rotation.batches.find(batch => batch.targets[source]?.length)!.key;
    const importClaim = await claimImportSource(source);
    expect(importClaim.token).toBeTruthy();
    expect((await collect({ batchKey, onlySources: [source] })).outcome).toBe('NoSources');
    expect(runCollector).not.toHaveBeenCalled();
    await settleSourceRequests(source, importClaim.token!, 0, 0);
    vi.mocked(runCollector).mockImplementation(async (_config, { tasks }) => {
      expect((await claimImportSource(source)).token).toBeUndefined();
      return { jobspyVersion: 'offline', jobs: [], activities: [], malformedLines: 0, outcomes: tasks.map(task => ({ taskId: task.task_id,
        source, searchTerm: task.search_term, location: task.location, countryIndeed: task.country_indeed,
        status: 'Succeeded', resultCount: 0, durationMs: 1, searchRequests: 0, detailRequests: 0 })) };
    });
    await collect({ batchKey, onlySources: [source] });
    expect(runCollector).toHaveBeenCalled();
    expect((await queryOne<any>(SELECT.from(db().SourceHealth).where({ source }))).importToken).toBeNull();
  });

  it.each(['pythonPath', 'collectorScript', 'spawn', 'after-start'] as const)('settles only proven pre-start failures with zero requests (%s)', async (failure) => {
    const actual = await vi.importActual<typeof import('../src/collector/run.js')>('../src/collector/run.js');
    const localStartup = failure !== 'after-start';
    const overrides = failure === 'spawn' ? { pythonPath: PROJECT_ROOT } : failure === 'after-start'
      ? { pythonPath: process.execPath, collectorScript: `${PROJECT_ROOT}/test/helpers/fake-collector.mjs` }
      : { [failure]: '/nonexistent/collector-file' };
    vi.mocked(runCollector).mockImplementation((config, options) => actual.runCollector({ ...config, ...overrides }, {
      ...options, ...(!localStartup ? { onProgress: async () => { throw new Error('Progress failed after worker startup'); } } : {}),
    }));
    const result = await collect({ batchKey: 'cap-broad', onlySources: ['linkedin'] });
    expect(result.outcome).toBe('Failed');
    expect(result.outcomes.every(row => row.executed === false)).toBe(true); // Alone this does not prove zero usage.
    const tasks = vi.mocked(runCollector).mock.calls[0]![1].tasks;
    const health = await queryOne<any>(SELECT.from(db().SourceHealth).where({ source: 'linkedin' }));
    expect(health).toMatchObject({ importToken: null, reservedSearch: 0, reservedDetail: 0,
      searchRequests: localStartup ? 0 : tasks.reduce((sum, task) => sum + task.search_request_limit!, 0),
      detailRequests: localStartup ? 0 : tasks.reduce((sum, task) => sum + (task.detail_request_limit ?? 0), 0) });
    expect(result.outcomes.every(row => row.errorKind === (localStartup ? 'local_startup' : 'error'))).toBe(true);
    if (localStartup) {
      expect(result.outcomes[0]!.message).toContain('Local collector startup failed');
      expect(health.cooldownUntil).toBeNull();
      expect(await query(SELECT.from(db().CollectionErrors).where({ run_ID: result.runId })))
        .toEqual(result.outcomes.map(() => expect.objectContaining({ kind: 'local_startup' })));
    }
  });

  it('filters new internships despite target keywords, while preserving listing updates and personal history', async () => {
    const original = { ...reviewRecord, id: 'old-intern', title: 'Working student SAP CAP Developer', job_url: 'https://www.linkedin.com/jobs/view/889900' };
    const id = (await ingestReview(original)).jobIds[0]!;
    await updateTracking(id, { personalNotes: 'Deliberately tracked', cvSent: true, cvSentAt: '2026-10-01T10:00:00Z' });
    const fixture = [original,
      ...['SAP BTP Internship', 'Werkstudent SAP Fiori', 'Finance Administrator SAP CAP'].map((title, index) => ({
        ...reviewRecord, id: `exclude-${index}`, company: `Excluded ${index}`, title,
        job_url: `https://www.linkedin.com/jobs/view/${990000 + index}`,
      })),
      { ...reviewRecord, id: 'finance-process', company: 'Target', title: 'SAP CAP Developer for Finance Processes',
        description: null, job_url: 'https://www.linkedin.com/jobs/view/991100' },
    ].map((job) => ({ job, taskId: 'offline', source: 'linkedin' }));
    const collected = await collect({ fixture });
    expect(collected.ingest).toMatchObject({ created: 1, accepted: 2, filtered: 3 });
    await rank({ rulesOnly: true });
    expect(await readJob(id)).toMatchObject({ personalNotes: 'Deliberately tracked', cvSent: true });
    expect(await listReminders(id)).toHaveLength(1);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(2);
    expect(await query(SELECT.from(db().AiAssessmentQueue))).toHaveLength(0);
    expect((await listJobs()).total).toBe(2); // The personally tracked legacy record remains accessible.
    const deliberate = await importVacancy({ url: 'https://example.com/student-role', title: 'SAP BTP Internship', description: 'SAP BTP and CAP internship.' });
    expect(deliberate).toMatchObject({ result: 'Added', message: expect.stringContaining('Relevance warning') });
  });

  it('keeps separate assessment counts and provider errors through shared operation finalisation', async () => {
    const id = (await ingestReview()).jobIds[0]!;
    await rank({ rulesOnly: true }); // Stored rules cache exists before the operation.
    enableReviewAi();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Temporary outage', { status: 503 })));
    const reservation = await claimCollection('cli-cycle');
    if (!reservation.acquired) throw new Error('Expected lease');
    await withCollectionOperation(reservation.claim, () => collect({ claim: reservation.claim, fixture: [] }),
      (_summary, report) => rank({ jobIds: [id], includePendingAi: true, onProgress: report }));
    expect(await readOperation()).toMatchObject({ outcome: 'Partial', jobsNew: 0, jobsUpdated: 0,
      cachedAssessments: 0, rulesAssessments: 0, aiSucceeded: 0, aiFailures: 1, aiCalls: 1,
      aiFailureReasons: [expect.stringContaining('503')], message: expect.stringContaining('AI attempts failed') });
    const second = await claimCollection('dashboard');
    if (!second.acquired) throw new Error('Expected next lease');
    await withCollectionOperation(second.claim, () => collect({ claim: second.claim, fixture: [] }),
      (_summary, report) => rank({ jobIds: [id], includePendingAi: true, onProgress: report }));
    expect(await readOperation()).toMatchObject({ outcome: 'Empty', cachedAssessments: 1, rulesAssessments: 0,
      aiSucceeded: 0, aiFailures: 0, aiCalls: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns one shared active operation to overlapping dashboard and scheduler processes', async () => {
    for (const trigger of ['dashboard', 'scheduled']) workers.push(startTestWorker('collection-claim-worker.ts', {
      JOB_RADAR_TEST_DB_PATH: file, JOB_RADAR_TEST_TRIGGER: trigger,
    }));
    await Promise.all(workers.map((worker) => worker.wait('ready')));
    for (const worker of workers) worker.child.send({ type: 'start' });
    const results = await Promise.all(workers.map((worker) => worker.wait('done')));
    expect(results.filter((row) => row.acquired)).toHaveLength(1);
    expect(new Set(results.map((row) => row.operationId)).size).toBe(1);
    const active = await claimCollection('dashboard');
    expect(active).toMatchObject({ acquired: false, operationId: results[0]!.operationId });
    await expect(collect({ fixture: [] })).rejects.toMatchObject({ operationId: results[0]!.operationId });
    expect(runCollector).not.toHaveBeenCalled();
    expect(await query(SELECT.from(db().CollectionOperations))).toHaveLength(1);
  }, 15_000);

  it('recovers an expired operation and fences its previous owner', async () => {
    const first = await claimCollection('dashboard');
    if (!first.acquired) throw new Error('Expected initial lease');
    await cds.run(UPDATE(db().CollectionLease).set({ expiresAt: '2000-01-01T00:00:00Z' }));
    expect(await readOperation()).toMatchObject({ ID: first.claim.operationId, stage: 'Error', outcome: 'Failed' });
    const next = await claimCollection('scheduled');
    expect(next.acquired).toBe(true);
    await expect(updateOperation(first.claim, { stage: 'Saving' })).rejects.toThrow('lease');
  });

  it.each(['failed', 'empty', 'partial', 'unavailable'] as const)('persists the %s collection outcome', async (scenario) => {
    vi.mocked(runCollector).mockImplementation(async (_config, options) => ({ jobspyVersion: 'offline', malformedLines: 0,
      jobs: [], activities: [], outcomes: options.tasks.map((task, index) => ({ taskId: task.task_id, source: task.source,
        searchTerm: task.search_term, location: task.location, countryIndeed: task.country_indeed,
        status: scenario === 'empty' || scenario === 'partial' && index === 1 ? 'Succeeded' : index === 0 ? 'Failed' : 'Skipped',
        resultCount: 0, durationMs: 1, errorKind: 'timeout', message: 'Offline outcome', nextCursor: { offset: 0 } })) }));
    const result = await collect({ batchKey: 'cap-broad', onlySources: ['linkedin'],
      ...(scenario === 'unavailable' ? { skipSources: new Map([['linkedin', 'cooldown']]) } : {}) });
    const outcome = { failed: 'Failed', empty: 'Empty', partial: 'Partial', unavailable: 'NoSources' }[scenario];
    expect(result.outcome).toBe(outcome);
    expect(await queryOne(SELECT.from(db().CollectionRuns).where({ ID: result.runId }))).toMatchObject({ status: outcome });
    expect(await readOperation()).toMatchObject({ outcome, stage: scenario === 'failed' ? 'Error' : 'Finished' });
  });

  it('persists calendar follow-ups across restart without resetting them on unchanged tracking saves', async () => {
    const id = (await ingestReview()).jobIds[0]!;
    const sentAt = '2026-10-23T20:30:00.000Z'; // Sofia 23:30, before the DST transition.
    await updateTracking(id, { cvSent: true, cvSentAt: sentAt, applicationDate: '2026-10-01' });
    const reminder = (await listReminders())[0]!;
    expect(reminder.dueDate).toBe('2026-10-30');
    await updateReminder(reminder.ID, { action: 'reschedule', dueDate: '2000-01-01' });
    await updateTracking(id, { cvSent: true, cvSentAt: sentAt, personalNotes: 'Updated notes' });
    await updateTracking(id, { viewed: true });
    await disconnectDb(); await connectDb(file);
    expect(await listReminders()).toMatchObject([{ ID: reminder.ID, dueDate: '2000-01-01', status: 'Pending' }]);
    expect(await readJob(id)).toMatchObject({ cvSentAt: sentAt, applicationDate: '2026-10-01' });
    await updateReminder(reminder.ID, { action: 'complete' });
    await updateReminder(reminder.ID, { action: 'complete' });
    await updateTracking(id, { cvSent: true, personalNotes: 'Another note' });
    await updateTracking(id, { viewed: false });
    await updateTracking(id, { cvSent: false });
    expect(await listReminders(id)).toMatchObject([{ ID: reminder.ID, status: 'Completed' }]);
    await updateTracking(id, { cvSent: true, cvSentAt: sentAt });
    await updateTracking(id, { status: 'Rejected' });
    expect((await listReminders(id)).map((row) => row.status).sort()).toEqual(['Cancelled', 'Completed']);
    expect(await listReminders()).toHaveLength(0);
  });

  it('leaves legacy send dates unknown until supplied and keeps closed applications in their view', async () => {
    const id = (await ingestReview()).jobIds[0]!;
    await cds.run(UPDATE(db().Jobs).set({ cvSent: true }).where({ ID: id }));
    await updateTracking(id, { cvSent: true, cvSentAt: null, personalNotes: 'Legacy application' });
    const legacy = await readJob(id);
    expect(legacy).toMatchObject({ status: 'New', cvSentAt: null });
    const module = await import(`${PROJECT_ROOT}/frontend/src/App.tsx`);
    const markup = renderToStaticMarkup(createElement(module.TrackingForm, { job: legacy,
      onSaved: () => {}, onDirty: () => {}, onBusy: () => {} }));
    const datetime = markup.match(/<input[^>]*type="datetime-local"[^>]*>/)![0];
    expect(datetime).not.toMatch(/\brequired(?:=|\s|>)/);
    await updateTracking(id, { status: 'Interview', personalNotes: 'Status can change without a date' });
    expect(await listReminders()).toHaveLength(0);
    expect(await readJob(id)).toMatchObject({ cvSentAt: null });
    await updateTracking(id, { cvSentAt: '2026-10-13T10:00:00Z' });
    await updateTracking(id, { cvSent: true, personalNotes: 'Date retained' });
    expect(await listReminders()).toHaveLength(1);
    await cds.run(UPDATE(db().SourceListings).set({ activityState: 'Closed' }).where({ job_ID: id }));
    expect((await listJobs(new URLSearchParams({ view: 'applications', minScore: '100', activity: 'Active' }))).items.map((row) => row.ID)).toEqual([id]);
    await updateTracking(id, { cvSent: false });
    expect(await listReminders(id)).toMatchObject([{ status: 'Cancelled' }]);
    await expect(updateTracking(id, { cvSent: true, personalNotes: 'Do not partially save' })).rejects.toMatchObject({ status: 400 });
  });
});
