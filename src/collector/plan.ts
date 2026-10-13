import type { AppConfig } from '../config/index.js';
import type { CollectorTask } from './types.js';

export interface PlannedBatch {
  batchKey: string;
  keywords: string[];
  /** Tasks grouped per source - each source is collected in its own subprocess
   *  so that one blocked board cannot affect the others. */
  tasksBySource: Map<string, CollectorTask[]>;
  skipped: Array<{ source: string; reason: string }>;
  descriptionRotation: DescriptionRotation;
}

export interface DescriptionRotation {
  lastSource: string | null;
  lastTaskBySource: Record<string, string>;
  lastSearchByScope?: Record<string, string>;
}

/**
 * Pick the rotating batch for a point in time. Batches advance every
 * `rotation.interval_hours`, so a 3-hourly schedule walks the whole rotation
 * instead of hammering every keyword against every country each cycle.
 */
export function selectBatchIndex(config: AppConfig, at: Date = new Date()): number {
  const { interval_hours, batches } = config.searches.rotation;
  const sequence = config.searches.rotation.sequence ?? batches.map((batch) => batch.key);
  const slot = Math.floor(at.getTime() / (interval_hours * 3_600_000));
  const key = sequence[((slot % sequence.length) + sequence.length) % sequence.length];
  return batches.findIndex((batch) => batch.key === key);
}

export interface PlanOptions {
  /** Enrich/refresh stored listings without issuing searches. */
  enrichOnly?: boolean;
  /** Persisted per-batch description cursors; planning itself is side-effect free. */
  descriptionRotation?: DescriptionRotation;
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
  for (const source of options.onlySources ?? []) {
    if (!searches.sources[source]) {
      throw new Error(`Unknown source "${source}". Available: ${Object.keys(searches.sources).join(', ')}`);
    }
  }
  const batches = searches.rotation.batches;
  const batch = options.enrichOnly ? {
    key: 'description-backlog', keywords: ['SAP'],
    targets: Object.fromEntries(Object.entries(searches.sources)
      .filter(([, source]) => source.supports_backlog_enrichment)
      .map(([name, source]) => [name, [Object.keys(source.geos)[0]!]])),
  } : options.batchKey
    ? batches.find((candidate) => candidate.key === options.batchKey)
    : batches[selectBatchIndex(config, options.at)];
  if (!batch) {
    throw new Error(`Unknown batch "${options.batchKey}". Available: ${batches.map((b) => b.key).join(', ')}`);
  }

  const skipped: PlannedBatch['skipped'] = [];
  for (const source of options.onlySources ?? []) {
    if (!batch.targets[source]?.length) {
      const available = batches.filter((candidate) => candidate.targets[source]?.length).map((candidate) => candidate.key);
      skipped.push({ source, reason: `not in batch "${batch.key}"; use --batch ${available.join(' or ')}` });
    }
  }
  const tasksBySource = new Map<string, CollectorTask[]>();

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
        tasks.push({
          task_id: `${batch.key}:${source}:${geoId}:${slug(keyword)}`,
          source,
          search_term: keyword,
          ...(geo.location ? { location: geo.location } : {}),
          ...(geo.country_indeed ? { country_indeed: geo.country_indeed } : {}),
          results_wanted: options.resultsWanted ?? sourceConfig.results_wanted ?? searches.defaults.results_wanted,
          hours_old: options.hoursOld ?? sourceConfig.hours_old ?? searches.defaults.hours_old,
          distance: searches.defaults.distance,
          description_format: searches.defaults.description_format,
          fetch_description: false,
          ...(source === 'linkedin' ? { search_request_limit: searches.linkedin_limits.max_search_requests_per_task } : {}),
          ...(options.enrichOnly ? { enrich_only: true } : {}),
          // Remote/contract are deliberately NOT pre-filtered: most postings
          // omit those fields and would be lost. Filtering happens after
          // normalization instead.
          is_remote: searches.defaults.is_remote,
          ...(searches.defaults.job_type ? { job_type: searches.defaults.job_type } : {}),
        });
      }
    }
    if (tasks.length) tasksBySource.set(source, tasks);
  }

  const searchCursors = { ...options.descriptionRotation?.lastSearchByScope };
  if (!options.enrichOnly) applySearchBudget(config, batch.key, tasksBySource, searchCursors, skipped);
  const descriptionRotation = applyDescriptionBudget(config, tasksBySource, options.descriptionRotation);
  descriptionRotation.lastSearchByScope = searchCursors;
  const details = (tasksBySource.get('linkedin') ?? []).filter((task) => task.fetch_description);
  let remainingDetails = searches.linkedin_limits.max_detail_requests_per_run;
  details.forEach((task, index) => {
    task.detail_request_limit = Math.ceil(remainingDetails / (details.length - index));
    remainingDetails -= task.detail_request_limit;
  });
  if (options.enrichOnly) {
    for (const [source, tasks] of tasksBySource) {
      const selected = tasks.filter((task) => task.fetch_description);
      if (selected.length) tasksBySource.set(source, selected);
      else tasksBySource.delete(source);
    }
  }
  return { batchKey: batch.key, keywords: batch.keywords, tasksBySource, skipped, descriptionRotation };
}

/** Rotate capped combinations, including a batch's tail, across persisted runs. */
function applySearchBudget(config: AppConfig, batchKey: string, tasksBySource: Map<string, CollectorTask[]>,
  cursors: Record<string, string>, skipped: PlannedBatch['skipped']): void {
  const rotate = (tasks: CollectorTask[], key: string) => {
    const start = tasks.findIndex((task) => task.task_id === cursors[key]);
    return [...tasks.slice(start + 1), ...tasks.slice(0, start + 1)];
  };
  const linkedin = tasksBySource.get('linkedin');
  if (linkedin) {
    const key = `${batchKey}:linkedin`;
    const limit = config.searches.linkedin_limits.max_search_tasks_per_run;
    const selected = rotate(linkedin, key).slice(0, limit);
    if (selected.length) tasksBySource.set('linkedin', selected);
    else tasksBySource.delete('linkedin');
    if (selected.length < linkedin.length) skipped.push({ source: 'linkedin',
      reason: `${linkedin.length - selected.length} search combinations postponed by LinkedIn task limit` });
  }
  const all = [...tasksBySource.values()].flat();
  const key = `${batchKey}:__all__`;
  const selected = rotate(all, key).slice(0, Math.min(18, config.searches.resilience.max_tasks_per_run));
  const ids = new Set(selected.map((task) => task.task_id));
  for (const [source, tasks] of tasksBySource) {
    const ready = tasks.filter((task) => ids.has(task.task_id));
    if (ready.length) tasksBySource.set(source, ready);
    else tasksBySource.delete(source);
    if (ready.length < tasks.length) skipped.push({ source, reason: `${tasks.length - ready.length} search combinations postponed by global task limit` });
  }
  if (selected.length) cursors[key] = selected.at(-1)!.task_id;
  const selectedLinkedin = selected.filter((task) => task.source === 'linkedin');
  if (selectedLinkedin.length) cursors[`${batchKey}:linkedin`] = selectedLinkedin.at(-1)!.task_id;
}

/**
 * Fetching descriptions costs one extra request per job and is the fastest way
 * to get rate limited, so only a bounded number of tasks are allowed to do it.
 * Jobs collected without a description stay incomplete on purpose.
 */
function applyDescriptionBudget(
  config: AppConfig, tasksBySource: Map<string, CollectorTask[]>, previous?: DescriptionRotation,
): DescriptionRotation {
  const state: DescriptionRotation = {
    lastSource: previous?.lastSource ?? null,
    lastTaskBySource: { ...previous?.lastTaskBySource },
  };
  const budget = config.searches.description_budget;
  if (budget.max_tasks_per_run <= 0) return state;

  const order = [...new Set([...budget.prefer_sources, ...Object.keys(config.searches.sources)])];
  const eligible = new Map<string, CollectorTask[]>();
  for (const source of order) {
    const sourceConfig = config.searches.sources[source];
    const tasks = tasksBySource.get(source);
    if (!sourceConfig || !tasks) continue;
    if (!sourceConfig.supports_description_fetch) continue;
    if (source === 'linkedin' && config.searches.linkedin_limits.max_detail_requests_per_run === 0) continue;
    if (sourceConfig.search_results_include_description && !sourceConfig.supports_backlog_enrichment) continue;
    eligible.set(source, tasks);
  }
  let sourceIndex = state.lastSource ? order.indexOf(state.lastSource) : -1;
  let allocated = 0;
  let misses = 0;
  // Round-robin sources, with a separate keyword/location cursor per source.
  // Unavailable sources keep their cursors and consume no description slots.
  while (allocated < Math.min(2, budget.max_tasks_per_run) && misses < order.length) {
    sourceIndex = (sourceIndex + 1) % order.length;
    const source = order[sourceIndex]!;
    const tasks = eligible.get(source);
    if (!tasks?.some((task) => !task.fetch_description)) { misses += 1; continue; }
    const cursorKey = `${tasks[0]!.task_id.split(':')[0]}:${source}`;
    // Read old per-batch cursors for compatibility; new cursors are scoped by
    // batch while the source cursor advances across every collection cycle.
    const last = tasks.findIndex((task) => task.task_id === (state.lastTaskBySource[cursorKey] ?? state.lastTaskBySource[source]));
    for (let offset = 1; offset <= tasks.length; offset += 1) {
      const task = tasks[(last + offset) % tasks.length]!;
      if (task.fetch_description) continue;
      task.fetch_description = true;
      state.lastTaskBySource[cursorKey] = task.task_id;
      state.lastSource = source;
      allocated += 1;
      misses = 0;
      break;
    }
  }
  return state;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
