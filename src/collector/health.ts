import { randomUUID } from 'node:crypto';
import { cds, db, SELECT, INSERT, UPDATE, query } from '../db/index.js';
import { loadConfig, type AppConfig } from '../config/index.js';
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
  windowStartedAt: string | null;
  searchRequests: number;
  detailRequests: number;
  reservedSearch: number;
  reservedDetail: number;
  recoveryPending: boolean;
  lastHttpStatus: number | null;
  lastRequestAt?: string | null;
  lastFailureStatus?: number | null;
  lastFailureAt?: string | null;
  lastFailureKind?: string | null;
  lastFailureMessage?: string | null;
  lastRateLimitAt?: string | null;
  recoverySuccesses?: number;
  lastRetryAfterSeconds: number | null;
  importToken: string | null;
  importUntil: string | null;
}

export async function readHealth(): Promise<SourceHealthRow[]> {
  return query<SourceHealthRow>(SELECT.from(db().SourceHealth));
}

/** Structured availability for the existing continuation scheduler; no reservations. */
export async function sourceResumeTimes(config: AppConfig, at = new Date()): Promise<Map<string, number>> {
  return new Map((await readHealth()).map((row) => {
    const limits = config.searches.linkedin_limits;
    const windowEnd = Date.parse(row.windowStartedAt ?? '') + limits.window_minutes * 60_000;
    return [row.source, Math.max(at.getTime(), Date.parse(row.cooldownUntil ?? '') || 0,
      row.importToken ? Date.parse(row.importUntil ?? '') || 0 : 0,
      row.source === 'linkedin' && (row.searchRequests ?? 0) + (row.reservedSearch ?? 0) >= limits.max_search_requests_per_window ? windowEnd || 0 : 0)];
  }));
}

/** Sources that must not be queried right now, with the reason why. */
export async function activeCooldowns(now: Date = new Date(), enrichOnly = false): Promise<Map<string, string>> {
  const rows = await readHealth();
  const result = new Map<string, string>();
  for (const row of rows) {
    if (row.cooldownUntil && new Date(row.cooldownUntil) > now) {
      const until = new Date(row.cooldownUntil);
      result.set(row.source, `on cooldown until ${until.toISOString()} (${row.lastStatus ?? 'unknown'})`);
      continue;
    }
    if (row.importToken && row.importUntil && new Date(row.importUntil) > now) {
      result.set(row.source, 'A shared source request is already running');
      continue;
    }
    if (row.source === 'linkedin') {
      const limits = loadConfig().searches.linkedin_limits;
      if (row.windowStartedAt && now.getTime() < new Date(row.windowStartedAt).getTime() + limits.window_minutes * 60_000 &&
        (enrichOnly ? (row.detailRequests ?? 0) + (row.reservedDetail ?? 0) >= limits.max_detail_requests_per_window
          : (row.searchRequests ?? 0) + (row.reservedSearch ?? 0) >= limits.max_search_requests_per_window)) {
        result.set(row.source, `Shared LinkedIn request allowance used until ${new Date(new Date(row.windowStartedAt).getTime() + limits.window_minutes * 60_000).toISOString()}`);
      }
    }
  }
  return result;
}

/**
 * Update the per-source circuit breaker. A source that keeps failing is put on
 * a cooldown whose length depends on the failure kind; a blocked source is not
 * retried at all until the cooldown expires.
 */
export async function recordOutcomes(config: AppConfig, outcomes: TaskOutcome[], now: Date = new Date(), startedAt = now): Promise<void> {
  const { failure_threshold, cooldown_minutes } = config.searches.resilience;
  const bySource = new Map<string, TaskOutcome[]>();
  for (const outcome of outcomes) {
    if (outcome.status === 'Skipped' || outcome.errorKind === 'local_startup') continue;
    const list = bySource.get(outcome.source) ?? [];
    list.push(outcome);
    bySource.set(outcome.source, list);
  }

  await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const rows: SourceHealthRow[] = await tx.run(SELECT.from(db().SourceHealth));
    const existing = new Map(rows.map((row) => [row.source, row]));

    for (const [source, sourceOutcomes] of bySource) {
      const previous = existing.get(source);
      const failures = sourceOutcomes.filter((outcome) => outcome.status === 'Failed');
      const latestRequest = [...sourceOutcomes].reverse().find(outcome => outcome.httpStatus !== undefined || outcome.httpStatusAt ||
        outcome.searchRequests === undefined || outcome.detailRequests === undefined || outcome.searchRequests + outcome.detailRequests > 0);
      const succeeded = sourceOutcomes.some((outcome) => outcome.status === 'Succeeded');
      const recovered = succeeded && !failures.length;
      // A collection started before an import was blocked must not clear that newer failure.
      if (recovered && previous?.updatedAt && new Date(previous.updatedAt) > startedAt && previous.lastStatus !== 'ok') continue;
      const limited = failures.some((outcome) => outcome.errorKind === 'rate_limit');
      const validResponse = source !== 'linkedin' || sourceOutcomes.some(outcome => outcome.status === 'Succeeded' &&
        (outcome.resultCount > 0 || outcome.coverage === 'exhausted'));
      const verifiedVisit = recovered && validResponse && Boolean(latestRequest && (latestRequest.httpStatus && latestRequest.httpStatus >= 200 && latestRequest.httpStatus < 400 ||
        (latestRequest.searchRequests ?? 0) + (latestRequest.detailRequests ?? 0) > 0));
      const recoverySuccesses = recovered ? (previous?.recoverySuccesses ?? 0) + Number(verifiedVisit) : 0;
      const lastRateLimitAt = previous?.lastRateLimitAt ?? (previous?.lastStatus === 'rate_limit' ? previous.updatedAt : null);
      // One probe demonstrates availability, not sustained recovery. Retain the
      // streak until two visits succeed and a full shared window has passed.
      const stable = recovered && (source !== 'linkedin' || verifiedVisit && recoverySuccesses >= 2 &&
        now.getTime() - Date.parse(lastRateLimitAt ?? '1970-01-01') >= config.searches.linkedin_limits.window_minutes * 60_000);
      const rateLimitStreak = limited ? Math.max(previous?.rateLimitStreak ?? 0,
        previous?.lastStatus === 'rate_limit' ? 1 : 0) + 1
        : stable ? 0 : previous?.rateLimitStreak ?? 0;

      let consecutiveFailures = recovered ? 0 : (previous?.consecutiveFailures ?? 0) + failures.length;
      let cooldownUntil: string | null = recovered ? null : (previous?.cooldownUntil ?? null);
      let blocked = recovered ? false : previous?.blocked ?? false;
      let lastStatus = recovered ? 'ok' : 'failed';
      let lastMessage = failures[0]?.message ?? null;

      const worstKind = pickWorstKind(failures.map((outcome) => outcome.errorKind));
      if (worstKind === 'blocked' || worstKind === 'rate_limit') {
        // Blocking is not transient: stop retrying immediately, do not wait for
        // the failure threshold, and never attempt to work around the block.
        blocked = blocked || worstKind === 'blocked';
        const base = cooldown_minutes[worstKind] ?? 60;
        const minutes = worstKind === 'rate_limit' ? Math.min(config.searches.resilience.max_rate_limit_cooldown_minutes,
          base * 2 ** Math.min(10, Math.max(0, rateLimitStreak - 1))) : base;
        const retryAfterMinutes = Math.max(0, ...failures.map((outcome) => Math.min(31_536_000, outcome.retryAfterSeconds ?? 0) / 60));
        cooldownUntil = new Date(Math.max(addMinutes(now, Math.max(minutes, retryAfterMinutes)).getTime(),
          new Date(previous?.cooldownUntil ?? 0).getTime())).toISOString();
        lastStatus = worstKind;
        consecutiveFailures = Math.max(consecutiveFailures, failure_threshold);
        log.warn(`Source "${source}" reported ${worstKind}; pausing it until ${cooldownUntil}`);
      } else if (!recovered && worstKind && consecutiveFailures >= failure_threshold) {
        cooldownUntil = new Date(Math.max(addMinutes(now, cooldown_minutes[worstKind] ?? 30).getTime(),
          new Date(previous?.cooldownUntil ?? 0).getTime())).toISOString();
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
        recoveryPending: stable ? false : Boolean(previous?.recoveryPending || worstKind === 'rate_limit' || worstKind === 'blocked'),
        recoverySuccesses,
        lastRateLimitAt: limited ? now.toISOString() : lastRateLimitAt,
        lastHttpStatus: latestRequest ? latestRequest.httpStatus ?? null : previous?.lastRequestAt ? previous.lastHttpStatus : null,
        lastRequestAt: latestRequest ? latestRequest.httpStatusAt ?? now.toISOString() : previous?.lastRequestAt ?? null,
        lastFailureStatus: previous?.lastFailureStatus ?? (previous?.lastHttpStatus && previous.lastHttpStatus >= 400 ? previous.lastHttpStatus : null),
        lastFailureAt: previous?.lastFailureAt ?? (previous?.lastStatus && previous.lastStatus !== 'ok' ? previous.updatedAt : null),
        lastFailureKind: previous?.lastFailureKind ?? (previous?.lastStatus !== 'ok' ? previous?.lastStatus : null),
        lastFailureMessage: previous?.lastFailureMessage ?? (previous?.lastStatus !== 'ok' ? previous?.lastMessage : null),
        ...(failures.length ? { lastFailureStatus: failures.at(-1)?.httpStatus ?? null,
          lastFailureAt: failures.at(-1)?.httpStatusAt ?? now.toISOString(), lastFailureKind: worstKind ?? 'error',
          lastFailureMessage: failures.at(-1)?.message?.slice(0, 1900) ?? null } : {}),
        lastRetryAfterSeconds: failures.find((outcome) => outcome.retryAfterSeconds !== undefined)?.retryAfterSeconds ?? previous?.lastRetryAfterSeconds ?? null,
      };
      if (previous) {
        await tx.run(UPDATE(db().SourceHealth).set(row).where({ source }));
      } else {
        await tx.run(INSERT.into(db().SourceHealth).entries(row));
      }
    }
  });
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

/** Serialize metadata lookups per source, across local processes, without holding a DB transaction during I/O. */
export async function claimImportSource(source: string): Promise<SourceRequestClaim> {
  return claimSourceRequests(source, 0, 3, 45_000);
}

export interface SourceRequestClaim { token?: string; reason?: string; searchLimit: number; detailLimit: number; recovery: boolean }

/** Reserve a persistent allowance before I/O. Expired reservations remain charged because their result is unknown. */
export async function claimSourceRequests(source: string, searchWanted: number, detailWanted: number, leaseMs = 45_000): Promise<SourceRequestClaim> {
  const config = loadConfig();
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const row = await tx.run(SELECT.one.from(db().SourceHealth).where({ source }));
    const unavailable = (reason: string): SourceRequestClaim => ({ reason, searchLimit: 0, detailLimit: 0, recovery: false });
    const now = new Date();
    if (row?.cooldownUntil && new Date(row.cooldownUntil) > now) return unavailable(`Source is on cooldown until ${row.cooldownUntil} (${row.lastStatus})`);
    if (row?.importToken && row.importUntil && new Date(row.importUntil) > now) return unavailable('A request for this source is already running. Try again later.');
    const limits = config.searches.linkedin_limits;
    const reset = !row?.windowStartedAt || now.getTime() - new Date(row.windowStartedAt).getTime() >= limits.window_minutes * 60_000;
    const windowStartedAt = reset ? now.toISOString() : row.windowStartedAt;
    const usedSearch = reset ? 0 : (row.searchRequests ?? 0) + (row.reservedSearch ?? 0);
    const usedDetail = reset ? 0 : (row.detailRequests ?? 0) + (row.reservedDetail ?? 0);
    const recovery = Boolean(row?.recoveryPending || row?.cooldownUntil && ['rate_limit', 'blocked'].includes(row.lastStatus));
    const searchLimit = source === 'linkedin' ? Math.min(searchWanted, recovery ? 1 : Infinity,
      Math.max(0, limits.max_search_requests_per_window - usedSearch)) : searchWanted;
    const detailLimit = source === 'linkedin' ? Math.min(detailWanted, recovery ? (searchWanted > 0 ? 0 : 1) : Infinity,
      Math.max(0, limits.max_detail_requests_per_window - usedDetail)) : detailWanted;
    if (searchWanted > 0 ? searchLimit === 0 : detailWanted > 0 && detailLimit === 0) return unavailable(
      `LinkedIn request allowance used; available after ${new Date(new Date(windowStartedAt).getTime() + limits.window_minutes * 60_000).toISOString()}`);
    const token = randomUUID();
    const values = { importToken: token, importUntil: new Date(now.getTime() + leaseMs).toISOString(),
      windowStartedAt,
      searchRequests: reset ? 0 : usedSearch, detailRequests: reset ? 0 : usedDetail,
      reservedSearch: searchLimit, reservedDetail: detailLimit };
    await tx.run(row ? UPDATE(db().SourceHealth).set(values).where({ source })
      : INSERT.into(db().SourceHealth).entries({ source, ...values }));
    return { token, searchLimit, detailLimit, recovery };
  });
}

export async function releaseImportSource(source: string, token: string): Promise<void> {
  await settleSourceRequests(source, token);
}

/** Unknown usage consumes the whole reservation; known usage returns only unused allowance. */
export async function settleSourceRequests(source: string, token: string, searchUsed?: number, detailUsed?: number): Promise<void> {
  await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const row = await tx.run(SELECT.one.from(db().SourceHealth).where({ source, importToken: token }));
    if (!row) return;
    await tx.run(UPDATE(db().SourceHealth).set({ importToken: null, importUntil: null,
      searchRequests: (row.searchRequests ?? 0) + (searchUsed ?? row.reservedSearch ?? 0),
      detailRequests: (row.detailRequests ?? 0) + (detailUsed ?? row.reservedDetail ?? 0),
      reservedSearch: 0, reservedDetail: 0 }).where({ source, importToken: token }));
  });
}
