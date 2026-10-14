import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { analyzeVacancy, finalAssessmentPolicy, type VacancyAnalysis } from './analysis.js';
import { matchesAny, pattern, type JobText } from './signals.js';
import type { AssessmentResult, MatchableJob } from './types.js';

export interface PrescreenResult {
  passed: boolean;
  reason: string | null;
}

/** Stage 1: cheap keyword screening. Nothing here costs an API call. */
export function prescreen(config: AppConfig, job: MatchableJob, analysis = analyzeVacancy(config, job)): PrescreenResult {
  const { text, relevance: relevant } = analysis;
  if (!relevant.accepted) return { passed: false, reason: relevant.reason };
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

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

interface TechnicalResult {
  score: number;
  matches: string[];
  focus: string | null;
}

function scoreTechnical(config: AppConfig, analysis: VacancyAnalysis): TechnicalResult {
  const { text } = analysis;
  const groups = config.scoring.technical.groups;
  const matches: string[] = [];
  let total = 0;

  for (const [groupName, weights] of Object.entries(groups)) {
    const evidence = analysis.profileEvidence.filter((item) => item.group === groupName &&
      !analysis.mandatoryGapEvidence.some((gap) => gap.profilePath === item.profilePath));
    matches.push(...evidence.map((item) => item.name));
    const groupScore = evidence.reduce((sum, item) => sum + weights.points_per_hit *
      (item.inTitle ? config.scoring.technical.title_multiplier : 1), 0);
    total += Math.min(groupScore, weights.cap);
  }

  const titleIsRelevant =
    /\b(?:sap|sapui5|fiori)\b/.test(text.all) &&
    /\b(btp|cap|capm|cpi|integration suite|sapui5|ui5|fiori|joule|architect|ai|cloud)\b/.test(text.title);
  if (titleIsRelevant) total = Math.max(total, config.scoring.technical.relevant_title_floor);

  let focus: string | null = null;
  if (text.hasDescription) {
    const matched = new Set(matches);
    for (const role of Object.values(config.scoring.technical.role_profiles)) {
      if (!matchesAny(text.title, role.title_any) || matchesAny(text.title, role.title_none)) continue;
      if (!role.required_skills.every((skill) => matched.has(skill))) continue;
      const relevant = Object.entries(role.skills).filter(([skill]) => matched.has(skill));
      if (relevant.length < role.min_matches) continue;
      const roleScore = relevant.reduce((sum, [, points]) => sum + points, 0);
      if (roleScore > total) { total = roleScore; focus = role.label; }
    }
  }

  return { score: clamp(total, config.scoring.technical.max), matches: [...new Set(matches)], focus };
}

interface DimensionResult {
  score: number;
  notes: string[];
  missing: string[];
}

function scoreCommercial(config: AppConfig, analysis: VacancyAnalysis): DimensionResult {
  const rules = config.scoring.commercial;
  const notes: string[] = [];
  const missing: string[] = [];
  let score = rules.base;

  const engagement = analysis.engagement;
  if (engagement === 'contract') {
    score += rules.contract_signals_bonus;
    notes.push('contract/freelance engagement indicated');
  } else if (engagement === 'permanent') {
    score -= rules.permanent_signals_penalty;
    notes.push('permanent employment indicated');
  } else if (engagement === 'alternatives') {
    missing.push('contract/permanent alternatives need confirmation');
  } else {
    missing.push('contract type not stated');
  }

  const rate = analysis.rate;
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

function scoreLocation(config: AppConfig, job: MatchableJob, analysis: VacancyAnalysis): DimensionResult {
  const rules = config.scoring.location;
  const notes: string[] = [];
  const missing: string[] = [];
  let score = rules.base;

  const mode = analysis.workMode;
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

/**
 * Stage 2a: deterministic assessment. Always available, even without an LLM key.
 * Unknown facts move a dimension towards the neutral score and are reported in
 * `missingInformation` rather than causing an automatic accept or reject.
 */
export function assessWithRules(config: AppConfig, job: MatchableJob, analysis = analyzeVacancy(config, job)): AssessmentResult {
  const technical = scoreTechnical(config, analysis);
  const commercial = scoreCommercial(config, analysis);
  const location = scoreLocation(config, job, analysis);
  const weights = config.scoring.weights;
  const policy = finalAssessmentPolicy(config, analysis,
    technical.score * weights.technical + commercial.score * weights.commercial + location.score * weights.location);
  const missingInformation = [...new Set([...analysis.missingInformation, ...commercial.missing, ...location.missing])];
  const explanation = buildExplanation({
    hardRejectReason: policy.hardRejectReason, needsReview: analysis.requiresReview,
    commercialNotes: commercial.notes, locationNotes: location.notes, missing: missingInformation,
  });
  return {
    engine: 'rules', model: null, profileVersion: config.profile.version, ...policy,
    technicalFit: technical.score, commercialFit: commercial.score, locationFit: location.score,
    strongMatches: technical.matches.slice(0, 12), mandatoryGaps: analysis.mandatoryGaps,
    mandatoryGapEvidence: analysis.mandatoryGapEvidence, preferredGaps: analysis.preferredGaps,
    missingInformation, explanation, suggestedCvVariant: suggestCvVariant(config, analysis.text),
  };
}

function buildExplanation(input: {
  hardRejectReason: string | null;
  needsReview: boolean;
  commercialNotes: string[];
  locationNotes: string[];
  missing: string[];
}): string {
  if (input.hardRejectReason) return `Rejected: ${input.hardRejectReason}`;
  const parts: string[] = [];
  if (input.needsReview) parts.push('Suitability requires review of the unresolved requirements.');
  parts.push(...input.commercialNotes.map(capitalise));
  parts.push(...input.locationNotes.map(capitalise));
  if (input.missing.length) parts.push(`Unknown: ${input.missing.slice(0, 3).join('; ')}.`);
  if (!parts.length) parts.push('Suitability is based on the stated employment and working conditions.');
  return parts.join(' ');
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1) + (value.endsWith('.') ? '' : '.');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
