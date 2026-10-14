import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { collectorJobSchema, type CollectorTask, type TaskOutcome } from './types.js';
import { assessWithRules, prescreen } from '../matching/rules.js';
import { analyzeVacancy } from '../matching/analysis.js';
import { cds, db, INSERT, SELECT, UPDATE } from '../db/index.js';
import { planBatch, type PlanOptions, type PlannedBatch } from './plan.js';
import { expireListingDeadlines, listingIsClosed } from '../persist/activity.js';

const ACTIVITY_REFRESH_MS = 24 * 3_600_000;

const stateSchema = z.object({
  lastSource: z.string().nullable(),
  lastTaskBySource: z.record(z.string(), z.string()),
  lastSearchByScope: z.record(z.string(), z.string()).default({}),
  linkedinPending: z.array(z.custom<CollectorTask>()).default([]),
});

/** Reserve description slots atomically, before any network calls. */
export async function reserveBatchPlan(config: AppConfig, options: PlanOptions = {}): Promise<PlannedBatch> {
  await expireListingDeadlines(options.at);
  const batchKey = planBatch(config, options).batchKey;
  return cds.tx(async (tx: any) => {
    // Acquire the SQLite write lock before reading cursors in another process.
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const globalKey = '__all_batches__';
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
    const plan = planBatch(config, { ...options, batchKey, descriptionRotation: previous,
      globalLinkedin: options.globalLinkedin ?? (!options.batchKey && !options.onlySources?.length) });
    for (const tasks of plan.tasksBySource.values()) for (const task of tasks) {
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
      if (!saved || at.getTime() - lastActivity >= idleHours * 3_600_000) {
        const values = { state: '{}', sweepStartedAt: at.toISOString(), updatedAt: at.toISOString() };
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
    await reserveEnrichment(tx, config, plan, options.at ?? new Date());
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
export async function recordQueryRotation(plan: PlannedBatch, outcomes: TaskOutcome[]): Promise<void> {
  const executed = new Set(outcomes.filter((row) => row.status !== 'Skipped' && row.executed !== false).map((row) => row.taskId));
  if (!executed.size) return;
  await cds.tx(async (tx: any) => {
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
  });
}

/** Reuse the already selected description slots for enrichment and stale activity.
 * Reservations are persisted before I/O, so bad/missing detail pages cannot
 * monopolize the queue after a restart. No extra search or description task. */
async function reserveEnrichment(tx: any, config: AppConfig, plan: PlannedBatch, at: Date): Promise<void> {
  const replaySources = new Set(Object.entries(config.searches.sources)
    .filter(([, source]) => source.supports_backlog_enrichment).map(([source]) => source));
  if (![...plan.tasksBySource].some(([source, tasks]) => replaySources.has(source) && tasks.some((task) => task.fetch_description))) return;
  const stored = await tx.run(`SELECT * FROM sap_jobradar_Jobs WHERE COALESCE(isDemo, 0) = 0`);
  const eligible = new Map<string, any>();
  for (const job of stored) {
    if (job.status === 'Ignored') continue;
    const analysis = analyzeVacancy(config, job);
    if (prescreen(config, job, analysis).passed && !assessWithRules(config, job, analysis).hardReject) eligible.set(job.ID, job);
  }
  if (!eligible.size) return;
  for (const [source, tasks] of plan.tasksBySource) {
    // Glassdoor descriptions use JobSpy's search-session GraphQL cookies.
    // Retain that integration rather than treating its public HTML as details.
    if (!replaySources.has(source)) continue;
    const selected = tasks.filter((task) => task.fetch_description);
    if (!selected.length) continue;
    const listings = await tx.run(SELECT.from(db().SourceListings).where({ source, job_ID: { in: [...eligible.keys()] } }));
    const lastAttempt = (listing: any) => new Date(listing.activityAttemptedAt ?? listing.descriptionAttemptedAt ??
      listing.activityCheckedAt ?? listing.firstSeenAt).getTime();
    const reserved = (listing: any) => Number(Boolean(listing.activityAttemptedAt || listing.descriptionAttemptedAt));
    listings.sort((a: any, b: any) => lastAttempt(a) - lastAttempt(b) || reserved(a) - reserved(b) || a.ID.localeCompare(b.ID));
    const chosen = new Set<string>();
    for (const task of selected) {
      const cutoff = at.getTime() - task.hours_old * 3_600_000;
      // Keep part of each slot for newly discovered search results.
      const allowance = task.detail_request_limit ?? task.results_wanted;
      const capacity = task.enrich_only ? Math.min(10, allowance)
        : Math.min(5, Math.max(0, Math.floor(allowance / 2)));
      task.detail_jobs = [];
      if (!capacity) continue;
      for (const listing of listings) {
        if (listingIsClosed(listing, at) || chosen.has(listing.ID)) continue;
        const job = eligible.get(listing.job_ID)!;
        const refresh = Boolean(job.description?.trim());
        if (refresh) {
          const lastCheck = Math.max(...[listing.activityAttemptedAt, listing.activityCheckedAt, listing.firstSeenAt]
            .filter(Boolean).map((value) => new Date(value).getTime()));
          if (at.getTime() - lastCheck < ACTIVITY_REFRESH_MS) continue;
        } else if (new Date(listing.lastSeenAt).getTime() < cutoff ||
          job.datePosted && new Date(job.datePosted).getTime() < cutoff) continue;
        const raw = collectorJobSchema.parse(JSON.parse(listing.rawRecord));
        task.detail_jobs.push({ ...raw, job_url: listing.rawUrl ?? listing.canonicalUrl,
          ...(refresh ? { activity_refresh: true } : {}) });
        chosen.add(listing.ID);
        await tx.run(UPDATE(db().SourceListings).set({ activityAttemptedAt: at.toISOString(),
          ...(!refresh ? { descriptionAttemptedAt: at.toISOString() } : {}) }).where({ ID: listing.ID }));
        if (task.detail_jobs.length >= capacity) break;
      }
    }
  }
}

/** Persist completed/streamed search progress, including before a timeout. */
export async function recordSearchProgress(outcomes: TaskOutcome[], at = new Date()): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.headChecked) await cds.run(UPDATE(db().SearchProgress).set({ headCheckedAt: at.toISOString() }).where({ taskKey: outcome.taskId }));
    if (!outcome.nextCursor || outcome.status === 'Skipped' || outcome.status === 'Failed' && outcome.resultCount === 0) continue;
    const previous: any = await cds.run(SELECT.one.from(db().SearchProgress).where({ taskKey: outcome.taskId }));
    const reset = outcome.nextCursor.offset === 0 || (outcome.nextCursor.page === 1 && !outcome.nextCursor.index);
    const values = { state: JSON.stringify(outcome.nextCursor), updatedAt: at.toISOString(),
      sweepStartedAt: reset || !previous ? at.toISOString() : previous.sweepStartedAt };
    await cds.run(previous ? UPDATE(db().SearchProgress).set(values).where({ taskKey: outcome.taskId })
      : INSERT.into(db().SearchProgress).entries({ taskKey: outcome.taskId, ...values }));
  }
}
