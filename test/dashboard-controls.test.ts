import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimCollection, readOperation, updateOperation } from '../src/collector/lease.js';
import { runCollector } from '../src/collector/run.js';
import { planBatch } from '../src/collector/plan.js';
import { recordSearchProgress, reserveBatchPlan } from '../src/collector/rotation.js';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, disconnectDb, query, queryOne, SELECT, UPDATE } from '../src/db/index.js';
import { importVacancy, type ImportMetadata } from '../src/dashboard/import.js';
import { listReminders, updateReminder } from '../src/dashboard/reminders.js';
import { listJobs, readJob, updateTracking } from '../src/dashboard/store.js';
import { collect } from '../src/pipeline/collect.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { ingestReview, reviewRecord } from './helpers/review.js';
import { startTestWorker, type TestWorker } from './helpers/worker.js';

vi.mock('../src/collector/run.js', () => ({ runCollector: vi.fn() }));
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

  it('keeps pagination after 108 hours and ignores an empty failed cursor reset', async () => {
    const config = loadConfig(), at = new Date('2026-10-01T00:00:00Z');
    const first = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['linkedin'], at });
    const task = first.tasksBySource.get('linkedin')![0]!;
    const outcome = { taskId: task.task_id, source: task.source, searchTerm: task.search_term,
      location: task.location, countryIndeed: task.country_indeed, status: 'Succeeded' as const,
      resultCount: 25, durationMs: 1, nextCursor: { offset: 20 } };
    await recordSearchProgress([outcome], at);
    await recordSearchProgress([{ ...outcome, status: 'Failed', resultCount: 0, nextCursor: { offset: 0 } }], at);
    await disconnectDb(); await connectDb(file);
    const resumed = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['linkedin'],
      at: new Date(at.getTime() + 108 * 3_600_000) });
    expect(resumed.tasksBySource.get('linkedin')!.find((row) => row.task_id === task.task_id)?.offset).toBe(20);
    await recordSearchProgress([{ ...outcome, resultCount: 0, nextCursor: { offset: 0 } }], at);
    expect(JSON.parse((await queryOne<any>(SELECT.from(db().SearchProgress).where({ taskKey: task.task_id }))).state)).toEqual({ offset: 0 });
  });

  it('drains a large postponed LinkedIn batch on subsequent three-hour cycles', () => {
    const config = loadConfig();
    let plan = planBatch(config, { batchKey: 'emea-frontend' });
    const seen = new Set<string>();
    for (let cycle = 0; cycle < 9; cycle += 1) {
      const tasks = [...plan.tasksBySource.values()].flat();
      expect(tasks.length).toBeLessThanOrEqual(18);
      expect(tasks.filter((task) => task.source === 'linkedin').length).toBeLessThanOrEqual(2);
      for (const task of tasks) if (task.source === 'linkedin') seen.add(task.task_id);
      plan = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: plan.descriptionRotation });
    }
    expect(seen.size).toBe(18);
  });

  it('persists calendar follow-ups across restart without resetting them on unchanged tracking saves', async () => {
    const id = (await ingestReview()).jobIds[0]!;
    const sentAt = '2026-10-23T20:30:00.000Z'; // Sofia 23:30, before the DST transition.
    await updateTracking(id, { cvSent: true, cvSentAt: sentAt, applicationDate: '2026-10-01' });
    const reminder = (await listReminders())[0]!;
    expect(reminder.dueDate).toBe('2026-10-30');
    await updateReminder(reminder.ID, { action: 'reschedule', dueDate: '2000-01-01' });
    await updateTracking(id, { cvSent: true, cvSentAt: sentAt, personalNotes: 'Updated notes' });
    await disconnectDb(); await connectDb(file);
    expect(await listReminders()).toMatchObject([{ ID: reminder.ID, dueDate: '2000-01-01', status: 'Pending' }]);
    expect(await readJob(id)).toMatchObject({ cvSentAt: sentAt, applicationDate: '2026-10-01' });
    await updateReminder(reminder.ID, { action: 'complete' });
    await updateReminder(reminder.ID, { action: 'complete' });
    await updateTracking(id, { cvSent: true, personalNotes: 'Another note' });
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
    await updateTracking(id, { personalNotes: 'Legacy application' });
    expect(await listReminders()).toHaveLength(0);
    expect(await readJob(id)).toMatchObject({ cvSentAt: null });
    await updateTracking(id, { cvSentAt: '2026-10-13T10:00:00Z' });
    await cds.run(UPDATE(db().SourceListings).set({ activityState: 'Closed' }).where({ job_ID: id }));
    expect((await listJobs(new URLSearchParams({ view: 'applications', minScore: '100', activity: 'Active' }))).items.map((row) => row.ID)).toEqual([id]);
    await updateTracking(id, { cvSent: false });
    expect(await listReminders(id)).toMatchObject([{ status: 'Cancelled' }]);
  });
});
