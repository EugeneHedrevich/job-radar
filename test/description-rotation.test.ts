import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, PROJECT_ROOT } from '../src/config/index.js';
import { planBatch, type DescriptionRotation } from '../src/collector/plan.js';
import { reserveBatchPlan } from '../src/collector/rotation.js';
import { cds, connectDb, db, DELETE, disconnectDb } from '../src/db/index.js';
import { closeTempDb, useTempDb } from './helpers/db.js';

const selected = (plan: ReturnType<typeof planBatch>) => [...plan.tasksBySource.values()].flat()
  .filter((task) => task.fetch_description);
let dbPath: string;
beforeAll(async () => { dbPath = await useTempDb(); });
beforeEach(async () => { await cds.run(DELETE.from(db().DescriptionRotation)); });
afterAll(closeTempDb);

describe('bounded persistent description rotation', () => {
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
    expect(restricted.descriptionRotation.lastTaskBySource.redglobal).toBe(first.descriptionRotation.lastTaskBySource.redglobal);
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

  it('keeps independent batch cursors', async () => {
    const first = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
    await reserveBatchPlan(loadConfig(), { batchKey: 'cap-broad' });
    const next = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
    expect(next.descriptionRotation).not.toEqual(first.descriptionRotation);
    expect(selected(next).map((task) => `${task.source}:${task.search_term}`)).toEqual(['redglobal:CAP', 'whitehall:BTP']);
  });
});
