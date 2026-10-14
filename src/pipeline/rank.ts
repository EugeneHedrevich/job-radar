import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../config/index.js';
import { cds, db, SELECT, INSERT, UPDATE, query, queryOne } from '../db/index.js';
import { assessWithLlm, LlmProviderError, LlmRejectedOutputError } from '../matching/llm.js';
import { assessWithRules, prescreen } from '../matching/rules.js';
import { analyzeVacancy } from '../matching/analysis.js';
import type { AssessmentResult, MatchableJob } from '../matching/types.js';
import { normalizeText, sha256 } from '../util/text.js';
import { log } from '../util/log.js';
import { closedJobIds, expireListingDeadlines, isJobClosed } from '../persist/activity.js';
import { aiPriority, claimAiAttempt, completeAiAttempt, synchronizeAiQueue, type AiOutcome } from './ai-queue.js';
import { suppressIgnoredWork } from './ignored.js';

export interface RankedJob {
  job: MatchableJob;
  assessment: AssessmentResult;
  assessmentId: string;
  cached: boolean;
}

export interface RankOptions {
  /** Restrict to these job ids (e.g. the ones a collection run just touched). */
  jobIds?: string[];
  /** Include stored AI candidates in the same call and request budget. */
  includePendingAi?: boolean;
  /** Skip the LLM stage even when a key is configured. */
  rulesOnly?: boolean;
  limit?: number;
  /** Re-evaluate even when a cached assessment exists. */
  force?: boolean;
  onProgress?: (progress: RankProgress) => Promise<void>;
}

export interface RankProgress {
  assessed: number;
  cachedAssessments: number;
  rulesAssessments: number;
  aiSucceeded: number;
  aiCalls: number;
  aiFailures: number;
  failureReasons: string[];
}

export function emptyRankProgress(): RankProgress {
  return { assessed: 0, cachedAssessments: 0, rulesAssessments: 0, aiSucceeded: 0, aiCalls: 0, aiFailures: 0, failureReasons: [] };
}

/**
 * Hash vacancy identity/content and effective matching configuration, including
 * versions and engine inputs. Operational limits and secrets are not inputs.
 */
export function assessmentCacheKey(
  config: AppConfig,
  job: MatchableJob,
  engine: 'rules' | 'llm',
): string {
  return sha256(JSON.stringify({
    revision: 16,
    job: {
      ID: job.ID, title: job.title, company: job.company,
      location: job.location, locationCountry: job.locationCountry,
      jobType: job.jobType, isRemote: job.isRemote,
      salaryMin: job.salaryMin, salaryMax: job.salaryMax,
      salaryInterval: job.salaryInterval, salaryCurrency: job.salaryCurrency,
      description: job.description, primaryUrl: job.primaryUrl, datePosted: job.datePosted,
    },
    profile: config.profile,
    scoring: config.scoring,
    cvVariants: config.cvVariants,
    engine,
    llm: engine === 'llm' ? {
      model: config.settings.llm.model,
      base_url: config.settings.llm.base_url,
      temperature: config.settings.llm.temperature,
      max_output_tokens: config.settings.llm.max_output_tokens,
      max_description_chars: config.settings.llm.max_description_chars,
      require_description: config.scoring.uncertainty.require_description_for_llm,
    } : undefined,
  }));
}

/** The latest assessment still valid for this job and effective configuration. */
export function currentAssessmentKeys(config: AppConfig, job: MatchableJob): string[] {
  return [assessmentCacheKey(config, job, 'llm'), assessmentCacheKey(config, job, 'rules')];
}

/** Also accepts a stored snapshot for bulk, read-only dashboard queries. */
export async function findCurrentAssessment(
  config: AppConfig, job: MatchableJob, stored?: readonly any[],
): Promise<any | undefined> {
  const keys = currentAssessmentKeys(config, job);
  if (stored) return stored.filter((row) => row.job_ID === job.ID && keys.includes(row.cacheKey))
    .sort((a, b) => keys.indexOf(a.cacheKey) - keys.indexOf(b.cacheKey) ||
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.ID.localeCompare(b.ID))[0];
  for (const cacheKey of keys) {
    const row = await queryOne(SELECT.from(db().Assessments).where({ job_ID: job.ID, cacheKey }));
    if (row) return row;
  }
  return undefined;
}

export async function rank(options: RankOptions = {}): Promise<RankedJob[]> {
  await expireListingDeadlines();
  await suppressIgnoredWork();
  if (options.jobIds && options.jobIds.length === 0 && !options.includePendingAi) return [];
  const config = loadConfig();
  const { Jobs, Assessments } = db();

  let queryBuilder = SELECT.from(Jobs);
  if (options.jobIds?.length && !options.includePendingAi) queryBuilder = queryBuilder.where({ ID: { in: options.jobIds } });
  const stored = await query<MatchableJob>(queryBuilder);
  const closed = await closedJobIds();
  const prepared = stored.filter((job) => !closed.has(job.ID)).map((job) => {
    const analysis = analyzeVacancy(config, job);
    const screen = prescreen(config, job, analysis);
    let assessment = assessWithRules(config, job, analysis);
    if (!screen.passed) assessment = { ...assessment,
      fitScore: Math.min(assessment.fitScore, config.scoring.hard_rejects.score_cap),
      recommendation: 'Skip', explanation: `Pre-screen: ${screen.reason}.` };
    const eligible = job.status !== 'Ignored' && !job.isDemo && screen.passed && Boolean(job.description?.trim()) &&
      assessment.fitScore >= config.scoring.thresholds.llm_screen_gate && !assessment.hardReject;
    return { job, analysis, assessment, eligible, llmKey: assessmentCacheKey(config, job, 'llm') };
  });
  const queue = await synchronizeAiQueue(prepared.filter((row) => row.eligible).map((row) => ({
    jobId: row.job.ID, cacheKey: row.llmKey, rulesScore: row.assessment.fitScore,
  })), stored.map((job) => job.ID), (config.settings.llm.request_timeout_seconds + 60) * 1000);
  const at = new Date();
  prepared.sort((a, b) => {
    const left = queue.get(a.llmKey), right = queue.get(b.llmKey);
    const leftPriority = left ? aiPriority(left, at) : -Infinity;
    const rightPriority = right ? aiPriority(right, at) : -Infinity;
    return (rightPriority === leftPriority ? 0 : rightPriority > leftPriority ? 1 : -1) ||
      (left?.queuedAt ?? '').localeCompare(right?.queuedAt ?? '') || a.job.ID.localeCompare(b.job.ID);
  });

  const useLlm = config.llmAvailable && !options.rulesOnly;
  let llmBudget = useLlm ? Math.min(5, config.settings.llm.max_jobs_per_run) : 0;
  const ranked: RankedJob[] = [];
  const progress = emptyRankProgress();
  const report = async () => options.onProgress?.({ ...progress, assessed: ranked.length, failureReasons: [...progress.failureReasons] });
  const append = async (result: RankedJob, category: 'cached' | 'rules' | AiOutcome) => {
    ranked.push(result);
    if (category === 'cached') progress.cachedAssessments += 1;
    else if (category === 'rules') progress.rulesAssessments += 1;
    else if (category === 'Succeeded') progress.aiSucceeded += 1;
    else progress.aiFailures += 1;
    await report();
  };

  for (const preparedJob of prepared) {
    const { job } = preparedJob;
    if (await isJobClosed(job.ID)) continue;
    let engine: 'rules' | 'llm' = 'rules';
    let assessment = preparedJob.assessment;
    const work = queue.get(preparedJob.llmKey);
    const eligibleForLlm = useLlm && preparedJob.eligible &&
      (options.force || work?.status === 'Pending' || work?.status === 'RetryPending');
    const cachedLlm = preparedJob.eligible ? await queryOne<any>(SELECT.from(Assessments).where({ cacheKey: preparedJob.llmKey })) : undefined;

    // Cached evaluations cost no requests, including after the request budget
    // has been spent. The budget governs calls rather than cache reads.
    if (cachedLlm && !options.force && (work?.status !== 'RetryPending' || !eligibleForLlm || llmBudget <= 0)) {
      await append({ job, assessment: rowToAssessment(cachedLlm), assessmentId: cachedLlm.ID, cached: true }, 'cached');
      continue;
    }
    const attempt = eligibleForLlm && llmBudget > 0 ? await claimAiAttempt(preparedJob.llmKey, options.force) : null;
    const shouldUseLlm = attempt !== null;
    if (!shouldUseLlm && cachedLlm && !options.force) {
      await append({ job, assessment: rowToAssessment(cachedLlm), assessmentId: cachedLlm.ID, cached: true }, 'cached');
      continue;
    }
    if (shouldUseLlm) engine = 'llm';

    const cacheKey = assessmentCacheKey(config, job, engine);
    if (!options.force && !shouldUseLlm) {
      const cached = await queryOne<any>(SELECT.from(Assessments).where({ cacheKey }));
      if (cached) {
        await append({ job, assessment: rowToAssessment(cached), assessmentId: cached.ID, cached: true }, 'cached');
        continue;
      }
    }

    let aiOutcome: AiOutcome | null = null, aiReason: string | null = null, retryAfter: string | null = null;
    if (shouldUseLlm) {
      // Tracking may have changed while cache lookups were in flight.
      const beforeRequest = await queryOne<MatchableJob>(SELECT.from(Jobs).where({ ID: job.ID }));
      if (!beforeRequest || beforeRequest.status === 'Ignored' || await isJobClosed(job.ID)) {
        await suppressIgnoredWork(cds, job.ID);
        await cds.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded', attempts: attempt! - 1 })
          .where({ cacheKey: preparedJob.llmKey, status: 'Attempting', attempts: attempt }));
        continue;
      }
      llmBudget -= 1;
      progress.aiCalls += 1;
      await report();
      try {
        assessment = await assessWithLlm(config, job, preparedJob.analysis);
        engine = assessment.engine;
        aiOutcome = engine === 'llm' ? 'Succeeded' : 'RejectedOutput';
        if (aiOutcome === 'RejectedOutput') aiReason = assessment.missingInformation
          .filter((reason) => /AI assessment uncertainty/i.test(reason)).join('; ').slice(0, 1000) || 'Model output failed evidence validation';
      } catch (error) {
        aiOutcome = error instanceof LlmRejectedOutputError ? 'RejectedOutput' : 'ProviderFailure';
        aiReason = `${error instanceof LlmProviderError ? error.transient ? 'Transient provider failure: ' : 'Provider access/configuration failure: ' : ''}${error instanceof Error ? error.message : String(error)}`.slice(0, 1000);
        if (aiOutcome === 'ProviderFailure') llmBudget = 0;
        if (error instanceof LlmProviderError && error.retryAfterSeconds) retryAfter = new Date(Date.now() + Math.min(31_536_000, error.retryAfterSeconds) * 1000).toISOString();
        log.warn('AI attempt failed; preserving rules fallback', { outcome: aiOutcome, reason: aiReason });
        assessment = { ...assessment,
          missingInformation: [...assessment.missingInformation, 'AI assessment unavailable; rules fallback saved. Retry can be queued explicitly.'],
          explanation: `${assessment.explanation} AI ${aiOutcome === 'ProviderFailure' ? 'request failed' : 'output was rejected'}; rules fallback used: ${aiReason}.`,
        };
        engine = 'rules';
      }
    }

    // Cache the performed attempt, including rejected model output or provider
    // failure. The fallback still reports its actual rules engine and reason.
    const storedKey = assessmentCacheKey(config, job, shouldUseLlm ? 'llm' : engine);
    const assessmentId = await storeAssessment(job.ID, storedKey, assessment, aiOutcome, aiReason);
    if (shouldUseLlm && aiOutcome) {
      await completeAiAttempt(storedKey, attempt!, aiOutcome, aiReason, retryAfter);
      if (aiReason) progress.failureReasons.push(`${job.title.slice(0, 80)} · ${aiOutcome === 'ProviderFailure' ? 'Provider failure' : 'Rejected output'}: ${aiReason}`);
    }
    await append({ job, assessment, assessmentId, cached: false }, aiOutcome ?? 'rules');
  }

  ranked.sort((a, b) => b.assessment.fitScore - a.assessment.fitScore);
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}

/** Viewing results never creates or replaces an assessment. */
export async function readTop(limit = 20, titleSearch?: string): Promise<RankedJob[]> {
  const config = loadConfig();
  const ranked: RankedJob[] = [];
  const needle = normalizeText(titleSearch);
  const closed = await closedJobIds();
  for (const job of await query<MatchableJob>(SELECT.from(db().Jobs))) {
    if (closed.has(job.ID)) continue;
    if (needle && !normalizeText(job.title).includes(needle)) continue;
    const current = await findCurrentAssessment(config, job);
    if (current) ranked.push({ job, assessment: rowToAssessment(current), assessmentId: current.ID, cached: true });
  }
  return ranked.sort((a, b) => b.assessment.fitScore - a.assessment.fitScore).slice(0, limit);
}

/** Refresh changed deterministic inputs locally, including tracked closed records. No provider or delivery path. */
export async function refreshDeterministicAssessments(): Promise<number> {
  const config = loadConfig();
  let refreshed = 0;
  for (const job of await query<MatchableJob>(SELECT.from(db().Jobs))) {
    const key = assessmentCacheKey(config, job, 'rules');
    if (await queryOne(SELECT.from(db().Assessments).where({ cacheKey: key }))) continue;
    await storeAssessment(job.ID, key, assessWithRules(config, job));
    refreshed += 1;
  }
  return refreshed;
}

async function storeAssessment(jobId: string, cacheKey: string, assessment: AssessmentResult,
  aiOutcome: AiOutcome | null = null, aiReason: string | null = null): Promise<string> {
  const { Assessments } = db();
  const values = {
    job_ID: jobId,
    cacheKey,
    engine: assessment.engine,
    aiOutcome, aiReason,
    model: assessment.model,
    profileVersion: assessment.profileVersion,
    fitScore: assessment.fitScore,
    recommendation: assessment.recommendation,
    technicalFit: assessment.technicalFit,
    commercialFit: assessment.commercialFit,
    locationFit: assessment.locationFit,
    strongMatches: JSON.stringify(assessment.strongMatches),
    mandatoryGaps: JSON.stringify(assessment.mandatoryGaps),
    mandatoryGapEvidence: JSON.stringify(assessment.mandatoryGapEvidence),
    preferredGaps: JSON.stringify(assessment.preferredGaps),
    missingInformation: JSON.stringify(assessment.missingInformation),
    explanation: assessment.explanation,
    suggestedCvVariant: assessment.suggestedCvVariant,
    hardReject: assessment.hardReject,
    hardRejectReason: assessment.hardRejectReason,
    createdAt: new Date().toISOString(),
  };
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    let existing = await tx.run(SELECT.one.from(Assessments).columns('ID', 'engine').where({ cacheKey }));
    if (existing && aiOutcome && (existing.engine !== 'llm' || aiOutcome !== 'Succeeded')) {
      // Keep every failed fallback and its reason in history when retrying.
      await tx.run(UPDATE(Assessments).set({ cacheKey: `${cacheKey}:${existing.ID}` }).where({ ID: existing.ID }));
      existing = undefined;
    }
    const id = existing?.ID ?? randomUUID();
    await tx.run(existing ? UPDATE(Assessments).set(values).where({ ID: id })
      : INSERT.into(Assessments).entries({ ID: id, ...values }));
    return id;
  });
}

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function rowToAssessment(row: any): AssessmentResult {
  return {
    engine: row.engine,
    model: row.model,
    profileVersion: row.profileVersion,
    fitScore: row.fitScore,
    recommendation: row.recommendation,
    technicalFit: row.technicalFit,
    commercialFit: row.commercialFit,
    locationFit: row.locationFit,
    strongMatches: parseList(row.strongMatches),
    mandatoryGaps: parseList(row.mandatoryGaps),
    mandatoryGapEvidence: parseEvidence(row.mandatoryGapEvidence),
    preferredGaps: parseList(row.preferredGaps),
    missingInformation: parseList(row.missingInformation),
    explanation: row.explanation ?? '',
    suggestedCvVariant: row.suggestedCvVariant ?? null,
    hardReject: Boolean(row.hardReject),
    hardRejectReason: row.hardRejectReason ?? null,
  };
}

function parseEvidence(value: string | null): AssessmentResult['mandatoryGapEvidence'] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => item &&
      ['requirement', 'vacancyQuote', 'profilePath', 'profileValue'].every((key) => typeof item[key] === 'string')) : [];
  } catch { return []; }
}
