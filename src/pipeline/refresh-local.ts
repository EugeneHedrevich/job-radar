import { loadConfig } from '../config/index.js';
import { cds, db, SELECT, UPDATE, query } from '../db/index.js';
import { claimCollection, CollectionBusyError, finishOperation, startLeaseHeartbeat, updateOperation } from '../collector/lease.js';
import { normalizeJob, extractCountry } from '../normalize/index.js';
import { descriptionPriority, vacancyRelevance } from '../matching/relevance.js';
import { ingestJobs } from '../persist/ingest.js';
import { assessmentCacheKey, refreshDeterministicAssessments } from './rank.js';

/** Recover recorded false exclusions and refresh local rules. Never calls an adapter or AI. */
export async function refreshSavedVacancies() {
  const reservation = await claimCollection('local-rules-refresh');
  if (!reservation.acquired) throw new CollectionBusyError(reservation.operationId);
  const claim = reservation.claim, stop = startLeaseHeartbeat(claim);
  let restored = 0, countries = 0;
  try {
    const config = loadConfig();
    const existing = await query<any>(SELECT.from(db().SourceListings).columns('source', 'canonicalUrl'));
    const known = new Set(existing.map((row) => `${row.source}:${row.canonicalUrl}`));
    const runs = await query<any>(SELECT.from(db().CollectionRuns).columns('ID', 'startedAt', 'diagnostics').orderBy('startedAt asc'));
    for (const run of runs) {
      const candidates = JSON.parse(run.diagnostics ?? '{}').candidates ?? [];
      const recover = candidates.filter((item: any) => item.relevance?.state === 'irrelevant' && !item.exclusion && item.job)
        .map((item: any) => normalizeJob(item.job, item.source)).filter(Boolean)
        .filter((job: any) => vacancyRelevance(config, job).state !== 'irrelevant')
        .sort((a: any, b: any) => descriptionPriority(config, a) - descriptionPriority(config, b));
      for (const job of recover) {
        const key = `${job.listing.source}:${job.listing.canonicalUrl}`;
        if (known.has(key)) continue;
        const result = await ingestJobs([job], { runId: run.ID, seenAt: new Date(run.startedAt), automatic: true });
        if (result.accepted) { known.add(key); restored += result.created; }
      }
    }
    await updateOperation(claim, { stage: 'Assessing', jobsNew: restored });
    const jobs = await query<any>(SELECT.from(db().Jobs));
    for (const job of jobs) {
      if (!job.locationCountry) {
        const country = extractCountry(job.location);
        if (country) { await cds.run(UPDATE(db().Jobs).set({ locationCountry: country }).where({ ID: job.ID })); countries++; job.locationCountry = country; }
      }
      // Preserve past attempts while preventing obsolete queued inputs from being paid for.
      await cds.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded' }).where({ job_ID: job.ID,
        status: { in: ['Pending', 'RetryPending'] }, cacheKey: { '!=': assessmentCacheKey(config, job, 'llm') } }));
    }
    const assessments = await refreshDeterministicAssessments();
    await finishOperation(claim, { stage: 'Finished', outcome: 'Completed', jobsNew: restored,
      jobsAssessed: assessments, rulesAssessments: assessments, aiCalls: 0,
      message: `Local refresh: ${restored} recovered vacancies, ${countries} corrected countries, ${assessments} new rules assessments. No upstream requests.` });
    return { restored, countries, assessments, aiCalls: 0, sourceRequests: 0 };
  } catch (error) {
    await finishOperation(claim, { stage: 'Error', outcome: 'Failed', message: String(error).slice(0, 1900) }).catch(() => undefined);
    throw error;
  } finally { await stop(); }
}
