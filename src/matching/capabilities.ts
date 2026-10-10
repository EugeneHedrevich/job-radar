import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import { requirementMentions, type RequirementMention } from './signals.js';

type AbapCapability = 'basic' | 'development' | 'unspecified';

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
    .flatMap((term) => requirementMentions(config, text, term));
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
  for (const mention of requirementMentions(config, text, 'ABAP')) {
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
