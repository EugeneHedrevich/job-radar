import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, PROJECT_ROOT, resetConfigCache } from '../src/config/index.js';
import { db, SELECT, query } from '../src/db/index.js';
import { loadFixture } from '../src/fixtures/load.js';
import { collect } from '../src/pipeline/collect.js';
import { notify } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, useTempDb } from './helpers/db.js';
import type { TelegramClient } from '../src/notify/telegram.js';

const FIXTURE = path.join(PROJECT_ROOT, 'fixtures', 'demo-jobs.jsonl');

function countingClient(): TelegramClient & { calls: number } {
  const client = {
    calls: 0,
    async send() {
      client.calls += 1;
      return { ok: true, messageId: client.calls, retryable: false };
    },
  };
  return client;
}

describe('full cycle on offline fixtures', () => {
  beforeAll(async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    resetConfigCache();
    await useTempDb();
  });
  afterAll(async () => {
    await closeTempDb();
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  it('works without an OPENAI_API_KEY using deterministic matching only', () => {
    const config = loadConfig();
    // The suite runs without secrets; this guards the "no LLM key" contract.
    expect(config.secrets.openaiApiKey).toBeUndefined();
    expect(config.llmAvailable).toBe(false);
  });

  it('collects, deduplicates across sources and ranks', async () => {
    const fixture = loadFixture(FIXTURE);
    expect(fixture.length).toBe(7);

    const first = await collect({ fixture });
    expect(first.jobsFound).toBe(7);
    // The same vacancy appears on LinkedIn and Indeed and must become one job.
    expect(first.ingest.mergedAcrossSources).toBe(1);
    expect(first.ingest.created).toBe(6);

    const ranked = await rank({ rulesOnly: true });
    expect(ranked.every((entry) => entry.assessment.engine === 'rules')).toBe(true);
    expect(ranked[0]!.assessment.fitScore).toBeGreaterThan(ranked.at(-1)!.assessment.fitScore);
    expect(ranked.every((entry) => entry.assessment.fitScore >= 0 && entry.assessment.fitScore <= 100)).toBe(true);
  });

  it('previews demo notifications without delivering them live or duplicating jobs', async () => {
    const client = countingClient();
    const before = await notify({ client, dryRun: true });
    expect(before.sent).toBeGreaterThan(0);

    const jobsBefore = (await query(SELECT.from(db().Jobs))).length;
    const listingsBefore = (await query(SELECT.from(db().SourceListings))).length;
    const callsAfterFirstNotify = client.calls;

    const second = await collect({ fixture: loadFixture(FIXTURE) });
    expect(second.ingest.created).toBe(0);
    expect(second.ingest.mergedAcrossSources).toBe(0);

    await rank({ rulesOnly: true });
    const again = await notify({ client });

    expect((await query(SELECT.from(db().Jobs))).length).toBe(jobsBefore);
    expect((await query(SELECT.from(db().SourceListings))).length).toBe(listingsBefore);
    expect(again.queued).toBe(0);
    expect(again.sent).toBe(0);
    expect(client.calls).toBe(callsAfterFirstNotify);
  });

  it('reuses cached assessments instead of re-evaluating unchanged jobs', async () => {
    const ranked = await rank({ rulesOnly: true });
    expect(ranked.every((entry) => entry.cached)).toBe(true);
  });

  it('never notifies a hard-rejected job', async () => {
    const notifications = await query<any>(SELECT.from(db().Notifications));
    const jobIds = notifications.map((row) => row.job_ID);
    const rejected = await query<any>(SELECT.from(db().Assessments).where({ hardReject: true }));
    for (const assessment of rejected) expect(jobIds).not.toContain(assessment.job_ID);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it('records the collection run, its tasks and its errors', async () => {
    const runs = await query<any>(SELECT.from(db().CollectionRuns));
    expect(runs.length).toBe(2);
    expect(runs.every((run: any) => run.status === 'Completed' && run.finishedAt)).toBe(true);
  });
});
