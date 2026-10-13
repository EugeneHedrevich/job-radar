import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../config/index.js';
import { cds, db, SELECT, INSERT, UPDATE, query, queryOne } from '../db/index.js';
import { assessWithLlm, LlmUnavailableError } from '../matching/llm.js';
import { assessWithRules, prescreen } from '../matching/rules.js';
import type { AssessmentResult, MatchableJob } from '../matching/types.js';
import { normalizeText, sha256 } from '../util/text.js';
import { log } from '../util/log.js';
import { closedJobIds, expireListingDeadlines, isJobClosed } from '../persist/activity.js';
import { aiPriority, completeAiAttempt, synchronizeAiQueue } from './ai-queue.js';
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
    revision: 14,
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
    const screen = prescreen(config, job);
    let assessment = assessWithRules(config, job);
    if (!screen.passed) assessment = { ...assessment,
      fitScore: Math.min(assessment.fitScore, config.scoring.hard_rejects.score_cap),
      recommendation: 'Skip', explanation: `Pre-screen: ${screen.reason}.` };
    const eligible = job.status !== 'Ignored' && !job.isDemo && screen.passed && Boolean(job.description?.trim()) &&
      assessment.fitScore >= config.scoring.thresholds.llm_screen_gate && !assessment.hardReject;
    return { job, assessment, eligible, llmKey: assessmentCacheKey(config, job, 'llm') };
  });
  const queue = await synchronizeAiQueue(prepared.filter((row) => row.eligible).map((row) => ({
    jobId: row.job.ID, cacheKey: row.llmKey, rulesScore: row.assessment.fitScore,
  })), stored.map((job) => job.ID));
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

  for (const preparedJob of prepared) {
    const { job } = preparedJob;
    if (await isJobClosed(job.ID)) continue;
    let engine: 'rules' | 'llm' = 'rules';
    let assessment = preparedJob.assessment;
    const eligibleForLlm = useLlm && preparedJob.eligible;

    // Cached evaluations cost no requests, including after the request budget
    // has been spent. The budget governs calls rather than cache reads.
    if (preparedJob.eligible && !options.rulesOnly && !options.force) {
      const cached = await queryOne<any>(SELECT.from(Assessments)
        .where({ cacheKey: assessmentCacheKey(config, job, 'llm') }));
      if (cached) {
        ranked.push({ job, assessment: rowToAssessment(cached), assessmentId: cached.ID, cached: true });
        continue;
      }
    }
    const shouldUseLlm = eligibleForLlm && llmBudget > 0;
    if (shouldUseLlm) engine = 'llm';

    const cacheKey = assessmentCacheKey(config, job, engine);
    if (!options.force) {
      const cached = await queryOne<any>(SELECT.from(Assessments).where({ cacheKey }));
      if (cached) {
        ranked.push({ job, assessment: rowToAssessment(cached), assessmentId: cached.ID, cached: true });
        continue;
      }
    }

    if (shouldUseLlm) {
      // Tracking may have changed while cache lookups were in flight.
      const beforeRequest = await queryOne<MatchableJob>(SELECT.from(Jobs).where({ ID: job.ID }));
      if (!beforeRequest || beforeRequest.status === 'Ignored' || await isJobClosed(job.ID)) {
        await suppressIgnoredWork(cds, job.ID);
        continue;
      }
      llmBudget -= 1;
      try {
        assessment = await assessWithLlm(config, job);
        engine = assessment.engine;
      } catch (error) {
        // Stop further calls for this run when the provider is failing.
        llmBudget = 0;
        if (error instanceof LlmUnavailableError) {
          log.warn('LLM unavailable, keeping deterministic assessment', { reason: error.message });
        } else {
          log.error('LLM assessment failed, keeping deterministic assessment', {
            title: job.title,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        assessment = { ...assessment,
          missingInformation: [...assessment.missingInformation, 'AI assessment unavailable; cached rules fallback. Use rank --force to retry.'],
          explanation: `${assessment.explanation} AI request failed; rules fallback used: ${error instanceof Error ? error.message.slice(0, 500) : 'provider failure'}.`,
        };
        engine = 'rules';
      }
    }

    // Cache the performed attempt, including rejected model output or provider
    // failure. The fallback still reports its actual rules engine and reason.
    const storedKey = assessmentCacheKey(config, job, shouldUseLlm ? 'llm' : engine);
    const assessmentId = await storeAssessment(job.ID, storedKey, assessment);
    if (shouldUseLlm) await completeAiAttempt(storedKey);
    ranked.push({ job, assessment, assessmentId, cached: false });
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

async function storeAssessment(jobId: string, cacheKey: string, assessment: AssessmentResult): Promise<string> {
  const { Assessments } = db();
  const existing = await queryOne<{ ID: string }>(SELECT.from(Assessments).columns('ID').where({ cacheKey }));
  const id = existing?.ID ?? randomUUID();
  const values = {
    job_ID: jobId,
    cacheKey,
    engine: assessment.engine,
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
  await cds.run(existing
    ? UPDATE(Assessments).set(values).where({ ID: id })
    : INSERT.into(Assessments).entries({ ID: id, ...values }));
  return id;
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
