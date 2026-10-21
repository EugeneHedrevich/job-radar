import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { jobText, onsiteDaysPerMonth, requirementKind, requirementSource, sentences, type Requirement, type RequirementMention } from './signals.js';
import type { MandatoryGapEvidence, MatchableJob } from './types.js';
import { capabilityMentions, capabilityParts, unclaimedMentions, unknownCapabilityFragments } from './capabilities.js';
import { constraintRequirementMatches, nonSkillConstraintClause } from './constraints.js';
import { analyzeVacancy, type VacancyAnalysis } from './analysis.js';

function sourceText(value: string): string {
  return normalizeText(value.replace(/<[^>]*>/g, ' ').replace(/\*\*|__|`/g, '').replace(/&nbsp;/g, ' '));
}

const unknown = (value: unknown) => value === undefined || value === null ||
  typeof value === 'string' && /^(?:unknown|not stated|unspecified|n\/a)?$/i.test(value.trim());

function termsInQuote(quote: string, terms: string[]): string | undefined {
  return terms.find((term) => {
    const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(quote);
  });
}

/** Unknown is not absence. Evidence must cite a real requirement and a known,
 * relevant profile fact that actually demonstrates incompatibility. */
export function validateGapEvidence(config: AppConfig, job: MatchableJob, gap: MandatoryGapEvidence, analysis?: VacancyAnalysis): string | null {
  const quote = sourceText(gap.vacancyQuote);
  if (!quote || !sourceText(`${job.title}\n${job.description ?? ''}`).includes(quote)) {
    return `unsupported requirement "${gap.requirement}": vacancy quote is not present in the source`;
  }
  const path = gap.profilePath.split('.');
  let fact: any = config.profile;
  for (const part of path) {
    if (!fact || !Object.hasOwn(fact, part)) { fact = undefined; break; }
    fact = fact[part];
  }
  const arrayFact = gap.profilePath === 'languages' || gap.profilePath === 'engagement.rejected_types';
  const value = arrayFact ? JSON.stringify(fact) : String(fact);
  if (unknown(fact) || (!['string', 'number', 'boolean'].includes(typeof fact) && !arrayFact) || value !== gap.profileValue) {
    return `profile fact for "${gap.requirement}" is unknown or does not match the stated evidence`;
  }
  const verified = (analysis ?? analyzeVacancy(config, job)).mandatoryGapEvidence.some((item) => {
    if (item.profilePath !== gap.profilePath || item.profileValue !== gap.profileValue ||
      !quote.includes(sourceText(item.vacancyQuote))) return false;
    if (constraintRequirementMatches(item, gap.requirement)) return true;
    const aliases = config.profile.not_claimed_aliases[item.requirement] ?? [];
    return Boolean(termsInQuote(sourceText(gap.requirement), aliases));
  });
  return verified ? null : `incompatibility for "${gap.requirement}" is not confirmed by the cited profile fact`;
}

/** Education omissions are retained even if the model forgets to report them. */
export function educationUncertainty(config: AppConfig, job: MatchableJob): string[] {
  const text = jobText(job).all;
  if (!/\b(?:degree|bachelor\w*|master\w*|phd|doctorate|education|studium|ausbildung|abschluss\w*)\b/.test(text)) return [];
  const missing: string[] = [];
  if (!config.profile.education.length) missing.push('candidate education is not stated; vacancy education requirements need confirmation');
  else if (config.profile.education.some((entry) => unknown(entry.qualification))) {
    missing.push('candidate qualification level is unknown; vacancy degree requirements need confirmation');
  }
  if (/\b(?:related field|related discipline|equivalent (?:education|experience)|similar (?:field|qualification)|vergleichbare\w* (?:qualifikation|ausbildung))\b/.test(text)) {
    missing.push('whether the declared education or experience satisfies the vacancy education alternatives is unknown');
  }
  return missing;
}

export function unresolvedMandatoryEducation(config: AppConfig, job: MatchableJob): boolean {
  if (!educationUncertainty(config, job).length) return false;
  const text = jobText(job).all;
  return [...text.matchAll(/\b(?:degree|bachelor\w*|master\w*|phd|doctorate|education|studium|ausbildung|abschluss\w*)\b/g)]
    .some((match) => requirementKind(config, text, match[0]) === 'mandatory');
}

export interface CapabilityRequirement {
  name: string;
  kind: Requirement;
  mentions: RequirementMention[];
  profileEvidence: 'confirmed' | 'not_claimed' | 'unknown' | 'mismatch';
}

export function requirementUncertainty(requirements: CapabilityRequirement[]): { mandatory: string[]; preferred: string[] } {
  return {
    mandatory: requirements.filter((item) => item.profileEvidence === 'unknown' && item.kind !== 'preferred')
      .map((item) => `profile evidence for required capability "${item.name}" is not stated`),
    preferred: requirements.filter((item) => item.profileEvidence === 'unknown' && item.kind === 'preferred')
      .map((item) => `profile evidence for preferred capability "${item.name}" is not stated`),
  };
}

/** Each compound member is evaluated independently against profile facts. */
export function capabilityRequirements(config: AppConfig, job: MatchableJob): CapabilityRequirement[] {
  const text = requirementSource(job);
  const declared = Object.values(config.profile.skills).flatMap((skills) => skills.flatMap((skill) => [skill.name, ...(skill.aliases ?? [])]));
  const absent = config.profile.not_claimed.flatMap((claim) => [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])]);
  const result: CapabilityRequirement[] = [];
  const add = (name: string, terms: string[], mentions = terms.flatMap((term) => capabilityMentions(config, text, term)),
    evidence?: CapabilityRequirement['profileEvidence']) => {
    if (!mentions.length) return;
    const kind = mentions.some((item) => item.kind === 'mandatory') ? 'mandatory' :
      mentions.some((item) => item.kind === 'preferred') ? 'preferred' : 'unclear';
    const exactAlias = (aliases: string[]) => terms.some((term) => aliases.some((alias) => normalizeText(term) === normalizeText(alias)));
    const profileEvidence = evidence ?? (exactAlias(declared) ? 'confirmed' : exactAlias(absent) ? 'not_claimed' : 'unknown');
    result.push({ name, kind, mentions, profileEvidence });
  };
  for (const skill of Object.values(config.profile.skills).flat()) {
    const terms = [skill.name, ...(skill.aliases ?? [])];
    add(skill.name, terms, terms.flatMap((term) => capabilityMentions(config, text, term)), 'confirmed');
  }
  for (const claim of config.profile.not_claimed) add(claim, [claim], unclaimedMentions(config, text, claim), 'not_claimed');
  for (const [name, terms] of Object.entries(config.scoring.requirement_capabilities)) {
    add(name, terms);
  }
  const catalogTerms = Object.values(config.scoring.requirement_capabilities).flat();
  for (const clause of sentences(text).flatMap(capabilityParts)) {
    if (nonSkillConstraintClause(clause)) continue;
    for (const capability of unknownCapabilityFragments(config, clause)) {
      if ((!/\b(?:certificat\w*|certified)\b/.test(capability) && termsInQuote(capability, catalogTerms)) ||
        /\b(?:onsite|on-site|office|remote|hybrid|travel|attendance|relocat\w*|days?|hours?|years?|degree|bachelor\w*|master\w*|education|studium|ausbildung|abschluss\w*|english|german|french|dutch|italian|spanish|polish|russian|language|rate|salary|contract|freelanc\w*|b2b|work permit|authori[sz]ation)\b/.test(capability)) continue;
      const mentions = capabilityMentions(config, text, capability);
      if (mentions.some((item) => item.kind !== 'unclear' || item.alternativeGroup)) add(capability, [capability], mentions, 'unknown');
    }
  }
  return result.filter((item, index) => result.findIndex((other) => other.name === item.name) === index);
}

export function deterministicGapEvidence(config: AppConfig, job: MatchableJob): MandatoryGapEvidence[] {
  const evidence: MandatoryGapEvidence[] = [];
  const text = jobText(job).all;
  const source = requirementSource(job);
  for (const [index, claim] of config.profile.not_claimed.entries()) {
    const terms = [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])];
    if (!unclaimedMentions(config, text, claim).some((mention) => mention.kind === 'mandatory')) continue;
    const blocks = sentences(source);
    let quote: string | undefined;
    for (let end = 0; end < blocks.length && !quote; end++) {
      const part = blocks[end]!;
      const term = termsInQuote(sourceText(part), terms);
      if (!term || requirementKind(config, sourceText(part), term) === 'preferred') continue;
      // Include the nearest section/list heading when the item itself has no
      // marker. A bare skill from earlier duties is not requirement evidence.
      for (let start = end; start >= 0; start--) {
        const candidate = blocks.slice(start, end + 1).join('\n');
        if (unclaimedMentions(config, candidate, claim).some((mention) => mention.kind === 'mandatory')) {
          quote = candidate;
          break;
        }
      }
    }
    if (quote) evidence.push({ requirement: claim, vacancyQuote: quote, profilePath: `not_claimed.${index}`, profileValue: claim });
  }
  const limit = config.profile.travel?.max_onsite_days_per_month;
  if (typeof limit === 'number' && (onsiteDaysPerMonth(config, text).mandatory ?? 0) > limit) {
    const quote = sentences(source).find((part) => (onsiteDaysPerMonth(config, sourceText(part)).mandatory ?? 0) > limit);
    if (quote) evidence.push({ requirement: 'required onsite attendance', vacancyQuote: quote,
      profilePath: 'travel.max_onsite_days_per_month', profileValue: String(limit) });
  }
  return evidence;
}
