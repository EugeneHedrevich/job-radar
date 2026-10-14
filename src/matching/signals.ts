import type { AppConfig } from '../config/index.js';
import { normalizeText } from '../util/text.js';
import type { MatchableJob } from './types.js';

export type WorkMode = 'fully_remote' | 'hybrid' | 'onsite' | 'unknown';
export type Engagement = 'contract' | 'permanent' | 'alternatives' | 'unknown';

const cache = new Map<string, RegExp>();

/** Compile a configured pattern once. Patterns come from config, never from job text. */
export function pattern(source: string, flags = 'i'): RegExp {
  const key = `${flags}:${source}`;
  let compiled = cache.get(key);
  if (!compiled) {
    compiled = new RegExp(source, flags);
    cache.set(key, compiled);
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

export function jobText(job: Pick<MatchableJob, 'title' | 'description'>): JobText {
  const title = normalizeText(job.title);
  // Keep list/paragraph boundaries for requirements and attendance schedules.
  const body = (job.description ?? '')
    .replace(/<\/?(?:li|p|div|h[1-6])\b[^>]*>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/).map(normalizeText).join('\n');
  return { title, body, all: `${title}\n${body}`, hasDescription: Boolean(body.trim()) };
}

export function detectEngagement(config: AppConfig, job: MatchableJob, text: JobText): Engagement {
  const signals = config.scoring.signals;
  // A negated contract term must never count as a positive engagement signal.
  const exclusions = config.scoring.hard_rejects.rules.filter((rule) =>
    rule.id === 'contract_excluded' || rule.id === 'permanent_only',
  );
  if (exclusions.some((rule) => employmentRuleMatches(config, text.all, rule.any))) return 'permanent';
  const clauses = sentences(text.all);
  const permanent = clauses.some((clause) => positiveEmploymentMatches(clause, signals.permanent ?? []));
  const contract = clauses.some((clause) => {
    // Match each occurrence locally. Technical B2B/contract terminology is not an offer.
    return (signals.contract ?? []).some((source) => [...clause.matchAll(new RegExp(source, 'gi'))].some((match) => {
      if (negatedOffer(clause, match.index, match[0].length)) return false;
      const local = clause.slice(Math.max(0, match.index - 45), match.index + match[0].length + 65);
      if (/b2b|contract/i.test(match[0]) && matchesAny(local, signals.technical_contract_context ?? []) &&
        !matchesAny(local, signals.employment_context ?? [])) return false;
      if (/^contract$/i.test(match[0]) && positiveEmploymentMatches(clause, signals.permanent ?? []) &&
        !/\b(?:or|oder|alternatively|either)\b|\s\/\s/.test(clause)) return false;
      return true;
    }));
  });
  if (clauses.some((clause) => positiveEmploymentMatches(clause, signals.employment_alternatives ?? [])) && permanent) return 'alternatives';
  if (contract && !permanent) return 'contract';
  if (permanent && !contract) return 'permanent';
  if (contract && permanent) return 'alternatives';
  const permanentNegated = clauses.some((clause) => matchesAny(clause, signals.permanent ?? []) &&
    !positiveEmploymentMatches(clause, signals.permanent ?? []));
  const jobType = normalizeText(job.jobType ?? '');
  if (/\bcontract\b/.test(jobType) && /\b(?:permanent|fulltime)\b/.test(jobType) && !permanentNegated) return 'alternatives';
  if (/\bcontract\b/.test(jobType)) return 'contract';
  if (/\bpermanent\b/.test(jobType) && !permanentNegated) return 'permanent';
  return 'unknown';
}

/** Negative technical B2B wording is not an exclusion of contractors either. */
export function employmentRuleMatches(config: AppConfig, text: string, patterns: readonly string[]): boolean {
  return sentences(text).some((clause) => patterns.some((source) => [...clause.matchAll(new RegExp(source, 'gi'))].some((match) => {
    // Exclusions like "no contractors" are themselves negative offers. Only
    // negate a positive permanent-only assertion here.
    if (/permanent|festanstellung|unbefristet/i.test(match[0]) && negatedOffer(clause, match.index, match[0].length)) return false;
    const local = clause.slice(Math.max(0, match.index - 45), match.index + match[0].length + 65);
    return !/b2b|c2c/i.test(match[0]) || !matchesAny(local, config.scoring.signals.technical_contract_context ?? []) ||
      matchesAny(local, config.scoring.signals.employment_context ?? []);
  })));
}

function negatedOffer(clause: string, start: number, length: number): boolean {
  return /\b(?:no|not|never|without|kein\w*|nicht)\s+(?:(?:a|an|any|offering|offer|only)\s+){0,2}$/.test(clause.slice(0, start)) ||
    /^\s+(?:(?:is|are)\s+)?(?:not\s+(?:offered|available|possible)|excluded)\b/.test(clause.slice(start + length));
}

export function positiveEmploymentMatches(clause: string, sources: readonly string[]): boolean {
  return sources.some((source) => [...clause.matchAll(pattern(source, 'gi'))]
    .some((match) => !negatedOffer(clause, match.index, match[0].length)));
}

export function detectWorkMode(config: AppConfig, job: MatchableJob, text: JobText): WorkMode {
  const signals = config.scoring.signals;
  const attendance = onsiteDaysPerMonth(config, text.all);
  if (Math.max(attendance.mandatory ?? 0, attendance.unclear ?? 0) > 0) return 'hybrid';
  if (hasMandatoryOnsiteCondition(config, text.all)) return 'onsite';
  const nonOptional = (sources: readonly string[]) => attendanceClauses(config, text.all).some((clause) =>
    sources.some((source) => [...clause.matchAll(pattern(source, 'gi'))].some((match) =>
      attendanceRequirement(config, clause, match.index, match.index + match[0].length) !== 'optional')));
  if (nonOptional(signals.hybrid ?? []) || limitedHomeoffice(config, text.all).length) return 'hybrid';
  const remoteSignals = sentences(text.all).flatMap((clause) => (signals.fully_remote ?? []).flatMap((source) =>
    [...clause.matchAll(pattern(source, 'gi'))].map((match) =>
      negatedOffer(clause, match.index, match[0].length) ||
      /\b(?:isn|aren|wasn|weren)['’]t\s*$/.test(clause.slice(0, match.index)))));
  // Conflicting positive/negative wording leaves attendance unresolved too.
  if (remoteSignals.includes(false) && !remoteSignals.includes(true)) return 'fully_remote';
  if (nonOptional(signals.onsite ?? [])) return 'onsite';
  // Source flags also cover hybrid work and never establish an attendance schedule.
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
    .split(/[\r\n;]+|(?<!\bmax\.)(?<!\bmin\.)(?<!\bca\.)(?<=[.!?])\s+/i)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** A remote cap establishes limited remote work, not an unstated five-day week. */
export function limitedHomeoffice(config: AppConfig, text: string): Array<{ quote: string; onsiteDays: number | null }> {
  return attendanceClauses(config, text).flatMap((clause) => {
    if (!matchesAny(clause, config.scoring.signals.homeoffice ?? [])) return [];
    return (config.scoring.signals.remote_weekly_limits ?? []).flatMap((source) => {
      const match = new RegExp(source, 'i').exec(clause);
      const amount = match ? Number(match[1]) : NaN;
      if (!match || !Number.isFinite(amount) || amount < 0 ||
        attendanceRequirement(config, clause, match.index, match.index + match[0].length) === 'optional') return [];
      const week = /\b(\d+)\s*[- ]day\s+(?:work(?:ing)?\s*)?week\b|\bwork(?:ing)?\s+(\d+)\s+days?\s+per\s+week\b/.exec(clause);
      const workingDays = week ? Number(week[1] ?? week[2]) : null;
      return [{ quote: clause, onsiteDays: workingDays !== null && workingDays > amount
        ? (workingDays - amount) * config.profile.compensation.working_days_per_month / workingDays : null }];
    });
  });
}

export type Requirement = 'mandatory' | 'preferred' | 'unclear';

export interface RequirementMention {
  kind: Requirement;
  clause: string;
  quote: string;
  start: number;
  end: number;
  alternativeGroup?: string;
  alternativeStatus?: 'satisfied' | 'incompatible' | 'uncertain';
}

/** Original wording and list boundaries for evidence shared by both engines. */
export function requirementSource(job: MatchableJob): string {
  return `${job.title}\n${(job.description ?? '').replace(/<\/?(?:li|p|div|h[1-6])\b[^>]*>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')}`;
}

interface Marker<T> { start: number; end: number; kind: T }

function markers<T>(text: string, sources: readonly string[], kind: T): Marker<T>[] {
  return sources.flatMap((source) => [...text.matchAll(pattern(source, 'gi'))]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, kind })));
}

function nearestMarker<T>(found: Marker<T>[], start: number, end: number): Marker<T> | undefined {
  const distance = (marker: Marker<T>) => Math.max(start - marker.end, marker.start - end, 0);
  return [...found].sort((a, b) => distance(a) - distance(b) || b.start - a.start)[0];
}

export interface CapabilityExpression {
  kind: 'term' | 'and' | 'or';
  start: number;
  end: number;
  children: CapabilityExpression[];
}

/** Small, bounded boolean grammar. Offsets keep choices local to each mention. */
export function capabilityExpression(config: AppConfig, text: string, start = 0, end = text.length, depth = 0): CapabilityExpression | null {
  if (text.length > 1600 || depth > 4) return null;
  const originalEnd = end;
  const obligation = [...(config.scoring.signals.mandatory_markers ?? []), ...(config.scoring.signals.preferred_markers ?? []),
    '\\b(?:optional|voluntary)\\b'];
  const colon = text.indexOf(':', start);
  if (colon >= start && colon < end && matchesAny(text.slice(start, colon), obligation)) start = colon + 1;
  const tail = pattern(`\\s+(?:(?:is|are)\\s+)?(?:${obligation.join('|')})[.!?\\s]*$`).exec(text.slice(start, end));
  if (tail) end = start + tail.index;
  while (start < end && /[\s.]/.test(text[start]!)) start++;
  while (end > start && /[\s.]/.test(text[end - 1]!)) end--;
  if (start === end) return null;
  const operators: Array<{ start: number; end: number; kind: 'and' | 'or' }> = [];
  let level = 0, outerEnd = -1;
  const token = /\(|\)|\b(?:and|und|sowie|or|oder)\b|[+&]/g;
  token.lastIndex = start;
  for (let match = token.exec(text); match && match.index < end; match = token.exec(text)) {
    if (match[0] === '(') level++;
    else if (match[0] === ')') { if (--level < 0) return null; if (!level && outerEnd < 0) outerEnd = match.index; }
    else if (!level) operators.push({ start: match.index, end: match.index + match[0].length,
      kind: /^(?:or|oder)$/.test(match[0]) ? 'or' : 'and' });
  }
  if (level || operators.length > 16) return null;
  if (text[start] === '(' && outerEnd === end - 1) return capabilityExpression(config, text, start + 1, end - 1, depth + 1);
  // Explicit obligations on both sides of AND are independent, even when an
  // earlier choice has no parentheses: "CAP or Kafka required AND RAP required".
  const independent = operators.filter((op) => /^(?:and|und|sowie)$/.test(text.slice(op.start, op.end)) &&
    matchesAny(text.slice(start, op.start), obligation) && matchesAny(text.slice(op.end, originalEnd), obligation));
  if (!independent.length && operators.some((op) => op.kind === 'or') &&
    operators.some((op) => /^(?:and|und|sowie)$/.test(text.slice(op.start, op.end)))) return null;
  const split = independent.length ? independent : operators.some((op) => op.kind === 'or')
    ? operators.filter((op) => op.kind === 'or') : operators;
  if (!split.length) {
    // Parenthetical prose/implicit operators are outside this grammar.
    return /[()]/.test(text.slice(start, end)) ? null : { kind: 'term', start, end, children: [] };
  }
  const cuts = [start, ...split.map((op) => op.end)];
  const children = cuts.map((from, index) => capabilityExpression(config, text, from, split[index]?.start ?? end, depth + 1));
  if (children.some((child) => !child)) return null;
  return { kind: independent.length ? 'and' : split[0]!.kind, start, end, children: children as CapabilityExpression[] };
}

/** AND conditions stay mandatory; only the enclosing OR can satisfy a choice. */
function alternativeGroup(config: AppConfig, clause: string, position: number): string | null {
  if (!/\b(?:or|oder)\b/.test(clause)) return null;
  const expression = capabilityExpression(config, clause);
  if (!expression) return clause; // The evaluator reports unsupported grouping as uncertain.
  const choice = (node: CapabilityExpression): string | null => node.kind === 'or' ? clause.slice(node.start, node.end) :
    node.children.filter((child) => position >= child.start && position < child.end).map(choice).find(Boolean) ?? null;
  return choice(expression);
}

/** Decide whether a term appears as a must-have or a nice-to-have. */
export function requirementMentions(config: AppConfig, text: string, term: string): RequirementMention[] {
  const needle = normalizeText(term);
  if (!needle) return [];
  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrenceSource = `(?<![a-z0-9])${escapedNeedle}(?![a-z0-9])`;
  // Most configured aliases do not occur in a given ad; avoid reparsing their sections.
  if (!pattern(occurrenceSource).test(normalizeText(text))) return [];
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
    const normalBlock = normalizeText(block);
    const sharedPreferred = !matchesAny(normalBlock, mandatoryMarkers) && preferredMarkers.some((source) =>
      new RegExp(`(?:${source})[.!?]?$`, 'i').test(normalBlock));
    let listKind: Requirement | null = sharedPreferred ? 'preferred' : section;
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
      const compulsory = markers(clause, ['\\bnot\\s+optional\\b'], 'mandatory' as const);
      const foundMarkers = [
        ...compulsory,
        ...markers(clause, mandatoryMarkers, 'mandatory' as const)
          .filter((marker) => !negated.some((negative) => marker.start >= negative.start && marker.end <= negative.end)),
        ...markers(clause, preferredMarkers, 'preferred' as const),
        ...markers(clause, ['\\b(?:optional|voluntary)\\b'], 'preferred' as const)
          .filter((marker) => !compulsory.some((other) => marker.start < other.end && other.start < marker.end)),
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
      for (const occurrence of clause.matchAll(pattern(occurrenceSource, 'g'))) {
        const local = nearestMarker(foundMarkers, occurrence.index, occurrence.index + needle.length);
        const kind: Requirement = local?.kind ?? listKind ?? 'unclear';
        const choice = alternativeGroup(config, clause, occurrence.index);
        mentions.push({ kind, clause, start: occurrence.index, end: occurrence.index + needle.length,
          ...(choice ? { alternativeGroup: choice } : {}),
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
  // A Homeoffice cap can describe the same optional hybrid arrangement.
  // Unrelated optional skills never pass onlyAttendanceDetails.
  if (/\bhybrid\b/.test(context) && onlyAttendanceDetails(config, context) &&
    matchesAny(fragment, config.scoring.signals.homeoffice ?? [])) return true;
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
    // Excluding fully remote work still leaves hybrid/attendance unresolved.
    !/\b(?:fully|100\s*%)\s*$/.test(clause.slice(0, match.index)) &&
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
  return limitedHomeoffice(config, text).some((limit) => limit.onsiteDays === null) || attendanceClauses(config, text).some((clause) =>
    onsiteSchedules(clause).length === 0 && markers(clause, [ONSITE, '\\bhybrid\\b'], 'onsite').some((marker) =>
      attendanceRequirement(config, clause, marker.start, marker.end) !== 'optional'));
}

/** Keep explicit frequency separate from whether that attendance is required. */
export function onsiteDaysPerMonth(config: AppConfig, text: string): OnsiteDays {
  const days: OnsiteDays = { mandatory: null, optional: null, unclear: null };
  for (const limit of limitedHomeoffice(config, text)) {
    if (limit.onsiteDays !== null) days.mandatory = Math.max(days.mandatory ?? 0, limit.onsiteDays);
  }
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
