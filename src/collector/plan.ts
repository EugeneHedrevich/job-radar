import type { AppConfig } from '../config/index.js';
import type { CollectorTask } from './types.js';
import { normalizeText } from '../util/text.js';

export interface PlannedBatch {
  batchKey: string;
  keywords: string[];
  /** Tasks grouped per source - each source is collected in its own subprocess
   *  so that one blocked board cannot affect the others. */
  tasksBySource: Map<string, CollectorTask[]>;
  skipped: Array<{ source: string; reason: string }>;
  descriptionRotation: DescriptionRotation;
  /** Proposed search order; persist only the executed prefix of each scope. */
  searchRotation: Record<string, string[]>;
}

export interface DescriptionRotation {
  enrichmentScanByScope?: Record<string, string>;
  lastSource: string | null;
  lastTaskBySource: Record<string, string>;
  lastSearchByScope?: Record<string, string>;
  linkedinPending?: CollectorTask[];
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
  preparationTimings?: Record<string, number>;
  /** Frozen weekly catalogue slice; selected outside the ordinary rotation. */
  searchTasks?: CollectorTask[];
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
  /** Internal: keep the full LinkedIn catalogue rotating during time-based cycles. */
  globalLinkedin?: boolean;
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

  for (const [source, references] of Object.entries(batch.targets)) {
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
    const geoIds = sourceGeographies(config, source, references, skipped);
    for (const geoId of geoIds) {
      if (sourceConfig.queries?.geos && !sourceConfig.queries.geos.includes(geoId)) continue;
      const geo = sourceConfig.geos[geoId];
      if (!geo) continue;
      for (const keyword of batch.keywords) {
        tasks.push(makeTask(config, batch.key, source, geoId, keyword, options));
      }
    }
    if (tasks.length) tasksBySource.set(source, distinctTasks(tasks));
  }

  const searchCursors = { ...options.descriptionRotation?.lastSearchByScope };
  const linkedinPending = [...(options.descriptionRotation?.linkedinPending ?? [])];
  const searchRotation: PlannedBatch['searchRotation'] = {};
  if (options.searchTasks) {
    tasksBySource.clear();
    const requests = new Set<string>();
    for (const task of options.searchTasks) {
      if (!searches.sources[task.source]?.enabled || options.skipSources?.has(task.source)) continue;
      const key = task.enrich_only ? task.task_id : searchRequestKey(task);
      if (requests.has(key)) continue;
      requests.add(key);
      const group = tasksBySource.get(task.source) ?? [];
      group.push({ ...task, fetch_description: false });
      tasksBySource.set(task.source, group);
    }
  } else if (!options.enrichOnly) applySearchBudget(config, batch.key, tasksBySource, searchCursors, skipped, linkedinPending, options, searchRotation);
  const descriptionRotation = applyDescriptionBudget(config, tasksBySource, options.descriptionRotation);
  descriptionRotation.lastSearchByScope = searchCursors;
  descriptionRotation.linkedinPending = linkedinPending;
  const details = (tasksBySource.get('linkedin') ?? []).filter((task) => task.fetch_description);
  let remainingDetails = searches.linkedin_limits.max_detail_requests_per_run;
  details.forEach((task, index) => {
    task.detail_request_limit = Math.ceil(remainingDetails / (details.length - index));
    remainingDetails -= task.detail_request_limit;
  });
  for (const tasks of tasksBySource.values()) for (const task of tasks) if (task.fetch_description)
    task.detail_title_patterns = Object.values(config.scoring.relevance.target_role_families).flat();
  if (options.enrichOnly) {
    for (const [source, tasks] of tasksBySource) {
      const selected = tasks.filter((task) => task.fetch_description);
      if (selected.length) tasksBySource.set(source, selected);
      else tasksBySource.delete(source);
    }
  }
  return { batchKey: options.searchTasks ? 'weekly' : batch.key, keywords: batch.keywords, tasksBySource, skipped, descriptionRotation, searchRotation };
}

/** Rotate capped combinations, including a batch's tail, across persisted runs. */
function applySearchBudget(config: AppConfig, batchKey: string, tasksBySource: Map<string, CollectorTask[]>,
  cursors: Record<string, string>, skipped: PlannedBatch['skipped'], pending: CollectorTask[], options: PlanOptions,
  searchRotation: PlannedBatch['searchRotation']): void {
  const rotate = (tasks: CollectorTask[], key: string) => {
    const start = tasks.findIndex((task) => task.task_id === cursors[key]);
    return [...tasks.slice(start + 1), ...tasks.slice(0, start + 1)];
  };
  const global = options.globalLinkedin ?? (!options.batchKey && !options.onlySources?.length);
  const linkedin = global ? linkedinCatalogue(config) : tasksBySource.get('linkedin') ?? [];
  const scope = global ? '__catalogue__:linkedin' : `${batchKey}:linkedin`;
  const linkedinAvailable = config.searches.sources.linkedin?.enabled && !options.skipSources?.has('linkedin') &&
    (!options.onlySources?.length || options.onlySources.includes('linkedin'));
  tasksBySource.delete('linkedin');
  const all = [...tasksBySource.values()].flat();
  const capacity = Math.min(18, config.searches.resilience.max_tasks_per_run);
  const selectedLinkedin = linkedinAvailable ? rotate(linkedin, scope).slice(0, Math.min(2,
    config.searches.linkedin_limits.max_search_tasks_per_run, Math.max(0, capacity - all.length))) : [];
  // Old queues are replaced by a catalogue cursor; saved per-query backfill is retained.
  pending.splice(0);
  const key = `${batchKey}:__all__`;
  const selected = rotate(all, key).slice(0, Math.max(0,
    Math.min(18, config.searches.resilience.max_tasks_per_run) - selectedLinkedin.length));
  searchRotation[key] = selected.map((task) => task.task_id);
  searchRotation[scope] = selectedLinkedin.map((task) => task.task_id);
  const ids = new Set(selected.map((task) => task.task_id));
  for (const [source, tasks] of tasksBySource) {
    const ready = tasks.filter((task) => ids.has(task.task_id));
    if (ready.length) tasksBySource.set(source, ready);
    else tasksBySource.delete(source);
    if (ready.length < tasks.length) skipped.push({ source, reason: `${tasks.length - ready.length} search combinations postponed by global task limit` });
  }
  if (selected.length) cursors[key] = selected.at(-1)!.task_id;
  if (selectedLinkedin.length) {
    const source = config.searches.sources.linkedin!;
    tasksBySource.set('linkedin', selectedLinkedin.map((task) => ({ ...task, fetch_description: false,
      hours_old: options.hoursOld ?? source.hours_old ?? config.searches.defaults.hours_old,
      results_wanted: options.resultsWanted ?? source.results_wanted ?? config.searches.defaults.results_wanted })));
    cursors[scope] = selectedLinkedin.at(-1)!.task_id;
    for (const task of selectedLinkedin) cursors[`${task.task_id.split(':')[0]}:linkedin`] = task.task_id;
  }
  if (linkedinAvailable && selectedLinkedin.length < linkedin.length) skipped.push({ source: 'linkedin',
    reason: `${linkedin.length - selectedLinkedin.length} catalogue combinations deferred; no more than two per available cycle` });
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
    ...(previous?.enrichmentScanByScope ? { enrichmentScanByScope: { ...previous.enrichmentScanByScope } } : {}),
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
      state.lastTaskBySource[`${task.task_id.split(':')[0]}:${source}`] = task.task_id;
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

function makeTask(config: AppConfig, batchKey: string, source: string, geoId: string, keyword: string, options: PlanOptions = {}): CollectorTask {
  const searches = config.searches, settings = searches.sources[source]!, geo = settings.geos[geoId]!;
  const query = settings.queries;
  const supportsFilters = ['linkedin', 'indeed'].includes(source);
  return { task_id: `${batchKey}:${source}:${geoId}:${slug(keyword)}`, source, search_term: sourceQuery(config, source, keyword),
    ...(geo.location ? { location: geo.location } : {}), ...(geo.country_indeed ? { country_indeed: geo.country_indeed } : {}),
    results_wanted: options.resultsWanted ?? settings.results_wanted ?? searches.defaults.results_wanted,
    hours_old: options.hoursOld ?? settings.hours_old ?? searches.defaults.hours_old,
    distance: searches.defaults.distance, description_format: searches.defaults.description_format, fetch_description: false,
    ...(source === 'linkedin' ? { search_request_limit: searches.linkedin_limits.max_search_requests_per_task } : {}),
    ...(options.enrichOnly ? { enrich_only: true } : {}), is_remote: supportsFilters ? query?.remote_only ?? searches.defaults.is_remote : false,
    ...(supportsFilters && (query?.employment ?? searches.defaults.job_type) ? { job_type: query?.employment ?? searches.defaults.job_type! } : {}) };
}

/** Keep board syntax explicit; public adapters receive plain phrases. */
export function sourceQuery(config: AppConfig, source: string, keyword: string): string {
  const query = config.searches.sources[source]?.queries;
  if (!query) return keyword;
  const raw = query.roles[keyword] ?? keyword;
  if (query.syntax === 'plain' || !['linkedin', 'indeed'].includes(source)) return raw;
  const modifier = /\s+(freelance|contract|B2B)$/i.exec(raw)?.[1];
  const phrase = modifier ? raw.slice(0, -(modifier.length + 1)) : raw;
  const clean = (value: string) => value.replace(/["\r\n]/g, ' ').trim();
  const main = query.exact_phrases ? `"${clean(phrase)}"${modifier ? ` ${modifier}` : ''}` : clean(raw);
  return main + query.exclusions.map((term) => query.syntax === 'linkedin' ? ` NOT "${clean(term)}"` : ` -"${clean(term)}"`).join('');
}

export function linkedinCatalogue(config: AppConfig): CollectorTask[] {
  if (!config.searches.sources.linkedin) return [];
  const tasks = config.searches.rotation.batches.flatMap((batch) => sourceGeographies(config, 'linkedin', batch.targets.linkedin ?? []).filter((geo) =>
    !config.searches.sources.linkedin?.queries?.geos || config.searches.sources.linkedin.queries.geos.includes(geo)).flatMap((geo) =>
    batch.keywords.map((keyword) => makeTask(config, batch.key, 'linkedin', geo, keyword))));
  return distinctTasks(tasks);
}

/** The enabled effective query/geography catalogue, without rotation or I/O. */
export function searchCatalogue(config: AppConfig): CollectorTask[] {
  return distinctTasks(config.searches.rotation.batches.flatMap((batch) => Object.entries(batch.targets)
    .flatMap(([source, geos]) => !config.searches.sources[source]?.enabled ? [] : sourceGeographies(config, source, geos).filter((geo) =>
      config.searches.sources[source]!.geos[geo] && (!config.searches.sources[source]!.queries?.geos ||
        config.searches.sources[source]!.queries!.geos!.includes(geo)))
      .flatMap((geo) => batch.keywords.map((keyword) => makeTask(config, batch.key, source, geo, keyword))))));
}

/** Only identical effective queries and filters share a task; broad skills
 * remain distinct from role phrases and from different country scopes. */
export function searchQueryKey(task: CollectorTask): string {
  return JSON.stringify([task.source, normalizeText(task.search_term), normalizeText(task.location),
    normalizeText(task.country_indeed), task.is_remote, normalizeText(task.job_type)]);
}

export function searchRequestKey(task: CollectorTask): string {
  return JSON.stringify([searchQueryKey(task), task.offset ?? 0, task.search_cursor?.page ?? 1, task.search_cursor?.index ?? 0,
    task.requested_start, task.requested_end, task.hours_old, task.results_wanted, task.head_only ?? null, Boolean(task.enrich_only)]);
}

export function sourceGeographies(config: AppConfig, source: string, references: string[], skipped?: PlannedBatch['skipped']): string[] {
  const ids = references.flatMap((ref) => ref.startsWith('@') ? config.searches.geography_groups[ref.slice(1)] ?? [] : [ref]);
  return [...new Set(ids)].filter((id) => {
    if (config.searches.sources[source]?.geos[id]) return true;
    skipped?.push({ source, reason: `Geography ${id} is unsupported by the configured ${source} adapter` });
    return false;
  });
}

export function catalogueLimitations(config: AppConfig): PlannedBatch['skipped'] {
  const skipped: PlannedBatch['skipped'] = [];
  for (const batch of config.searches.rotation.batches) for (const [source, refs] of Object.entries(batch.targets))
    if (config.searches.sources[source]?.enabled) sourceGeographies(config, source, refs, skipped);
  return [...new Map(skipped.map((row) => [`${row.source}:${row.reason}`, row])).values()];
}

function distinctTasks(tasks: CollectorTask[]): CollectorTask[] {
  return [...new Map(tasks.map((task) => [searchQueryKey(task), task])).values()];
}

/** Capacity of the actual configured sequence, before cooldowns; never a promise of complete coverage. */
export function linkedinCoverage(config: AppConfig) {
  const searches = config.searches;
  const sequence = searches.rotation.sequence ?? searches.rotation.batches.map((batch) => batch.key);
  const taskKeys = linkedinCatalogue(config).map((task) => task.task_id);
  const limit = Math.min(18, searches.resilience.max_tasks_per_run);
  const slotsPerSequence = sequence.reduce((slots, key) => {
    const batch = searches.rotation.batches.find((row) => row.key === key)!;
    const otherTasks = Object.entries(batch.targets).reduce((sum, [source, geos]) => sum +
      (source !== 'linkedin' && searches.sources[source]?.enabled ? sourceGeographies(config, source, geos).filter((geo) =>
        !searches.sources[source]?.queries?.geos || searches.sources[source]!.queries!.geos!.includes(geo)).length * batch.keywords.length : 0), 0);
    return slots + (searches.sources.linkedin?.enabled ? Math.min(2, searches.linkedin_limits.max_search_tasks_per_run,
      Math.max(0, limit - otherTasks)) : 0);
  }, 0);
  return { combinations: taskKeys.length, slotsPerSequence, sequenceHours: sequence.length * searches.rotation.interval_hours,
    freshnessHours: searches.sources.linkedin?.hours_old ?? searches.defaults.hours_old, taskKeys };
}
