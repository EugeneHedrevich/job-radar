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
    const count = config.searches.rotation.sequence?.length ?? config.searches.rotation.batches.length;
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
    expect(seen.size).toBe(config.searches.rotation.batches.length);
  });

  it('revisits every broad priority group and public catalogue within 33 hours', () => {
    const config = loadConfig();
    const sequence = config.searches.rotation.sequence!;
    for (const key of ['cap-broad', 'ui5-broad', 'joule-broad', 'btp-ai-broad', 'sap-public']) {
      const positions = sequence.flatMap((item, index) => item === key ? [index] : []);
      expect(positions).toHaveLength(3);
      const wrapped = [...positions, positions[0]! + sequence.length];
      expect(Math.max(...positions.map((position, i) => (wrapped[i + 1]! - position) * config.searches.rotation.interval_hours))).toBe(33);
    }
  });

  it('covers broad technologies, roles and engagement variants on all six sources', () => {
    const config = loadConfig();
    const allSources = ['linkedin', 'indeed', 'glassdoor', 'redglobal', 'eursap', 'whitehall'];
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

  it('searches every new public source and Michael Page market without using API description slots', () => {
    const config = loadConfig();
    const plan = planBatch(config, { batchKey: 'sap-public' });
    expect([...plan.tasksBySource.keys()]).toEqual(['michaelpage', 'nextventures', 'remotive', 'arbeitnow', 'remoteok', 'jobicy']);
    expect(plan.tasksBySource.get('michaelpage')!.map((task) => task.location)).toEqual(
      ['Poland', 'Germany', 'Netherlands', 'United Kingdom', 'Switzerland', 'France', 'United Arab Emirates']);
    expect([...plan.tasksBySource.values()].flat()).toHaveLength(12);
    expect([...plan.tasksBySource.values()].flat().every((task) => task.search_term === 'SAP')).toBe(true);
    const descriptions = [...plan.tasksBySource.values()].flat().filter((task) => task.fetch_description);
    expect(descriptions.map((task) => task.source)).toEqual(['michaelpage', 'nextventures']);
    expect(plan.tasksBySource.get('michaelpage')!.every((task) => task.hours_old === 2160)).toBe(true);
    expect(planBatch(config, { batchKey: 'sap-public', hoursOld: 168 }).tasksBySource.get('michaelpage')!
      .every((task) => task.hours_old === 168)).toBe(true);
  });

  it('covers UI5 individual markets and both compact and spaced developer names', () => {
    const config = loadConfig();
    const broad = planBatch(config, { batchKey: 'ui5-broad' });
    expect(broad.tasksBySource.get('linkedin')!.map((task) => task.location))
      .toEqual(expect.arrayContaining(['European Union', 'Germany', 'Netherlands']));
    expect(broad.tasksBySource.get('indeed')!.map((task) => task.country_indeed))
      .toEqual(expect.arrayContaining(['Germany', 'Poland']));
    expect([...broad.tasksBySource.values()].flat()).toHaveLength(18);
    const frontend = planBatch(config, { batchKey: 'frontend' });
    expect(frontend.keywords).toEqual(['SAPUI5 Developer', 'SAP UI5 Developer', 'SAP Fiori Developer']);
    expect([...frontend.tasksBySource.values()].flat()).toHaveLength(18);
    expect(frontend.tasksBySource.get('linkedin')!.some((task) => task.location === 'Bulgaria')).toBe(true);
    expect(frontend.tasksBySource.get('indeed')!.some((task) => task.country_indeed === 'Bulgaria')).toBe(false);
  });

  it('covers all three EMEA regions and uses supported UAE endpoints', () => {
    const config = loadConfig();
    const frontend = planBatch(config, { batchKey: 'emea-frontend' });
    expect([...frontend.tasksBySource.values()].flat()).toHaveLength(18);
    expect(frontend.tasksBySource.get('linkedin')!.map((task) => task.location))
      .toEqual(expect.arrayContaining(['EMEA', 'Europe', 'Middle East', 'Africa', 'United Arab Emirates', 'Dubai, United Arab Emirates']));
    const core = planBatch(config, { batchKey: 'emea-core' });
    expect(core.tasksBySource.get('indeed')!.map((task) => task.country_indeed))
      .toEqual(expect.arrayContaining(['United Arab Emirates', 'South Africa', 'Egypt']));
    const uae = planBatch(config, { batchKey: 'uae-frontend' });
    expect([...uae.tasksBySource.values()].flat()).toHaveLength(12);
    expect(uae.tasksBySource.get('indeed')!.every((task) => task.country_indeed === 'United Arab Emirates')).toBe(true);
    expect(planBatch(config, { batchKey: 'sap-public' }).tasksBySource.get('michaelpage')!
      .some((task) => task.location === 'United Arab Emirates' && task.search_term === 'SAP')).toBe(true);
    expect(config.searches.sources.glassdoor!.geos.ae).toBeUndefined();
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
