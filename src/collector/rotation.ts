import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { collectorJobSchema, type CollectorTask, type TaskOutcome } from './types.js';
import { assessWithRules, prescreen } from '../matching/rules.js';
import { analyzeVacancy } from '../matching/analysis.js';
import { cds, db, INSERT, SELECT, UPDATE } from '../db/index.js';
import { planBatch, searchQueryKey, type PlanOptions, type PlannedBatch } from './plan.js';
import { expireListingDeadlines, listingIsClosed } from '../persist/activity.js';
import { descriptionPriority, hasPersonalTracking } from '../matching/relevance.js';
import { maintainPendingCandidates } from '../persist/ingest.js';
import { jobText } from '../matching/signals.js';

const ACTIVITY_REFRESH_MS = 24 * 3_600_000;

const stateSchema = z.object({
  enrichmentScanByScope: z.record(z.string(), z.string()).optional(),
  lastSource: z.string().nullable(),
  lastTaskBySource: z.record(z.string(), z.string()),
  lastSearchByScope: z.record(z.string(), z.string()).default({}),
  linkedinPending: z.array(z.custom<CollectorTask>()).default([]),
});

/** Reserve description slots atomically, before any network calls. */
export async function reserveBatchPlan(config: AppConfig, options: PlanOptions = {}): Promise<PlannedBatch> {
  const timings = options.preparationTimings ?? {};
  let checkpoint = performance.now();
  await expireListingDeadlines(options.at);
  timings.expireListingDeadlines = Math.round(performance.now() - checkpoint);
  const batchKey = planBatch(config, options).batchKey;
  const waitingAt = performance.now();
  return cds.tx(async (tx: any) => {
    // Acquire the SQLite write lock before reading cursors in another process.
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    timings.acquirePlanningLock = Math.round(performance.now() - waitingAt);
    await maintainPendingCandidates(tx, options.at ?? new Date());
    const globalKey = '__all_batches__';
    checkpoint = performance.now();
    const existing = await tx.run(SELECT.one.from(db().DescriptionRotation).where({ batchKey: globalKey }));
    let previous = existing ? stateSchema.parse(JSON.parse(existing.state)) : undefined;
    if (!previous) {
      // Retain keyword progress from the earlier per-batch state format.
      previous = { lastSource: null, lastTaskBySource: {}, lastSearchByScope: {}, linkedinPending: [] };
      for (const row of await tx.run(SELECT.from(db().DescriptionRotation))) {
        const old = stateSchema.parse(JSON.parse(row.state));
        for (const [source, cursor] of Object.entries(old.lastTaskBySource)) {
          previous.lastTaskBySource[`${row.batchKey}:${source}`] = cursor;
        }
      }
    }
    timings.readRotation = Math.round(performance.now() - checkpoint); checkpoint = performance.now();
    const plan = planBatch(config, { ...options, ...(!options.searchTasks ? { batchKey } : {}), descriptionRotation: previous,
      globalLinkedin: options.globalLinkedin ?? (!options.batchKey && !options.onlySources?.length) });
    timings.plan = Math.round(performance.now() - checkpoint); checkpoint = performance.now();
    for (const tasks of plan.tasksBySource.values()) for (const task of tasks) {
      if (options.searchTasks) continue; // Weekly cursors belong to the frozen operation.
      if (task.enrich_only) continue;
      const saved = await tx.run(SELECT.one.from(db().SearchProgress).where({ taskKey: task.task_id }));
      const at = options.at ?? new Date();
      // Expire abandoned cursors, not ongoing sweeps. A normal visit can be
      // 108 hours apart; successful head-only visits also verify activity.
      const rotationHours = config.searches.rotation.interval_hours *
        (config.searches.rotation.sequence ?? config.searches.rotation.batches).length;
      const idleHours = Math.max(task.hours_old, rotationHours * 2);
      const lastActivity = saved ? Math.max(new Date(saved.updatedAt).getTime(),
        saved.headCheckedAt ? new Date(saved.headCheckedAt).getTime() : 0) : 0;
      const queryKey = searchQueryKey(task);
      if (saved?.queryKey === queryKey) {
        if (saved.headCheckedAt) task.hours_old = Math.max(task.hours_old, Math.min(task.hours_old + config.searches.coverage.catch_up_hours,
          Math.ceil((at.getTime() - Date.parse(saved.headCheckedAt)) / 3_600_000)));
        if (saved.failedAt) task.hours_old += Math.min(config.searches.coverage.catch_up_hours,
          Math.max(0, Math.ceil((at.getTime() - new Date(saved.failedAt).getTime()) / 3_600_000)));
        if (((saved.successfulVisits ?? 0) + 1) % config.searches.coverage.older_scan_every === 0)
          task.hours_old = Math.max(task.hours_old, config.searches.coverage.older_scan_hours);
      }
      if (!saved || saved.queryKey !== queryKey || at.getTime() - lastActivity >= idleHours * 3_600_000) {
        const values = { state: '{}', queryKey, sweepStartedAt: at.toISOString(), updatedAt: at.toISOString(),
          ...(saved?.queryKey !== queryKey ? { headCheckedAt: null, failedAt: null, successfulVisits: 0 } : {}) };
        await tx.run(saved ? UPDATE(db().SearchProgress).set(values).where({ taskKey: task.task_id })
          : INSERT.into(db().SearchProgress).entries({ taskKey: task.task_id, ...values }));
        continue;
      }
      const cursor = JSON.parse(saved.state);
      if (['linkedin', 'indeed'].includes(task.source)) {
        if (cursor.offset > 0 && cursor.offset < (task.source === 'linkedin' ? 1000 : 300)) task.offset = cursor.offset;
        // Decide head/backfill again in Python using the actual allocated allowance.
        if (task.offset) task.head_only = !saved.headCheckedAt ||
          new Date(saved.headCheckedAt).getTime() <= new Date(saved.updatedAt).getTime();
      } else task.search_cursor = cursor;
    }
    timings.searchCursors = Math.round(performance.now() - checkpoint);
    await reserveEnrichment(tx, config, plan, options.at ?? new Date(), timings);
    if (options.enrichOnly) {
      for (const [source, tasks] of plan.tasksBySource) {
        const ready = tasks.filter((task) => task.detail_jobs?.length);
        if (ready.length) plan.tasksBySource.set(source, ready);
        else plan.tasksBySource.delete(source);
      }
    }
    const values = { state: JSON.stringify({ ...plan.descriptionRotation,
      lastSearchByScope: previous.lastSearchByScope }), updatedAt: new Date().toISOString() };
    await tx.run(existing
      ? UPDATE(db().DescriptionRotation).set(values).where({ batchKey: globalKey })
      : INSERT.into(db().DescriptionRotation).entries({ batchKey: globalKey, ...values }));
    return plan;
  });
}

/** A skipped combination stays at the front of the next plan, even if later tasks ran. */
export async function recordQueryRotation(plan: PlannedBatch, outcomes: TaskOutcome[], connection?: any): Promise<void> {
  const executed = new Set(outcomes.filter((row) => row.status !== 'Skipped' && row.executed !== false).map((row) => row.taskId));
  if (!executed.size) return;
  if (!connection) return cds.tx((tx: any) => recordQueryRotation(plan, outcomes, tx));
  const tx = connection;
  await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
  const row = await tx.run(SELECT.one.from(db().DescriptionRotation).where({ batchKey: '__all_batches__' }));
  if (!row) return;
  const state = stateSchema.parse(JSON.parse(row.state));
  for (const [scope, tasks] of Object.entries(plan.searchRotation)) {
    for (const task of tasks) {
      if (!executed.has(task)) break;
      state.lastSearchByScope[scope] = task;
      if (scope.endsWith(':linkedin')) state.lastSearchByScope[`${task.split(':')[0]}:linkedin`] = task;
    }
  }
  await tx.run(UPDATE(db().DescriptionRotation).set({ state: JSON.stringify(state), updatedAt: new Date().toISOString() })
    .where({ batchKey: '__all_batches__' }));
}

/** Reuse the already selected description slots for enrichment and stale activity.
 * Reservations are persisted before I/O, so bad/missing detail pages cannot
 * monopolize the queue after a restart. No extra search or description task. */
async function reserveEnrichment(tx: any, config: AppConfig, plan: PlannedBatch, at: Date, timings: Record<string, number>): Promise<void> {
  const replaySources = new Set(Object.entries(config.searches.sources)
    .filter(([, source]) => source.supports_backlog_enrichment).map(([source]) => source));
  if (![...plan.tasksBySource].some(([source, tasks]) => replaySources.has(source) && tasks.some((task) => task.fetch_description))) return;
  const began = performance.now();
  const sources = [...plan.tasksBySource].filter(([source, tasks]) => replaySources.has(source) && tasks.some((t) => t.fetch_description)).map(([source]) => source);
  const allListings = await tx.run(SELECT.from(db().SourceListings).where({ source: { in: sources } }));
  const ids = [...new Set(allListings.map((listing: any) => listing.job_ID))];
  if (!ids.length) return;
  const stored = await tx.run(SELECT.from(db().Jobs).where({ ID: { in: ids }, isDemo: false, status: { '!=': 'Ignored' } }));
  const jobs = new Map<string, any>(stored.filter((job: any) => !job.enrichmentDeferredAt || job.manuallyImportedAt || hasPersonalTracking(job)).map((job: any) => [job.ID, job]));
  const described = new Map<string, boolean>(stored.map((job: any) => [job.ID, jobText(job).hasDescription]));
  const eligible = new Map<string, boolean>();
  const pending = new Set<string>();
  timings.enrichmentReads = Math.round(performance.now() - began);
  let analysisMs = 0;
  for (const [source, tasks] of plan.tasksBySource) {
    // Glassdoor descriptions use JobSpy's search-session GraphQL cookies.
    // Retain that integration rather than treating its public HTML as details.
    if (!replaySources.has(source)) continue;
    const selected = tasks.filter((task) => task.fetch_description);
    if (!selected.length) continue;
    const listings = allListings.filter((listing: any) => listing.source === source && jobs.has(listing.job_ID) && !listingIsClosed(listing, at));
    const lastAttempt = (listing: any) => new Date(listing.activityAttemptedAt ?? listing.descriptionAttemptedAt ??
      listing.activityCheckedAt ?? listing.firstSeenAt).getTime();
    const reserved = (listing: any) => Number(Boolean(listing.activityAttemptedAt || listing.descriptionAttemptedAt));
    const priority = (listing: any) => {
      const job = jobs.get(listing.job_ID)!;
      return Number(described.get(job.ID)) * 3 + descriptionPriority(config, { title: job.title });
    };
    const priorities = new Map<string, number>(listings.map((listing: any) => [listing.ID, priority(listing)]));
    listings.sort((a: any, b: any) => priorities.get(a.ID)! - priorities.get(b.ID)! || lastAttempt(a) - lastAttempt(b) || reserved(a) - reserved(b) || a.ID.localeCompare(b.ID));
    const scans = plan.descriptionRotation.enrichmentScanByScope ??= {};
    const scanOrder = [...new Set<number>(priorities.values())].sort((a, b) => a - b).flatMap((rank) => {
      const group = listings.filter((listing: any) => priorities.get(listing.ID) === rank);
      const after = group.findIndex((listing: any) => listing.ID === scans[`${source}:${rank}`]);
      return [...group.slice(after + 1), ...group.slice(0, after + 1)];
    }).slice(0, 40);
    const chosen = new Set<string>();
    for (const task of selected) {
      const cutoff = at.getTime() - task.hours_old * 3_600_000;
      // Keep part of each slot for newly discovered search results.
      const allowance = task.detail_request_limit ?? task.results_wanted;
      const capacity = task.enrich_only ? Math.min(10, allowance)
        : Math.min(5, Math.max(0, Math.floor(allowance / 2)));
      task.detail_jobs = [];
      if (!capacity) continue;
      for (const listing of scanOrder) {
        if (listingIsClosed(listing, at) || chosen.has(listing.ID)) continue;
        const job = jobs.get(listing.job_ID)!;
        if ((priorities.get(listing.ID) ?? 9) >= 9) continue;
        scans[`${source}:${priorities.get(listing.ID)}`] = listing.ID;
        if (!eligible.has(job.ID)) {
          const start = performance.now();
          const analysis = analyzeVacancy(config, job);
          if (analysis.relevance.state === 'unresolved') pending.add(job.ID);
          eligible.set(job.ID, analysis.relevance.state === 'unresolved' ||
            prescreen(config, job, analysis).passed && !assessWithRules(config, job, analysis).hardReject);
          analysisMs += performance.now() - start;
        }
        if (!eligible.get(job.ID)) continue;
        const refresh = Boolean(described.get(job.ID));
        const old = new Date(listing.lastSeenAt).getTime() < cutoff ||
          Boolean(job.datePosted && new Date(job.datePosted).getTime() < cutoff);
        if (refresh) {
          const lastCheck = Math.max(...[listing.activityAttemptedAt, listing.activityCheckedAt, listing.firstSeenAt]
            .filter(Boolean).map((value) => new Date(value).getTime()));
          if (at.getTime() - lastCheck < ACTIVITY_REFRESH_MS) continue;
        } else if (old && !pending.has(job.ID)) continue;
        const raw = collectorJobSchema.parse(JSON.parse(listing.rawRecord));
        task.detail_jobs.push({ ...raw, job_url: listing.rawUrl ?? listing.canonicalUrl,
          ...(!refresh ? { description: null } : {}),
          ...(refresh || old && pending.has(job.ID) ? { activity_refresh: true } : {}) });
        chosen.add(listing.ID);
        await tx.run(UPDATE(db().SourceListings).set({ activityAttemptedAt: at.toISOString(),
          ...(!refresh ? { descriptionAttemptedAt: at.toISOString() } : {}) }).where({ ID: listing.ID }));
        if (task.detail_jobs.length >= capacity) break;
      }
    }
  }
  timings.enrichmentAnalysis = Math.round(analysisMs);
  timings.reserveEnrichment = Math.round(performance.now() - began);
}

/** Persist verified/streamed progress in the transaction that saves its records. */
export async function recordSearchProgress(outcomes: TaskOutcome[], at = new Date(), connection: any = cds): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.status === 'Skipped' || outcome.taskId.startsWith('description-backlog:')) continue;
    const existing: any = await connection.run(SELECT.one.from(db().SearchProgress).where({ taskKey: outcome.taskId }));
    const cursor = existing ? JSON.parse(existing.state) : {};
    const hasBackfill = cursor.offset > 0 || cursor.page > 1 || cursor.index > 0;
    const recovered = outcome.status === 'Succeeded' && (outcome.nextCursor || outcome.headChecked && !hasBackfill);
    if (existing) await connection.run(UPDATE(db().SearchProgress).set({
      failedAt: outcome.status === 'Failed' ? existing.failedAt ?? at.toISOString() : recovered ? null : existing.failedAt,
      successfulVisits: (existing.successfulVisits ?? 0) + Number(outcome.status === 'Succeeded' && Boolean(outcome.headChecked)),
    }).where({ taskKey: outcome.taskId }));
    if (outcome.headChecked) await connection.run(UPDATE(db().SearchProgress).set({ headCheckedAt: at.toISOString() }).where({ taskKey: outcome.taskId }));
    if (!outcome.nextCursor || outcome.status === 'Failed' && outcome.resultCount === 0) continue;
    const previous: any = await connection.run(SELECT.one.from(db().SearchProgress).where({ taskKey: outcome.taskId }));
    const reset = outcome.nextCursor.offset === 0 || (outcome.nextCursor.page === 1 && !outcome.nextCursor.index);
    const values = { state: JSON.stringify(outcome.nextCursor), updatedAt: at.toISOString(),
      sweepStartedAt: reset || !previous ? at.toISOString() : previous.sweepStartedAt };
    await connection.run(previous ? UPDATE(db().SearchProgress).set(values).where({ taskKey: outcome.taskId })
      : INSERT.into(db().SearchProgress).entries({ taskKey: outcome.taskId, ...values }));
  }
}
