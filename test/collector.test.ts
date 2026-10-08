import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { runCollector } from '../src/collector/run.js';
import { activeCooldowns, recordOutcomes } from '../src/collector/health.js';
import { planBatch, selectBatchIndex } from '../src/collector/plan.js';
import { closeTempDb, useTempDb } from './helpers/db.js';
import type { CollectorTask } from '../src/collector/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function task(id: string, source = 'linkedin'): CollectorTask {
  return {
    task_id: id,
    source,
    search_term: 'SAP BTP Developer',
    location: 'European Union',
    results_wanted: 5,
    hours_old: 72,
    distance: 50,
    description_format: 'markdown',
    fetch_description: false,
    is_remote: false,
  };
}

function configWith(script: string) {
  process.env.JOB_RADAR_PYTHON = process.execPath;
  process.env.JOB_RADAR_COLLECTOR_SCRIPT = path.join(here, 'helpers', script);
  resetConfigCache();
  return loadConfig({ reload: true });
}

afterAll(() => {
  delete process.env.JOB_RADAR_PYTHON;
  delete process.env.JOB_RADAR_COLLECTOR_SCRIPT;
  resetConfigCache();
});

describe('malformed collector output', () => {
  it('keeps the valid records and counts the bad lines instead of throwing', async () => {
    const config = configWith('fake-collector.mjs');
    const output = await runCollector(config, {
      tasks: [task('t1')],
      taskTimeoutSeconds: 10,
      delayBetweenTasksSeconds: 0,
      processTimeoutSeconds: 30,
    });

    expect(output.jobspyVersion).toBe('test-double');
    expect(output.jobs).toHaveLength(1);
    expect(output.jobs[0]!.job.id).toBe('ok-1');
    // not-JSON, schema violation and unknown discriminator - the blank line is ignored.
    expect(output.malformedLines).toBe(3);
    expect(output.outcomes).toHaveLength(1);
    expect(output.outcomes[0]!.status).toBe('Succeeded');
  });

  it('records tasks the collector never reported on as failed', async () => {
    const config = configWith('failing-collector.mjs');
    const output = await runCollector(config, {
      tasks: [task('a'), task('b'), task('c')],
      taskTimeoutSeconds: 10,
      delayBetweenTasksSeconds: 0,
      processTimeoutSeconds: 30,
    });

    expect(output.outcomes).toHaveLength(3);
    expect(output.outcomes.filter((outcome) => outcome.status === 'Failed')).toHaveLength(3);
    expect(output.outcomes.find((outcome) => outcome.taskId === 'a')!.errorKind).toBe('blocked');
    expect(output.outcomes.find((outcome) => outcome.taskId === 'b')!.errorKind).toBe('parse');
  });

  it('fails loudly when the interpreter does not exist', async () => {
    const config = loadConfig();
    await expect(
      runCollector({ ...config, pythonPath: '/nonexistent/python' }, {
        tasks: [task('x')],
        taskTimeoutSeconds: 5,
        delayBetweenTasksSeconds: 0,
        processTimeoutSeconds: 10,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('source failure isolation', () => {
  beforeAll(async () => {
    await useTempDb();
  });
  afterAll(closeTempDb);

  it('puts a blocked source on cooldown and leaves the others usable', async () => {
    const config = loadConfig();
    const now = new Date('2026-10-06T12:00:00Z');
    await recordOutcomes(
      config,
      [
        {
          taskId: 'a',
          source: 'linkedin',
          searchTerm: 'x',
          location: 'EU',
          countryIndeed: undefined,
          status: 'Failed',
          resultCount: 0,
          durationMs: 1,
          errorKind: 'blocked',
          message: '403',
        },
        {
          taskId: 'b',
          source: 'indeed',
          searchTerm: 'x',
          location: 'Germany',
          countryIndeed: 'Germany',
          status: 'Succeeded',
          resultCount: 4,
          durationMs: 1,
        },
      ],
      now,
    );

    const cooldowns = await activeCooldowns(now);
    expect(cooldowns.has('linkedin')).toBe(true);
    expect(cooldowns.has('indeed')).toBe(false);

    const plan = planBatch(config, { batchKey: 'btp-core', skipSources: cooldowns });
    expect(plan.tasksBySource.has('linkedin')).toBe(false);
    expect(plan.tasksBySource.has('indeed')).toBe(true);
    expect(plan.skipped.map((entry) => entry.source)).toContain('linkedin');
  });

  it('lets a source recover once the cooldown has expired', async () => {
    const later = new Date('2026-10-08T12:00:00Z');
    expect((await activeCooldowns(later)).has('linkedin')).toBe(false);
  });
});

describe('batch planning', () => {
  it('plans SAP specialists without assumed geography and within the existing budgets', () => {
    const config = loadConfig();
    const plan = planBatch(config, { batchKey: 'sap-specialists' });
    expect([...plan.tasksBySource.keys()]).toEqual(['redglobal', 'eursap', 'whitehall']);
    const tasks = [...plan.tasksBySource.values()].flat();
    expect(tasks).toHaveLength(15);
    expect(tasks.every((entry) => entry.location === undefined && entry.country_indeed === undefined)).toBe(true);
    expect(tasks.filter((entry) => entry.fetch_description).length).toBeLessThanOrEqual(
      config.searches.description_budget.max_tasks_per_run,
    );
    expect(tasks.length).toBeLessThanOrEqual(config.searches.resilience.max_tasks_per_run);
  });

  it.each(['redglobal', 'eursap', 'whitehall'])('collects %s independently with a description budget', (source) => {
    const plan = planBatch(loadConfig(), { batchKey: 'sap-specialists', onlySources: [source] });
    expect([...plan.tasksBySource.keys()]).toEqual([source]);
    expect(plan.tasksBySource.get(source)!.some((entry) => entry.fetch_description)).toBe(true);
  });

  it('rotates through the configured batches over time', () => {
    const config = loadConfig();
    const batches = config.searches.rotation.batches.length;
    const seen = new Set<number>();
    for (let hours = 0; hours < batches * config.searches.rotation.interval_hours; hours += config.searches.rotation.interval_hours) {
      seen.add(selectBatchIndex(config, new Date(Date.UTC(2026, 0, 1, hours))));
    }
    expect(seen.size).toBe(batches);
  });

  it('stays within the configured task budget and description budget', () => {
    const config = loadConfig();
    const plan = planBatch(config, { batchKey: 'btp-core' });
    const tasks = [...plan.tasksBySource.values()].flat();
    expect(tasks.length).toBeLessThanOrEqual(config.searches.resilience.max_tasks_per_run);
    expect(tasks.filter((entry) => entry.fetch_description).length).toBeLessThanOrEqual(
      config.searches.description_budget.max_tasks_per_run,
    );
  });

  it('never pre-filters on remote or contract, so incomplete listings survive', () => {
    const config = loadConfig();
    const tasks = [...planBatch(config, { batchKey: 'btp-core' }).tasksBySource.values()].flat();
    expect(tasks.every((entry) => entry.is_remote === false)).toBe(true);
    expect(tasks.every((entry) => entry.job_type === undefined)).toBe(true);
  });

  it('uses source-specific geography', () => {
    const config = loadConfig();
    const plan = planBatch(config, { batchKey: 'btp-core' });
    expect(plan.tasksBySource.get('linkedin')!.every((entry) => entry.country_indeed === undefined)).toBe(true);
    expect(plan.tasksBySource.get('indeed')!.every((entry) => typeof entry.country_indeed === 'string')).toBe(true);
  });
});
