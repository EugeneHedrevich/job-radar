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
  SearchProgress: any;
  AiAssessmentQueue: any;
  ListingActivityEvents: any;
  Assessments: any;
  Notifications: any;
  CollectionLease: any;
  CollectionOperations: any;
  FollowUpReminders: any;
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
      await ensurePersonalTracking(tx);
      await ensureLocalControls(tx);
      await ensureRecoveryFields(tx);
      await ensureIndexes(tx);
    });
    entities = cds.entities(NAMESPACE) as unknown as Entities;
    return db;
  })();
  return dbPromise;
}

/** Add user-owned fields in place; retain all vacancy and application history. */
async function ensurePersonalTracking(connection: any): Promise<void> {
  const columns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_Jobs)');
  for (const [name, type] of [
    ['personalNotes', 'TEXT'], ['applicationDate', 'DATE'],
    ['cvSent', 'BOOLEAN DEFAULT 0'], ['sentCvLabel', 'VARCHAR(500)'],
    ['cvSentAt', 'TIMESTAMP'], ['manuallyImportedAt', 'TIMESTAMP'],
    ['viewedAt', 'TIMESTAMP'],
  ]) {
    if (!columns.some((column) => column.name === name)) {
      await connection.run(`ALTER TABLE sap_jobradar_Jobs ADD COLUMN ${name} ${type}`);
    }
  }
}

async function ensureLocalControls(connection: any): Promise<void> {
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_CollectionLease
    (name VARCHAR(50) PRIMARY KEY NOT NULL, operation_ID VARCHAR(36), token VARCHAR(36), expiresAt TIMESTAMP)`);
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_CollectionOperations
    (ID VARCHAR(36) PRIMARY KEY NOT NULL, run_ID VARCHAR(36), trigger VARCHAR(50), stage VARCHAR(20),
    outcome VARCHAR(30), startedAt TIMESTAMP, updatedAt TIMESTAMP, finishedAt TIMESTAMP,
    tasksTotal INTEGER DEFAULT 0, tasksDone INTEGER DEFAULT 0, tasksSucceeded INTEGER DEFAULT 0,
    tasksFailed INTEGER DEFAULT 0, tasksSkipped INTEGER DEFAULT 0, jobsFound INTEGER DEFAULT 0,
    jobsNew INTEGER DEFAULT 0, jobsUpdated INTEGER DEFAULT 0, jobsAssessed INTEGER DEFAULT 0,
    aiCalls INTEGER DEFAULT 0, aiBacklog INTEGER DEFAULT 0, aiBudgetExhausted BOOLEAN DEFAULT 0, message VARCHAR(2000))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_FollowUpReminders
    (ID VARCHAR(36) PRIMARY KEY NOT NULL, job_ID VARCHAR(36), kind VARCHAR(30), sentAt TIMESTAMP NOT NULL,
    dueDate DATE NOT NULL, status VARCHAR(20), createdAt TIMESTAMP, updatedAt TIMESTAMP, completedAt TIMESTAMP)`);
}

async function ensureRecoveryFields(connection: any): Promise<void> {
  for (const [table, fields] of [
    ['Assessments', [['aiOutcome', 'VARCHAR(30)'], ['aiReason', 'VARCHAR(2000)']]],
    ['AiAssessmentQueue', [['attempts', 'INTEGER DEFAULT 0'], ['attemptedAt', 'TIMESTAMP'],
      ['retryAfter', 'TIMESTAMP'], ['lastOutcome', 'VARCHAR(30)'], ['lastReason', 'VARCHAR(2000)']]],
    ['CollectionOperations', [['cachedAssessments', 'INTEGER'], ['rulesAssessments', 'INTEGER'],
      ['aiSucceeded', 'INTEGER'], ['aiFailures', 'INTEGER'], ['aiFailureReasons', 'TEXT']]],
    ['SourceHealth', [['importToken', 'VARCHAR(36)'], ['importUntil', 'TIMESTAMP']]],
    ['SearchProgress', [['headCheckedAt', 'TIMESTAMP']]],
    ['SourceHealth', [['windowStartedAt', 'TIMESTAMP'], ['searchRequests', 'INTEGER DEFAULT 0'],
      ['detailRequests', 'INTEGER DEFAULT 0'], ['reservedSearch', 'INTEGER DEFAULT 0'], ['reservedDetail', 'INTEGER DEFAULT 0'],
      ['recoveryPending', 'BOOLEAN DEFAULT 0'], ['lastHttpStatus', 'INTEGER'], ['lastRetryAfterSeconds', 'REAL']]],
    ['CollectionRuns', [['jobsAccepted', 'INTEGER'], ['jobsFiltered', 'INTEGER'], ['exclusionReasons', 'TEXT']]],
    ['CollectionOperations', [['jobsAccepted', 'INTEGER'], ['jobsFiltered', 'INTEGER'], ['exclusionReasons', 'TEXT']]],
  ] as const) {
    const columns: Array<{ name: string }> = await connection.run(`PRAGMA table_info(sap_jobradar_${table})`);
    for (const [field, type] of fields) if (!columns.some((column) => column.name === field))
      await connection.run(`ALTER TABLE sap_jobradar_${table} ADD COLUMN ${field} ${type}`);
  }
}

async function ensureMatchingState(connection: any): Promise<void> {
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_SearchProgress
    (taskKey VARCHAR(200) PRIMARY KEY NOT NULL, state TEXT, sweepStartedAt TIMESTAMP, updatedAt TIMESTAMP)`);
  for (const [table, fields] of [
    ['CollectionTasks', [['searchRequests', 'INTEGER'], ['detailRequests', 'INTEGER']]],
    ['SourceHealth', [['rateLimitStreak', 'INTEGER DEFAULT 0']]],
  ] as const) {
    const existing: Array<{ name: string }> = await connection.run(`PRAGMA table_info(sap_jobradar_${table})`);
    for (const [field, type] of fields) if (!existing.some((column) => column.name === field))
      await connection.run(`ALTER TABLE sap_jobradar_${table} ADD COLUMN ${field} ${type}`);
  }
  const runColumns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_CollectionRuns)');
  if (!runColumns.some((column) => column.name === 'heartbeatAt')) {
    await connection.run('ALTER TABLE sap_jobradar_CollectionRuns ADD COLUMN heartbeatAt TIMESTAMP');
  }
  const listingColumns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_SourceListings)');
  if (!listingColumns.some((column) => column.name === 'descriptionAttemptedAt')) {
    await connection.run('ALTER TABLE sap_jobradar_SourceListings ADD COLUMN descriptionAttemptedAt TIMESTAMP');
  }
  for (const [name, type] of [
    ['activityState', "VARCHAR(20) DEFAULT 'Unknown'"], ['activityCheckedAt', 'TIMESTAMP'],
    ['closureReason', 'VARCHAR(50)'], ['activityEvidence', 'VARCHAR(2000)'],
    ['activityAttemptedAt', 'TIMESTAMP'], ['validThrough', 'TIMESTAMP'],
  ]) {
    if (!listingColumns.some((column) => column.name === name)) {
      await connection.run(`ALTER TABLE sap_jobradar_SourceListings ADD COLUMN ${name} ${type}`);
    }
  }
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_AiAssessmentQueue
    (cacheKey VARCHAR(128) PRIMARY KEY NOT NULL, job_ID VARCHAR(36), rulesScore INTEGER,
      queuedAt TIMESTAMP, completedAt TIMESTAMP, status VARCHAR(20))`);
  await connection.run(`CREATE TABLE IF NOT EXISTS sap_jobradar_ListingActivityEvents
    (ID VARCHAR(36) PRIMARY KEY NOT NULL, listing_ID VARCHAR(36), state VARCHAR(20),
      reason VARCHAR(50), evidence VARCHAR(2000), checkedAt TIMESTAMP)`);
  const eventColumns: Array<{ name: string }> = await connection.run('PRAGMA table_info(sap_jobradar_ListingActivityEvents)');
  if (!eventColumns.some((column) => column.name === 'validThrough')) {
    await connection.run('ALTER TABLE sap_jobradar_ListingActivityEvents ADD COLUMN validThrough TIMESTAMP');
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
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_cv_followup
       ON sap_jobradar_FollowUpReminders (job_ID, kind) WHERE status = 'Pending'`,
    `CREATE INDEX IF NOT EXISTS idx_followup_due ON sap_jobradar_FollowUpReminders (status, dueDate)`,
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
    `CREATE INDEX IF NOT EXISTS idx_ai_queue_pending
       ON sap_jobradar_AiAssessmentQueue (status, queuedAt, job_ID)`,
    `CREATE INDEX IF NOT EXISTS idx_listing_activity
       ON sap_jobradar_SourceListings (job_ID, activityState)`,
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
  delete (cds.services as any)?.db;
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
