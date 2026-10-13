import { randomUUID } from 'node:crypto';
import { cds, db, INSERT, SELECT, UPDATE, queryOne } from '../db/index.js';
import type { CollectionOperation } from '../dashboard/types.js';
import { log } from '../util/log.js';

const LEASE_MS = 5 * 60_000;
const NAME = 'collection';
export interface CollectionClaim { operationId: string; token: string }
export class CollectionBusyError extends Error {
  constructor(public readonly operationId: string) { super(`Collection ${operationId} is already running`); }
}

async function expireLease(tx: any, lease: any, now: Date): Promise<void> {
  if (!lease?.token || new Date(lease.expiresAt).getTime() > now.getTime()) return;
  const operation = await tx.run(SELECT.one.from(db().CollectionOperations).where({ ID: lease.operation_ID }));
  await tx.run(UPDATE(db().CollectionOperations).set({ stage: 'Error', outcome: 'Failed',
    finishedAt: now.toISOString(), updatedAt: now.toISOString(),
    message: 'The local process stopped or lost its lease. Start collection to continue.' })
    .where({ ID: lease.operation_ID, outcome: 'Running' }));
  if (operation?.run_ID) {
    const changed = await tx.run(UPDATE(db().CollectionRuns).set({ status: 'Failed', finishedAt: now.toISOString() })
      .where({ ID: operation.run_ID, status: 'Running' }));
    if (changed) await tx.run(INSERT.into(db().CollectionErrors).entries({ ID: randomUUID(), run_ID: operation.run_ID,
      kind: 'interrupted', message: 'The shared collection lease expired.', occurredAt: now.toISOString() }));
  }
  await tx.run(UPDATE(db().CollectionLease).set({ token: null, expiresAt: null }).where({ name: NAME, token: lease.token }));
}

/** SQLite's writer lock makes repeated clicks and independent processes atomic. */
export async function claimCollection(trigger: string, now = new Date()): Promise<
  { acquired: true; claim: CollectionClaim } | { acquired: false; operationId: string }> {
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const lease = await tx.run(SELECT.one.from(db().CollectionLease).where({ name: NAME }));
    await expireLease(tx, lease, now);
    if (lease?.token && new Date(lease.expiresAt).getTime() > now.getTime()) {
      return { acquired: false as const, operationId: lease.operation_ID };
    }
    const operationId = randomUUID(), token = randomUUID();
    await tx.run(INSERT.into(db().CollectionOperations).entries({ ID: operationId, trigger,
      stage: 'Preparing', outcome: 'Running', startedAt: now.toISOString(), updatedAt: now.toISOString() }));
    const values = { operation_ID: operationId, token, expiresAt: new Date(now.getTime() + LEASE_MS).toISOString() };
    await tx.run(lease ? UPDATE(db().CollectionLease).set(values).where({ name: NAME })
      : INSERT.into(db().CollectionLease).entries({ name: NAME, ...values }));
    return { acquired: true as const, claim: { operationId, token } };
  });
}

export async function updateOperation(claim: CollectionClaim, patch: Partial<CollectionOperation>): Promise<void> {
  const now = new Date();
  await cds.tx(async (tx: any) => {
    const renewed = await tx.run(UPDATE(db().CollectionLease)
      .set({ expiresAt: new Date(now.getTime() + LEASE_MS).toISOString() })
      .where({ name: NAME, token: claim.token, operation_ID: claim.operationId, expiresAt: { '>': now.toISOString() } }));
    if (!renewed) throw new Error('Collection lease expired or changed owner');
    await tx.run(UPDATE(db().CollectionOperations).set({ ...patch,
      ...(patch.aiFailureReasons !== undefined ? { aiFailureReasons: JSON.stringify(patch.aiFailureReasons) } : {}), updatedAt: now.toISOString() })
      .where({ ID: claim.operationId }));
  });
}

export function startLeaseHeartbeat(claim: CollectionClaim): () => Promise<void> {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(() => updateOperation(claim, {}))
      .catch((error) => log.warn('Collection lease heartbeat failed', { message: String(error) }));
  }, 30_000);
  timer.unref();
  return async () => { clearInterval(timer); await pending; };
}

export async function finishOperation(claim: CollectionClaim, patch: Partial<CollectionOperation>): Promise<void> {
  await updateOperation(claim, { ...patch, finishedAt: new Date().toISOString() });
  await cds.run(UPDATE(db().CollectionLease).set({ token: null, expiresAt: null })
    .where({ name: NAME, token: claim.token, operation_ID: claim.operationId }));
}

export async function readOperation(id?: string): Promise<CollectionOperation | null> {
  const activeId = await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const lease = await tx.run(SELECT.one.from(db().CollectionLease).where({ name: NAME }));
    const now = new Date();
    await expireLease(tx, lease, now);
    return lease?.token && new Date(lease.expiresAt).getTime() > now.getTime() ? lease.operation_ID : undefined;
  });
  const selectedId = id ?? activeId;
  const row = await queryOne<any>(selectedId ? SELECT.from(db().CollectionOperations).where({ ID: selectedId })
    : SELECT.from(db().CollectionOperations).orderBy('startedAt desc', 'ID desc'));
  if (!row) return null;
  let reasons: string[] = [];
  try { const parsed: unknown = JSON.parse(row.aiFailureReasons ?? '[]');
    if (Array.isArray(parsed)) reasons = parsed.filter((value) => typeof value === 'string');
  } catch { /* Old diagnostic text remains in message. */ }
  return { ...row, aiBudgetExhausted: Boolean(row.aiBudgetExhausted), aiFailureReasons: reasons };
}
