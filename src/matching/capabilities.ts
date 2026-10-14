import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { requirementMentions, type RequirementMention } from './signals.js';

type AbapCapability = 'basic' | 'development' | 'unspecified';

export const proficiencyLevels: Record<string, number> = { basic: 1, working: 2, strong: 3, advanced: 3, expert: 4 };

export function requiredProficiency(mention: RequirementMention): string | undefined {
  const prefix = mention.clause.slice(0, mention.start);
  const suffix = mention.clause.slice(mention.end);
  return /\b(expert|advanced|strong|working|basic)\s+(?:(?:knowledge|experience|understanding|of|in|with|sap)\s+)*$/.exec(prefix)?.[1] ??
    /^\s+(?:(?:knowledge|experience|proficiency|at|level|is|are|must|be|an?|the)\s+){0,5}(expert|advanced|strong|working|basic)\b/.exec(suffix)?.[1];
}

/** One evidenced choice satisfies an explicit skill alternative. Insufficient
 * proficiency or basic ABAP never establishes an independent development skill. */
export function capabilityMentions(config: AppConfig, text: string, term: string): RequirementMention[] {
  return requirementMentions(config, text, term).map((mention) => {
    if (mention.kind !== 'mandatory' || !mention.alternativeGroup) return mention;
    const satisfied = Object.values(config.profile.skills).flat().some((skill) =>
      [skill.name, ...(skill.aliases ?? [])].some((alias) =>
        requirementMentions(config, mention.alternativeGroup!, alias).some((choice) => {
          const level = requiredProficiency(choice);
          if (level && proficiencyLevels[level]! > proficiencyLevels[skill.proficiency]!) return false;
          if (normalizeText(skill.name) === 'abap' && abapCapability(choice) === 'development' &&
            config.profile.not_claimed.some((claim) => /abap.*development/i.test(claim))) return false;
          return true;
        })));
    return { ...mention, kind: satisfied ? 'preferred' : 'unclear' };
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
  if (!/abap/i.test(claim)) return mentions;
  return mentions.filter((mention) => {
    const capability = abapCapability(mention);
    return capability === 'development' || capability === 'unspecified' && claim !== 'ABAP development';
  });
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
