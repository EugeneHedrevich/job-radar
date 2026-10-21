import { claimCollection, finishOperation, readOperation, startLeaseHeartbeat, updateOperation,
  type CollectionClaim } from '../collector/lease.js';
import { loadConfig } from '../config/index.js';
import { db, SELECT, query } from '../db/index.js';
import { collect, outcomeMessage, type CollectOptions, type CollectSummary } from './collect.js';
import { rank, emptyRankProgress, type RankOptions, type RankedJob, type RankProgress } from './rank.js';
import { PENDING_AI_STATUSES } from './ai-queue.js';
import { log } from '../util/log.js';
import { createWeeklyState, extendWeeklyCatalogue, readWeeklyState, weeklyProgress } from './weekly.js';
import { vacancyRelevance } from '../matching/relevance.js';
import { jobText } from '../matching/signals.js';
import { patchRunDiagnostics } from '../dashboard/diagnostics.js';
import { ApiError } from '../dashboard/errors.js';

/** No notification path: a dashboard collection never sends Telegram. */
export async function collectAndAssess(claim: CollectionClaim, options: CollectOptions = {}) {
  return withCollectionOperation(claim, () => collect({ ...options, claim }),
    (summary, onProgress) => rank({ jobIds: summary.ingest.jobIds, includePendingAi: !options.fixture,
      rulesOnly: Boolean(options.fixture), onProgress }), Boolean(options.fixture));
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
    const aiBudgetExhausted = !rulesOnly && config.llmAvailable && aiBacklog > 0 &&
      progress.aiCalls >= Math.min(5, config.settings.llm.max_jobs_per_run);
    const weekly = await readWeeklyState(claim.operationId);
    if (weekly) {
      const jobs = weekly.jobIds?.length ? await query<any>(SELECT.from(db().Jobs).where({ ID: { in: weekly.jobIds } })) : [];
      weekly.relevantVacancies = jobs.filter((job) => vacancyRelevance(config, job).accepted).length;
      weekly.pendingDescriptions = jobs.filter((job) => !jobText(job).hasDescription && vacancyRelevance(config, job).state !== 'irrelevant').length;
      await updateOperation(claim, { weeklyState: JSON.stringify(weekly) });
    }
    const coverage = weekly ? weeklyProgress(weekly) : null;
    const outcome = coverage && (coverage.deferred || coverage.limited) && summary.outcome !== 'Failed' ? 'Partial' :
      progress.aiFailures && summary.outcome !== 'Failed' ? 'Partial' : summary.outcome;
    await patchRunDiagnostics(summary.runId, { assessment: { ...progress, aiBacklog, aiBudgetExhausted },
      assessingMs: Math.round(performance.now() - assessingAt), totalMs: Math.round(performance.now() - began),
      memoryEnd: process.memoryUsage() });
    await finishOperation(claim, { stage: outcome === 'Failed' ? 'Error' : 'Finished', outcome,
      jobsAssessed: progress.assessed, cachedAssessments: progress.cachedAssessments, rulesAssessments: progress.rulesAssessments,
      aiSucceeded: progress.aiSucceeded, aiFailures: progress.aiFailures, aiFailureReasons: progress.failureReasons,
      aiCalls: progress.aiCalls, aiBacklog, aiBudgetExhausted,
      assessmentRemaining: 0,
      message: `${coverage ? `Weekly interval: ${coverage.checked}/${coverage.total} combinations checked; ${coverage.exhaustive} exhausted, ${coverage.deferred} deferred, ${coverage.limited} limited. Continue uses the same dates and existing allowances.` : outcomeMessage(summary.outcome)}${progress.aiFailures ? ` ${progress.aiFailures} AI attempts failed; fallbacks saved. Retry can be queued in vacancy details.` : ''}` });
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
  const { mode, continueId } = input as { mode?: unknown; continueId?: unknown };
  if (mode !== undefined && !['rotation', 'weekly'].includes(String(mode)) ||
    continueId !== undefined && (typeof continueId !== 'string' || !/^[\da-f-]{36}$/i.test(continueId)))
    throw new ApiError(400, 'Use rotation or weekly collection and a valid continuation ID');
  const config = loadConfig({ reload: true });
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
      const weekly = prior ? extendWeeklyCatalogue(config, prior) : mode === 'weekly' ? createWeeklyState(config, began) : null;
      if (weekly) await updateOperation(reservation.claim, { weeklyState: JSON.stringify(weekly) });
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
