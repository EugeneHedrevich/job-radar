import { cds, db, INSERT, SELECT, UPDATE } from '../db/index.js';
import type { AiOutcome } from '../matching/types.js';
export type { AiOutcome } from '../matching/types.js';

export const MAX_AI_ATTEMPTS = 3; // Initial attempt plus two explicit retries, per unchanged input key.
export const PENDING_AI_STATUSES = ['Pending', 'RetryPending'];
export interface AiCandidate { jobId: string; cacheKey: string; rulesScore: number }
export interface AiQueueRow extends AiCandidate {
  queuedAt: string; status: string; attempts: number; retryAfter: string | null;
}

/** Recognise historical fallbacks without changing cache keys or discarding them. */
export function aiOutcomeOf(row: any): AiOutcome | null {
  if (!row) return null;
  if (row.aiOutcome) return row.aiOutcome;
  if (row.engine === 'llm') return 'Succeeded';
  const text = `${row.explanation ?? ''} ${row.missingInformation ?? ''}`;
  if (/AI request failed|AI assessment unavailable/i.test(text)) return 'ProviderFailure';
  if (/rules fallback used|AI assessment uncertainty/i.test(text)) return 'RejectedOutput';
  return null;
}

/** Failures stay held until the user explicitly requeues them. */
export async function synchronizeAiQueue(candidates: AiCandidate[], scope: string[], attemptTimeoutMs = 120_000): Promise<Map<string, AiQueueRow>> {
  if (!scope.length) return new Map();
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const current = new Set(candidates.map((candidate) => candidate.cacheKey));
    const rows = await tx.run(SELECT.from(db().AiAssessmentQueue).where({ job_ID: { in: scope } }));
    const byKey = new Map<string, any>(rows.map((row: any) => [row.cacheKey, row]));
    for (const row of rows) if (!current.has(row.cacheKey) && row.status !== 'Completed') {
      await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded' }).where({ cacheKey: row.cacheKey }));
    }
    const result = new Map<string, AiQueueRow>();
    const arrivedAt = new Date().toISOString();
    for (const candidate of candidates) {
      const job = await tx.run(SELECT.one.from(db().Jobs).columns('status').where({ ID: candidate.jobId }));
      if (!job || job.status === 'Ignored') {
        await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded' }).where({ cacheKey: candidate.cacheKey }));
        continue;
      }
      const cached = await tx.run(SELECT.one.from(db().Assessments).where({ cacheKey: candidate.cacheKey }));
      const previous = byKey.get(candidate.cacheKey);
      const cachedOutcome = cached ? aiOutcomeOf(cached) ?? 'ProviderFailure' : null;
      const attempting = previous?.status === 'Attempting' && previous.attemptedAt &&
        Date.now() - new Date(previous.attemptedAt).getTime() < attemptTimeoutMs;
      const interrupted = previous?.status === 'Attempting' && !attempting;
      const attempts = Math.max(previous?.attempts ?? 0, cached ? 1 : 0);
      const queuedAt = previous?.queuedAt ?? arrivedAt;
      const status = attempting ? 'Attempting' : interrupted ? 'Failed' : cachedOutcome === 'Succeeded' ? 'Completed'
        : previous?.status === 'RetryPending' ? 'RetryPending' : cachedOutcome === 'RejectedOutput' ? 'Rejected'
          : cachedOutcome === 'ProviderFailure' ? 'Failed' : previous?.status === 'Failed' || previous?.status === 'Rejected'
            ? previous.status : 'Pending';
      const values = { job_ID: candidate.jobId, rulesScore: candidate.rulesScore, queuedAt, status, attempts,
        completedAt: status === 'Completed' ? previous?.completedAt ?? cached?.createdAt : null,
        ...(interrupted ? { lastOutcome: 'ProviderFailure', lastReason: 'AI attempt was interrupted; its outcome could not be verified.' }
          : cachedOutcome ? { lastOutcome: cachedOutcome, lastReason: cached.aiReason ??
            (cachedOutcome === 'Succeeded' ? null : String(cached.explanation ?? 'Historical AI fallback').slice(0, 1900)) } : {}) };
      await tx.run(previous ? UPDATE(db().AiAssessmentQueue).set(values).where({ cacheKey: candidate.cacheKey })
        : INSERT.into(db().AiAssessmentQueue).entries({ cacheKey: candidate.cacheKey, ...values }));
      result.set(candidate.cacheKey, { ...candidate, queuedAt, status, attempts, retryAfter: previous?.retryAfter ?? null });
    }
    return result;
  });
}

export function aiPriority(row: AiQueueRow, at: Date): number {
  if (!PENDING_AI_STATUSES.includes(row.status)) return -Infinity;
  return row.rulesScore + Math.max(0, at.getTime() - new Date(row.queuedAt).getTime()) / (3 * 3_600_000);
}

/** A short SQLite claim prevents repeated retry clicks or overlapping ranks paying twice. */
export async function claimAiAttempt(cacheKey: string, force = false, operationId?: string): Promise<number | null> {
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const row = await tx.run(SELECT.one.from(db().AiAssessmentQueue).where({ cacheKey }));
    if (!row || row.attempts >= MAX_AI_ATTEMPTS || row.status === 'Attempting' || row.status === 'Superseded' ||
      !force && !PENDING_AI_STATUSES.includes(row.status) || row.retryAfter && new Date(row.retryAfter) > new Date()) return null;
    const job = await tx.run(SELECT.one.from(db().Jobs).columns('status').where({ ID: row.job_ID }));
    if (!job || job.status === 'Ignored') return null;
    if (operationId) {
      const operation = await tx.run(SELECT.one.from(db().CollectionOperations).where({ ID: operationId, outcome: 'Running' }));
      if (!operation || operation.aiCallsReserved >= operation.aiCallLimit) return null;
      // Reserve before I/O; a crash cannot refund an unknown paid attempt.
      await tx.run(UPDATE(db().CollectionOperations).set({ aiCallsReserved: (operation.aiCallsReserved ?? 0) + 1 }).where({ ID: operationId }));
    }
    const attempt = (row.attempts ?? 0) + 1;
    await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Attempting', attempts: attempt,
      attemptedAt: new Date().toISOString() }).where({ cacheKey }));
    return attempt;
  });
}

export async function completeAiAttempt(cacheKey: string, attempt: number, outcome: AiOutcome, reason: string | null,
  retryAfter: string | null = null): Promise<void> {
  await cds.run(UPDATE(db().AiAssessmentQueue).set({ status: outcome === 'Succeeded' ? 'Completed'
    : outcome === 'RejectedOutput' ? 'Rejected' : 'Failed', completedAt: outcome === 'Succeeded' ? new Date().toISOString() : null,
    lastOutcome: outcome, lastReason: reason, retryAfter }).where({ cacheKey, status: 'Attempting', attempts: attempt }));
}
