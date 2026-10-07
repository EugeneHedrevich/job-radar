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
  // Keep list/paragraph boundaries for requirements and attendance schedules.
  const body = (job.description ?? '')
    .replace(/<\/?(?:li|p|div|h[1-6])\b[^>]*>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/).map(normalizeText).join('\n');
  return { title, body, all: `${title}\n${body}`, hasDescription: Boolean(job.description) };
}

export function detectEngagement(config: AppConfig, job: MatchableJob, text: JobText): Engagement {
  const signals = config.scoring.signals;
  // A negated contract term must never count as a positive engagement signal.
  const exclusions = config.scoring.hard_rejects.rules.filter((rule) =>
    rule.id === 'contract_excluded' || rule.id === 'permanent_only',
  );
  if (exclusions.some((rule) => matchesAny(text.all, rule.any))) return 'permanent';
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
  const attendance = onsiteDaysPerMonth(config, text.all);
  if (Math.max(attendance.mandatory ?? 0, attendance.unclear ?? 0) > 0) return 'hybrid';
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

/** Preserve list items and clauses, without splitting technology names at dots. */
export function sentences(text: string): string[] {
  return text
    .split(/[\r\n;]+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export type Requirement = 'mandatory' | 'preferred' | 'unclear';

interface Marker<T> { start: number; end: number; kind: T }

function markers<T>(text: string, sources: readonly string[], kind: T): Marker<T>[] {
  return sources.flatMap((source) => [...text.matchAll(new RegExp(source, 'gi'))]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, kind })));
}

function nearestMarker<T>(found: Marker<T>[], start: number, end: number): Marker<T> | undefined {
  const distance = (marker: Marker<T>) => Math.max(start - marker.end, marker.start - end, 0);
  return [...found].sort((a, b) => distance(a) - distance(b) || b.start - a.start)[0];
}

/** Decide whether a term appears as a must-have or a nice-to-have. */
export function requirementKind(config: AppConfig, text: string, term: string): Requirement | null {
  const needle = normalizeText(term);
  if (!needle) return null;
  const mandatoryMarkers = config.scoring.signals.mandatory_markers ?? [];
  const preferredMarkers = config.scoring.signals.preferred_markers ?? [];
  let found = false;
  let preferred = false;
  let section: Requirement | null = null;
  for (const block of sentences(text)) {
    // A shared marker governs the remaining comma-separated items in this
    // sentence, until an item supplies its own mandatory/preferred marker.
    let listKind: Requirement | null = section;
    for (const part of block.split(/,|\s+[|•]\s*/)) {
      const clause = normalizeText(part).replace(/^(?:[-*#]+|\d+[.)])\s*/, '');
      const foundMarkers = [
        ...markers(clause, mandatoryMarkers, 'mandatory' as const),
        ...markers(clause, preferredMarkers, 'preferred' as const),
      ];
      // A marker-only heading applies to subsequent list entries. Ordinary
      // headings end that section; inline markers apply to their own skill.
      const remainder = foundMarkers.reduce((value, marker) =>
        value.replace(clause.slice(marker.start, marker.end), ''), clause)
        .replace(/[:*#]/g, '').trim();
      if (foundMarkers.length && /^(?:(?:skills|requirements|qualifications|experience)\s*)?$/.test(remainder)) {
        section = foundMarkers.some((marker) => marker.kind === 'mandatory') ? 'mandatory' : 'preferred';
        listKind = section;
        continue;
      }
      const colon = clause.indexOf(':');
      if (colon >= 0 && foundMarkers.some((marker) => marker.start < colon)) {
        section = nearestMarker(foundMarkers, 0, colon)?.kind ?? null;
        listKind = section;
      } else if (clause.endsWith(':')) {
        section = null;
        listKind = null;
      }
      for (const occurrence of clause.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
        found = true;
        const kind = nearestMarker(foundMarkers, occurrence.index, occurrence.index + needle.length)?.kind ?? listKind;
        if (kind === 'mandatory') return 'mandatory';
        if (kind === 'preferred') preferred = true;
      }
      if (foundMarkers.length) listKind = [...foundMarkers].sort((a, b) => b.start - a.start)[0]!.kind;
    }
  }
  return found ? preferred ? 'preferred' : 'unclear' : null;
}

const NUMBER = '(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)';
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ONSITE = '\\b(?:on[- ]?site|onsite|in(?:[- ]|\\s+(?:the\\s+)?)office|office|vor ort)\\b';

export interface OnsiteDays {
  mandatory: number | null;
  optional: number | null;
  unclear: number | null;
}

type AttendanceRequirement = keyof OnsiteDays;

function attendanceRequirement(config: AppConfig, clause: string, start: number, end: number): AttendanceRequirement {
  const compulsory = markers(clause, ['\\bnot\\s+optional\\b'], 'mandatory' as const);
  const optional = markers(clause, [
    '\\b(?:optional|voluntary)\\b',
    '\\b(?:not|never)\\s+(?:strictly\\s+)?(?:required|mandatory|essential|compulsory|obligatory|expected)\\b',
    "\\b(?:isn|aren|wasn|weren)['’]t\\s+(?:required|mandatory|compulsory|expected)\\b",
    "\\b(?:do(?:es)?\\s+not|don['’]t|doesn['’]t)\\s+(?:need|have)\\s+to\\b",
    '\\bno\\s+(?:requirement|obligation)\\s+to\\b',
    '\\bno\\s+need\\s+(?:for|to)\\b',
    '\\bnot\\s+(?:a\\s+)?(?:requirement|obligation)\\b',
    '\\bno\\s+(?:mandatory|required|compulsory)\\s+(?:onsite|on[- ]site|office|travel|attendance|visits?)\\b',
    '\\bno\\s+(?:onsite|on[- ]site|office|travel)(?:\\s+(?:attendance|visits?|presence))?\\s+(?:(?:is|are)\\s+)?required\\b',
  ], 'optional' as const).filter((marker) => !compulsory.some((other) => marker.start < other.end && other.start < marker.end));
  const mandatory = [
    ...compulsory,
    ...markers(clause, [
      ...(config.scoring.signals.mandatory_markers ?? []),
      '\\b(?:must|have\\s+to|need\\s+to|compulsory|obligatory)\\b',
    ], 'mandatory' as const),
  ].filter((marker) => !optional.some((other) => marker.start < other.end && other.start < marker.end));
  return nearestMarker([...optional, ...mandatory], start, end)?.kind ?? 'unclear';
}

/** Keep explicit frequency separate from whether that attendance is required. */
export function onsiteDaysPerMonth(config: AppConfig, text: string): OnsiteDays {
  const days: OnsiteDays = { mandatory: null, optional: null, unclear: null };
  const schedule = new RegExp(`(${NUMBER})(?:\\s*(?:-|–|to)\\s*(${NUMBER}))?\\s+(?:(?:on[- ]?site|onsite|office|remote)\\s+)?days?(?:\\s+(?:on[- ]?site|onsite|in\\s+(?:the\\s+)?office|remote))?\\s*(?:/|per|a|each|every)\\s*(week|month|year)\\b`, 'g');
  // Conjunctions and commas separate independent requirements: an optional
  // skill or negated visit must not change another attendance obligation.
  const clauses = sentences(text).flatMap((sentence) =>
    normalizeText(sentence).split(/,|\s+(?:and|but|whereas|while)\s+/));
  for (const clause of clauses) {
    const modes = [...markers(clause, [ONSITE], 'onsite'), ...markers(clause, ['\\bremote\\b'], 'remote')];
    for (const match of clause.matchAll(schedule)) {
      if (nearestMarker(modes, match.index, match.index + match[0].length)?.kind !== 'onsite') continue;
      const amount = NUMBER_WORDS[match[2] ?? match[1]!] ?? Number(match[2] ?? match[1]);
      const factor = match[3] === 'week' ? config.profile.compensation.working_days_per_month / 5 : match[3] === 'year' ? 1 / 12 : 1;
      const kind = attendanceRequirement(config, clause, match.index, match.index + match[0].length);
      days[kind] = Math.max(days[kind] ?? 0, amount * factor);
    }
  }
  return days;
}
