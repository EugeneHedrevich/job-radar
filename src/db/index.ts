import path from 'node:path';
import { mkdirSync } from 'node:fs';
import cds from '@sap/cds';
import { loadConfig, PROJECT_ROOT } from '../config/index.js';
import { loadFixture } from '../fixtures/load.js';
import { normalizeJob } from '../normalize/index.js';
import { log } from '../util/log.js';

export const NAMESPACE = 'sap.jobradar';

export interface Entities {
  Jobs: any;
  SourceListings: any;
  CollectionRuns: any;
  CollectionTasks: any;
  CollectionErrors: any;
  SourceHealth: any;
  DescriptionRotation: any;
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

    cds.env.requires.db = {
      kind: 'sqlite', impl: '@cap-js/sqlite', credentials: { url: dbPath },
      // The synchronous SQLite driver cannot wait on another connection in the
      // same event loop. Serialize this process's short database transactions.
      pool: { min: 1, max: 1, evictionRunIntervalMillis: 0 },
    } as any;
    // Keep the plain CSN around: cds.deploy must not receive the already
    // unfolded nodejs model, or foreign keys get generated twice.
    const csn = await cds.load(path.join(PROJECT_ROOT, 'db'));
    cds.model = cds.compile.for.nodejs(csn);

    const db = await cds.connect.to('db');
    // Independent CLI processes must wait for short writes instead of failing
    // immediately with SQLITE_BUSY. No transaction spans Telegram delivery.
    await db.run('PRAGMA busy_timeout = 5000');
    const existing: Array<{ name: string }> = await db.run(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    );
    const deployed = existing.some((row) => row.name === 'sap_jobradar_Jobs');
    if (!deployed) {
      log.info('Deploying CDS schema', { dbPath });
      await (cds as any).deploy(csn).to(db);
    }
    await db.tx(async (tx: any) => {
      // CAP starts a deferred transaction. A write, even with no matching rows,
      // acquires SQLite's writer lock before any migration reads the schema.
      // A competing process waits here, then checks the committed schema again.
      await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
      await ensureDemoProvenance(tx);
      await ensureNotificationClaims(tx);
      await ensureMatchingState(tx);
      await ensureIndexes(tx);
    });
    entities = cds.entities(NAMESPACE) as unknown as Entities;
    return db;
  })();
  return dbPromise;
}

async function ensureMatchingState(connection: any): Promise<void> {
  const runColumns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_CollectionRuns)');
  if (!runColumns.some((column) => column.name === 'heartbeatAt')) {
    await connection.run('ALTER TABLE sap_jobradar_CollectionRuns ADD COLUMN heartbeatAt TIMESTAMP');
  }
  const listingColumns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_SourceListings)');
  if (!listingColumns.some((column) => column.name === 'descriptionAttemptedAt')) {
    await connection.run('ALTER TABLE sap_jobradar_SourceListings ADD COLUMN descriptionAttemptedAt TIMESTAMP');
  }
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_DescriptionRotation
    (batchKey VARCHAR(200) PRIMARY KEY NOT NULL, state TEXT, updatedAt TIMESTAMP)`);
  const columns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_Assessments)');
  if (!columns.some((column) => column.name === 'mandatoryGapEvidence')) {
    await connection.run('ALTER TABLE sap_jobradar_Assessments ADD COLUMN mandatoryGapEvidence TEXT');
  }
}

async function ensureNotificationClaims(connection: any): Promise<void> {
  const columns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_Notifications)');
  for (const [name, type] of [['claimToken', 'VARCHAR(36)'], ['claimUntil', 'TIMESTAMP']]) {
    if (!columns.some((column) => column.name === name)) {
      await connection.run(`ALTER TABLE sap_jobradar_Notifications ADD COLUMN ${name} ${type}`);
    }
  }
  // Preserve the history of duplicate rows left by earlier races, retaining a
  // sent row if one exists. Only one active notification may remain per job.
  await connection.run(`UPDATE sap_jobradar_Notifications SET status = 'Superseded'
    WHERE ID IN (SELECT ID FROM (
      SELECT ID, ROW_NUMBER() OVER (PARTITION BY job_ID, channel ORDER BY
        CASE status WHEN 'Sent' THEN 0 WHEN 'Sending' THEN 1 ELSE 2 END,
        createdAt, ID) AS position
      FROM sap_jobradar_Notifications WHERE status != 'Superseded'
    ) WHERE position > 1)`);
}

/** Add provenance without redeploying or dropping an existing database. */
async function ensureDemoProvenance(connection: any): Promise<void> {
  const columns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_Jobs)');
  if (!columns.some((column) => column.name === 'isDemo')) {
    await connection.run('ALTER TABLE sap_jobradar_Jobs ADD COLUMN isDemo BOOLEAN DEFAULT 0');
  }
  // Older versions placed the bundled fictional listings in the live database.
  // Identify them by listing identity, including secondary listings after a merge.
  for (const record of loadFixture(path.join(PROJECT_ROOT, 'fixtures', 'demo-jobs.jsonl'))) {
    const listing = normalizeJob(record.job, record.source)?.listing;
    if (!listing) continue;
    await connection.run(
      `UPDATE sap_jobradar_Jobs SET isDemo = 1 WHERE ID IN
       (SELECT job_ID FROM sap_jobradar_SourceListings
        WHERE source = ? AND (sourceJobId = ? OR canonicalUrl = ?))`,
      [listing.source, listing.sourceJobId, listing.canonicalUrl],
    );
  }
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
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_job_channel
       ON sap_jobradar_Notifications (job_ID, channel) WHERE status != 'Superseded'`,
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
