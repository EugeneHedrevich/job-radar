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
  if (!currency) {
    return { value, currency: null, comparable: false, note: 'salary currency not stated; rate cannot be compared with the profile' };
  }
  return { value, currency, comparable: true, note: null };
}

/** Preserve list items and clauses, without splitting technology names at dots. */
export function sentences(text: string): string[] {
  return text
    .split(/[\r\n;]+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export type Requirement = 'mandatory' | 'preferred' | 'unclear';

export interface RequirementMention {
  kind: Requirement;
  clause: string;
  quote: string;
  start: number;
  end: number;
}

/** Original wording and list boundaries for evidence shared by both engines. */
export function requirementSource(job: MatchableJob): string {
  return `${job.title}\n${(job.description ?? '').replace(/<\/?(?:li|p|div|h[1-6])\b[^>]*>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')}`;
}

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
export function requirementMentions(config: AppConfig, text: string, term: string): RequirementMention[] {
  const needle = normalizeText(term);
  if (!needle) return [];
  const mandatoryMarkers = config.scoring.signals.mandatory_markers ?? [];
  const preferredMarkers = config.scoring.signals.preferred_markers ?? [];
  const mentions: RequirementMention[] = [];
  let section: Requirement | null = null;
  let sectionStart = 0;
  const blocks = sentences(text);
  for (const [blockIndex, block] of blocks.entries()) {
    const heading = normalizeText(block).replace(/^(?:[-+*#]+|\d+[.)])\s*/, '')
      .replace(/[:*#]+$/g, '').trim();
    // Recruiter requirement sections often have no marker on each list item.
    // Section boundaries also keep benefits/responsibilities out of that list.
    if (matchesAny(heading, config.scoring.signals.mandatory_sections ?? [])) {
      section = 'mandatory';
      sectionStart = blockIndex;
      continue;
    }
    if (matchesAny(heading, config.scoring.signals.preferred_sections ?? [])) {
      section = 'preferred';
      sectionStart = blockIndex;
      continue;
    }
    if (matchesAny(heading, config.scoring.signals.non_requirement_sections ?? [])) {
      section = null;
      sectionStart = blockIndex;
      continue;
    }
    // A shared marker governs the remaining comma-separated items in this
    // sentence, until an item supplies its own mandatory/preferred marker.
    let listKind: Requirement | null = section;
    for (const part of block.split(/,|\s+[|•]\s*/)) {
      const clause = normalizeText(part).replace(/^(?:[-+*#]+|\d+[.)])\s*/, '');
      const attendancePart = pattern(ONSITE).test(clause) || pattern(SCHEDULE).test(clause) ||
        /\b(?:attendance|relocation)\b/.test(clause);
      // An attendance obligation ends an inline skill list. Its marker must
      // not turn a neighboring, unqualified skill into a mandatory requirement.
      if (attendancePart) listKind = section;
      const negated = markers(clause, [
        '\\b(?:not|never)\\s+(?:strictly\\s+)?(?:require[ds]?|mandatory|essential|compulsory|obligatory)\\b',
        '\\bnie\\s+(?:(?:jest|sa)\\s+)?wymagan(?:e|a|y)\\b',
        '\\bnicht\\s+(?:erforderlich|zwingend)\\b',
        '\\bnon\\s+(?:requis|obligatoire)\\b',
        '\\bniet\\s+vereist\\b',
      ], 'preferred' as const);
      const foundMarkers = [
        ...markers(clause, mandatoryMarkers, 'mandatory' as const)
          .filter((marker) => !negated.some((negative) => marker.start >= negative.start && marker.end <= negative.end)),
        ...markers(clause, preferredMarkers, 'preferred' as const),
        ...markers(clause, ['\\b(?:optional|voluntary)\\b'], 'preferred' as const),
        ...negated,
      ];
      // A marker-only heading applies to subsequent list entries. Ordinary
      // headings end that section; inline markers apply to their own skill.
      const remainder = foundMarkers.reduce((value, marker) =>
        value.replace(clause.slice(marker.start, marker.end), ''), clause)
        .replace(/[:*#]/g, '').trim();
      if (foundMarkers.length && /^(?:(?:skills|requirements|qualifications|experience)\s*)?$/.test(remainder)) {
        section = foundMarkers.some((marker) => marker.kind === 'mandatory') ? 'mandatory' : 'preferred';
        sectionStart = blockIndex;
        listKind = section;
        continue;
      }
      const colon = clause.indexOf(':');
      if (!attendancePart && colon >= 0 && foundMarkers.some((marker) => marker.start < colon)) {
        section = nearestMarker(foundMarkers, 0, colon)?.kind ?? null;
        sectionStart = blockIndex;
        listKind = section;
      } else if (clause.endsWith(':')) {
        section = null;
        listKind = null;
      }
      const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const occurrence of clause.matchAll(new RegExp(`(?<![a-z0-9])${escapedNeedle}(?![a-z0-9])`, 'g'))) {
        const local = nearestMarker(foundMarkers, occurrence.index, occurrence.index + needle.length);
        const kind = local?.kind ?? listKind ?? 'unclear';
        mentions.push({ kind, clause, start: occurrence.index, end: occurrence.index + needle.length,
          quote: !local && section ? blocks.slice(sectionStart, blockIndex + 1).join('\n') : block });
      }
      if (foundMarkers.length && !attendancePart) listKind = [...foundMarkers].sort((a, b) => b.start - a.start)[0]!.kind;
    }
  }
  return mentions;
}

export function requirementKind(config: AppConfig, text: string, term: string): Requirement | null {
  const mentions = requirementMentions(config, text, term);
  return mentions.some((mention) => mention.kind === 'mandatory') ? 'mandatory' :
    mentions.some((mention) => mention.kind === 'preferred') ? 'preferred' : mentions.length ? 'unclear' : null;
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

const SCHEDULE = `(${NUMBER})(?:\\s*(?:-|–|to)\\s*(${NUMBER}))?\\s+(?:(?:on[- ]?site|onsite|office|remote)\\s+)?days?(?:\\s+(?:on[- ]?site|onsite|in\\s+(?:the\\s+)?office|remote))?\\s*(?:/|per|a|each|every)\\s*(week|month|year)\\b`;
const WORK_MODE = `${ONSITE}|\\bremote\\b`;

function attendanceMarkers(config: AppConfig, clause: string): Marker<'mandatory' | 'optional'>[] {
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
    '\\b(?:not|never)\\s+(?:fully\\s+|100\\s*%\\s*)?(?:on[- ]?site|onsite|in[- ]office|vor ort)\\b',
    '\\bno\\s+relocation\\s+(?:(?:is|are)\\s+)?(?:required|mandatory)\\b',
  ], 'optional' as const).filter((marker) => !compulsory.some((other) => marker.start < other.end && other.start < marker.end));
  const mandatory = [
    ...compulsory,
    ...markers(clause, [
      ...(config.scoring.signals.mandatory_markers ?? []),
      '\\b(?:must|have\\s+to|need\\s+to|compulsory|obligatory)\\b',
    ], 'mandatory' as const),
  ].filter((marker) => !optional.some((other) => marker.start < other.end && other.start < marker.end));
  return [...optional, ...mandatory];
}

function attendanceRequirement(
  config: AppConfig, clause: string, start: number, end: number, fallback: AttendanceRequirement = 'unclear',
): AttendanceRequirement {
  return nearestMarker(attendanceMarkers(config, clause), start, end)?.kind ?? fallback;
}

/** A continuation contains only attendance details, never an unrelated skill. */
function onlyAttendanceDetails(config: AppConfig, fragment: string): boolean {
  let remainder = fragment;
  for (const marker of attendanceMarkers(config, fragment).sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    remainder = remainder.replace(fragment.slice(marker.start, marker.end), ' ');
  }
  remainder = remainder.replace(new RegExp(SCHEDULE, 'g'), ' ').replace(new RegExp(WORK_MODE, 'g'), ' ')
    .replace(/\bat\s+least\b/g, ' ')
    .replace(/\b(?:attendance|presence|visits?|work|working|days?|hybrid|fully|is|are|be|it|this|also|only|approximately)\b/g, ' ')
    .replace(/[\s:.*#()\-!?]+/g, '');
  return remainder === '';
}

function relatedAttendanceFragment(config: AppConfig, context: string, fragment: string): boolean {
  if (!onlyAttendanceDetails(config, fragment)) return false;
  const contextMode = pattern(WORK_MODE).test(context);
  const contextSchedule = pattern(SCHEDULE).test(context);
  const fragmentMode = pattern(WORK_MODE).test(fragment);
  const fragmentSchedule = pattern(SCHEDULE).test(fragment);
  if (!contextMode && !contextSchedule) {
    // A standalone "optional," or "required," can introduce a requirement.
    return onlyAttendanceDetails(config, context) && attendanceMarkers(config, context).length > 0;
  }
  // A second complete attendance statement owns its own obligation marker.
  if (fragmentMode && fragmentSchedule) return false;
  if (fragmentMode) return !contextMode && contextSchedule;
  return true;
}

/** Join dependent fragments; independent subjects reset the context. */
function attendanceClauses(config: AppConfig, text: string): string[] {
  return sentences(text).flatMap((sentence) => {
    const parts = normalizeText(sentence).split(/(,|\s+(?:and|with|plus|but|whereas|while)\s+)/);
    const clauses: string[] = [];
    let context = parts[0] ?? '';
    for (let index = 1; index < parts.length; index += 2) {
      const separator = parts[index]!.trim();
      const fragment = (parts[index + 1] ?? '').trim();
      if ([',', 'and', 'with', 'plus'].includes(separator) && relatedAttendanceFragment(config, context, fragment)) {
        context = `${context} ${fragment}`;
      } else {
        if (context) clauses.push(context);
        context = fragment;
      }
    }
    if (context) clauses.push(context);
    return clauses;
  });
}

function mandatoryOnsiteCondition(config: AppConfig, clause: string): boolean {
  const rule = config.scoring.hard_rejects.rules.find((candidate) => candidate.id === 'onsite_heavy');
  if (!rule || matchesAny(clause, rule.none)) return false;
  // These patterns describe a required work mode or prohibit remote work.
  // Optional/negated markers still take precedence within that requirement.
  return rule.any.some((source) => [...clause.matchAll(new RegExp(source, 'gi'))].some((match) =>
    attendanceRequirement(config, clause, match.index, match.index + match[0].length, 'mandatory') === 'mandatory'));
}

export function hasMandatoryOnsiteCondition(config: AppConfig, text: string): boolean {
  return attendanceClauses(config, text).some((clause) => mandatoryOnsiteCondition(config, clause));
}

/** Ignore partial matches inside ambiguous numbers or time periods. */
function onsiteSchedules(clause: string): RegExpExecArray[] {
  const modes = [...markers(clause, [ONSITE], 'onsite'), ...markers(clause, ['\\bremote\\b'], 'remote')];
  return [...clause.matchAll(new RegExp(SCHEDULE, 'g'))].filter((match) => {
    const end = match.index + match[0].length;
    const alternativeNumber = pattern(`\\b${NUMBER}\\s+or\\s*$`).test(clause.slice(0, match.index));
    const alternativePeriod = /^\s*(?:or|\/)\s*(?:(?:per|a|each|every)\s+)?(?:week|month|year)\b/.test(clause.slice(end));
    return !alternativeNumber && !alternativePeriod && nearestMarker(modes, match.index, end)?.kind === 'onsite';
  });
}

/** Surface onsite mentions without a reliable, non-optional schedule. */
export function hasUnclearOnsiteFrequency(config: AppConfig, text: string): boolean {
  return attendanceClauses(config, text).some((clause) =>
    onsiteSchedules(clause).length === 0 && markers(clause, [ONSITE], 'onsite').some((marker) =>
      attendanceRequirement(config, clause, marker.start, marker.end) !== 'optional'));
}

/** Keep explicit frequency separate from whether that attendance is required. */
export function onsiteDaysPerMonth(config: AppConfig, text: string): OnsiteDays {
  const days: OnsiteDays = { mandatory: null, optional: null, unclear: null };
  for (const clause of attendanceClauses(config, text)) {
    for (const match of onsiteSchedules(clause)) {
      const amount = NUMBER_WORDS[match[2] ?? match[1]!] ?? Number(match[2] ?? match[1]);
      const factor = match[3] === 'week' ? config.profile.compensation.working_days_per_month / 5 : match[3] === 'year' ? 1 / 12 : 1;
      const kind = attendanceRequirement(config, clause, match.index, match.index + match[0].length,
        mandatoryOnsiteCondition(config, clause) ? 'mandatory' : 'unclear');
      days[kind] = Math.max(days[kind] ?? 0, amount * factor);
    }
  }
  return days;
}
