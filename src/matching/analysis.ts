import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { abapUncertainty, proficiencyLevels, requiredProficiency } from './capabilities.js';
import { matchingConstraints, type MatchingConstraints } from './constraints.js';
import { capabilityRequirements, deterministicGapEvidence, educationUncertainty, requirementUncertainty,
  unresolvedMandatoryEducation, type CapabilityRequirement } from './evidence.js';
import { vacancyRelevance, type Relevance } from './relevance.js';
import { detectEngagement, detectWorkMode, employmentRuleMatches, hasMandatoryOnsiteCondition,
  hasUnclearOnsiteFrequency, hourlyRate, jobText, matchesAny, onsiteDaysPerMonth, pattern, requirementMentions,
  requirementSource, type Engagement, type HourlyRate, type JobText, type OnsiteDays, type WorkMode } from './signals.js';
import type { MandatoryGapEvidence, MatchableJob, Recommendation } from './types.js';

export interface ProfileEvidence {
  name: string;
  group: string;
  profilePath: string;
  profileValue: string;
  inTitle: boolean;
  inBody: boolean;
}

export interface HardRejectHit { id: string; reason: string }

/** Facts and uncertainty shared by rules scoring and model validation. */
export interface VacancyAnalysis {
  text: JobText;
  relevance: Relevance;
  engagement: Engagement;
  workMode: WorkMode;
  rate: HourlyRate;
  attendance: OnsiteDays;
  unclearAttendance: boolean;
  requirements: CapabilityRequirement[];
  profileEvidence: ProfileEvidence[];
  constraints: MatchingConstraints;
  hardRejects: HardRejectHit[];
  mandatoryGaps: string[];
  mandatoryGapEvidence: MandatoryGapEvidence[];
  preferredGaps: string[];
  missingInformation: string[];
  requiresReview: boolean;
}

export function analyzeVacancy(config: AppConfig, job: MatchableJob): VacancyAnalysis {
  const text = jobText(job);
  const relevance = vacancyRelevance(config, job);
  const engagement = detectEngagement(config, job, text);
  const workMode = detectWorkMode(config, job, text);
  const attendance = onsiteDaysPerMonth(config, text.all);
  const unclearAttendance = hasUnclearOnsiteFrequency(config, text.all);
  const requirements = capabilityRequirements(config, job);
  const profileEvidence = Object.entries(config.profile.skills).flatMap(([group, skills]) => skills.map((skill, index) => {
    const terms = [skill.name, ...(skill.aliases ?? [])].map((term) =>
      pattern(`(?<![a-z0-9])${normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`));
    return { name: skill.name, group, profilePath: `skills.${group}.${index}.proficiency`, profileValue: skill.proficiency,
      inTitle: terms.some((term) => term.test(text.title)), inBody: terms.some((term) => term.test(text.body)) };
  })).filter((item) => item.inTitle || item.inBody);
  const constraints = matchingConstraints(config, job, { engagement, workMode });
  const levelEvidence = insufficientLevels(config, job, requirements, profileEvidence);
  for (const gap of levelEvidence) {
    constraints.hardRejectReasons.push(`Required ${gap.requirement} exceeds the declared profile level (${gap.profileValue}).`);
    constraints.evidence.push(gap);
    const skill = profileEvidence.find((item) => item.profilePath === gap.profilePath);
    const requirement = requirements.find((item) => item.name === skill?.name);
    if (requirement) requirement.profileEvidence = 'mismatch';
  }
  const hardRejects = findHardRejects(config, text, requirements, attendance);
  const rate = hourlyRate(config, job);
  if (rate.comparable && rate.upperBound !== null && rate.upperBound < config.profile.compensation.minimum_hourly_rate) {
    hardRejects.push({ id: 'minimum_rate', reason: `The stated rate is at most ${rate.upperBound.toFixed(2)} ${rate.currency}/h, below the profile minimum of ${config.profile.compensation.minimum_hourly_rate} ${rate.currency}/h.` });
  }
  if (relevance.state === 'irrelevant') hardRejects.push({ id: 'role_relevance', reason: relevance.reason! });
  hardRejects.push(...constraints.hardRejectReasons.map((reason) => ({ id: 'profile_constraint', reason })));
  const unclaimed = requirements.filter((item) => item.profileEvidence === 'not_claimed');
  const mandatoryGaps = unclaimed.filter((item) => item.kind === 'mandatory' &&
    item.mentions.some((mention) => mention.kind === 'mandatory' && !mention.alternativeGroup))
    .map((item) => `${item.name} appears to be mandatory`);
  mandatoryGaps.push(...hardRejects.filter((hit) => hit.id !== 'unclaimed_mandatory_skill').map((hit) => hit.reason));
  const unclear = unclaimed.filter((item) => item.kind === 'unclear').map((item) => `unclear whether "${item.name}" is mandatory`);
  const capabilityUnknown = requirementUncertainty(requirements);
  const unresolvedGroups = [...new Set(requirements.flatMap((item) => item.mentions)
    .filter((mention) => mention.alternativeStatus === 'uncertain').map((mention) => mention.alternativeGroup!))];
  const abap = abapUncertainty(config, text.all);
  const missingInformation = [...unclear, ...capabilityUnknown.mandatory, ...capabilityUnknown.preferred,
    ...educationUncertainty(config, job), ...constraints.missing, ...abap.missing,
    ...unresolvedGroups.map((group) => `mandatory capability grouping "${group}" needs confirmation`)];
  if (relevance.state === 'unresolved') missingInformation.push(relevance.reason!);
  if (attendance.unclear !== null) missingInformation.push(`unclear whether onsite attendance (${attendance.unclear.toFixed(1)} days/month) is mandatory`);
  if (unclearAttendance) missingInformation.push('onsite attendance frequency is not stated or unclear');
  if (!text.hasDescription) missingInformation.unshift('full description was not retrieved - assessment is based on the title only');
  return { text, relevance, engagement, workMode, rate, attendance, unclearAttendance, requirements, profileEvidence, constraints,
    hardRejects, mandatoryGaps: [...new Set(mandatoryGaps)],
    mandatoryGapEvidence: [...deterministicGapEvidence(config, job), ...constraints.evidence],
    preferredGaps: [...unclaimed.filter((item) => item.kind === 'preferred').map((item) => `${item.name} is listed as preferred`), ...constraints.preferredGaps],
    missingInformation: [...new Set(missingInformation)],
    requiresReview: relevance.state === 'unresolved' || !text.hasDescription || Boolean(unclear.length || capabilityUnknown.mandatory.length || unresolvedGroups.length || constraints.requiresReview ||
      abap.requiresReview || unresolvedMandatoryEducation(config, job) || attendance.unclear !== null || unclearAttendance) };
}

/** Mandatory contradictions win over all bonuses, for either engine. */
export function finalAssessmentPolicy(config: AppConfig, analysis: VacancyAnalysis, score: number,
  recommendation?: Recommendation, additionalEvidence: MandatoryGapEvidence[] = [], forceReview = false) {
  let fitScore = Math.max(0, Math.min(100, Math.round(score)));
  if (!analysis.text.hasDescription) fitScore = Math.min(fitScore, config.scoring.uncertainty.cap_without_description);
  const reasons = [...analysis.hardRejects.map((hit) => hit.reason), ...additionalEvidence.map((gap) => `Confirmed mandatory mismatch: ${gap.requirement}.`)];
  const hardReject = reasons.length > 0;
  if (hardReject) fitScore = Math.min(fitScore, config.scoring.hard_rejects.score_cap);
  else if (analysis.requiresReview || forceReview) fitScore = Math.min(fitScore, config.scoring.thresholds.apply - 1);
  const byScore: Recommendation = fitScore >= config.scoring.thresholds.apply ? 'Apply' :
    fitScore >= config.scoring.thresholds.review ? 'Review' : 'Skip';
  const selected = recommendation ?? byScore;
  return { fitScore, recommendation: hardReject ? 'Skip' as const : selected === 'Apply' && byScore !== 'Apply' ? 'Review' as const : selected,
    hardReject, hardRejectReason: reasons.length ? [...new Set(reasons)].join(' ') : null };
}

export function findHardRejects(config: AppConfig, text: JobText, requirements: CapabilityRequirement[], attendance: OnsiteDays): HardRejectHit[] {
  const hits: HardRejectHit[] = [];
  const limit = config.profile.travel?.max_onsite_days_per_month;
  if (typeof limit === 'number' && attendance.mandatory !== null && attendance.mandatory > limit) {
    hits.push({ id: 'travel_limit', reason: `Required onsite attendance (${attendance.mandatory.toFixed(1)} days/month) exceeds the profile limit (${limit} days/month).` });
  }
  for (const rule of config.scoring.hard_rejects.rules) {
    if (rule.id === 'language_barrier') continue;
    const matched = rule.id === 'contract_excluded' || rule.id === 'permanent_only'
      ? employmentRuleMatches(config, text.all, rule.any)
      : rule.id === 'onsite_heavy' ? hasMandatoryOnsiteCondition(config, text.all)
      : rule.id === 'abap_only' ? /\babap\s+(?:developer|programmer)\b|\brap\s+(?:developer|expert|specialist)\b/.test(text.title) && !matchesAny(text.all, rule.none)
      : matchesAny(text.all, rule.any) && !matchesAny(text.all, rule.none);
    if (matched) hits.push({ id: rule.id, reason: rule.reason });
  }
  const incompatibleGroups = new Set(requirements.flatMap((item) => item.mentions
    .filter((mention) => mention.alternativeStatus === 'incompatible').map((mention) => mention.alternativeGroup!)));
  for (const group of incompatibleGroups) hits.push({ id: 'mandatory_alternatives',
    reason: `Every alternative in the mandatory requirement "${group}" conflicts with the declared profile.` });
  for (const item of requirements.filter((item) => item.profileEvidence === 'not_claimed' && item.kind === 'mandatory' &&
    item.mentions.some((mention) => mention.kind === 'mandatory' && !mention.alternativeGroup))) {
    hits.push({ id: 'unclaimed_mandatory_skill', reason: `Required capability is explicitly not claimed in the profile: ${item.name} appears to be mandatory.` });
  }
  return hits;
}

function insufficientLevels(config: AppConfig, job: MatchableJob, requirements: CapabilityRequirement[], profile: ProfileEvidence[]): MandatoryGapEvidence[] {
  const evidence: MandatoryGapEvidence[] = [];
  for (const item of profile) {
    for (const mention of requirements.find((requirement) => requirement.name === item.name)?.mentions ?? []) {
      if (mention.kind !== 'mandatory') continue;
      const level = requiredProficiency(mention);
      if (level && proficiencyLevels[level]! > proficiencyLevels[item.profileValue]!) evidence.push({ requirement: `${level} ${item.name}`, vacancyQuote: mention.quote,
        profilePath: item.profilePath, profileValue: item.profileValue });
    }
  }
  const rank = (value: string) => /phd|doctorate|doctoral/i.test(value) ? 3 : /master/i.test(value) ? 2 : /bachelor/i.test(value) ? 1 : null;
  for (const term of ['bachelor', "bachelor's", 'master', "master's", 'phd', 'doctorate']) {
    for (const mention of requirementMentions(config, requirementSource(job), term)) {
      if (mention.kind !== 'mandatory' || /\b(?:related|equivalent|or|similar)\b/.test(mention.clause)) continue;
      const required = rank(term);
      const known = config.profile.education.map((entry) => rank(entry.qualification ?? ''));
      if (required && known.length && known.every((level) => level !== null && level < required)) {
        evidence.push({ requirement: `${term.replace(/'s$/, '')} degree`, vacancyQuote: mention.quote,
          profilePath: 'education.0.qualification', profileValue: config.profile.education[0]!.qualification! });
      }
    }
  }
  return evidence.filter((item, index, all) => all.findIndex((other) => other.requirement === item.requirement && other.profilePath === item.profilePath) === index);
}
