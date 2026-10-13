import { cds, db, INSERT, SELECT, UPDATE } from '../db/index.js';

export interface AiCandidate { jobId: string; cacheKey: string; rulesScore: number }
export interface AiQueueRow extends AiCandidate { queuedAt: string; status: string }

/** Reconcile durable work with current inputs and completed attempt caches.
 * Rules-only results do not finish work; a saved AI fallback does. */
export async function synchronizeAiQueue(candidates: AiCandidate[], scope: string[]): Promise<Map<string, AiQueueRow>> {
  if (!scope.length) return new Map();
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const current = new Set(candidates.map((candidate) => candidate.cacheKey));
    const rows = await tx.run(SELECT.from(db().AiAssessmentQueue).where({ job_ID: { in: scope } }));
    const byKey = new Map<string, any>(rows.map((row: any) => [row.cacheKey, row]));
    for (const row of rows) {
      if (row.status === 'Pending' && !current.has(row.cacheKey)) {
        await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded' }).where({ cacheKey: row.cacheKey }));
      }
    }
    const result = new Map<string, AiQueueRow>();
    // One arrival time for this batch prevents SELECT/insert iteration order
    // from deciding the paid-call order among equally scored new candidates.
    const arrivedAt = new Date().toISOString();
    for (const candidate of candidates) {
      const job = await tx.run(SELECT.one.from(db().Jobs).columns('status').where({ ID: candidate.jobId }));
      if (!job || job.status === 'Ignored') {
        await tx.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Superseded' })
          .where({ job_ID: candidate.jobId, status: 'Pending' }));
        continue;
      }
      const cached = await tx.run(SELECT.one.from(db().Assessments).where({ cacheKey: candidate.cacheKey }));
      const previous = byKey.get(candidate.cacheKey);
      const queuedAt = previous?.queuedAt ?? arrivedAt;
      const status = cached ? 'Completed' : 'Pending';
      const values = { job_ID: candidate.jobId, rulesScore: candidate.rulesScore, queuedAt, status,
        completedAt: cached ? previous?.completedAt ?? cached.createdAt : null };
      await tx.run(previous
        ? UPDATE(db().AiAssessmentQueue).set(values).where({ cacheKey: candidate.cacheKey })
        : INSERT.into(db().AiAssessmentQueue).entries({ cacheKey: candidate.cacheKey, ...values }));
      result.set(candidate.cacheKey, { ...candidate, queuedAt, status });
    }
    return result;
  });
}

/** Unbounded aging adds one score point per three hours. Old candidates
 * eventually outrank new high-scoring arrivals; ties have a stable order. */
export function aiPriority(row: AiQueueRow, at: Date): number {
  return row.rulesScore + Math.max(0, at.getTime() - new Date(row.queuedAt).getTime()) / (3 * 3_600_000);
}

export async function completeAiAttempt(cacheKey: string): Promise<void> {
  await cds.run(UPDATE(db().AiAssessmentQueue).set({ status: 'Completed', completedAt: new Date().toISOString() })
    .where({ cacheKey }));
}
