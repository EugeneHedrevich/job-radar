import { claimCollection, finishOperation, readOperation, startLeaseHeartbeat, updateOperation,
  type CollectionClaim } from '../collector/lease.js';
import { loadConfig } from '../config/index.js';
import { db, SELECT, query } from '../db/index.js';
import { collect, outcomeMessage, type CollectOptions, type CollectSummary } from './collect.js';
import { rank, emptyRankProgress, type RankOptions, type RankedJob, type RankProgress } from './rank.js';
import { PENDING_AI_STATUSES } from './ai-queue.js';
import { log } from '../util/log.js';

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
  try {
    const summary = await collectWork();
    await updateOperation(claim, { stage: 'Assessing' });
    await assessWork(summary, async (next) => {
      progress = next;
      await updateOperation(claim, { jobsAssessed: next.assessed, aiCalls: next.aiCalls,
        cachedAssessments: next.cachedAssessments, rulesAssessments: next.rulesAssessments,
        aiSucceeded: next.aiSucceeded, aiFailures: next.aiFailures, aiFailureReasons: next.failureReasons });
    });
    const aiBacklog = (await query(SELECT.from(db().AiAssessmentQueue).where({ status: { in: PENDING_AI_STATUSES } }))).length;
    const config = loadConfig();
    const aiBudgetExhausted = !rulesOnly && config.llmAvailable && aiBacklog > 0 &&
      progress.aiCalls >= Math.min(5, config.settings.llm.max_jobs_per_run);
    const outcome = progress.aiFailures && summary.outcome !== 'Failed' ? 'Partial' : summary.outcome;
    await finishOperation(claim, { stage: outcome === 'Failed' ? 'Error' : 'Finished', outcome,
      jobsAssessed: progress.assessed, cachedAssessments: progress.cachedAssessments, rulesAssessments: progress.rulesAssessments,
      aiSucceeded: progress.aiSucceeded, aiFailures: progress.aiFailures, aiFailureReasons: progress.failureReasons,
      aiCalls: progress.aiCalls, aiBacklog, aiBudgetExhausted,
      message: `${outcomeMessage(summary.outcome)}${progress.aiFailures ? ` ${progress.aiFailures} AI attempts failed; fallbacks saved. Retry can be queued in vacancy details.` : ''}` });
    return summary;
  } catch (error) {
    await finishOperation(claim, { stage: 'Error', outcome: 'Failed', aiFailureReasons: progress.failureReasons,
      message: String(error).slice(0, 1900) }).catch(() => undefined);
    throw error;
  } finally { await stop(); }
}

export async function startDashboardCollection() {
  const reservation = await claimCollection('dashboard');
  if (reservation.acquired) {
    // Return the operation ID before invoking source adapters or AI.
    setImmediate(() => { void collectAndAssess(reservation.claim).catch((error) =>
      log.error('Dashboard collection failed', { message: String(error) })); });
  }
  const operationId = reservation.acquired ? reservation.claim.operationId : reservation.operationId;
  return { operationId, reused: !reservation.acquired, operation: await readOperation(operationId) };
}
