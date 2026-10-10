import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { collectorJobSchema } from './types.js';
import { assessWithRules, prescreen } from '../matching/rules.js';
import { cds, db, INSERT, SELECT, UPDATE } from '../db/index.js';
import { planBatch, type PlanOptions, type PlannedBatch } from './plan.js';
import { expireListingDeadlines, listingIsClosed } from '../persist/activity.js';

const ACTIVITY_REFRESH_MS = 24 * 3_600_000;

const stateSchema = z.object({
  lastSource: z.string().nullable(),
  lastTaskBySource: z.record(z.string(), z.string()),
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
      previous = { lastSource: null, lastTaskBySource: {} };
      for (const row of await tx.run(SELECT.from(db().DescriptionRotation))) {
        const old = stateSchema.parse(JSON.parse(row.state));
        for (const [source, cursor] of Object.entries(old.lastTaskBySource)) {
          previous.lastTaskBySource[`${row.batchKey}:${source}`] = cursor;
        }
      }
    }
    const plan = planBatch(config, { ...options, batchKey, descriptionRotation: previous });
    await reserveEnrichment(tx, config, plan, options.at ?? new Date());
    if (options.enrichOnly) {
      for (const [source, tasks] of plan.tasksBySource) {
        const ready = tasks.filter((task) => task.detail_jobs?.length);
        if (ready.length) plan.tasksBySource.set(source, ready);
        else plan.tasksBySource.delete(source);
      }
    }
    const values = { state: JSON.stringify(plan.descriptionRotation), updatedAt: new Date().toISOString() };
    await tx.run(existing
      ? UPDATE(db().DescriptionRotation).set(values).where({ batchKey: globalKey })
      : INSERT.into(db().DescriptionRotation).entries({ batchKey: globalKey, ...values }));
    return plan;
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
    if (prescreen(config, job).passed && !assessWithRules(config, job).hardReject) eligible.set(job.ID, job);
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
      const capacity = task.enrich_only ? Math.min(10, task.results_wanted)
        : Math.min(5, Math.max(1, Math.floor(task.results_wanted / 2)));
      task.detail_jobs = [];
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
