import { fork, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/config/index.js';
import { connectDb, disconnectDb } from '../src/db/index.js';

interface WorkerEvent { type: string; message?: string }
interface Worker { child: ChildProcess; events: WorkerEvent[]; wait(type: string): Promise<WorkerEvent> }
const workers: Worker[] = [];
let legacyTemplate: string;

function startWorker(dbPath: string, holdSchema = false): Worker {
  const child = fork(path.join(PROJECT_ROOT, 'test/helpers/migration-worker.ts'), [], {
    cwd: PROJECT_ROOT, execArgv: ['--import', 'tsx'], silent: true,
    env: {
      ...process.env, JOB_RADAR_TEST_DB_PATH: dbPath, JOB_RADAR_TEST_HOLD_SCHEMA: String(holdSchema),
      OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '',
    },
  });
  const events: WorkerEvent[] = [];
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout?.resume();
  child.on('message', (event: WorkerEvent) => { events.push(event); });
  const worker: Worker = {
    child, events,
    wait(type) {
      return new Promise((resolve, reject) => {
        const existing = events.find((event) => event.type === type || event.type === 'error');
        if (existing) {
          if (existing.type === type) resolve(existing);
          else reject(new Error(existing.message));
          return;
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Migration worker did not emit ${type}: ${stderr}`)); }, 7000);
        const onMessage = (event: WorkerEvent) => {
          if (event.type !== type && event.type !== 'error') return;
          cleanup();
          if (event.type === type) resolve(event);
          else reject(new Error(event.message));
        };
        const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); };
        child.on('message', onMessage);
      });
    },
  };
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (worker.child.exitCode === null) worker.child.kill();
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
    `);
  } finally { legacy.close(); }
  return dbPath;
}

beforeAll(async () => { legacyTemplate = await createLegacyTemplate(); });

function legacyDatabase(): string {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'job-radar-migration-')), 'legacy.sqlite');
  copyFileSync(legacyTemplate, dbPath);
  return dbPath;
}

describe('serialized legacy database migrations', () => {
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
      expect(migrated.prepare('SELECT ID, title, description, primaryUrl FROM sap_jobradar_Jobs').all()).toEqual([{
        ID: 'legacy-job', title: 'Original vacancy', description: 'Original description', primaryUrl: 'https://example.com/legacy',
      }]);
      expect(migrated.prepare('SELECT ID, status, payload, telegramMessageId FROM sap_jobradar_Notifications ORDER BY ID').all()).toEqual([
        { ID: 'older-history', status: 'Superseded', payload: 'original history payload', telegramMessageId: 7 },
        { ID: 'pending-copy', status: 'Superseded', payload: 'original pending payload', telegramMessageId: null },
        { ID: 'sent-copy', status: 'Sent', payload: 'original sent payload', telegramMessageId: 42 },
      ]);
      expect(() => migrated.exec(`INSERT INTO sap_jobradar_Notifications (ID, job_ID, channel, status)
        VALUES ('extra-active', 'legacy-job', 'telegram', 'Pending')`)).toThrow(/UNIQUE/);
    } finally { migrated.close(); }
  }, 15000);

  it('propagates unrelated database errors and rolls back schema and history changes', async () => {
    const dbPath = legacyDatabase();
    const broken = new DatabaseSync(dbPath);
    try {
      broken.exec(`DROP INDEX idx_job_fingerprint;
        INSERT INTO sap_jobradar_Jobs (ID, fingerprint, title, primaryUrl, firstSeenAt, lastSeenAt)
        VALUES ('conflicting-job', 'legacy-fingerprint', 'Second vacancy', 'https://example.com/second',
          '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`);
    } finally { broken.close(); }
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
      expect(rolledBack.prepare("SELECT status FROM sap_jobradar_Notifications WHERE ID = 'pending-copy'").get()?.status).toBe('Pending');
      expect(rolledBack.prepare('SELECT ID FROM sap_jobradar_Jobs').all()).toHaveLength(2);
    } finally { rolledBack.close(); }
  }, 15000);
});
