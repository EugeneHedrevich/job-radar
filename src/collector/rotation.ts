import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { cds, db, INSERT, SELECT, UPDATE } from '../db/index.js';
import { planBatch, type PlanOptions, type PlannedBatch } from './plan.js';

const stateSchema = z.object({
  lastSource: z.string().nullable(),
  lastTaskBySource: z.record(z.string(), z.string()),
});

/** Reserve description slots atomically, before any network calls. */
export async function reserveBatchPlan(config: AppConfig, options: PlanOptions = {}): Promise<PlannedBatch> {
  const batchKey = planBatch(config, options).batchKey;
  return cds.tx(async (tx: any) => {
    // Acquire the SQLite write lock before reading cursors in another process.
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const existing = await tx.run(SELECT.one.from(db().DescriptionRotation).where({ batchKey }));
    const previous = existing ? stateSchema.parse(JSON.parse(existing.state)) : undefined;
    const plan = planBatch(config, { ...options, batchKey, descriptionRotation: previous });
    const values = { state: JSON.stringify(plan.descriptionRotation), updatedAt: new Date().toISOString() };
    await tx.run(existing
      ? UPDATE(db().DescriptionRotation).set(values).where({ batchKey })
      : INSERT.into(db().DescriptionRotation).entries({ batchKey, ...values }));
    return plan;
  });
}
