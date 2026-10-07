import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../src/config/index.js';
import { cds, db, DELETE, INSERT, SELECT, query, queryOne } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { notify, type NotifySummary } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, useTempDb } from './helpers/db.js';

interface Event { type: string; message?: string; summary?: NotifySummary }
interface Worker { child: ChildProcess; events: Event[]; wait(type: string): Promise<Event> }
const workers: Worker[] = [];
let dbPath: string;

function startWorker(): Worker {
  const child = fork(path.join(PROJECT_ROOT, 'test/helpers/notification-worker.ts'), [], {
    cwd: PROJECT_ROOT, execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, JOB_RADAR_TEST_DB_PATH: dbPath, OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
  });
  const events: Event[] = [];
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout?.resume();
  child.on('message', (event: Event) => { events.push(event); });
  const worker: Worker = {
    child, events,
    wait(type) {
      return new Promise<Event>((resolve, reject) => {
        const existing = events.find((event) => event.type === type || event.type === 'error');
        if (existing) {
          if (existing.type === 'error') reject(new Error(existing.message));
          else resolve(existing);
          return;
        }
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker did not emit ${type}: ${stderr}`)); }, 6000);
        const onMessage = (event: Event) => {
          if (event.type !== type && event.type !== 'error') return;
          cleanup();
          if (event.type === 'error') reject(new Error(event.message));
          else resolve(event);
        };
        const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); };
        child.on('message', onMessage);
      });
    },
  };
  workers.push(worker);
  return worker;
}

beforeAll(async () => { dbPath = await useTempDb(); });
afterAll(closeTempDb);
beforeEach(async () => {
  for (const entity of [db().Notifications, db().Assessments, db().SourceListings, db().Jobs]) await cds.run(DELETE.from(entity));
  await ingestJobs([normalizeJob({
    id: 'concurrent', title: 'Senior SAP BTP Developer (CAP / Node.js)',
    company: 'Concurrent Test', location: 'Berlin, Germany', job_url: 'https://example.com/concurrent',
    job_type: 'contract', is_remote: true, min_amount: 60, max_amount: 75, interval: 'hourly', currency: 'EUR',
    description: 'Freelance, fully remote within the EU. Build CAP services with Node.js, TypeScript, CDS, OData V4, SAP HANA Cloud, Cloud Foundry and XSUAA. Nice to have: SAPUI5 and Integration Suite.',
  }, 'linkedin')!], { runId: null });
  await rank({ rulesOnly: true });
});
afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.child.exitCode === null) worker.child.kill();
  }
});

describe('notifications from independent processes', () => {
  it.each([false, true])('sends once when two processes overlap, existing queue: %s', async (alreadyQueued) => {
    if (alreadyQueued) await notify({ dryRun: true, client: { async send() { return { ok: true, retryable: false }; } } });
    const first = startWorker();
    const second = startWorker();
    await Promise.all([first.wait('ready'), second.wait('ready')]);
    let deliveryTimer: ReturnType<typeof setTimeout>;
    const delivered = new Promise<Worker>((resolve, reject) => {
      deliveryTimer = setTimeout(() => reject(new Error('Neither process claimed delivery')), 6000);
      for (const worker of [first, second]) worker.child.on('message', (event: Event) => {
        if (event.type === 'delivery') { clearTimeout(deliveryTimer); resolve(worker); }
        if (event.type === 'error') { clearTimeout(deliveryTimer); reject(new Error(event.message)); }
      });
    });
    first.child.send({ type: 'start' });
    second.child.send({ type: 'start' });
    const winner = await delivered;
    const other = winner === first ? second : first;
    // Keep the winning sender blocked until the other process has completed.
    // A second send would hang that process and fail this assertion.
    expect((await other.wait('done')).summary!.sent).toBe(0);
    winner.child.send({ type: 'release' });
    expect((await winner.wait('done')).summary!.sent).toBe(1);
    expect([...first.events, ...second.events].filter((event) => event.type === 'delivery')).toHaveLength(1);
    expect(await query(SELECT.from(db().Notifications))).toHaveLength(1);
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Sent', attempts: 1, claimToken: null });
  }, 15000);

  it('keeps legacy duplicate history while preventing delivery when one copy was already sent', async () => {
    await notify({ dryRun: true, client: { async send() { return { ok: true, retryable: false }; } } });
    const original = await queryOne<any>(SELECT.from(db().Notifications));
    await cds.run('DROP INDEX idx_notification_job_channel');
    await cds.run(INSERT.into(db().Notifications).entries({ ...original, ID: randomUUID(), status: 'Sent', telegramMessageId: 42 }));
    const worker = startWorker();
    await worker.wait('ready');
    worker.child.send({ type: 'start' });
    expect((await worker.wait('done')).summary!.sent).toBe(0);
    const rows = await query<any>(SELECT.from(db().Notifications));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'Sent')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'Superseded')).toHaveLength(1);
    expect(worker.events.filter((event) => event.type === 'delivery')).toHaveLength(0);
  }, 15000);
});
