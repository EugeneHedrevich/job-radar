import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PROJECT_ROOT } from "../src/config/index.js";
import { connectDb, db, disconnectDb, query, SELECT } from "../src/db/index.js";
import { notify } from "../src/pipeline/notify.js";
import { startTestWorker, type TestWorker } from './helpers/worker.js';
interface WorkerEvent {
    type: string;
    message?: string;
}
type Worker = TestWorker<WorkerEvent>;
const workers: Worker[] = [];
let legacyTemplate: string;
function startWorker(dbPath: string, holdSchema = false): Worker {
    const worker = startTestWorker<WorkerEvent>('migration-worker.ts', {
        JOB_RADAR_TEST_DB_PATH: dbPath, JOB_RADAR_TEST_HOLD_SCHEMA: String(holdSchema),
    });
    workers.push(worker);
    return worker;
}
afterEach(async () => {
    for (const worker of workers.splice(0)) {
        if (worker.child.exitCode === null)
            worker.child.kill();
    }
    await disconnectDb();
});
async function createLegacyTemplate(): Promise<string> {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'job-radar-migration-')), 'legacy.sqlite');
    await connectDb(dbPath);
    await disconnectDb();
    const legacy = new DatabaseSync(dbPath);
    try {
        legacy.exec(`
      DROP INDEX idx_notification_job_channel;
      ALTER TABLE sap_jobradar_Notifications DROP COLUMN claimToken;
      ALTER TABLE sap_jobradar_Notifications DROP COLUMN claimUntil;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN isDemo;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN personalNotes;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN viewedAt;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN applicationDate;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN cvSent;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN sentCvLabel;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN descriptionAttemptedAt;
      DROP INDEX idx_listing_activity;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN activityState;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN activityCheckedAt;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN closureReason;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN activityEvidence;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN activityAttemptedAt;
      ALTER TABLE sap_jobradar_SourceListings DROP COLUMN validThrough;
      ALTER TABLE sap_jobradar_Assessments DROP COLUMN mandatoryGapEvidence;
      DROP TABLE sap_jobradar_DescriptionRotation;
      DROP TABLE sap_jobradar_SearchProgress;
      ALTER TABLE sap_jobradar_CollectionTasks DROP COLUMN searchRequests;
      ALTER TABLE sap_jobradar_CollectionTasks DROP COLUMN detailRequests;
      ALTER TABLE sap_jobradar_CollectionTasks DROP COLUMN coverage;
      ALTER TABLE sap_jobradar_CollectionTasks DROP COLUMN coverageReason;
      ALTER TABLE sap_jobradar_CollectionRuns DROP COLUMN operationId;
      ALTER TABLE sap_jobradar_CollectionRuns DROP COLUMN diagnostics;
      ALTER TABLE sap_jobradar_CollectionRuns DROP COLUMN deferredKeys;
      ALTER TABLE sap_jobradar_CollectionRuns DROP COLUMN jobsDeferred;
      ALTER TABLE sap_jobradar_Jobs DROP COLUMN enrichmentDeferredAt;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN resumeAt;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN aiCallsReserved;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN aiCallLimit;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN jobsDeferred;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN lastRequestAt;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN lastFailureStatus;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN lastFailureAt;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN lastFailureKind;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN lastFailureMessage;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN lastRateLimitAt;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN recoverySuccesses;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN weeklyState;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN currentSource;
      ALTER TABLE sap_jobradar_CollectionOperations DROP COLUMN assessmentRemaining;
      ALTER TABLE sap_jobradar_SourceHealth DROP COLUMN rateLimitStreak;
      DROP TABLE sap_jobradar_AiAssessmentQueue;
      DROP TABLE sap_jobradar_ListingActivityEvents;
      INSERT INTO sap_jobradar_SourceHealth (source, lastStatus, lastHttpStatus, updatedAt)
        VALUES ('linkedin', 'ok', 429, '2026-10-21T10:38:00Z');
      INSERT INTO sap_jobradar_Jobs
        (ID, fingerprint, title, description, primaryUrl, firstSeenAt, lastSeenAt)
        VALUES ('legacy-job', 'legacy-fingerprint', 'Original vacancy', 'Original description',
          'https://example.com/legacy', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
      INSERT INTO sap_jobradar_Notifications
        (ID, job_ID, channel, status, attempts, payload, telegramMessageId, createdAt)
        VALUES
          ('pending-copy', 'legacy-job', 'telegram', 'Pending', 0, 'original pending payload', NULL, '2026-10-01T00:00:00Z'),
          ('sent-copy', 'legacy-job', 'telegram', 'Sent', 1, 'original sent payload', 42, '2026-10-02T00:00:00Z'),
          ('older-history', 'legacy-job', 'telegram', 'Superseded', 2, 'original history payload', 7, '2026-09-01T00:00:00Z');
      INSERT INTO sap_jobradar_SourceListings
        (ID, job_ID, source, sourceJobId, canonicalUrl, rawRecord, firstSeenAt, lastSeenAt)
        VALUES ('legacy-listing', 'legacy-job', 'linkedin', 'legacy-id', 'https://example.com/legacy',
          '{"title":"Original vacancy"}', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z');
      INSERT INTO sap_jobradar_Assessments
        (ID, job_ID, cacheKey, engine, fitScore, mandatoryGaps, createdAt)
        VALUES ('legacy-assessment', 'legacy-job', 'revision-6-cache', 'llm', 60,
          '["original gap"]', '2026-10-01T00:00:00Z');
    `);
    }
    finally {
        legacy.close();
    }
    return dbPath;
}
beforeAll(async () => { legacyTemplate = await createLegacyTemplate(); });
function legacyDatabase(): string {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'job-radar-migration-')), 'legacy.sqlite');
    copyFileSync(legacyTemplate, dbPath);
    return dbPath;
}
describe('serialized legacy database migrations', () => {
    it('adds refresh fields to an existing activity database without losing observations', async () => {
        const dbPath = legacyDatabase();
        await connectDb(dbPath); await disconnectDb();
        const previous = new DatabaseSync(dbPath);
        try {
            previous.exec(`ALTER TABLE sap_jobradar_SourceListings DROP COLUMN validThrough;
              ALTER TABLE sap_jobradar_SourceListings DROP COLUMN activityAttemptedAt;
              ALTER TABLE sap_jobradar_ListingActivityEvents DROP COLUMN validThrough;
              UPDATE sap_jobradar_SourceListings SET activityState = 'Active', activityCheckedAt = '2026-10-01T12:00:00Z';
              INSERT INTO sap_jobradar_ListingActivityEvents (ID, listing_ID, state, evidence, checkedAt)
              VALUES ('saved-observation', 'legacy-listing', 'Active', 'Original page evidence', '2026-10-01T12:00:00Z')`);
        } finally { previous.close(); }
        await connectDb(dbPath); await disconnectDb();
        const migrated = new DatabaseSync(dbPath);
        try {
            expect(migrated.prepare('SELECT activityState, validThrough, activityAttemptedAt FROM sap_jobradar_SourceListings').get())
                .toEqual({ activityState: 'Active', validThrough: null, activityAttemptedAt: null });
            expect(migrated.prepare('SELECT ID, state, evidence, validThrough FROM sap_jobradar_ListingActivityEvents').get())
                .toEqual({ ID: 'saved-observation', state: 'Active', evidence: 'Original page evidence', validThrough: null });
        } finally { migrated.close(); }
    });
    it('locks before inspecting columns and preserves data, Superseded history and notification uniqueness', async () => {
        const dbPath = legacyDatabase();
        const first = startWorker(dbPath, true);
        const second = startWorker(dbPath);
        await Promise.all([first.wait('ready'), second.wait('ready')]);
        first.child.send({ type: 'start' });
        await first.wait('schema-read');
        second.child.send({ type: 'start' });
        await second.wait('starting');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(second.events.some((event) => ['schema-read', 'done', 'error'].includes(event.type))).toBe(false);
        first.child.send({ type: 'release' });
        await Promise.all([first.wait('done'), second.wait('done')]);
        const migrated = new DatabaseSync(dbPath);
        try {
            const columns = migrated.prepare('PRAGMA table_info(sap_jobradar_Notifications)').all();
            expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['claimToken', 'claimUntil']));
            for (const [table, expected] of Object.entries({ CollectionOperations: ['resumeAt', 'aiCallsReserved', 'aiCallLimit', 'jobsDeferred'],
              CollectionRuns: ['deferredKeys', 'jobsDeferred'], Jobs: ['enrichmentDeferredAt'], SourceHealth: ['lastRequestAt', 'lastFailureAt', 'lastFailureStatus', 'lastRateLimitAt', 'recoverySuccesses'] }))
              expect(migrated.prepare(`PRAGMA table_info(sap_jobradar_${table})`).all().map(column => column.name)).toEqual(expect.arrayContaining(expected));
            expect(migrated.prepare('SELECT lastHttpStatus, lastRequestAt, lastFailureStatus, lastFailureAt, recoveryPending, rateLimitStreak FROM sap_jobradar_SourceHealth').get())
              .toEqual({ lastHttpStatus: null, lastRequestAt: null, lastFailureStatus: 429, lastFailureAt: null, recoveryPending: 1, rateLimitStreak: 1 });
            expect(migrated.prepare('PRAGMA table_info(sap_jobradar_Assessments)').all().map((column) => column.name)).toContain('mandatoryGapEvidence');
            expect(migrated.prepare('PRAGMA table_info(sap_jobradar_CollectionTasks)').all().map((column) => column.name))
                .toEqual(expect.arrayContaining(['searchRequests', 'detailRequests', 'coverage', 'coverageReason']));
            expect(migrated.prepare('PRAGMA table_info(sap_jobradar_SearchProgress)').all().map((column) => column.name))
                .toEqual(expect.arrayContaining(['headCheckedAt', 'queryKey', 'failedAt', 'successfulVisits']));
            expect(migrated.prepare('PRAGMA table_info(sap_jobradar_SourceHealth)').all().map((column) => column.name)).toContain('rateLimitStreak');
            expect(migrated.prepare('SELECT COUNT(*) AS count FROM sap_jobradar_SearchProgress').get()).toEqual({ count: 0 });
            expect(migrated.prepare('PRAGMA table_info(sap_jobradar_SourceListings)').all().map((column) => column.name)).toContain('descriptionAttemptedAt');
            expect(migrated.prepare('PRAGMA table_info(sap_jobradar_SourceListings)').all().map((column) => column.name))
                .toEqual(expect.arrayContaining(['activityState', 'activityCheckedAt', 'activityAttemptedAt', 'validThrough']));
            expect(migrated.prepare('SELECT ID, sourceJobId, rawRecord, activityState FROM sap_jobradar_SourceListings').all()).toEqual([
                { ID: 'legacy-listing', sourceJobId: 'legacy-id', rawRecord: '{"title":"Original vacancy"}', activityState: 'Unknown' },
            ]);
            expect(migrated.prepare('SELECT ID, cacheKey, fitScore, mandatoryGaps, mandatoryGapEvidence FROM sap_jobradar_Assessments').all()).toEqual([{
                    ID: 'legacy-assessment', cacheKey: 'revision-6-cache', fitScore: 60, mandatoryGaps: '["original gap"]', mandatoryGapEvidence: null,
                }]);
            expect(migrated.prepare('SELECT ID, title, description, primaryUrl FROM sap_jobradar_Jobs').all()).toEqual([{
                    ID: 'legacy-job', title: 'Original vacancy', description: 'Original description', primaryUrl: 'https://example.com/legacy',
                }]);
            expect(migrated.prepare('SELECT status, personalNotes, viewedAt, applicationDate, cvSent, sentCvLabel FROM sap_jobradar_Jobs').get())
                .toEqual({ status: 'New', personalNotes: null, viewedAt: null, applicationDate: null, cvSent: 0, sentCvLabel: null });
            expect(migrated.prepare('SELECT ID, status, payload, telegramMessageId FROM sap_jobradar_Notifications ORDER BY ID').all()).toEqual([
                { ID: 'older-history', status: 'Superseded', payload: 'original history payload', telegramMessageId: 7 },
                { ID: 'pending-copy', status: 'Superseded', payload: 'original pending payload', telegramMessageId: null },
                { ID: 'sent-copy', status: 'Sent', payload: 'original sent payload', telegramMessageId: 42 },
            ]);
            expect(() => migrated.exec(`INSERT INTO sap_jobradar_Notifications (ID, job_ID, channel, status)
        VALUES ('extra-active', 'legacy-job', 'telegram', 'Pending')`)).toThrow(/UNIQUE/);
        }
        finally {
            migrated.close();
        }
    }, 15000);
    it('propagates unrelated database errors and rolls back schema and history changes', async () => {
        const dbPath = legacyDatabase();
        const broken = new DatabaseSync(dbPath);
        try {
            broken.exec(`DROP INDEX idx_job_fingerprint;
        INSERT INTO sap_jobradar_Jobs (ID, fingerprint, title, primaryUrl, firstSeenAt, lastSeenAt)
        VALUES ('conflicting-job', 'legacy-fingerprint', 'Second vacancy', 'https://example.com/second',
          '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`);
        }
        finally {
            broken.close();
        }
        const worker = startWorker(dbPath);
        await worker.wait('ready');
        worker.child.send({ type: 'start' });
        expect((await worker.wait('error')).message).toMatch(/UNIQUE/);
        const rolledBack = new DatabaseSync(dbPath);
        try {
            const columns = rolledBack.prepare('PRAGMA table_info(sap_jobradar_Notifications)').all().map((column) => column.name);
            expect(columns).not.toContain('claimToken');
            expect(columns).not.toContain('claimUntil');
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_Jobs)').all().map((column) => column.name)).not.toContain('isDemo');
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_Jobs)').all().map((column) => column.name))
                .not.toEqual(expect.arrayContaining(['personalNotes', 'applicationDate', 'cvSent', 'sentCvLabel']));
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_Assessments)').all().map((column) => column.name)).not.toContain('mandatoryGapEvidence');
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_SourceListings)').all().map((column) => column.name)).not.toContain('descriptionAttemptedAt');
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_SourceListings)').all().map((column) => column.name)).not.toContain('activityState');
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_AiAssessmentQueue)').all()).toEqual([]);
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_ListingActivityEvents)').all()).toEqual([]);
            expect(rolledBack.prepare('PRAGMA table_info(sap_jobradar_DescriptionRotation)').all()).toEqual([]);
            expect(rolledBack.prepare("SELECT status FROM sap_jobradar_Notifications WHERE ID = 'pending-copy'").get()?.status).toBe('Pending');
            expect(rolledBack.prepare('SELECT ID FROM sap_jobradar_Jobs').all()).toHaveLength(2);
        }
        finally {
            rolledBack.close();
        }
    }, 15000);
});
describe("storage", () => {
    const execute = promisify(execFile);
    const cli = path.join(PROJECT_ROOT, 'node_modules/tsx/dist/cli.mjs');
    async function demoCycle(directory: string, flags: string[]) {
        return execute(process.execPath, [cli, 'src/cli.ts', 'cycle', ...flags], {
            cwd: PROJECT_ROOT,
            env: { ...process.env, JOB_RADAR_DB_DIR: directory, OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
            timeout: 15000,
        });
    }
    afterAll(disconnectDb);
    describe('demo storage and legacy databases', () => {
        it.each([['--demo'], ['--fixture', 'fixtures/demo-jobs.jsonl']])('isolates fixtures and automatically previews notifications: %s', async (...flags) => {
            const directory = mkdtempSync(path.join(tmpdir(), 'job-radar-cli-'));
            const { stdout } = await demoCycle(directory, flags);
            expect(stdout).toContain('(dry run)');
            expect(existsSync(path.join(directory, 'job-radar.sqlite'))).toBe(false);
            expect(existsSync(path.join(directory, 'demo', 'job-radar.sqlite'))).toBe(true);
        });
        it('migrates legacy demo records and holds their pending notifications without losing jobs', async () => {
            const directory = mkdtempSync(path.join(tmpdir(), 'job-radar-legacy-'));
            await demoCycle(directory, ['--demo']);
            const legacyPath = path.join(directory, 'job-radar.sqlite');
            copyFileSync(path.join(directory, 'demo', 'job-radar.sqlite'), legacyPath);
            const legacy = new DatabaseSync(legacyPath);
            legacy.exec('ALTER TABLE sap_jobradar_Jobs DROP COLUMN isDemo');
            legacy.close();
            await connectDb(legacyPath);
            const jobs = await query<any>(SELECT.from(db().Jobs));
            expect(jobs).toHaveLength(6);
            expect(jobs.every((job) => job.isDemo)).toBe(true);
            const previews = await query<any>(SELECT.from(db().Notifications));
            expect(previews).toHaveLength(2);
            const client = { send: vi.fn(async () => ({ ok: true, messageId: 1, retryable: false })) };
            const summary = await notify({ client });
            expect(summary.sent).toBe(0);
            expect(summary.skipped).toBe(2);
            expect(client.send).not.toHaveBeenCalled();
            expect(await query(SELECT.from(db().Jobs))).toHaveLength(6);
        });
    });
});
