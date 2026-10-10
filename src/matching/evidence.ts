import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { jobText, onsiteDaysPerMonth, requirementKind, sentences } from './signals.js';
import type { MandatoryGapEvidence, MatchableJob } from './types.js';

function sourceText(value: string): string {
  return normalizeText(value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' '));
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
export function validateGapEvidence(config: AppConfig, job: MatchableJob, gap: MandatoryGapEvidence): string | null {
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
  if (unknown(fact) || !['string', 'number', 'boolean'].includes(typeof fact) || String(fact) !== gap.profileValue) {
    return `profile fact for "${gap.requirement}" is unknown or does not match the stated evidence`;
  }
  const text = jobText(job).all;
  const mandatory = (terms: string[]) => {
    const term = termsInQuote(quote, terms);
    return term && termsInQuote(sourceText(gap.requirement), terms) &&
      requirementKind(config, quote, term) !== 'preferred' && requirementKind(config, text, term) === 'mandatory';
  };
  if (path[0] === 'not_claimed' && path.length === 2) {
    const claim = String(fact);
    if (mandatory([claim, ...(config.profile.not_claimed_aliases[claim] ?? [])])) return null;
  }
  if (path[0] === 'skills' && path.length === 4 && path[3] === 'proficiency') {
    const skill = config.profile.skills[path[1]!]?.[Number(path[2])];
    const levels: Record<string, number> = { basic: 1, working: 2, strong: 3, expert: 4 };
    if (skill && mandatory([skill.name, ...(skill.aliases ?? [])])) {
      const terms = [skill.name, ...(skill.aliases ?? [])];
      for (const clause of sentences(quote).flatMap((part) => part.split(','))) {
        const term = termsInQuote(clause, terms);
        if (!term || requirementKind(config, clause, term) !== 'mandatory') continue;
        const position = clause.indexOf(normalizeText(term));
        const required = [...clause.matchAll(/\b(expert|advanced|strong|working|basic)\b/g)]
          .sort((a, b) => Math.abs(a.index - position) - Math.abs(b.index - position))[0]?.[1];
        if (required && (levels[required === 'advanced' ? 'strong' : required] ?? 0) > (levels[skill.proficiency] ?? 0)) return null;
      }
    }
  }
  if (path[0] === 'education' && path.length === 3) {
    // A related field / equivalent experience is an unresolved alternative,
    // not proof that Chemical Engineering is incompatible.
    if (/\b(?:related|equivalent|or|similar)\b/.test(quote)) {
      return `education equivalency for "${gap.requirement}" is not established`;
    }
    const degree = /\b(?:degree|bachelor\w*|master\w*|phd|doctorate)\b/.exec(quote)?.[0];
    if (degree && /\b(?:degree|bachelor\w*|master\w*|phd|doctorate|education)\b/.test(sourceText(gap.requirement)) &&
      requirementKind(config, quote, degree) !== 'preferred' && requirementKind(config, text, degree) === 'mandatory') {
      const ranks = (value: string) => /phd|doctorate|doctoral/i.test(value) ? 3 : /master/i.test(value) ? 2 : /bachelor/i.test(value) ? 1 : null;
      if (path[2] === 'qualification') {
        const requiredRank = ranks(quote);
        const knownRanks = config.profile.education.map((entry) => ranks(entry.qualification ?? ''));
        if (requiredRank !== null && knownRanks.length && knownRanks.every((rank) => rank !== null && rank < requiredRank)) return null;
      }
      // A stated Chemical Engineering field is not proof that the candidate
      // has no other degree or cannot meet an equivalent qualification.
      if (path[2] === 'field') return `education eligibility for "${gap.requirement}" is not established by the declared field alone`;
    }
  }
  if (gap.profilePath === 'travel.max_onsite_days_per_month' && typeof fact === 'number') {
    const days = onsiteDaysPerMonth(config, text).mandatory;
    if (days !== null && days > fact && /\b(?:onsite|on-site|office|travel)\b/.test(sourceText(gap.requirement)) && /\b(?:onsite|on-site|office)\b/.test(quote) &&
      (onsiteDaysPerMonth(config, quote).mandatory ?? 0) > fact) return null;
  }
  // SAP experience is a stated floor (7+), never a confirmed upper bound.
  return `incompatibility for "${gap.requirement}" is not confirmed by the cited profile fact`;
}

/** Education omissions are retained even if the model forgets to report them. */
export function educationUncertainty(config: AppConfig, job: MatchableJob): string[] {
  const text = jobText(job).all;
  if (!/\b(?:degree|bachelor\w*|master\w*|phd|doctorate|education)\b/.test(text)) return [];
  const missing: string[] = [];
  if (!config.profile.education.length) missing.push('candidate education is not stated; vacancy education requirements need confirmation');
  else if (config.profile.education.some((entry) => unknown(entry.qualification))) {
    missing.push('candidate qualification level is unknown; vacancy degree requirements need confirmation');
  }
  if (/\b(?:related field|related discipline|equivalent (?:education|experience)|similar (?:field|qualification))\b/.test(text)) {
    missing.push('whether the declared education or experience satisfies the vacancy education alternatives is unknown');
  }
  return missing;
}

/** Preserve explicit but undocumented capability requirements independently of
 * the model. Lists use requirementKind's local mandatory/preferred boundaries. */
export function unknownSkillRequirements(config: AppConfig, job: MatchableJob): string[] {
  const text = jobText(job).all;
  const known = [
    ...Object.values(config.profile.skills).flatMap((skills) => skills.flatMap((skill) => [skill.name, ...(skill.aliases ?? [])])),
    ...config.profile.not_claimed.flatMap((claim) => [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])]),
  ];
  const result: string[] = [];
  const markers = [...(config.scoring.signals.mandatory_markers ?? []), ...(config.scoring.signals.preferred_markers ?? [])];
  for (const clause of sentences(text).flatMap((part) => part.split(','))) {
    let capability = clause;
    for (const marker of markers) capability = capability.replace(new RegExp(marker, 'gi'), '');
    capability = capability.replace(/^(?:[-*#]+|\d+[.)])\s*/, '')
      .replace(/\b(?:is|are|a|an|skills?|requirements?|qualifications?)\b/g, '').replace(/[:.!?]/g, '').trim();
    // Connective fragments under a requirement heading are not capabilities.
    if (/^(?:(?:and|or|with|in|of|to|for|the|you|will|we|our|your|mit|und|oder|der|die|das)\s*)+$/.test(capability)) continue;
    if (!capability || termsInQuote(capability, known) ||
      /\b(?:onsite|on-site|office|remote|hybrid|travel|attendance|relocat\w*|days?|hours?|years?|degree|bachelor\w*|master\w*|education|english|german|french|dutch|italian|spanish|polish|russian|language|rate|salary|contract|freelanc\w*|b2b|work permit|authori[sz]ation)\b/.test(capability)) continue;
    if (requirementKind(config, text, capability) === 'mandatory') {
      result.push(`profile evidence for required capability "${capability}" is not stated`);
    }
  }
  return [...new Set(result)];
}

export function deterministicGapEvidence(config: AppConfig, job: MatchableJob): MandatoryGapEvidence[] {
  const evidence: MandatoryGapEvidence[] = [];
  const text = jobText(job).all;
  const source = `${job.title}\n${(job.description ?? '').replace(/<\/?(?:li|p|div|h[1-6])\b[^>]*>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')}`;
  for (const [index, claim] of config.profile.not_claimed.entries()) {
    const terms = [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])];
    if (!terms.some((term) => requirementKind(config, text, term) === 'mandatory')) continue;
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
        if (requirementKind(config, candidate, term) === 'mandatory') {
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
