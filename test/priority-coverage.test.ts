import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { planBatch, selectBatchIndex } from '../src/collector/plan.js';
import { PRIORITY_DIRECTIONS, priorityDirections } from '../src/matching/directions.js';
import { assessWithRules, prescreen } from '../src/matching/rules.js';
import type { MatchableJob } from '../src/matching/types.js';
import { summarizeDirections } from '../src/pipeline/coverage.js';

function job(title: string, description: string | null = null): MatchableJob {
  return { ID: title, title, description, descriptionHash: null, company: null, location: null,
    locationCountry: null, isRemote: null, jobType: null, salaryMin: null, salaryMax: null,
    salaryInterval: null, salaryCurrency: null, primaryUrl: 'https://example.com/job', datePosted: null };
}

describe('priority search coverage within operational limits', () => {
  it('executes every configured task, including each batch tail, in one bounded rotation', () => {
    const config = loadConfig();
    const seen = new Set<string>();
    const count = config.searches.rotation.batches.length;
    expect(count * config.searches.rotation.interval_hours).toBeLessThan(config.searches.defaults.hours_old);
    for (let slot = 0; slot < count; slot += 1) {
      const at = new Date(slot * config.searches.rotation.interval_hours * 3_600_000);
      const index = selectBatchIndex(config, at);
      const batch = config.searches.rotation.batches[index]!;
      const plan = planBatch(config, { at });
      const expected = Object.entries(batch.targets).flatMap(([source, geos]) => geos.flatMap((geo) =>
        batch.keywords.map((keyword) => `${source}:${geo}:${keyword}`)));
      const tasks = [...plan.tasksBySource.values()].flat();
      expect(tasks).toHaveLength(expected.length);
      expect(tasks.length).toBeLessThanOrEqual(18);
      expect(tasks.filter((task) => task.fetch_description).length).toBeLessThanOrEqual(2);
      for (const [source, geos] of Object.entries(batch.targets)) {
        expect(plan.tasksBySource.get(source)).toHaveLength(geos.length * batch.keywords.length);
        for (const keyword of batch.keywords) expect(plan.tasksBySource.get(source)!.some((task) => task.search_term === keyword)).toBe(true);
      }
      seen.add(batch.key);
    }
    expect(seen.size).toBe(count);
  });

  it('covers broad technologies, roles and engagement variants on all six sources', () => {
    const config = loadConfig();
    const allSources = Object.keys(config.searches.sources);
    const required = ['SAP CAP', 'SAP CAPM', 'SAP Cloud Application Programming Model', 'SAPUI5', 'SAP UI5', 'SAP Fiori', 'Fiori Elements',
      'SAP Joule', 'Joule Studio', 'SAP Joule Developer', 'SAP Business AI', 'SAP AI Core', 'SAP Generative AI Hub', 'SAP BTP AI'];
    for (const source of allSources) {
      const terms = config.searches.rotation.batches.flatMap((batch) =>
        planBatch(config, { batchKey: batch.key, onlySources: [source] }).tasksBySource.get(source)?.map((task) => task.search_term) ?? []);
      expect(terms).toEqual(expect.arrayContaining(required));
      for (const prefix of ['cap-', 'ui5-', 'joule-', 'btp-ai-']) {
        const queries = config.searches.rotation.batches.filter((batch) => batch.key.startsWith(prefix)).flatMap((batch) => batch.keywords);
        for (const variant of ['Developer', 'Consultant', 'Architect', 'freelance', 'contract', 'B2B']) {
          expect(queries.some((term) => term.includes(variant))).toBe(true);
        }
      }
    }
    const firstFour = config.searches.rotation.batches.slice(0, 4).map((batch) => batch.key);
    expect(firstFour).toEqual(['cap-broad', 'ui5-broad', 'joule-broad', 'btp-ai-broad']);
    expect(config.settings.llm.max_jobs_per_run).toBe(5);
    expect(config.settings.telegram.max_per_run).toBe(3);
    expect(config.settings.telegram.min_fit_score).toBe(75);
  });

  it.each(['SAP Joule Developer', 'SAP Joule Architect', 'SAPUI5 Developer', 'SAP BTP AI Consultant'])
    ('retains relevant SAP titles: %s', (title) => {
      const config = loadConfig();
      const vacancy = job(title);
      expect(prescreen(config, vacancy).passed).toBe(true);
      expect(assessWithRules(config, vacancy).technicalFit).toBeGreaterThanOrEqual(config.scoring.technical.relevant_title_floor);
    });

  it('requires SAP context for standalone Joule and generic AI roles', () => {
    const config = loadConfig();
    for (const title of ['Joule Developer', 'Generative AI Architect', 'RAG Developer']) {
      expect(prescreen(config, job(title)).passed).toBe(false);
      expect(priorityDirections(job(title))).toEqual([]);
    }
    expect(prescreen(config, job('Joule Studio Consultant', 'Work on SAP integrations.')).passed).toBe(true);
    expect(priorityDirections(job('Joule Studio Consultant', 'Work on SAP integrations.'))).toEqual(['Joule']);
  });

  it('counts processing stages independently, including multi-direction roles', () => {
    const config = loadConfig();
    const full = job('SAP CAP and Joule Developer', 'SAP CAP and Joule Studio, fully remote contract.');
    const assessment = { ...assessWithRules(config, full), engine: 'llm' as const };
    const counts = summarizeDirections(config, [
      { job: full, assessment, deliveryAvailable: true },
      { job: job('SAP CAPM Consultant'), deliveryAvailable: false },
      { job: job('Generic AI Developer'), deliveryAvailable: false },
    ]);
    expect(counts.map((count) => count.direction)).toEqual([...PRIORITY_DIRECTIONS]);
    expect(counts[0]).toMatchObject({ collected: 2, described: 1, prescreened: 2, llm: 1, notify: 1 });
    expect(counts[2]).toMatchObject({ collected: 1, described: 1, prescreened: 1, llm: 1, notify: 1 });
    expect(counts[3]!.collected).toBe(0);
  });
});
