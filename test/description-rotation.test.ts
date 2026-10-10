import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, PROJECT_ROOT } from '../src/config/index.js';
import { planBatch, type DescriptionRotation } from '../src/collector/plan.js';
import { reserveBatchPlan } from '../src/collector/rotation.js';
import { cds, connectDb, db, DELETE, disconnectDb, INSERT } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { closeTempDb, useTempDb } from './helpers/db.js';

const selected = (plan: ReturnType<typeof planBatch>) => [...plan.tasksBySource.values()].flat()
  .filter((task) => task.fetch_description);
let dbPath: string;
beforeAll(async () => { dbPath = await useTempDb(); });
beforeEach(async () => {
  for (const entity of [db().DescriptionRotation, db().SourceListings, db().Jobs]) await cds.run(DELETE.from(entity));
});
afterAll(closeTempDb);

describe('bounded persistent description rotation', () => {
  it('reserves stored descriptions without searches and keeps the two-task budget', async () => {
    const at = new Date();
    await ingestJobs([normalizeJob({ id: '7097972', title: 'SAP BTP Developer',
      job_url: 'https://www.michaelpage.pl/job-detail/sap-btp/ref/jn-092026-7097972',
      date_posted: '2026-09-07', description: null }, 'michaelpage')!], { runId: null, seenAt: at });
    const plan = await reserveBatchPlan(loadConfig(), { enrichOnly: true, onlySources: ['michaelpage'], resultsWanted: 5, at });
    const tasks = [...plan.tasksBySource.values()].flat();
    expect(plan.batchKey).toBe('description-backlog');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ enrich_only: true, fetch_description: true });
    expect(tasks[0]!.detail_jobs).toHaveLength(1);
    expect(tasks[0]!.hours_old).toBe(2160);
    const empty = await reserveBatchPlan(loadConfig(), { enrichOnly: true, onlySources: ['whitehall'], at });
    expect(empty.tasksBySource.size).toBe(0);
  });
  it('enriches stored listings independently of the active keyword and moves failed reservations to the queue tail', async () => {
    const at = new Date('2026-10-09T12:00:00Z');
    const config = loadConfig();
    for (let index = 0; index < 6; index += 1) {
      await ingestJobs([normalizeJob({ id: `pending-${index}`, title: 'SAP CAP Developer',
        job_url: `https://eursap.eu/jobs/pending-${index}`, date_posted: '2026-10-09', description: null }, 'eursap')!],
      { runId: null, seenAt: at });
    }
    const first = await reserveBatchPlan(config, { batchKey: 'ui5-broad', onlySources: ['eursap'], resultsWanted: 5, at });
    const firstDetails = selected(first).flatMap((task) => task.detail_jobs ?? []);
    expect(firstDetails).toHaveLength(4);
    expect(firstDetails.every((record) => record.title === 'SAP CAP Developer')).toBe(true);
    expect([...first.tasksBySource.values()].flat().every((task) => /UI5/i.test(task.search_term))).toBe(true);
    const next = await reserveBatchPlan(config, { batchKey: 'joule-broad', onlySources: ['eursap'], resultsWanted: 5,
      at: new Date(at.getTime() + 3_600_000) });
    const nextDetails = selected(next).flatMap((task) => task.detail_jobs ?? []);
    expect(nextDetails.slice(0, 2).every((record) => !firstDetails.some((previous) => previous.id === record.id))).toBe(true);
    expect(selected(next)).toHaveLength(2);
    expect([...next.tasksBySource.values()].flat().length).toBeLessThanOrEqual(18);
    const cooling = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['eursap'],
      skipSources: new Map([['eursap', 'cooldown']]), at });
    expect(selected(cooling)).toEqual([]);
  });

  it('preserves keyword cursors from legacy per-batch rotation state', async () => {
    await cds.run(INSERT.into(db().DescriptionRotation).entries({ batchKey: 'sap-specialists',
      state: JSON.stringify({ lastSource: 'eursap', lastTaskBySource: { redglobal: 'sap-specialists:redglobal:all:btp' } }),
      updatedAt: new Date().toISOString() }));
    const resumed = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists', onlySources: ['redglobal'] });
    expect(selected(resumed).map((task) => task.search_term)).toEqual(['CAP', 'CPI']);
  });

  it('keeps Glassdoor description fetching in its existing JobSpy search session', async () => {
    await ingestJobs([normalizeJob({ id: 'glassdoor-pending', title: 'SAP CAP Developer',
      job_url: 'https://www.glassdoor.nl/job-listing/j?jl=123', description: null }, 'glassdoor')!], { runId: null });
    const plan = await reserveBatchPlan(loadConfig(), { batchKey: 'cap-broad', onlySources: ['glassdoor'] });
    expect(selected(plan)).toHaveLength(2);
    expect(selected(plan).every((task) => task.detail_jobs === undefined)).toBe(true);
  });
  it('covers all three agencies and all five keywords in eight two-slot cycles', () => {
    const config = loadConfig();
    let state: DescriptionRotation | undefined;
    const seen = new Set<string>();
    const cycles: string[][] = [];
    for (let cycle = 0; cycle < 8; cycle += 1) {
      const plan = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: state });
      const descriptions = selected(plan);
      expect(descriptions).toHaveLength(2);
      cycles.push(descriptions.map((task) => `${task.source}:${task.search_term}`));
      descriptions.forEach((task) => seen.add(task.task_id));
      state = plan.descriptionRotation;
    }
    expect(cycles[0]).toEqual(['redglobal:BTP', 'eursap:BTP']);
    expect(cycles[1]).toEqual(['redglobal:CAP', 'whitehall:BTP']);
    expect(seen.size).toBe(15);
  });

  it('skips disabled/cooling/restricted sources without consuming their keyword cursors', () => {
    const config = structuredClone(loadConfig());
    const first = planBatch(config, { batchKey: 'sap-specialists' });
    const restricted = planBatch(config, { batchKey: 'sap-specialists', onlySources: ['whitehall'], descriptionRotation: first.descriptionRotation });
    expect(selected(restricted).map((task) => task.search_term)).toEqual(['BTP', 'CAP']);
    expect(restricted.descriptionRotation.lastTaskBySource['sap-specialists:redglobal']).toBe(first.descriptionRotation.lastTaskBySource['sap-specialists:redglobal']);
    config.searches.sources.redglobal!.enabled = false;
    const blocked = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: restricted.descriptionRotation,
      skipSources: new Map([['eursap', 'cooldown']]) });
    expect(selected(blocked).every((task) => task.source === 'whitehall')).toBe(true);
    expect(selected(blocked).map((task) => task.search_term)).toEqual(['CPI', 'UI5']);
    config.searches.sources.redglobal!.enabled = true;
    const recovered = planBatch(config, { batchKey: 'sap-specialists', onlySources: ['redglobal'], descriptionRotation: blocked.descriptionRotation });
    expect(selected(recovered).map((task) => task.search_term)).toEqual(['CAP', 'CPI']);
  });

  it('preserves state when there are no available sources and never grants the same task twice', () => {
    const config = structuredClone(loadConfig());
    const first = planBatch(config, { batchKey: 'sap-specialists' });
    const none = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: first.descriptionRotation,
      skipSources: new Map(['redglobal', 'eursap', 'whitehall'].map((source) => [source, 'cooldown'])) });
    expect(selected(none)).toEqual([]);
    expect(none.descriptionRotation).toEqual(first.descriptionRotation);
    config.searches.rotation.batches.find((batch) => batch.key === 'sap-specialists')!.keywords = ['CAP'];
    const single = planBatch(config, { batchKey: 'sap-specialists', onlySources: ['whitehall'] });
    expect(selected(single)).toHaveLength(1);
  });

  it('resumes the persisted batch in a fresh process instead of selecting the first tasks again', async () => {
    const first = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
    await disconnectDb();
    try {
      const { stdout } = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', path.join(PROJECT_ROOT, 'test/helpers/rotation-worker.ts'), dbPath],
        { cwd: PROJECT_ROOT, env: { ...process.env, OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' } });
      const result = JSON.parse(stdout.split('\n').find((line) => line.startsWith('ROTATION '))!.slice(9));
      expect(result).toEqual(['redglobal:CAP', 'whitehall:BTP']);
      expect(selected(first).map((task) => `${task.source}:${task.search_term}`)).not.toEqual(result);
    } finally { await connectDb(dbPath); }
    const third = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
    expect(selected(third).map((task) => `${task.source}:${task.search_term}`)).toEqual(['eursap:CAP', 'whitehall:CAP']);
  });

  it('advances sources across different batches while preserving their keyword cursors', async () => {
    const first = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
    const other = await reserveBatchPlan(loadConfig(), { batchKey: 'cap-broad' });
    expect(selected(other).map((task) => task.source)).toEqual(['linkedin', 'whitehall']);
    const next = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
    expect(next.descriptionRotation).not.toEqual(first.descriptionRotation);
    expect(selected(next).map((task) => `${task.source}:${task.search_term}`)).toEqual(['redglobal:CAP', 'eursap:CAP']);
  });

  it('gives every eligible description source a slot within three mixed priority cycles', async () => {
    const seen = new Set<string>();
    for (const batchKey of ['cap-broad', 'ui5-broad', 'joule-broad']) {
      const plan = await reserveBatchPlan(loadConfig(), { batchKey });
      expect(selected(plan)).toHaveLength(2);
      selected(plan).forEach((task) => seen.add(task.source));
    }
    expect([...seen].sort()).toEqual(['eursap', 'glassdoor', 'linkedin', 'redglobal', 'whitehall']);
  });
});
