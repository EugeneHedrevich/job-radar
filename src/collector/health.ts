import { cds, db, SELECT, INSERT, UPDATE, query } from '../db/index.js';
import type { AppConfig } from '../config/index.js';
import { log } from '../util/log.js';
import type { ErrorKind, TaskOutcome } from './types.js';

export interface SourceHealthRow {
  source: string;
  consecutiveFailures: number;
  rateLimitStreak: number;
  cooldownUntil: string | null;
  blocked: boolean;
  lastStatus: string | null;
  lastMessage: string | null;
  updatedAt: string | null;
}

export async function readHealth(): Promise<SourceHealthRow[]> {
  return query<SourceHealthRow>(SELECT.from(db().SourceHealth));
}

/** Sources that must not be queried right now, with the reason why. */
export async function activeCooldowns(now: Date = new Date()): Promise<Map<string, string>> {
  const rows = await readHealth();
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.cooldownUntil) continue;
    const until = new Date(row.cooldownUntil);
    if (until > now) {
      result.set(row.source, `on cooldown until ${until.toISOString()} (${row.lastStatus ?? 'unknown'})`);
    }
  }
  return result;
}

/**
 * Update the per-source circuit breaker. A source that keeps failing is put on
 * a cooldown whose length depends on the failure kind; a blocked source is not
 * retried at all until the cooldown expires.
 */
export async function recordOutcomes(config: AppConfig, outcomes: TaskOutcome[], now: Date = new Date()): Promise<void> {
  const { failure_threshold, cooldown_minutes } = config.searches.resilience;
  const bySource = new Map<string, TaskOutcome[]>();
  for (const outcome of outcomes) {
    if (outcome.status === 'Skipped') continue;
    const list = bySource.get(outcome.source) ?? [];
    list.push(outcome);
    bySource.set(outcome.source, list);
  }

  const existing = new Map((await readHealth()).map((row) => [row.source, row]));

  for (const [source, sourceOutcomes] of bySource) {
    const previous = existing.get(source);
    const failures = sourceOutcomes.filter((outcome) => outcome.status === 'Failed');
    const succeeded = sourceOutcomes.some((outcome) => outcome.status === 'Succeeded');
    const recovered = succeeded && !failures.length;
    const limited = failures.some((outcome) => outcome.errorKind === 'rate_limit');
    const rateLimitStreak = limited ? Math.max(previous?.rateLimitStreak ?? 0,
      previous?.lastStatus === 'rate_limit' ? 1 : 0) + 1
      : recovered ? 0 : previous?.rateLimitStreak ?? 0;

    let consecutiveFailures = recovered ? 0 : (previous?.consecutiveFailures ?? 0) + failures.length;
    let cooldownUntil: string | null = recovered ? null : (previous?.cooldownUntil ?? null);
    let blocked = false;
    let lastStatus = recovered ? 'ok' : 'failed';
    let lastMessage = failures[0]?.message ?? null;

    const worstKind = pickWorstKind(failures.map((outcome) => outcome.errorKind));
    if (worstKind === 'blocked' || worstKind === 'rate_limit') {
      // Blocking is not transient: stop retrying immediately, do not wait for
      // the failure threshold, and never attempt to work around the block.
      blocked = worstKind === 'blocked';
      const base = cooldown_minutes[worstKind] ?? 60;
      const minutes = worstKind === 'rate_limit' ? Math.min(config.searches.resilience.max_rate_limit_cooldown_minutes,
        base * 2 ** Math.min(10, Math.max(0, rateLimitStreak - 1))) : base;
      const retryAfterMinutes = Math.max(0, ...failures.map((outcome) => (outcome.retryAfterSeconds ?? 0) / 60));
      cooldownUntil = new Date(Math.max(addMinutes(now, Math.max(minutes, retryAfterMinutes)).getTime(),
        new Date(previous?.cooldownUntil ?? 0).getTime())).toISOString();
      lastStatus = worstKind;
      consecutiveFailures = Math.max(consecutiveFailures, failure_threshold);
      log.warn(`Source "${source}" reported ${worstKind}; pausing it until ${cooldownUntil}`);
    } else if (!recovered && worstKind && consecutiveFailures >= failure_threshold) {
      cooldownUntil = addMinutes(now, cooldown_minutes[worstKind] ?? 30).toISOString();
      lastStatus = worstKind;
      log.warn(`Source "${source}" failed ${consecutiveFailures}x; cooling down until ${cooldownUntil}`);
    }

    const row = {
      source,
      consecutiveFailures,
      rateLimitStreak,
      cooldownUntil,
      blocked,
      lastStatus,
      lastMessage: lastMessage ? lastMessage.slice(0, 1900) : null,
      updatedAt: now.toISOString(),
    };
    if (previous) {
      await cds.run(UPDATE(db().SourceHealth).set(row).where({ source }));
    } else {
      await cds.run(INSERT.into(db().SourceHealth).entries(row));
    }
  }
}

const SEVERITY: Record<string, number> = {
  blocked: 5,
  rate_limit: 4,
  timeout: 3,
  network: 2,
  parse: 2,
  error: 1,
};

function pickWorstKind(kinds: Array<ErrorKind | undefined>): ErrorKind | undefined {
  let worst: ErrorKind | undefined;
  for (const kind of kinds) {
    if (!kind) continue;
    if (!worst || (SEVERITY[kind] ?? 0) > (SEVERITY[worst] ?? 0)) worst = kind;
  }
  return worst;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}
