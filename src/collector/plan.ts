import type { AppConfig } from '../config/index.js';
import type { CollectorTask } from './types.js';

export interface PlannedBatch {
  batchKey: string;
  keywords: string[];
  /** Tasks grouped per source - each source is collected in its own subprocess
   *  so that one blocked board cannot affect the others. */
  tasksBySource: Map<string, CollectorTask[]>;
  skipped: Array<{ source: string; reason: string }>;
}

/**
 * Pick the rotating batch for a point in time. Batches advance every
 * `rotation.interval_hours`, so a 3-hourly schedule walks the whole rotation
 * instead of hammering every keyword against every country each cycle.
 */
export function selectBatchIndex(config: AppConfig, at: Date = new Date()): number {
  const { interval_hours, batches } = config.searches.rotation;
  const slot = Math.floor(at.getTime() / (interval_hours * 3_600_000));
  return ((slot % batches.length) + batches.length) % batches.length;
}

export interface PlanOptions {
  at?: Date;
  /** Sources currently on cooldown or explicitly disabled by the caller. */
  skipSources?: Map<string, string>;
  /** Restrict the plan to these sources (CLI `--source`). */
  onlySources?: string[];
  /** Force a specific batch key instead of the rotation. */
  batchKey?: string;
  /** Override the freshness window. */
  hoursOld?: number;
  /** Override results per task. */
  resultsWanted?: number;
}

export function planBatch(config: AppConfig, options: PlanOptions = {}): PlannedBatch {
  const { searches } = config;
  const batches = searches.rotation.batches;
  const batch = options.batchKey
    ? batches.find((candidate) => candidate.key === options.batchKey)
    : batches[selectBatchIndex(config, options.at)];
  if (!batch) {
    throw new Error(`Unknown batch "${options.batchKey}". Available: ${batches.map((b) => b.key).join(', ')}`);
  }

  const skipped: PlannedBatch['skipped'] = [];
  const tasksBySource = new Map<string, CollectorTask[]>();
  let planned = 0;

  for (const [source, geoIds] of Object.entries(batch.targets)) {
    const sourceConfig = searches.sources[source];
    if (!sourceConfig) continue;
    if (!sourceConfig.enabled) {
      skipped.push({ source, reason: 'disabled in searches.yaml' });
      continue;
    }
    if (options.onlySources?.length && !options.onlySources.includes(source)) continue;
    const cooldownReason = options.skipSources?.get(source);
    if (cooldownReason) {
      skipped.push({ source, reason: cooldownReason });
      continue;
    }

    const tasks: CollectorTask[] = [];
    for (const geoId of geoIds) {
      const geo = sourceConfig.geos[geoId];
      if (!geo) continue;
      for (const keyword of batch.keywords) {
        if (planned >= searches.resilience.max_tasks_per_run) break;
        tasks.push({
          task_id: `${batch.key}:${source}:${geoId}:${slug(keyword)}`,
          source,
          search_term: keyword,
          ...(geo.location ? { location: geo.location } : {}),
          ...(geo.country_indeed ? { country_indeed: geo.country_indeed } : {}),
          results_wanted: options.resultsWanted ?? sourceConfig.results_wanted ?? searches.defaults.results_wanted,
          hours_old: options.hoursOld ?? searches.defaults.hours_old,
          distance: searches.defaults.distance,
          description_format: searches.defaults.description_format,
          fetch_description: false,
          // Remote/contract are deliberately NOT pre-filtered: most postings
          // omit those fields and would be lost. Filtering happens after
          // normalization instead.
          is_remote: searches.defaults.is_remote,
          ...(searches.defaults.job_type ? { job_type: searches.defaults.job_type } : {}),
        });
        planned += 1;
      }
    }
    if (tasks.length) tasksBySource.set(source, tasks);
  }

  applyDescriptionBudget(config, tasksBySource);
  return { batchKey: batch.key, keywords: batch.keywords, tasksBySource, skipped };
}

/**
 * Fetching descriptions costs one extra request per job and is the fastest way
 * to get rate limited, so only a bounded number of tasks are allowed to do it.
 * Jobs collected without a description stay incomplete on purpose.
 */
function applyDescriptionBudget(config: AppConfig, tasksBySource: Map<string, CollectorTask[]>): void {
  const budget = config.searches.description_budget;
  if (budget.max_tasks_per_run <= 0) return;

  const candidates: CollectorTask[] = [];
  const order = [...budget.prefer_sources, ...tasksBySource.keys()];
  const seen = new Set<string>();
  for (const source of order) {
    if (seen.has(source)) continue;
    seen.add(source);
    const sourceConfig = config.searches.sources[source];
    const tasks = tasksBySource.get(source);
    if (!sourceConfig || !tasks) continue;
    if (!sourceConfig.supports_description_fetch) continue;
    if (sourceConfig.search_results_include_description) continue;
    candidates.push(...tasks);
  }
  for (const task of candidates.slice(0, budget.max_tasks_per_run)) {
    task.fetch_description = true;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
