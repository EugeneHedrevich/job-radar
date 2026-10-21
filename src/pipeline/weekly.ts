import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, type AppConfig } from '../config/index.js';
import { catalogueLimitations, searchCatalogue, searchQueryKey } from '../collector/plan.js';
import type { CollectorTask, TaskOutcome } from '../collector/types.js';
import { db, SELECT, UPDATE, queryOne, query } from '../db/index.js';
import type { WeeklyProgress } from '../dashboard/types.js';
import { activeCooldowns, sourceResumeTimes } from '../collector/health.js';
import { vacancyRelevance } from '../matching/relevance.js';
import { jobText } from '../matching/signals.js';
import { loadConfig } from '../config/index.js';

export interface WeeklySearch {
  task: CollectorTask;
  visits: number;
  checked: boolean;
  state: 'pending' | 'exhausted' | 'limited' | 'capped' | 'failed' | 'cooldown';
  retryAfter?: string;
  quarantined?: number;
  failures?: number;
  reason?: string;
}
export interface WeeklyState {
  automatic?: boolean; // legacy, manually stepped operations opt in on continuation
  totals?: Record<string, number>;
  assessedRuns?: string[];
  unsupported?: Array<{ source: string; reason: string }>;
  jobIds?: string[];
  relevantVacancies?: number;
  pendingDescriptions?: number;
  deferredCandidates?: number;
  start: string; end: string; cycles: number;
  searches: WeeklySearch[];
  configuration: ReturnType<typeof reviewConfiguration>;
  revision: string | null;
}

export function codeRevision(): string | null {
  try {
    const options = { cwd: PROJECT_ROOT, encoding: 'utf8' as const, timeout: 1000 };
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], options).trim();
    return revision + (dirty ? '+dirty' : '');
  }
  catch { return null; }
}

/** Explicit allowlist: never serialize AppConfig.secrets, env, proxy or endpoint URLs. */
export function reviewConfiguration(config: AppConfig) {
  const llm = config.settings.llm;
  return { profile: config.profile, scoring: config.scoring, cvVariants: config.cvVariants,
    searches: config.searches, llm: { enabled: llm.enabled, available: config.llmAvailable,
      model: llm.model, temperature: llm.temperature, max_output_tokens: llm.max_output_tokens,
      max_description_chars: llm.max_description_chars, max_jobs_per_run: Math.min(5, llm.max_jobs_per_run) },
    ceilings: { searchTasks: Math.min(18, config.searches.resilience.max_tasks_per_run),
      descriptionTasks: Math.min(2, config.searches.description_budget.max_tasks_per_run), aiCalls: 5, telegramCalls: 3 },
    notificationThreshold: config.settings.telegram.min_fit_score };
}

export function createWeeklyState(config: AppConfig, at = new Date(), lookbackHours = 168): WeeklyState {
  return { start: new Date(at.getTime() - lookbackHours * 3_600_000).toISOString(), end: at.toISOString(), cycles: 0,
    searches: searchCatalogue(config).map((task) => ({ task, visits: 0, checked: false, state: 'pending', reason: 'Awaiting a bounded search slot' })),
    unsupported: catalogueLimitations(config), configuration: reviewConfiguration(config), revision: codeRevision() };
}

/** Add newly configured scopes without replacing the interval or saved cursors. */
export function extendWeeklyCatalogue(config: AppConfig, state: WeeklyState): WeeklyState {
  const next = structuredClone(state);
  const keys = new Set(next.searches.map((search) => searchQueryKey(search.task)));
  for (const task of searchCatalogue(config)) if (!keys.has(searchQueryKey(task))) {
    next.searches.push({ task, visits: 0, checked: false, state: 'pending', reason: 'New configured geography/query scope' });
    keys.add(searchQueryKey(task));
  }
  next.unsupported = catalogueLimitations(config);
  return next;
}

const unfinished = (search: WeeklySearch) => !['exhausted', 'limited', 'capped'].includes(search.state);

/** Availability is current; committed cursors/history remain unchanged. */
export function weeklyAvailability(state: WeeklyState, deferrals: Map<string, string>, currentSource?: string | null): WeeklyState {
  return { ...state, searches: state.searches.map((search) => {
    if (!unfinished(search)) return search;
    const reason = deferrals.get(search.task.source);
    if (reason && !(currentSource === search.task.source && /already running/i.test(reason)))
      return { ...search, state: 'cooldown' as const, reason };
    return search.state === 'cooldown' ? { ...search, state: 'pending' as const, reason: 'Cooldown finished; continuation retained' } : search;
  }) };
}

export function weeklyProgress(state: WeeklyState): WeeklyProgress {
  return { automatic: Boolean(state.automatic), deferredCandidates: state.deferredCandidates ?? 0, totals: state.totals ?? {}, start: state.start, end: state.end, total: state.searches.length,
    checked: state.searches.filter((s) => s.checked).length,
    exhaustive: state.searches.filter((s) => s.state === 'exhausted').length,
    deferred: state.searches.filter(unfinished).length,
    limited: state.searches.filter((s) => ['limited', 'capped'].includes(s.state)).length,
    failed: state.searches.filter((s) => s.state === 'failed').length,
    cooldown: state.searches.filter((s) => s.state === 'cooldown').length,
    unsupported: state.unsupported?.length ?? 0,
    relevantVacancies: state.relevantVacancies ?? 0, pendingDescriptions: state.pendingDescriptions ?? 0,
    canContinue: state.searches.some(unfinished), cycles: state.cycles,
    limitations: [...new Set(state.searches.flatMap((s) => s.reason ? [`${s.task.source}: ${s.reason}${s.retryAfter ? `; retry after ${s.retryAfter}` : ''}`] : []))] };
}

/** A persisted cycle remains bounded; waiting never consumes a source lease. */
export function weeklyTasks(config: AppConfig, state: WeeklyState, skip: Map<string, string>, at = new Date()): CollectorTask[] {
  const pending = state.searches.filter((s) => unfinished(s) && (!s.retryAfter || Date.parse(s.retryAfter) <= at.getTime()) &&
    config.searches.sources[s.task.source]?.enabled && !skip.has(s.task.source));
  // Round-robin sources among least-visited combinations, then continue their pages.
  const groups = new Map<string, WeeklySearch[]>();
  for (const search of pending.sort((a, b) => a.visits - b.visits)) {
    const group = groups.get(search.task.source) ?? []; group.push(search); groups.set(search.task.source, group);
  }
  if (groups.has('linkedin')) groups.set('linkedin', prioritizeLinkedin(state.searches, groups.get('linkedin')!));
  const selected: CollectorTask[] = [];
  const capacity = Math.min(18, config.searches.resilience.max_tasks_per_run);
  let linkedin = 0;
  while (selected.length < capacity) {
    let added = false;
    for (const [source, group] of groups) {
      if (selected.length >= capacity) break;
      if (source === 'linkedin' && linkedin >= Math.min(2, config.searches.linkedin_limits.max_search_tasks_per_run)) continue;
      const next = group.shift(); if (!next) continue;
      selected.push({ ...next.task, requested_start: state.start, requested_end: state.end,
        // Relative upstream filters widen as time passes; the fixed upper bound is applied locally.
        hours_old: Math.max(1, Math.ceil((at.getTime() - Date.parse(state.start)) / 3_600_000)),
        ...(source === 'linkedin' ? { search_request_limit: next.checked ? config.searches.linkedin_limits.max_search_requests_per_task : 1,
          ...(!next.checked ? { offset: next.task.offset ?? 0, head_only: true, results_wanted: 10 } : {}) } : {}) });
      if (source === 'linkedin') linkedin += 1;
      added = true;
    }
    if (!added) break;
  }
  return selected;
}

/** Primary family/region heads precede aliases and backfill. Count only verified visits. */
function prioritizeLinkedin(all: WeeklySearch[], pending: WeeklySearch[]): WeeklySearch[] {
  const family = (s: WeeklySearch) => /\bbtp\b/i.test(s.task.search_term) ? 'btp' : /\bcapm?\b|cloud application programming/i.test(s.task.search_term) ? 'cap' :
    /ui5|fiori/i.test(s.task.search_term) ? 'ui5' : /cpi|integration/i.test(s.task.search_term) ? 'integration' : 'other';
  const region = (s: WeeklySearch) => /emirates|dubai|abu dhabi|saudi|riyadh|jeddah|eastern province|qatar|kuwait|bahrain|oman/i.test(s.task.location ?? '') ? 'gcc' : 'eu-other';
  const bucket = (s: WeeklySearch) => `${family(s)}:${region(s)}`;
  const primary = (s: WeeklySearch) => /^(?:"?sap (?:cap|btp|cpi|integration suite|fiori)"?|"?sapui5"?)(?:\s+(?:NOT|-).*)?$/i.test(s.task.search_term);
  const tier = (s: WeeklySearch) => s.checked ? 2 : primary(s) ? 0 : 1;
  const counts = new Map<string, number>();
  for (const s of all.filter((s) => s.task.source === 'linkedin' && s.checked)) counts.set(bucket(s), (counts.get(bucket(s)) ?? 0) + 1);
  const remaining = [...pending], result: WeeklySearch[] = [];
  while (remaining.length) {
    remaining.sort((a, b) => tier(a) - tier(b) || (counts.get(bucket(a)) ?? 0) - (counts.get(bucket(b)) ?? 0) || a.visits - b.visits);
    const next = remaining.shift()!; result.push(next); counts.set(bucket(next), (counts.get(bucket(next)) ?? 0) + 1);
  }
  return result;
}

export async function nextWeeklyResume(config: AppConfig, state: WeeklyState, at = new Date()): Promise<string | null> {
  const times = await sourceResumeTimes(config, at);
  const eligible = state.searches.filter((s) => unfinished(s) && config.searches.sources[s.task.source]?.enabled)
    .map((s) => Math.max(at.getTime() + 60_000, times.get(s.task.source) ?? 0, Date.parse(s.retryAfter ?? '') || 0));
  return eligible.length ? new Date(Math.min(...eligible)).toISOString() : null;
}

export async function readWeeklyState(id: string): Promise<WeeklyState | null> {
  const row = await queryOne<any>(SELECT.from(db().CollectionOperations).columns('weeklyState', 'currentSource', 'outcome').where({ ID: id }));
  if (!row?.weeklyState) return null;
  const state: WeeklyState = JSON.parse(row.weeklyState);
  if (!state.jobIds) {
    const runs = await query<any>(SELECT.from(db().CollectionRuns).columns('ID', 'diagnostics').where({ operationId: id }));
    const listings = runs.length ? await query<any>(SELECT.from(db().SourceListings).columns('job_ID').where({ run_ID: { in: runs.map((run) => run.ID) } })) : [];
    state.jobIds = [...new Set<string>([...listings.map((listing) => listing.job_ID),
      ...runs.flatMap((run) => JSON.parse(run.diagnostics ?? '{}').ingest?.jobIds ?? [])])];
  }
  if (state.relevantVacancies === undefined && state.jobIds.length) {
    const jobs = await query<any>(SELECT.from(db().Jobs).where({ ID: { in: state.jobIds } })), config = loadConfig();
    state.relevantVacancies = jobs.filter((job) => vacancyRelevance(config, job).accepted).length;
    state.pendingDescriptions = jobs.filter((job) => !jobText(job).hasDescription && vacancyRelevance(config, job).state !== 'irrelevant').length;
  }
  return weeklyAvailability(state, await activeCooldowns(), row.outcome === 'Running' ? row.currentSource : null);
}

/** Called only in the results transaction: replay cannot move past unsaved cards. */
export async function commitWeeklyProgress(id: string, state: WeeklyState, outcomes: TaskOutcome[], tx: any,
  deferrals = new Map<string, string>(), jobIds: string[] = [], counts: Record<string, number> = {}) {
  const next = structuredClone(state);
  next.cycles += 1;
  next.totals ??= {};
  for (const [key, count] of Object.entries(counts)) next.totals[key] = (next.totals[key] ?? 0) + count;
  for (const search of next.searches) if (unfinished(search) && deferrals.has(search.task.source)) {
    search.reason = deferrals.get(search.task.source);
    search.state = 'cooldown';
  }
  for (const outcome of outcomes) {
    const search = next.searches.find((s) => s.task.task_id === outcome.taskId);
    if (!search) continue;
    if (outcome.status === 'Skipped' || outcome.executed === false) {
      search.reason = outcome.message;
      if (/cooldown|paused|allowance/i.test(outcome.message ?? '')) search.state = 'cooldown';
      continue;
    }
    search.visits += 1;
    search.quarantined = (search.quarantined ?? 0) + (outcome.quarantinedCandidates ?? 0);
    search.checked ||= Boolean(outcome.headChecked || outcome.status === 'Succeeded');
    if (outcome.nextCursor) {
      if (['linkedin', 'indeed'].includes(search.task.source)) search.task.offset = outcome.nextCursor.offset;
      else search.task.search_cursor = outcome.nextCursor;
    }
    if (outcome.status !== 'Succeeded') {
      search.failures = (search.failures ?? 0) + 1;
      search.reason = outcome.message ?? 'Search failed; continuation retained';
      search.state = ['rate_limit', 'blocked'].includes(outcome.errorKind ?? '') ? 'cooldown' : 'failed';
      search.retryAfter = new Date(Date.now() + 30 * 60_000).toISOString();
      if (search.failures >= loadConfig().searches.resilience.failure_threshold) {
        search.state = 'capped'; search.reason = `Automatic attempts stopped after ${search.failures} failures; cursor retained for review. ${search.reason}`;
      }
      continue;
    }
    search.state = 'pending'; delete search.retryAfter;
    if (!outcome.nextCursor && search.task.source === 'linkedin' && search.task.offset) {
      search.reason = 'Only the head was checked; saved backfill is still deferred';
      continue;
    }
    if (outcome.coverage === 'exhausted' && search.quarantined) {
      search.state = 'capped'; search.reason = 'Pages exhausted, but unprocessed candidates remain in diagnostics for review';
    } else if (outcome.coverage === 'exhausted') { search.state = 'exhausted'; delete search.reason; }
    else if (search.task.source === 'glassdoor' || !outcome.nextCursor ||
      outcome.nextCursor.offset === 0 || outcome.nextCursor.page === 1 && !outcome.nextCursor.index) {
      search.state = 'capped';
      search.reason = outcome.coverageReason ?? 'Adapter did not verify exhaustion or provide reliable continuation';
    } else search.reason = outcome.coverageReason ?? 'More pages remain within the requested interval';
    // A later one-request LinkedIn allowance must continue saved backfill.
    if (search.task.offset) search.task.head_only = false;
  }
  next.jobIds = [...new Set([...(state.jobIds ?? []), ...jobIds])];
  await tx.run(UPDATE(db().CollectionOperations).set({ weeklyState: JSON.stringify(next) }).where({ ID: id }));
}

export function publicationRange(date: string | null | undefined, range: { start: string; end: string }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(Date.parse(date))) return 'unknown';
  // Source date-only values cannot establish an exact time on either boundary day.
  if (date.length === 10) return date < range.start.slice(0, 10) || date > range.end.slice(0, 10) ? 'outside' :
    date === range.start.slice(0, 10) || date === range.end.slice(0, 10) ? 'boundary-day' : 'inside';
  return Date.parse(date) < Date.parse(range.start) || Date.parse(date) > Date.parse(range.end) ? 'outside' : 'inside';
}
