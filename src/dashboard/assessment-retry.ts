import { loadConfig, resetConfigCache } from '../config/index.js';
import { cds, db, SELECT, UPDATE } from '../db/index.js';
import { prescreen, assessWithRules } from '../matching/rules.js';
import { listingIsClosed } from '../persist/activity.js';
import { assessmentCacheKey } from '../pipeline/rank.js';
import { MAX_AI_ATTEMPTS, synchronizeAiQueue } from '../pipeline/ai-queue.js';
import { ApiError } from './errors.js';

export function eligibleForAiRetry(config: ReturnType<typeof loadConfig>, job: any): boolean {
  const rules = assessWithRules(config, job);
  return job.status !== 'Ignored' && !job.isDemo && Boolean(job.description?.trim()) && prescreen(config, job).passed &&
    !rules.hardReject && rules.fitScore >= config.scoring.thresholds.llm_screen_gate;
}

/** Requeue one failed input key; the next normal rank shares the five-call budget. */
export async function requeueAssessment(id: string) {
  resetConfigCache();
  const config = loadConfig();
  const job: any = await cds.run(SELECT.one.from(db().Jobs).where({ ID: id }));
  if (!job) throw new ApiError(404, 'Vacancy not found');
  if (!eligibleForAiRetry(config, job)) throw new ApiError(409, 'This vacancy is not eligible for AI assessment');
  const cacheKey = assessmentCacheKey(config, job, 'llm');
  await synchronizeAiQueue([{ jobId: id, cacheKey, rulesScore: assessWithRules(config, job).fitScore }], [id],
    (config.settings.llm.request_timeout_seconds + 60) * 1000);
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const current = await tx.run(SELECT.one.from(db().Jobs).where({ ID: id }));
    const listings = await tx.run(SELECT.from(db().SourceListings).where({ job_ID: id }));
    if (!current || !eligibleForAiRetry(config, current) || assessmentCacheKey(config, current, 'llm') !== cacheKey ||
      listings.length && listings.every((listing: any) => listingIsClosed(listing))) throw new ApiError(409, 'The vacancy changed or is no longer eligible');
    const work = await tx.run(SELECT.one.from(db().AiAssessmentQueue).where({ cacheKey }));
    if (work?.status === 'RetryPending') return { queued: true, alreadyQueued: true };
    if (!work || !['Failed', 'Rejected'].includes(work.status)) throw new ApiError(409, 'Only failed AI attempts can be requeued');
    if (work.attempts >= MAX_AI_ATTEMPTS) throw new ApiError(409, `The ${MAX_AI_ATTEMPTS}-attempt limit for these inputs has been reached`);
    if (work.retryAfter && new Date(work.retryAfter) > new Date()) throw new ApiError(409, `Provider cooldown lasts until ${work.retryAfter}`);
    await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'RetryPending', completedAt: null }).where({ cacheKey }));
    return { queued: true, alreadyQueued: false };
  });
}
