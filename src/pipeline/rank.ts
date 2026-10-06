import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../config/index.js';
import { cds, db, SELECT, INSERT, query, queryOne } from '../db/index.js';
import { assessWithLlm, LlmUnavailableError } from '../matching/llm.js';
import { assessWithRules, prescreen } from '../matching/rules.js';
import type { AssessmentResult, MatchableJob } from '../matching/types.js';
import { sha256 } from '../util/text.js';
import { log } from '../util/log.js';

export interface RankedJob {
  job: MatchableJob;
  assessment: AssessmentResult;
  assessmentId: string;
  cached: boolean;
}

export interface RankOptions {
  /** Restrict to these job ids (e.g. the ones a collection run just touched). */
  jobIds?: string[];
  /** Skip the LLM stage even when a key is configured. */
  rulesOnly?: boolean;
  limit?: number;
  /** Re-evaluate even when a cached assessment exists. */
  force?: boolean;
}

/**
 * Build the cache key for an assessment. It covers the job content, the profile
 * version, the scoring version and the engine, so changing any of them forces a
 * fresh evaluation while repeated runs reuse the previous result.
 */
export function assessmentCacheKey(
  config: AppConfig,
  job: MatchableJob,
  engine: 'rules' | 'llm',
): string {
  const content = [
    job.title,
    job.company ?? '',
    job.location ?? '',
    job.jobType ?? '',
    job.isRemote === null ? '' : String(job.isRemote),
    `${job.salaryMin ?? ''}-${job.salaryMax ?? ''}-${job.salaryInterval ?? ''}-${job.salaryCurrency ?? ''}`,
    job.descriptionHash ?? 'no-description',
  ].join('|');
  const engineTag = engine === 'llm' ? `llm:${config.settings.llm.model}` : 'rules';
  return sha256(
    `${content}||profile=${config.profile.version}||scoring=${config.scoring.version}||engine=${engineTag}`,
  );
}

export async function rank(options: RankOptions = {}): Promise<RankedJob[]> {
  const config = loadConfig();
  const { Jobs, Assessments } = db();

  let queryBuilder = SELECT.from(Jobs);
  if (options.jobIds?.length) queryBuilder = queryBuilder.where({ ID: { in: options.jobIds } });
  const jobs = await query<MatchableJob>(queryBuilder);

  const useLlm = config.llmAvailable && !options.rulesOnly;
  let llmBudget = useLlm ? config.settings.llm.max_jobs_per_run : 0;
  const ranked: RankedJob[] = [];

  for (const job of jobs) {
    const screen = prescreen(config, job);
    if (!screen.passed) {
      log.debug('Prescreen dropped job', { title: job.title, reason: screen.reason });
    }

    let engine: 'rules' | 'llm' = 'rules';
    let assessment = assessWithRules(config, job);
    if (!screen.passed) {
      assessment = {
        ...assessment,
        fitScore: Math.min(assessment.fitScore, config.scoring.hard_rejects.score_cap),
        recommendation: 'Skip',
        explanation: `Pre-screen: ${screen.reason}.`,
      };
    }

    const shouldUseLlm =
      useLlm &&
      screen.passed &&
      llmBudget > 0 &&
      Boolean(job.description) &&
      assessment.fitScore >= config.scoring.thresholds.llm_screen_gate &&
      !assessment.hardReject;

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
      try {
        assessment = await assessWithLlm(config, job);
        llmBudget -= 1;
      } catch (error) {
        if (error instanceof LlmUnavailableError) {
          log.warn('LLM unavailable, keeping deterministic assessment', { reason: error.message });
        } else {
          log.error('LLM assessment failed, keeping deterministic assessment', {
            title: job.title,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        engine = 'rules';
      }
    }

    const storedKey = assessmentCacheKey(config, job, engine);
    const assessmentId = await storeAssessment(job.ID, storedKey, assessment);
    ranked.push({ job, assessment, assessmentId, cached: false });
  }

  ranked.sort((a, b) => b.assessment.fitScore - a.assessment.fitScore);
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}

async function storeAssessment(jobId: string, cacheKey: string, assessment: AssessmentResult): Promise<string> {
  const { Assessments } = db();
  const existing = await queryOne<{ ID: string }>(SELECT.from(Assessments).columns('ID').where({ cacheKey }));
  if (existing) return existing.ID;

  const id = randomUUID();
  await cds.run(
    INSERT.into(Assessments).entries({
      ID: id,
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
      preferredGaps: JSON.stringify(assessment.preferredGaps),
      missingInformation: JSON.stringify(assessment.missingInformation),
      explanation: assessment.explanation,
      suggestedCvVariant: assessment.suggestedCvVariant,
      hardReject: assessment.hardReject,
      hardRejectReason: assessment.hardRejectReason,
      createdAt: new Date().toISOString(),
    }),
  );
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
    preferredGaps: parseList(row.preferredGaps),
    missingInformation: parseList(row.missingInformation),
    explanation: row.explanation ?? '',
    suggestedCvVariant: row.suggestedCvVariant ?? null,
    hardReject: Boolean(row.hardReject),
    hardRejectReason: row.hardRejectReason ?? null,
  };
}
