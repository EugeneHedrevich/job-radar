import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { capabilityExpression, pattern, requirementMentions, type CapabilityExpression, type RequirementMention } from './signals.js';

type AbapCapability = 'basic' | 'development' | 'unspecified';

export const proficiencyLevels: Record<string, number> = { basic: 1, working: 2, strong: 3, advanced: 3, expert: 4 };

export function requiredProficiency(mention: RequirementMention): string | undefined {
  const prefix = mention.clause.slice(0, mention.start);
  const suffix = mention.clause.slice(mention.end);
  return /\b(expert|advanced|strong|working|basic)\s+(?:(?:knowledge|experience|understanding|of|in|with|sap)\s+)*$/.exec(prefix)?.[1] ??
    /^\s+(?:(?:knowledge|experience|proficiency|at|level|is|are|must|be|an?|the)\s+){0,5}(expert|advanced|strong|working|basic)\b/.exec(suffix)?.[1];
}

export function capabilityParts(text: string): string[] {
  return normalizeText(text).replace(/\bS\/4(?:HANA)?\b|\bFI\/CO\b|\bSD\/MM\b|\bAMDP\/CDS\b/gi, (term) => term.replaceAll('/', '∕'))
    .split(/,|\s+(?:and|und|sowie|as well as|with|using|or|oder)\s+|\s*[&/+|]\s*/)
    .map((part) => part.replaceAll('∕', '/'));
}

function certificationMention(mention: RequirementMention): boolean {
  const boundaries = [...mention.clause.matchAll(/,|\s+(?:and|und|sowie|with|using|or|oder)\s+|\s*[&/+|]\s*/g)];
  const start = boundaries.filter((match) => match.index + match[0].length <= mention.start).at(-1);
  const end = boundaries.find((match) => match.index >= mention.end);
  return /\b(?:certificat\w*|certified)\b/.test(mention.clause.slice(start ? start.index + start[0].length : 0, end?.index));
}

/** Retain the unmatched members of a fragment instead of letting a known skill
 * hide them. A certification is a separate fact, never proved by a skill. */
export function unknownCapabilityFragments(config: AppConfig, fragment: string): string[] {
  const known = [...Object.values(config.profile.skills).flatMap((skills) => skills.flatMap((skill) => [skill.name, ...(skill.aliases ?? [])])),
    ...config.profile.not_claimed.flatMap((claim) => [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])])];
  const markers = ['\\bnot\\s+optional\\b', '\\b(?:not|never)\\s+(?:strictly\\s+)?(?:required|mandatory|essential|compulsory|obligatory)\\b',
    ...(config.scoring.signals.mandatory_markers ?? []), ...(config.scoring.signals.preferred_markers ?? []), '\\b(?:optional|voluntary)\\b'];
  return capabilityParts(fragment).flatMap((part) => {
    let residual = part;
    for (const marker of markers) residual = residual.replace(pattern(marker, 'gi'), ' ');
    const certification = /\b(?:certificat\w*|certified)\b/.test(residual);
    if (!certification) for (const term of [...known].sort((a, b) => b.length - a.length)) {
      const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      residual = residual.replace(pattern(`(?<![a-z0-9])(?:sap\\s+)?${escaped}(?![a-z0-9])`, 'g'), ' ');
    }
    residual = residual.replace(/^(?:[-*#]+|\d+[.)])\s*/, '')
      .replace(/\b(?:is|are|be|a|an|skills?|requirements?|qualifications?)\b/g, ' ')
      .replace(/[():.!?]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!certification) residual = residual.replace(/^(?:(?:experience|knowledge|understanding|proficiency|expert|advanced|strong|basic|working|deep|extensive|in|of|with|at|least|either|both|the)\s+)+/, '')
      .replace(/\s+(?:(?:experience|knowledge|understanding|proficiency|development|in|of|with|at|level)\s*)+$/, '').trim();
    if (!residual || /^(?:experience|knowledge|understanding|proficiency|development|expert|advanced|strong|basic|working|in|of|with|and|or|either|both|the|to|for|you|will|we|our|your|mit|und|oder|der|die|das)(?:\s+(?:of|in|with|and|or|the|will))*$/.test(residual)) return [];
    return [residual];
  });
}

export type AlternativeStatus = 'satisfied' | 'incompatible' | 'uncertain';

/** Each alternative is a conjunction: all its requirements need evidence. */
export function capabilityAlternativeStatus(config: AppConfig, group: string): AlternativeStatus {
  const expression = capabilityExpression(config, group);
  if (!expression) return 'uncertain';
  const evaluate = (node: CapabilityExpression): AlternativeStatus | 'optional' => {
    if (node.kind !== 'term') {
      const children = node.children.map(evaluate);
      return node.kind === 'or' ? children.includes('satisfied') ? 'satisfied' :
        children.every((state) => state === 'incompatible') ? 'incompatible' : 'uncertain' :
        children.includes('incompatible') ? 'incompatible' : children.every((state) => state === 'optional') ? 'optional' :
          children.every((state) => state === 'satisfied' || state === 'optional') ? 'satisfied' : 'uncertain';
    }
    const branch = group.slice(node.start, node.end);
    let evidenced = false;
    let contradicted = false;
    let optional = false, required = false, unclear = false;
    const compulsory = (mention: RequirementMention) => {
      if (mention.kind === 'preferred') { optional = true; return false; }
      if (mention.kind === 'unclear') { unclear = true; return false; }
      required = true;
      return true;
    };
    for (const skill of Object.values(config.profile.skills).flat()) {
      for (const choice of [skill.name, ...(skill.aliases ?? [])].flatMap((alias) => requirementMentions(config, branch, alias, 'mandatory'))) {
        if (!compulsory(choice)) continue;
        // The mention may name a required certificate, rather than capability.
        if (certificationMention(choice)) continue;
        const level = requiredProficiency(choice);
        if (level && proficiencyLevels[level]! > proficiencyLevels[skill.proficiency]!) contradicted = true;
        else evidenced = true;
      }
    }
    for (const claim of config.profile.not_claimed) {
      const mentions = [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])]
        .flatMap((alias) => requirementMentions(config, branch, alias, 'mandatory'));
      if (mentions.some((mention) => compulsory(mention) && unclaimedCapability(claim, mention))) contradicted = true;
    }
    const unknown = unknownCapabilityFragments(config, branch).filter((capability) => {
      const mentions = requirementMentions(config, branch, capability, 'mandatory');
      return !mentions.length || mentions.some(compulsory);
    });
    if (unclear) return 'uncertain';
    // An optional term is neutral within AND, without claiming profile evidence.
    if (optional && !required && !unknown.length) return 'optional';
    if (contradicted) return 'incompatible';
    return evidenced && !unknown.length ? 'satisfied' : 'uncertain';
  };
  const result = evaluate(expression);
  return result === 'optional' ? 'uncertain' : result;
}

/** Preserve group uncertainty/contradiction on every member for both engines. */
export function capabilityMentions(config: AppConfig, text: string, term: string): RequirementMention[] {
  return requirementMentions(config, text, term).map((mention) => {
    if (mention.kind !== 'mandatory' || !mention.alternativeGroup) return mention;
    const alternativeStatus = capabilityAlternativeStatus(config, mention.alternativeGroup);
    return { ...mention, alternativeStatus, kind: alternativeStatus === 'satisfied' ? 'preferred' :
      alternativeStatus === 'incompatible' ? 'mandatory' : 'unclear' };
  });
}

/** Interpret the occurrence, not every ABAP word anywhere in the ad. */
export function abapCapability(mention: RequirementMention): AbapCapability {
  const occurrences = [...mention.clause.matchAll(/\babap\b/g)];
  const position = occurrences.findIndex((match) => match.index === mention.start ||
    match.index >= mention.start && match.index < mention.end);
  const before = position > 0 ? occurrences[position - 1]!.index + 4 : 0;
  const after = position >= 0 && position < occurrences.length - 1 ? occurrences[position + 1]!.index : mention.clause.length;
  const prefix = mention.clause.slice(before, mention.start);
  const conjunctions = [...prefix.matchAll(/\b(?:and|but|whereas|while|und|et|en)\b/g)];
  const localStart = conjunctions.length ? before + conjunctions.at(-1)!.index + conjunctions.at(-1)![0].length : before;
  const suffix = mention.clause.slice(mention.end, after);
  const nextConjunction = /\b(?:and|but|whereas|while|und|et|en)\b/.exec(suffix);
  const localEnd = nextConjunction ? mention.end + nextConjunction.index : after;
  const context = mention.clause.slice(localStart, localEnd);
  const basic = /\b(?:basic|fundamental|understand\w*|read\w*|debug\w*|troubleshoot\w*|grundkenntnisse|verstandnis|lesen|podstaw\w*|czytani\w*|debugowani\w*|comprehension|lecture|basiskennis)\b/.test(context);
  const ownership = '(?:develop(?:ment|ing)?|programming|implement(?:ation|ing)?|custom(?:ization|ising|izing)?|entwic\\w*|programowani\\w*|developpement|ontwikkeling)';
  const ownsDevelopment = new RegExp(`\\b${ownership}\\b`).test(mention.clause.slice(mention.start, mention.end)) ||
    new RegExp(`\\b${ownership}\\s+(?:(?:in|of|with|independent|custom|new|own|sap)\\s+){0,4}$`).test(mention.clause.slice(localStart, mention.start)) ||
    new RegExp(`^\\s+(?:(?:oo|objects|cloud|custom)\\s+){0,3}${ownership}\\b`).test(mention.clause.slice(mention.end, localEnd));
  // Reading existing ABAP developer code is not owning its development.
  if (basic && !ownsDevelopment) return 'basic';
  if (ownsDevelopment || /\babap\s+(?:oo|objects|developer|programmer)\b|object[- ]oriented\s+abap/.test(context)) return 'development';
  return 'unspecified';
}

/** The generic ABAP alias only proves a development gap in a development context. */
export function unclaimedMentions(config: AppConfig, text: string, claim: string): RequirementMention[] {
  const mentions = [claim, ...(config.profile.not_claimed_aliases[claim] ?? [])]
    .flatMap((term) => capabilityMentions(config, text, term));
  return mentions.filter((mention) => unclaimedCapability(claim, mention));
}

function unclaimedCapability(claim: string, mention: RequirementMention): boolean {
  if (certificationMention(mention)) return false;
  if (!/abap/i.test(claim)) return true;
  const capability = abapCapability(mention);
  return capability === 'development' || capability === 'unspecified' && claim !== 'ABAP development';
}

export function abapUncertainty(config: AppConfig, text: string): { missing: string[]; requiresReview: boolean } {
  const declared = Object.values(config.profile.skills).flat().find((skill) => normalizeText(skill.name) === 'abap');
  const missing: string[] = [];
  let requiresReview = false;
  for (const mention of capabilityMentions(config, text, 'ABAP')) {
    const capability = abapCapability(mention);
    if (capability === 'development') continue;
    if (capability === 'basic' && declared &&
      !/\b(?:expert|advanced|strong|deep|extensive)\b/.test(mention.clause)) continue;
    const detail = capability === 'basic' ? 'basic ABAP understanding, reading or debugging' : 'the required ABAP capability and level';
    missing.push(`profile evidence for ${detail} is not stated (${mention.kind})`);
    if (mention.kind !== 'preferred') requiresReview = true;
  }
  return { missing: [...new Set(missing)], requiresReview };
}
