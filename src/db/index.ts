import path from 'node:path';
import { mkdirSync } from 'node:fs';
import cds from '@sap/cds';
import { loadConfig, PROJECT_ROOT } from '../config/index.js';
import { log } from '../util/log.js';

export const NAMESPACE = 'sap.jobradar';

export interface Entities {
  Jobs: any;
  SourceListings: any;
  CollectionRuns: any;
  CollectionTasks: any;
  CollectionErrors: any;
  SourceHealth: any;
  Assessments: any;
  Notifications: any;
}

let dbPromise: Promise<any> | undefined;
let entities: Entities | undefined;

/**
 * Connect to the persistent SQLite database, deploying the CDS schema the
 * first time. Deployment is skipped when the tables already exist, so repeated
 * runs and restarts never drop data.
 */
export async function connectDb(dbPathOverride?: string): Promise<any> {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const dbPath = dbPathOverride ?? loadConfig().dbPath;
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

    cds.env.requires.db = { kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: dbPath } } as any;
    // Keep the plain CSN around: cds.deploy must not receive the already
    // unfolded nodejs model, or foreign keys get generated twice.
    const csn = await cds.load(path.join(PROJECT_ROOT, 'db'));
    cds.model = cds.compile.for.nodejs(csn);

    const db = await cds.connect.to('db');
    const existing: Array<{ name: string }> = await db.run(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    const deployed = existing.some((row) => row.name === 'sap_jobradar_Jobs');
    if (!deployed) {
      log.info('Deploying CDS schema', { dbPath });
      await (cds as any).deploy(csn).to(db);
    }
    await ensureIndexes(db);
    entities = cds.entities(NAMESPACE) as unknown as Entities;
    return db;
  })();
  return dbPromise;
}

/**
 * Database-level uniqueness for the primary dedupe keys. CDS `@assert.unique`
 * is only enforced by the application layer, which is not enough to guarantee
 * "running twice creates no duplicates".
 */
async function ensureIndexes(db: any): Promise<void> {
  const statements = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_source_jobid
       ON sap_jobradar_SourceListings (source, sourceJobId)
       WHERE sourceJobId IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_source_url
       ON sap_jobradar_SourceListings (source, canonicalUrl)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_job_fingerprint
       ON sap_jobradar_Jobs (fingerprint)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_assessment_cachekey
       ON sap_jobradar_Assessments (cacheKey)`,
    `CREATE INDEX IF NOT EXISTS idx_job_company
       ON sap_jobradar_Jobs (companyNormalized)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_status
       ON sap_jobradar_Notifications (status)`,
  ];
  for (const statement of statements) await db.run(statement);
}

export function db(): Entities {
  if (!entities) throw new Error('connectDb() must be awaited before using entities');
  return entities;
}

export async function disconnectDb(): Promise<void> {
  if (!dbPromise) return;
  const connection = await dbPromise;
  await connection.disconnect?.();
  dbPromise = undefined;
  entities = undefined;
}

export { cds };

// Use the explicit cds.ql entry points instead of the implicit globals so the
// query builders are typed and importable from ESM modules.
export const { SELECT, INSERT, UPSERT, UPDATE, DELETE } = cds.ql as any;

/** Run a CQN query and get rows back as a plain, iterable array. */
export async function query<T = any>(statement: unknown): Promise<T[]> {
  const rows = await cds.run(statement as any);
  return (Array.isArray(rows) ? rows : rows ? [rows] : []) as T[];
}

export async function queryOne<T = any>(statement: unknown): Promise<T | undefined> {
  return (await query<T>(statement))[0];
}
