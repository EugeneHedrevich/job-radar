import { claimCollection, finishOperation, readOperation, startLeaseHeartbeat, updateOperation,
  type CollectionClaim } from '../collector/lease.js';
import { loadConfig } from '../config/index.js';
import { db, SELECT, query } from '../db/index.js';
import { collect, outcomeMessage, type CollectOptions } from './collect.js';
import { rank } from './rank.js';
import { log } from '../util/log.js';

/** No notification path: a dashboard collection never sends Telegram. */
export async function collectAndAssess(claim: CollectionClaim, options: CollectOptions = {}) {
  const stop = startLeaseHeartbeat(claim);
  try {
    const summary = await collect({ ...options, claim });
    await updateOperation(claim, { stage: 'Assessing' });
    let aiCalls = 0, aiFailures = 0;
    await rank({ jobIds: summary.ingest.jobIds, includePendingAi: !options.fixture, rulesOnly: Boolean(options.fixture),
      onProgress: async (progress) => {
        aiCalls = progress.aiCalls; aiFailures = progress.aiFailures;
        await updateOperation(claim, { jobsAssessed: progress.assessed, aiCalls });
      } });
    const aiBacklog = (await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).length;
    const config = loadConfig();
    const aiBudgetExhausted = !options.fixture && config.llmAvailable && aiBacklog > 0 &&
      aiCalls >= Math.min(5, config.settings.llm.max_jobs_per_run);
    const outcome = aiFailures && ['Completed', 'Empty'].includes(summary.outcome) ? 'Partial' : summary.outcome;
    await finishOperation(claim, { stage: outcome === 'Failed' ? 'Error' : 'Finished', outcome,
      aiCalls, aiBacklog, aiBudgetExhausted, message: `${outcomeMessage(summary.outcome)}${aiFailures ? ' AI failed; rules fallback saved.' : ''}` });
    return summary;
  } catch (error) {
    await finishOperation(claim, { stage: 'Error', outcome: 'Failed', message: String(error).slice(0, 1900) }).catch(() => undefined);
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
