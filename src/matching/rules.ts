import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import {
  detectEngagement,
  detectWorkMode,
  hasMandatoryOnsiteCondition,
  hasUnclearOnsiteFrequency,
  hourlyRate,
  jobText,
  matchesAny,
  onsiteDaysPerMonth,
  pattern,
  requirementKind,
  type JobText,
} from './signals.js';
import type { AssessmentResult, MatchableJob, Recommendation } from './types.js';

export interface PrescreenResult {
  passed: boolean;
  reason: string | null;
}

/** Stage 1: cheap keyword screening. Nothing here costs an API call. */
export function prescreen(config: AppConfig, job: MatchableJob): PrescreenResult {
  const text = jobText(job);
  const { require_any, drop_title_terms, rescue_terms } = config.scoring.prescreen;

  if (require_any.length && !matchesAny(text.all, require_any)) {
    return { passed: false, reason: 'no required keyword found in title or description' };
  }
  const droppedTerm = drop_title_terms.find((term) => pattern(`\\b${term}\\b`).test(text.title));
  if (droppedTerm && !matchesAny(text.all, rescue_terms.map((term) => `\\b${term}\\b`))) {
    return { passed: false, reason: `title matches excluded term "${droppedTerm}"` };
  }
  return { passed: true, reason: null };
}

interface HardRejectHit {
  id: string;
  reason: string;
}

export function findHardRejects(config: AppConfig, text: JobText): HardRejectHit[] {
  const hits: HardRejectHit[] = [];
  const limit = config.profile.travel?.max_onsite_days_per_month;
  const requiredDays = onsiteDaysPerMonth(config, text.all).mandatory;
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 && requiredDays !== null && requiredDays > limit) {
    hits.push({ id: 'travel_limit', reason: `Required onsite attendance (${requiredDays.toFixed(1)} days/month) exceeds the profile limit (${limit} days/month).` });
  }
  for (const rule of config.scoring.hard_rejects.rules) {
    if (rule.id === 'onsite_heavy') {
      if (hasMandatoryOnsiteCondition(config, text.all)) hits.push({ id: rule.id, reason: rule.reason });
      continue;
    }
    if (!matchesAny(text.all, rule.any)) continue;
    if (rule.none.length && matchesAny(text.all, rule.none)) continue;
    hits.push({ id: rule.id, reason: rule.reason });
  }
  return hits;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

interface TechnicalResult {
  score: number;
  matches: string[];
}

function scoreTechnical(config: AppConfig, text: JobText): TechnicalResult {
  const groups = config.scoring.technical.groups;
  const matches: string[] = [];
  let total = 0;

  for (const [groupName, skills] of Object.entries(config.profile.skills)) {
    const weights = groups[groupName];
    if (!weights) continue; // groups absent from scoring.yaml (e.g. "limited") never add points
    let groupScore = 0;
    for (const skill of skills) {
      const terms = [skill.name, ...(skill.aliases ?? [])];
      const inTitle = terms.some((term) => pattern(`\\b${escapeRegex(normalizeText(term))}\\b`).test(text.title));
      const inBody = terms.some((term) => pattern(`\\b${escapeRegex(normalizeText(term))}\\b`).test(text.body));
      if (!inTitle && !inBody) continue;
      matches.push(skill.name);
      groupScore += inTitle
        ? weights.points_per_hit * config.scoring.technical.title_multiplier
        : weights.points_per_hit;
    }
    total += Math.min(groupScore, weights.cap);
  }

  const titleIsRelevant =
    /\bsap\b/.test(text.title) &&
    /\b(btp|cap|capm|cpi|integration suite|ui5|fiori|architect|ai|cloud)\b/.test(text.title);
  if (titleIsRelevant) total = Math.max(total, config.scoring.technical.relevant_title_floor);

  return { score: clamp(total, config.scoring.technical.max), matches: [...new Set(matches)] };
}

interface DimensionResult {
  score: number;
  notes: string[];
  missing: string[];
}

function scoreCommercial(config: AppConfig, job: MatchableJob, text: JobText): DimensionResult {
  const rules = config.scoring.commercial;
  const notes: string[] = [];
  const missing: string[] = [];
  let score = rules.base;

  const engagement = detectEngagement(config, job, text);
  if (engagement === 'contract') {
    score += rules.contract_signals_bonus;
    notes.push('contract/freelance engagement indicated');
  } else if (engagement === 'permanent') {
    score -= rules.permanent_signals_penalty;
    notes.push('permanent employment indicated');
  } else {
    missing.push('contract type not stated');
  }

  const rate = hourlyRate(config, job);
  if (rate.value === null || !rate.comparable) {
    missing.push(rate.note ?? 'rate not stated');
  } else if (rate.value >= config.profile.compensation.target_hourly_rate) {
    score += rules.rate_at_or_above_target_bonus;
    notes.push(`implied rate ~${rate.value.toFixed(0)} ${rate.currency}/h meets the target`);
  } else if (rate.value < config.profile.compensation.minimum_hourly_rate) {
    score -= rules.rate_below_minimum_penalty;
    notes.push(`implied rate ~${rate.value.toFixed(0)} ${rate.currency}/h is below the minimum`);
  }

  return { score: clamp(score, rules.max), notes, missing };
}

function scoreLocation(config: AppConfig, job: MatchableJob, text: JobText): DimensionResult {
  const rules = config.scoring.location;
  const notes: string[] = [];
  const missing: string[] = [];
  let score = rules.base;

  const attendance = onsiteDaysPerMonth(config, text.all);
  if (attendance.unclear !== null) {
    missing.push(`unclear whether onsite attendance (${attendance.unclear.toFixed(1)} days/month) is mandatory`);
  }
  if (hasUnclearOnsiteFrequency(config, text.all)) missing.push('onsite attendance frequency is not stated or unclear');
  const mode = detectWorkMode(config, job, text);
  const country = job.locationCountry;
  const preferred = country
    ? config.scoring.preferred_countries.some((name) => name.toLowerCase() === country.toLowerCase())
    : null;

  switch (mode) {
    case 'fully_remote':
      score += rules.fully_remote_bonus;
      if (preferred) score += rules.remote_within_europe_bonus;
      notes.push('fully remote');
      break;
    case 'hybrid':
      score -= rules.hybrid_penalty;
      notes.push('hybrid - on-site attendance mentioned');
      break;
    case 'onsite':
      score -= rules.onsite_penalty;
      notes.push('on-site role');
      break;
    default:
      missing.push('work mode (remote/hybrid/on-site) not stated');
  }

  if (preferred === true) {
    score += rules.preferred_country_bonus;
    notes.push(`${country} is inside the preferred region`);
  } else if (preferred === false) {
    score -= rules.outside_preferred_region_penalty;
    notes.push(`${country} is outside the preferred region`);
  } else {
    missing.push('country not identifiable from the posting');
  }

  // Work authorisation is never inferred from the base location.
  if (preferred === false) missing.push('work authorisation for this country is not established');

  return { score: clamp(score, rules.max), notes, missing };
}

function collectGaps(config: AppConfig, text: JobText) {
  const mandatoryGaps: string[] = [];
  const preferredGaps: string[] = [];
  const unclear: string[] = [];
  for (const claim of config.profile.not_claimed) {
    const kinds = [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])]
      .map((term) => requirementKind(config, text.all, term));
    const kind = kinds.includes('mandatory') ? 'mandatory' : kinds.includes('preferred') ? 'preferred' : kinds.includes('unclear') ? 'unclear' : null;
    if (!kind) continue;
    if (kind === 'mandatory') mandatoryGaps.push(`${claim} appears to be mandatory`);
    else if (kind === 'preferred') preferredGaps.push(`${claim} is listed as preferred`);
    else unclear.push(`unclear whether "${claim}" is mandatory`);
  }
  return { mandatoryGaps, preferredGaps, unclear };
}

/** Pick the best configured CV variant. Never invents a variant. */
export function suggestCvVariant(config: AppConfig, text: JobText): string {
  let best = config.cvVariants.default;
  let bestScore = -1;
  for (const variant of config.cvVariants.variants) {
    let score = 0;
    for (const term of variant.focus) {
      const needle = escapeRegex(normalizeText(term));
      // The title says what the role IS; the description only says what it touches.
      if (pattern(`\\b${needle}\\b`).test(text.title)) score += 5;
      else if (pattern(`\\b${needle}\\b`).test(text.body)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = variant.id;
    }
  }
  return bestScore <= 0 ? config.cvVariants.default : best;
}

export function recommendationFor(config: AppConfig, score: number): Recommendation {
  if (score >= config.scoring.thresholds.apply) return 'Apply';
  if (score >= config.scoring.thresholds.review) return 'Review';
  return 'Skip';
}

/**
 * Stage 2a: deterministic assessment. Always available, even without an LLM key.
 * Unknown facts move a dimension towards the neutral score and are reported in
 * `missingInformation` rather than causing an automatic accept or reject.
 */
export function assessWithRules(config: AppConfig, job: MatchableJob): AssessmentResult {
  const text = jobText(job);
  const hardRejects = findHardRejects(config, text);
  const technical = scoreTechnical(config, text);
  const commercial = scoreCommercial(config, job, text);
  const location = scoreLocation(config, job, text);
  const gaps = collectGaps(config, text);

  const weights = config.scoring.weights;
  let fitScore = Math.round(
    technical.score * weights.technical + commercial.score * weights.commercial + location.score * weights.location,
  );

  const missingInformation = [...commercial.missing, ...location.missing, ...gaps.unclear];
  if (!text.hasDescription) {
    missingInformation.unshift('full description was not retrieved - assessment is based on the title only');
    fitScore = Math.min(fitScore, config.scoring.uncertainty.cap_without_description);
  }

  const mandatoryGaps = [...gaps.mandatoryGaps];
  let hardRejectReason: string | null = null;
  if (hardRejects.length) {
    hardRejectReason = hardRejects.map((hit) => hit.reason).join(' ');
    for (const hit of hardRejects) mandatoryGaps.push(hit.reason);
    fitScore = Math.min(fitScore, config.scoring.hard_rejects.score_cap);
  }

  let recommendation: Recommendation = hardRejects.length ? 'Skip' : recommendationFor(config, fitScore);
  // Never recommend applying to a vacancy whose text we have not read.
  if (!text.hasDescription && recommendation === 'Apply') recommendation = 'Review';
  if (mandatoryGaps.length > 0 && recommendation === 'Apply') recommendation = 'Review';

  const explanation = buildExplanation({
    hardRejectReason,
    technicalMatches: technical.matches,
    commercialNotes: commercial.notes,
    locationNotes: location.notes,
    missing: missingInformation,
  });

  return {
    engine: 'rules',
    model: null,
    profileVersion: config.profile.version,
    fitScore,
    recommendation,
    technicalFit: technical.score,
    commercialFit: commercial.score,
    locationFit: location.score,
    strongMatches: technical.matches.slice(0, 12),
    mandatoryGaps,
    preferredGaps: gaps.preferredGaps,
    missingInformation,
    explanation,
    suggestedCvVariant: suggestCvVariant(config, text),
    hardReject: hardRejects.length > 0,
    hardRejectReason,
  };
}

function buildExplanation(input: {
  hardRejectReason: string | null;
  technicalMatches: string[];
  commercialNotes: string[];
  locationNotes: string[];
  missing: string[];
}): string {
  if (input.hardRejectReason) return `Rejected: ${input.hardRejectReason}`;
  const parts: string[] = [];
  if (input.technicalMatches.length) parts.push(`Matches ${input.technicalMatches.slice(0, 6).join(', ')}.`);
  else parts.push('No profile skill matched the posting text.');
  parts.push(...input.commercialNotes.map(capitalise));
  parts.push(...input.locationNotes.map(capitalise));
  if (input.missing.length) parts.push(`Unknown: ${input.missing.slice(0, 3).join('; ')}.`);
  return parts.join(' ');
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1) + (value.endsWith('.') ? '' : '.');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
