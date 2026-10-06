import { readFileSync } from 'node:fs';
import { collectorLineSchema, type CollectorJob } from '../collector/types.js';
import { log } from '../util/log.js';

export interface FixtureRecord {
  taskId: string;
  source: string;
  job: CollectorJob;
}

/**
 * Load offline demo data in the collector's JSON Lines format.
 * Fixtures are DEMO DATA - they never contain live vacancies.
 */
export function loadFixture(file: string): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  let malformed = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed += 1;
      continue;
    }
    const result = collectorLineSchema.safeParse(parsed);
    if (!result.success || result.data.type !== 'job') {
      malformed += 1;
      continue;
    }
    records.push({ taskId: result.data.task_id, source: result.data.source, job: result.data.job });
  }
  if (malformed) log.warn('Fixture contained lines that were ignored', { file, malformed });
  return records;
}
