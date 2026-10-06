import type { AppConfig } from '../config/index.js';
import type { AssessmentResult, MatchableJob } from '../matching/types.js';
import { detectEngagement, detectWorkMode, hourlyRate, jobText } from '../matching/signals.js';

const SOURCE_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  indeed: 'Indeed',
  glassdoor: 'Glassdoor',
  zip_recruiter: 'ZipRecruiter',
  google: 'Google',
};

export interface NotificationPayload {
  text: string;
  url: string;
  buttonText: string;
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function locationLabel(config: AppConfig, job: MatchableJob): string {
  const mode = detectWorkMode(config, job, jobText(job));
  const place = job.location ?? job.locationCountry ?? null;
  if (mode === 'fully_remote') return place ? `Remote (${place})` : 'Remote';
  if (mode === 'hybrid') return place ? `Hybrid (${place})` : 'Hybrid';
  if (mode === 'onsite') return place ? `On-site (${place})` : 'On-site';
  return place ?? 'location not stated';
}

function engagementLabel(config: AppConfig, job: MatchableJob): string {
  const engagement = detectEngagement(config, job, jobText(job));
  if (engagement === 'contract') return 'Contract';
  if (engagement === 'permanent') return 'Permanent';
  return 'contract type not stated';
}

function rateLabel(config: AppConfig, job: MatchableJob): string {
  const rate = hourlyRate(config, job);
  if (rate.value === null) return 'not stated';
  const amount = `${Math.round(rate.value)} ${rate.currency ?? ''}/h`.trim();
  return rate.comparable ? `~${amount} (implied)` : `~${amount} (implied, ${rate.note})`;
}

function cvLabel(config: AppConfig, variantId: string | null): string {
  const variant = config.cvVariants.variants.find((candidate) => candidate.id === variantId);
  return variant ? variant.label : 'none configured';
}

/** Build the Telegram message. Never fabricates unknown values. */
export function formatNotification(
  config: AppConfig,
  job: MatchableJob,
  assessment: AssessmentResult,
  sources: string[],
): NotificationPayload {
  const sourceText = sources.length ? sources.map(sourceLabel).join(' + ') : 'unknown source';
  const matches = assessment.strongMatches.length ? assessment.strongMatches.slice(0, 6).join(', ') : 'none detected';

  const lines = [
    `${assessment.fitScore}/100 — ${job.title}`,
    `${sourceText} | ${locationLabel(config, job)} | ${engagementLabel(config, job)}`,
    job.company ? `Company: ${job.company}` : 'Company: not stated',
    `Rate: ${rateLabel(config, job)}`,
    `Matches: ${matches}`,
  ];

  for (const gap of assessment.mandatoryGaps.slice(0, 2)) lines.push(`Gap: ${gap}`);
  for (const unknown of assessment.missingInformation.slice(0, 2)) lines.push(`Unknown: ${unknown}`);

  lines.push(`Suggested CV: ${cvLabel(config, assessment.suggestedCvVariant)}`);
  lines.push(`Published: ${job.datePosted ?? 'unknown'}`);
  lines.push(`Recommendation: ${assessment.recommendation} (fit score, not a hiring probability)`);
  lines.push(`Open vacancy: ${job.primaryUrl}`);

  return { text: lines.join('\n'), url: job.primaryUrl, buttonText: 'Open vacancy' };
}
