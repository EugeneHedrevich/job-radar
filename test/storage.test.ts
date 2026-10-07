import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PROJECT_ROOT } from '../src/config/index.js';
import { connectDb, db, disconnectDb, SELECT, query } from '../src/db/index.js';
import { notify } from '../src/pipeline/notify.js';

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
