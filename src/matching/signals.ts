import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import type { MatchableJob } from './types.js';

export type WorkMode = 'fully_remote' | 'hybrid' | 'onsite' | 'unknown';
export type Engagement = 'contract' | 'permanent' | 'unknown';

const cache = new Map<string, RegExp>();

/** Compile a configured pattern once. Patterns come from config, never from job text. */
export function pattern(source: string): RegExp {
  let compiled = cache.get(source);
  if (!compiled) {
    compiled = new RegExp(source, 'i');
    cache.set(source, compiled);
  }
  return compiled;
}

export function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((source) => pattern(source).test(text));
}

export function firstMatch(text: string, patterns: readonly string[]): string | null {
  for (const source of patterns) {
    const found = text.match(pattern(source));
    if (found) return found[0];
  }
  return null;
}

/** Searchable, normalised view of a job. */
export interface JobText {
  title: string;
  body: string;
  all: string;
  hasDescription: boolean;
}

export function jobText(job: MatchableJob): JobText {
  const title = normalizeText(job.title);
  const body = normalizeText(job.description ?? '');
  return { title, body, all: `${title}\n${body}`, hasDescription: Boolean(job.description) };
}

export function detectEngagement(config: AppConfig, job: MatchableJob, text: JobText): Engagement {
  const signals = config.scoring.signals;
  const jobType = normalizeText(job.jobType ?? '');
  if (jobType.includes('contract')) return 'contract';
  const contract = matchesAny(text.all, signals.contract ?? []);
  const permanent = matchesAny(text.all, signals.permanent ?? []);
  if (contract && !permanent) return 'contract';
  if (permanent && !contract) return 'permanent';
  if (contract && permanent) return 'contract'; // mixed postings stay open
  return 'unknown';
}

export function detectWorkMode(config: AppConfig, job: MatchableJob, text: JobText): WorkMode {
  const signals = config.scoring.signals;
  if (matchesAny(text.all, signals.fully_remote ?? [])) return 'fully_remote';
  if (matchesAny(text.all, signals.hybrid ?? [])) return 'hybrid';
  if (matchesAny(text.all, signals.onsite ?? [])) return 'onsite';
  if (job.isRemote === true) return 'fully_remote';
  if (job.isRemote === false && text.hasDescription) return 'onsite';
  return 'unknown';
}

export interface HourlyRate {
  value: number | null;
  currency: string | null;
  comparable: boolean;
  note: string | null;
}

/** Convert a posted salary into an hourly figure comparable to the target rate. */
export function hourlyRate(config: AppConfig, job: MatchableJob): HourlyRate {
  const amount = job.salaryMax ?? job.salaryMin;
  if (amount === null || amount === undefined) {
    return { value: null, currency: job.salaryCurrency, comparable: false, note: 'rate not stated' };
  }
  const currency = (job.salaryCurrency ?? '').toUpperCase() || null;
  const { hours_per_day, working_days_per_month, working_months_per_year, currency: target } =
    config.profile.compensation;

  const interval = (job.salaryInterval ?? '').toLowerCase();
  const divisor: Record<string, number> = {
    hourly: 1,
    daily: hours_per_day,
    weekly: hours_per_day * 5,
    monthly: hours_per_day * working_days_per_month,
    yearly: hours_per_day * working_days_per_month * working_months_per_year,
  };
  const factor = divisor[interval];
  if (!factor) {
    return { value: null, currency, comparable: false, note: `salary interval "${interval || 'unknown'}" not comparable` };
  }
  const value = amount / factor;
  if (currency && currency !== target.toUpperCase()) {
    return { value, currency, comparable: false, note: `rate stated in ${currency}, target is ${target}` };
  }
  return { value, currency: currency ?? target, comparable: true, note: null };
}

/** Split into rough sentences so a requirement can be read in context. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:\n])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export type Requirement = 'mandatory' | 'preferred' | 'unclear';

/** Decide whether a term appears as a must-have or a nice-to-have. */
export function requirementKind(config: AppConfig, text: string, term: string): Requirement | null {
  const needle = normalizeText(term);
  if (!needle) return null;
  const mandatoryMarkers = config.scoring.signals.mandatory_markers ?? [];
  const preferredMarkers = config.scoring.signals.preferred_markers ?? [];
  let found = false;
  for (const sentence of sentences(text)) {
    if (!sentence.includes(needle)) continue;
    found = true;
    if (matchesAny(sentence, preferredMarkers)) return 'preferred';
    if (matchesAny(sentence, mandatoryMarkers)) return 'mandatory';
  }
  return found ? 'unclear' : null;
}
