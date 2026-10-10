import type { AppConfig } from '../config/index.js';
import { extractCountry } from '../normalize/index.js';
import { normalizeText } from '../util/text.js';
import { detectEngagement, detectWorkMode, jobText, requirementMentions, requirementSource, sentences } from './signals.js';
import type { MandatoryGapEvidence, MatchableJob } from './types.js';

export interface MatchingConstraints {
  hardRejectReasons: string[];
  evidence: MandatoryGapEvidence[];
  preferredGaps: string[];
  missing: string[];
  requiresReview: boolean;
}

const LANGUAGES: Record<string, { name: string; aliases: string[] }> = {
  en: { name: 'English', aliases: ['English', 'Englisch', 'Englischkenntnisse', 'angielski', 'angielskiego', 'anglais', 'Engels'] },
  de: { name: 'German', aliases: ['German', 'Deutsch', 'Deutschkenntnisse', 'niemiecki', 'niemieckiego', 'allemand', 'Duits'] },
  fr: { name: 'French', aliases: ['French', 'Franzosisch', 'Franzosischkenntnisse', 'francuski', 'francuskiego', 'francais', 'Frans'] },
  nl: { name: 'Dutch', aliases: ['Dutch', 'Niederlandisch', 'niderlandzki', 'neerlandais', 'Nederlands'] },
  it: { name: 'Italian', aliases: ['Italian', 'Italienisch', 'wloski', 'włoskiego', 'italien', 'Italiaans'] },
  es: { name: 'Spanish', aliases: ['Spanish', 'Spanisch', 'hiszpanski', 'hiszpanskiego', 'espagnol', 'Spaans'] },
  pl: { name: 'Polish', aliases: ['Polish', 'Polnisch', 'polski', 'polskiego', 'polonais', 'Pools'] },
  ru: { name: 'Russian', aliases: ['Russian', 'Russisch', 'rosyjski', 'rosyjskiego', 'russe'] },
  bg: { name: 'Bulgarian', aliases: ['Bulgarian', 'Bulgarisch', 'bulgare', 'Bulgaars'] },
  uk: { name: 'Ukrainian', aliases: ['Ukrainian', 'Ukrainisch', 'ukrainski', 'ukrainien'] },
  ar: { name: 'Arabic', aliases: ['Arabic', 'Arabisch', 'arabski', 'arabe'] },
  pt: { name: 'Portuguese', aliases: ['Portuguese', 'Portugiesisch', 'portugalski', 'portugais', 'Portugees'] },
};

const COUNTRIES: Record<string, string[]> = {
  Bulgaria: ['Bulgaria', 'Bulgarien', 'Bulgarie', 'Bulgarije'],
  'United Kingdom': ['UK', 'United Kingdom', 'Britain', 'Great Britain', 'Royaume-Uni', 'Vereinigtes Konigreich'],
  'United States': ['US', 'USA', 'United States'],
  Germany: ['Germany', 'Deutschland', 'Allemagne', 'Niemcy', 'Duitsland'],
  Netherlands: ['Netherlands', 'Niederlande', 'Pays-Bas', 'Nederland'],
  Poland: ['Poland', 'Polska', 'Polen', 'Pologne'],
  France: ['France', 'Frankreich', 'Frankrijk'],
  Austria: ['Austria', 'Osterreich', 'Autriche'],
  Switzerland: ['Switzerland', 'Schweiz', 'Suisse'],
  Ireland: ['Ireland', 'Irland', 'Irlande'],
  Spain: ['Spain', 'Spanien', 'Espagne'],
  Italy: ['Italy', 'Italien', 'Italie'],
  'United Arab Emirates': ['UAE', 'United Arab Emirates'],
};
const EU_COUNTRIES = new Set(['Bulgaria', 'Germany', 'Netherlands', 'Poland', 'France', 'Austria', 'Ireland', 'Spain', 'Italy',
  'Belgium', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark', 'Estonia', 'Finland', 'Greece', 'Hungary', 'Latvia',
  'Lithuania', 'Luxembourg', 'Malta', 'Portugal', 'Romania', 'Slovakia', 'Slovenia', 'Sweden']);

const unknown = (value: unknown) => value === undefined || value === null ||
  typeof value === 'string' && /^(?:unknown|not stated|unspecified|n\/a)?$/i.test(value.trim());
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const escape = (value: string) => normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasTerm = (text: string, term: string) => new RegExp(`(?<![a-z0-9])${escape(term)}(?![a-z0-9])`).test(normalizeText(text));

function locationScopes(text: string): string[] {
  const scopes = Object.entries(COUNTRIES).filter(([, aliases]) => aliases.some((alias) => hasTerm(text, alias))).map(([country]) => country);
  for (const country of EU_COUNTRIES) if (hasTerm(text, country) && !scopes.includes(country)) scopes.push(country);
  for (const [scope, aliases] of Object.entries({ EU: ['EU', 'European Union'], EEA: ['EEA'], Europe: ['Europe', 'Europa'],
    Worldwide: ['Worldwide', 'Anywhere', 'Global', 'Monde entier'] })) {
    if (aliases.some((alias) => hasTerm(text, alias))) scopes.push(scope);
  }
  return scopes;
}

export function constraintRequirementMatches(evidence: MandatoryGapEvidence, requirement: string): boolean {
  const text = normalizeText(requirement), canonical = normalizeText(evidence.requirement);
  if (text.includes(canonical) || canonical.includes(text)) return true;
  if (evidence.profilePath === 'availability.weekly_capacity_hours') return /\b(?:hours?|capacity|workload)\b/.test(text);
  if (evidence.profilePath.startsWith('availability.')) return /\b(?:start|notice|availability|available)\b/.test(text);
  if (evidence.profilePath === 'identity.base_location') return /\b(?:residen\w*|location|remote|based|country|geograph\w*)\b/.test(text);
  if (evidence.profilePath.startsWith('work_authorization.')) return /\b(?:authori\w*|work permit|right to work|sponsor\w*)\b/.test(text);
  return false;
}

function allowedByScope(country: string, scopes: string[]): boolean {
  return scopes.includes(country) || scopes.includes('Worldwide') ||
    scopes.includes('EU') && EU_COUNTRIES.has(country) ||
    scopes.includes('EEA') && (EU_COUNTRIES.has(country) || ['Norway', 'Iceland', 'Liechtenstein'].includes(country)) ||
    scopes.includes('Europe') && (EU_COUNTRIES.has(country) || ['United Kingdom', 'Switzerland', 'Norway', 'Iceland', 'Liechtenstein'].includes(country));
}

export function nonSkillConstraintClause(clause: string): boolean {
  return Object.values(LANGUAGES).some((language) => language.aliases.some((alias) => hasTerm(clause, alias))) ||
    /\b(?:start date|start within|start immediately|start asap|notice period|weekly capacity|workload|working hours|time ?zone|residents?|residence|work authori[sz]ation|right to work)\b/.test(clause);
}

/** Only explicit requirements can demonstrate a contradiction. Unknown facts
 * and proficiency levels are retained independently of a model's answer. */
export function matchingConstraints(config: AppConfig, job: MatchableJob): MatchingConstraints {
  const result: MatchingConstraints = { hardRejectReasons: [], evidence: [], preferredGaps: [], missing: [], requiresReview: false };
  const source = requirementSource(job);
  const mentionFor = (block: string, term: string) => requirementMentions(config, source, term)
    .find((item) => normalizeText(item.quote).endsWith(normalizeText(block)) && item.clause.includes(term));
  const addMissing = (message: string, review = true) => { result.missing.push(message); result.requiresReview ||= review; };
  const reject = (reason: string, requirement: string, vacancyQuote: string, profilePath: string, fact: unknown) => {
    result.hardRejectReasons.push(reason);
    result.evidence.push({ requirement, vacancyQuote, profilePath, profileValue: typeof fact === 'object' ? JSON.stringify(fact) : String(fact) });
  };

  for (const [code, language] of Object.entries(LANGUAGES)) {
    const held = config.profile.languages.find((entry) => entry.code.toLowerCase() === code);
    for (const mention of language.aliases.flatMap((alias) => requirementMentions(config, source, alias))) {
      // A German client/company or a description written in German is not a
      // language requirement. Speaking titles and requirement lists are local.
      const after = mention.clause.slice(mention.end);
      if (/^\s+(?:company|client|office|market|customer|branch|citizens?|residents?|nationality|nationals?)\b/.test(after)) continue;
      const speaking = /^[- ]speaking\b/.test(after);
      const kind = speaking && mention.kind === 'unclear' ? 'mandatory' : mention.kind;
      const distance = (start: number, end: number) => Math.max(mention.start - end, start - mention.end, 0);
      const level = [...mention.clause.matchAll(/\b(A[12]|B[12]|C[12])\b/gi)]
        .sort((a, b) => distance(a.index, a.index + a[0].length) - distance(b.index, b.index + b[0].length))[0]?.[0].toUpperCase();
      const fluency = /\b(?:fluent|fluency|native|business|professional|verhandlungssicher\w*|sehr gute|biegł\w*|courant|vloeiend)\b/.test(mention.clause);
      if (kind === 'unclear' && !fluency && !/\b(?:language|kenntnisse|jezyk|język|langue|taal)\b/.test(mention.clause)) continue;
      if (!held) {
        if (kind === 'mandatory') reject(`${language.name} language is mandatory and is not held in profile.languages.`,
          language.name, mention.quote, 'languages', config.profile.languages);
        else if (kind === 'preferred') result.preferredGaps.push(`${language.name} language is listed as preferred`);
        else addMissing(`unclear whether ${language.name} language is mandatory`);
        continue;
      }
      if (kind === 'preferred') continue;
      const knownLevel = /^(?:A[12]|B[12]|C[12])$/i.test(held.proficiency) ? held.proficiency.toUpperCase() : null;
      if (level) {
        if (!knownLevel) addMissing(`${language.name} ${level} requirement needs confirmation; ${held.proficiency} does not establish a CEFR level`);
        else if (['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(knownLevel) < ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(level)) {
          if (kind === 'mandatory') reject(`${language.name} ${level} exceeds the declared ${knownLevel} language level.`, language.name,
            mention.quote, `languages.${config.profile.languages.indexOf(held)}.proficiency`, held.proficiency);
          else addMissing(`unclear whether ${language.name} ${level} is mandatory`);
        }
      } else if (fluency && !['native', 'fluent'].includes(held.proficiency.toLowerCase())) {
        addMissing(`${language.name} fluency requirement needs confirmation; declared proficiency is ${held.proficiency}`);
      }
    }
  }

  const availability = config.profile.availability ?? {};
  for (const block of sentences(source)) {
    const clause = normalizeText(block);
    const workload = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:\/|per|a|each)\s*week\b/.exec(clause);
    if (workload) {
      const mention = mentionFor(block, workload[0]);
      const mandatory = mention?.kind === 'mandatory' || /\b(?:workload|working hours|commitment|work)\b/.test(clause);
      if (mention?.kind !== 'preferred') {
        const capacity = number(availability.weekly_capacity_hours);
        if (capacity === null) addMissing('candidate weekly capacity is unknown; vacancy workload needs confirmation');
        else if (Number(workload[1]) > capacity) {
          if (mandatory) reject(`Required workload (${workload[1]} hours/week) exceeds declared capacity (${capacity}).`, 'weekly capacity',
            mention?.quote ?? block, 'availability.weekly_capacity_hours', capacity);
          else addMissing(`whether ${workload[1]} hours/week is required is unknown; declared capacity is ${capacity}`);
        }
      }
    }
    const start = /\b(?:start(?:ing)?|commence|begin|notice period|availability|available)\b[^.!?]*?\b(?:immediate(?:ly)?|asap|within\s+\d+\s+days?|\d{4}-\d{2}-\d{2})\b/.exec(clause);
    if (start) {
      const mention = mentionFor(block, start[0]);
      if (mention?.kind !== 'preferred') {
        const mandatory = mention?.kind === 'mandatory' || /\b(?:start(?:ing)?|commence|begin)\s*(?::|date|within|immediate|asap|on|by)/.test(start[0]);
        if (availability.status === 'unavailable' && mandatory) {
          reject('The profile is unavailable for the required start.', 'start availability', mention?.quote ?? block, 'availability.status', availability.status);
        } else {
          const days = /within\s+(\d+)\s+days?/.exec(start[0]);
          const deadlineDays = days ? Number(days[1]) : /immediate|asap/.test(start[0]) ? 0 : null;
          const notice = number(availability.notice_period_days);
          if (deadlineDays !== null) {
            if (notice === null) addMissing('candidate notice period is unknown; required start needs confirmation');
            else if (notice > deadlineDays) {
              if (mandatory) reject(`Required start within ${deadlineDays} days conflicts with the ${notice}-day notice period.`, 'start availability',
                mention?.quote ?? block, 'availability.notice_period_days', notice);
              else addMissing('whether the immediate start is mandatory needs confirmation');
            }
            if (unknown(availability.status)) addMissing('candidate availability status is unknown');
            if (unknown(availability.earliest_start)) addMissing('candidate earliest start date is unknown; start readiness needs confirmation', false);
            else addMissing(`the calendar deadline for the relative start window needs confirmation against earliest start ${String(availability.earliest_start)}`);
          } else {
            const deadline = /\d{4}-\d{2}-\d{2}/.exec(start[0])?.[0];
            const earliest = availability.earliest_start;
            if (typeof earliest !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(earliest)) {
              addMissing('candidate earliest start date is unknown; required start date needs confirmation');
            } else if (deadline && earliest > deadline) {
              if (mandatory) reject(`Required start (${deadline}) precedes the declared earliest start (${earliest}).`, 'start availability',
                mention?.quote ?? block, 'availability.earliest_start', earliest);
              else addMissing('whether the stated start date is mandatory needs confirmation');
            }
          }
        }
      }
    }
    if (/\b(?:full[- ]time|part[- ]time)\b/.test(clause) && !workload && /\b(?:required|mandatory|commitment|workload)\b/.test(clause)) {
      addMissing('required workload has no stated weekly hours; capacity compatibility needs confirmation');
    }
    if (!start && /\b(?:start date|starting date|earliest start|notice period)\b/.test(clause)) {
      addMissing('vacancy start / notice requirement has no comparable date or duration; availability needs confirmation');
    }
    const schedule = /\b(?:time ?zone|working hours|business hours|[cepm][ds]t|cest|eest|cet|eet|gmt|utc)\b|\b\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\b/.exec(clause);
    if (schedule) {
      addMissing('working hours and timezone compatibility need confirmation', mentionFor(block, schedule[0])?.kind === 'mandatory');
    }
  }

  const baseCountry = extractCountry(config.profile.identity.base_location);
  const text = jobText(job);
  const remote = detectWorkMode(config, job, text) === 'fully_remote';
  const engagement = detectEngagement(config, job, text);
  const auth = config.profile.work_authorization ?? {};
  let residencyFound = false;
  let authFound = false;
  for (const block of sentences(source)) {
    const clause = normalizeText(block);
    if (/\b(?:citizens? only|citizenship|nationality)\b/.test(clause)) {
      addMissing('candidate citizenship / nationality eligibility is not stated and cannot be inferred from residence');
    }
    const residency = /candidate required location\s*:\s*(.+)|\b(?:residents?|residence|residency)\b|\b(?:must|only|requires?|required|mandatory)\b[^.!?]*\b(?:based|located|reside|living|work from)\b|\bremote\b[^.!?]*\b(?:only|within|from)\b|\b(?:residents? uniquement|wohnsitz|woonachtig)\b/.exec(clause);
    if (residency && !/candidate required location:\s*(?:not stated|unknown)/.test(clause)) {
      residencyFound = true;
      // An EU remote format does not cancel a narrower residents-only rule.
      const residencePart = clause.split(/,|\s+(?:but|whereas|while)\s+/)
        .find((part) => /\b(?:residents?|residence|residency|based|located|reside|living|wohnsitz|woonachtig)\b/.test(part));
      const scopeText = /candidate required location/.test(clause) ? clause : residencePart ?? clause;
      const scopes = locationScopes(scopeText);
      const specific = /\b(?:residents?|residence|residency|based|located|reside|living|wohnsitz|woonachtig)\b/.exec(scopeText);
      const mention = mentionFor(block, specific?.[0] ?? residency[0]);
      const optional = mention?.kind === 'preferred' || /\bno\s+(?:residence|residency|resident)\w*\s+requirement\b/.test(scopeText);
      const mandatory = mention?.kind === 'mandatory' || /candidate required location|\bonly\b|\bwithin\b/.test(scopeText);
      if (!optional) {
        if (!scopes.length || !baseCountry) addMissing('candidate residence / permitted remote working location needs confirmation');
        else if (!allowedByScope(baseCountry, scopes)) {
          if (mandatory && (remote || config.profile.travel?.accepts_relocation === false)) {
            reject(`Required candidate location (${scopes.join(' / ')}) excludes the declared base in ${baseCountry}.`, 'candidate residence',
              mention?.quote ?? block, 'identity.base_location', config.profile.identity.base_location);
          } else addMissing(`ability to meet the candidate location restriction (${scopes.join(' / ')}) needs confirmation`);
        }
      }
    }
    const authorization = /\b(?:right to work|work authori[sz]ation|work permit|employment authori[sz]ation|no (?:visa )?sponsorship|arbeitserlaubnis|autorisation de travail|werkvergunning)\b/.exec(clause);
    if (authorization) {
      authFound = true;
      const mention = mentionFor(block, authorization[0]);
      if (mention?.kind === 'preferred') continue;
      if (/\bno (?:visa )?sponsorship\b/.test(clause) && auth.requires_sponsorship === true) {
        reject('Sponsorship is excluded but the profile explicitly requires it.', 'work authorization', mention?.quote ?? block,
          'work_authorization.requires_sponsorship', true);
        continue;
      }
      const scopes = locationScopes(clause);
      const country = scopes.find((scope) => Object.hasOwn(COUNTRIES, scope) || EU_COUNTRIES.has(scope)) ??
        (scopes.includes('EU') || scopes.includes('EEA') ? 'EU/EEA local employment' : job.locationCountry);
      const key = country === 'United Kingdom' ? 'uk' : country === 'United States' ? 'usa' : country ? normalizeText(country).replace(/ /g, '_') : null;
      const permission = key ? auth[key] : undefined;
      if (key && (permission === 'unauthorized' || permission === 'not_authorized' || permission === false) && mention?.kind === 'mandatory') {
        reject(`Required work authorization for ${country} is explicitly not held.`, 'work authorization', mention.quote,
          `work_authorization.${key}`, permission);
      } else if (unknown(permission) || !['authorized', 'authorized_as_employee'].includes(String(permission))) {
        addMissing(`work authorization / sponsorship for ${country ?? 'the required jurisdiction'} is not established`);
      }
    }
  }
  if (remote && !residencyFound) addMissing(`permission to perform this remote role from ${baseCountry ?? 'the declared base'} is not stated`, false);
  // EU contractor permission cannot establish local employment authorization.
  if (!authFound && (!remote || engagement !== 'contract') && job.locationCountry &&
    !(job.locationCountry === 'Bulgaria' && auth.bulgaria === 'authorized')) {
    addMissing(`local employment work authorization for ${job.locationCountry} is not established`, false);
  }
  result.hardRejectReasons = [...new Set(result.hardRejectReasons)];
  result.missing = [...new Set(result.missing)];
  result.preferredGaps = [...new Set(result.preferredGaps)];
  result.evidence = result.evidence.filter((item, index, all) =>
    all.findIndex((other) => other.requirement === item.requirement && other.profilePath === item.profilePath && other.vacancyQuote === item.vacancyQuote) === index);
  return result;
}
