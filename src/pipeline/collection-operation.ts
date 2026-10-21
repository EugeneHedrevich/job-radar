import { claimCollection, finishOperation, readOperation, startLeaseHeartbeat, updateOperation,
  type CollectionClaim } from '../collector/lease.js';
import { loadConfig } from '../config/index.js';
import { cds, db, SELECT, UPDATE, query } from '../db/index.js';
import { collect, outcomeMessage, type CollectOptions, type CollectSummary } from './collect.js';
import { rank, emptyRankProgress, type RankOptions, type RankedJob, type RankProgress } from './rank.js';
import { PENDING_AI_STATUSES } from './ai-queue.js';
import { log } from '../util/log.js';
import { createWeeklyState, extendWeeklyCatalogue, nextWeeklyResume, readWeeklyState, weeklyProgress } from './weekly.js';
import { hasPersonalTracking, vacancyRelevance } from '../matching/relevance.js';
import { jobText } from '../matching/signals.js';
import { patchRunDiagnostics } from '../dashboard/diagnostics.js';
import { ApiError } from '../dashboard/errors.js';
import { MAX_PERIOD_HOURS } from '../dashboard/types.js';

/** No notification path: a dashboard collection never sends Telegram. */
export async function collectAndAssess(claim: CollectionClaim, options: CollectOptions = {}) {
  return withCollectionOperation(claim, () => collect({ ...options, claim }),
    (summary, onProgress) => rank({ jobIds: [...new Set([...summary.ingest.jobIds, ...(options.weekly?.jobIds ?? [])])], includePendingAi: !options.fixture,
      rulesOnly: Boolean(options.fixture), ...(options.weekly ? { operationId: claim.operationId } : {}), onProgress }), Boolean(options.fixture));
}

/** One finalisation path for dashboard, scheduler and CLI; delivery is separate. */
export async function withCollectionOperation(claim: CollectionClaim, collectWork: () => Promise<CollectSummary>,
  assessWork: (summary: CollectSummary, report: NonNullable<RankOptions['onProgress']>) => Promise<RankedJob[]>, rulesOnly = false) {
  const stop = startLeaseHeartbeat(claim);
  let progress: RankProgress = emptyRankProgress();
  let runId: string | undefined;
  const began = performance.now();
  let assessingAt: number | undefined;
  try {
    const summary = await collectWork();
    runId = summary.runId;
    assessingAt = performance.now();
    await updateOperation(claim, { stage: 'Assessing', currentSource: null });
    await assessWork(summary, async (next) => {
      progress = next;
      await updateOperation(claim, { jobsAssessed: next.assessed, aiCalls: next.aiCalls,
        cachedAssessments: next.cachedAssessments, rulesAssessments: next.rulesAssessments,
        aiSucceeded: next.aiSucceeded, aiFailures: next.aiFailures, aiFailureReasons: next.failureReasons,
        assessmentRemaining: next.remaining ?? null });
    });
    const aiBacklog = (await query(SELECT.from(db().AiAssessmentQueue).where({ status: { in: PENDING_AI_STATUSES } }))).length;
    const config = loadConfig();
    const operation = await readOperation(claim.operationId);
    const aiBudgetExhausted = !rulesOnly && config.llmAvailable && aiBacklog > 0 &&
      (operation?.weekly ? (operation.aiCallsReserved ?? 0) >= (operation.aiCallLimit ?? 5) : progress.aiCalls >= Math.min(5, config.settings.llm.max_jobs_per_run));
    const weekly = await readWeeklyState(claim.operationId);
    if (weekly) {
      const jobs = weekly.jobIds?.length ? await query<any>(SELECT.from(db().Jobs).where({ ID: { in: weekly.jobIds } })) : [];
      weekly.relevantVacancies = jobs.filter((job) => vacancyRelevance(config, job).accepted).length;
      weekly.pendingDescriptions = jobs.filter((job) => job.status !== 'Ignored' &&
        (!job.enrichmentDeferredAt || job.manuallyImportedAt || hasPersonalTracking(job)) &&
        !jobText(job).hasDescription && vacancyRelevance(config, job).state !== 'irrelevant').length;
      weekly.deferredCandidates = (await query<any>(SELECT.from(db().CollectionRuns).columns('jobsDeferred').where({ operationId: claim.operationId })))
        .reduce((count, row) => count + (row.jobsDeferred ?? 0), 0);
      if (!weekly.assessedRuns?.includes(summary.runId)) {
        weekly.totals ??= {};
        for (const key of ['assessed', 'cachedAssessments', 'rulesAssessments', 'aiCalls', 'aiSucceeded', 'aiFailures'] as const)
          weekly.totals[key] = (weekly.totals[key] ?? 0) + progress[key];
        (weekly.assessedRuns ??= []).push(summary.runId);
      }
      await updateOperation(claim, { weeklyState: JSON.stringify(weekly) });
    }
    const coverage = weekly ? weeklyProgress(weekly) : null;
    let outcome = coverage && (coverage.deferred || coverage.limited || (coverage.unsupported ?? 0) || weekly?.deferredCandidates) && summary.outcome !== 'Failed' ? 'Partial' :
      progress.aiFailures && summary.outcome !== 'Failed' ? 'Partial' : summary.outcome;
    const localStartup = summary.outcomes.some((task) => task.errorKind === 'local_startup');
    const resumeAt = weekly?.automatic && !localStartup ? await nextWeeklyResume(config, weekly) : null;
    if (weekly && !resumeAt && !localStartup) outcome = coverage && (coverage.deferred || coverage.limited || coverage.unsupported || weekly.deferredCandidates || progress.aiFailures)
      ? 'Partial' : weekly.totals?.received ? 'Completed' : 'Empty';
    await patchRunDiagnostics(summary.runId, { assessment: { ...progress, aiBacklog, aiBudgetExhausted },
      assessingMs: Math.round(performance.now() - assessingAt), totalMs: Math.round(performance.now() - began),
      memoryEnd: process.memoryUsage() });
    await finishOperation(claim, { stage: resumeAt ? 'Waiting' : outcome === 'Failed' ? 'Error' : 'Finished', outcome: resumeAt ? 'Running' : outcome,
      resumeAt,
      jobsAssessed: progress.assessed, cachedAssessments: progress.cachedAssessments, rulesAssessments: progress.rulesAssessments,
      aiSucceeded: progress.aiSucceeded, aiFailures: progress.aiFailures, aiFailureReasons: progress.failureReasons,
      aiCalls: progress.aiCalls, aiBacklog, aiBudgetExhausted,
      assessmentRemaining: 0,
      message: `${coverage ? `Period search: ${coverage.checked}/${coverage.total} combinations checked; ${coverage.exhaustive} exhausted, ${coverage.deferred} deferred, ${coverage.limited} capped. ${resumeAt ? 'Cycle finished; waiting for scheduled continuation with the same dates and allowances.' : 'Operation finished; coverage limitations are retained.'}` : outcomeMessage(summary.outcome)}${progress.aiFailures ? ` ${progress.aiFailures} AI attempts failed; fallbacks saved. Retry can be queued in vacancy details.` : ''}` });
    return summary;
  } catch (error) {
    if (runId) await patchRunDiagnostics(runId, { assessment: progress, assessmentError: String(error),
      assessingMs: assessingAt ? Math.round(performance.now() - assessingAt) : null,
      totalMs: Math.round(performance.now() - began), memoryEnd: process.memoryUsage() }).catch(() => undefined);
    await finishOperation(claim, { stage: 'Error', outcome: 'Failed', aiFailureReasons: progress.failureReasons,
      message: String(error).slice(0, 1900) }).catch(() => undefined);
    throw error;
  } finally { await stop(); }
}

export async function startDashboardCollection(input: unknown = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Invalid collection options');
  const { mode, lookbackHours, automatic } = input as { mode?: unknown; lookbackHours?: unknown; automatic?: unknown };
  let { continueId } = input as { continueId?: unknown };
  if (mode !== undefined && !['rotation', 'weekly'].includes(String(mode)) ||
    continueId !== undefined && (typeof continueId !== 'string' || !/^[\da-f-]{36}$/i.test(continueId)))
    throw new ApiError(400, 'Use rotation or weekly collection and a valid continuation ID');
  if (lookbackHours !== undefined && (typeof lookbackHours !== 'number' || !Number.isInteger(lookbackHours) ||
    lookbackHours < 1 || lookbackHours > MAX_PERIOD_HOURS))
    throw new ApiError(400, `Choose a whole number of hours from 1 to ${MAX_PERIOD_HOURS} (up to one year)`);
  if (lookbackHours !== undefined && (mode !== 'weekly' || continueId))
    throw new ApiError(400, 'Choose a period when starting a new period search; continuation keeps its saved dates');
  if (automatic !== undefined && (typeof automatic !== 'boolean' || mode !== 'weekly'))
    throw new ApiError(400, 'Automatic continuation must be a boolean for a period search');
  const config = loadConfig({ reload: true });
  if (mode === 'weekly' && !continueId) {
    const pending = await query<any>(SELECT.from(db().CollectionOperations).where({ outcome: 'Running', pauseRequestedAt: null, weeklyState: { '!=': null } }).orderBy('startedAt asc'));
    const automatic = pending.find((row) => JSON.parse(row.weeklyState).automatic);
    if (automatic) return { operationId: automatic.ID, reused: true, operation: await readOperation(automatic.ID) };
  }
  if (continueId) {
    const prior = await readWeeklyState(String(continueId));
    if (!prior) throw new ApiError(404, 'Weekly operation not found');
    if (!weeklyProgress(prior).canContinue) throw new ApiError(409, 'No deferred weekly searches remain');
  }
  const began = new Date();
  const reservation = await claimCollection('dashboard', began, continueId as string | undefined);
  if (reservation.acquired) {
    try {
      const prior = continueId ? await readWeeklyState(String(continueId)) : null;
      const weekly = prior ? extendWeeklyCatalogue(config, prior) : mode === 'weekly' ? createWeeklyState(config, began, lookbackHours as number | undefined) : null;
      if (weekly) {
        weekly.automatic = (automatic as boolean | undefined) ?? prior?.automatic ?? false;
        const runs = await query<any>(SELECT.from(db().CollectionRuns).columns('diagnostics').where({ operationId: reservation.claim.operationId }));
        const spent = runs.reduce((count, row) => count + (JSON.parse(row.diagnostics ?? '{}').assessment?.aiCalls ?? 0), 0);
        if (!weekly.totals) {
          weekly.totals = {};
          for (const row of runs) {
            const prior = JSON.parse(row.diagnostics ?? '{}');
            const counters = { received: prior.counts?.received ?? 0, created: prior.ingest?.created ?? 0,
              updated: prior.ingest?.updatedJobIds?.length ?? 0, accepted: prior.ingest?.accepted ?? 0,
              filtered: prior.ingest?.filtered ?? 0, deferred: prior.ingest?.deferred ?? 0, ...prior.assessment };
            for (const [key, count] of Object.entries(counters)) if (typeof count === 'number') weekly.totals[key] = (weekly.totals[key] ?? 0) + count;
          }
        }
        const current = await readOperation(reservation.claim.operationId);
        await updateOperation(reservation.claim, { weeklyState: JSON.stringify(weekly),
          aiCallsReserved: Math.max(current?.aiCallsReserved ?? 0, spent), aiCallLimit: Math.min(current?.aiCallLimit ?? 5, 5, config.settings.llm.max_jobs_per_run) });
      }
      // Return the operation ID before invoking source adapters or AI.
      setImmediate(() => { void collectAndAssess(reservation.claim, weekly ? { weekly } : {}).catch((error) =>
        log.error('Dashboard collection failed', { message: String(error) })); });
    } catch (error) {
      await finishOperation(reservation.claim, { stage: 'Error', outcome: 'Failed', message: String(error).slice(0, 1900) });
      throw error;
    }
  }
  const operationId = reservation.acquired ? reservation.claim.operationId : reservation.operationId;
  return { operationId, reused: !reservation.acquired, operation: await readOperation(operationId) };
}

/** Pausing never requests source I/O, refunds usage, or interrupts saved-result commits. */
export async function pausePeriodCollection(id: string) {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new ApiError(400, 'Invalid operation ID');
  await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const operation = await tx.run(SELECT.one.from(db().CollectionOperations).where({ ID: id }));
    if (!operation?.weeklyState) throw new ApiError(404, 'Period search not found');
    if (!weeklyProgress(JSON.parse(operation.weeklyState)).canContinue) throw new ApiError(409, 'No remaining searches to pause');
    const lease = await tx.run(SELECT.one.from(db().CollectionLease).where({ name: 'collection' }));
    const executing = lease?.operation_ID === id && lease.token && Date.parse(lease.expiresAt) > Date.now();
    const now = new Date().toISOString();
    await tx.run(UPDATE(db().CollectionOperations).set({ pauseRequestedAt: operation.pauseRequestedAt ?? now,
      resumeAt: null, updatedAt: now,
      ...(!executing ? { stage: 'Paused', outcome: 'Partial', finishedAt: now } : {}),
      message: executing ? 'Pausing after the current batch saves its results. No further batches will be scheduled.'
        : 'Search paused. Saved dates and progress retained; resume explicitly to continue.' }).where({ ID: id }));
  });
  return readOperation(id);
}

/** Called by the existing scheduler, including after restart. The lease rechecks due time atomically. */
export async function resumePeriodCollection(at = new Date()): Promise<boolean> {
  await readOperation(); // recover an expired execution lease without resetting source reservations
  at = new Date(Math.max(at.getTime(), Date.now())); // recovery may have just made an operation eligible
  const waiting = await query<any>(SELECT.from(db().CollectionOperations).where({ stage: 'Waiting', outcome: 'Running', pauseRequestedAt: null, resumeAt: { '<=': at.toISOString() } }).orderBy('resumeAt asc'));
  for (const operation of waiting) {
    const state = await readWeeklyState(operation.ID);
    if (!state?.automatic) continue;
    const reservation = await claimCollection('period-continuation', at, operation.ID, true);
    if (!reservation.acquired) return false;
    await collectAndAssess(reservation.claim, { weekly: state });
    return true; // one bounded cycle per scheduler tick; never calls notify
  }
  return false;
}
