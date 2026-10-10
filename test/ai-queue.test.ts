import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, connectDb, db, DELETE, disconnectDb, SELECT, UPDATE, query } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { rank } from '../src/pipeline/rank.js';
import { useTempDb, closeTempDb } from './helpers/db.js';
import { enableReviewAi, reviewAiResponse, reviewRecord } from './helpers/review.js';

let file: string;
beforeAll(async () => { file = await useTempDb(); });
beforeEach(async () => {
  resetConfigCache(); vi.unstubAllGlobals();
  for (const entity of [db().AiAssessmentQueue, db().Assessments, db().SourceListings, db().Jobs]) await cds.run(DELETE.from(entity));
});
afterAll(async () => { vi.unstubAllGlobals(); resetConfigCache(); await closeTempDb(); });

async function seed(key: string, description = reviewRecord.description!) {
  return ingestJobs([normalizeJob({ ...reviewRecord, id: key, title: `${reviewRecord.title} ${key}`,
    job_url: `https://www.linkedin.com/jobs/view/${key}`, description }, 'linkedin')!], { runId: null });
}

describe('durable AI work across collection cycles', () => {
  it('shares five requests between new jobs and backlog, including an empty collection after restart', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(...(await seed(`original-${i}`)).jobIds);
    enableReviewAi();
    const request = vi.fn(async () => reviewAiResponse()); vi.stubGlobal('fetch', request);
    const first = await rank({ jobIds: ids, includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(5);
    expect(first.filter((row) => row.assessment.engine === 'llm')).toHaveLength(5);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(7);
    await disconnectDb(); resetConfigCache(); await connectDb(file); enableReviewAi();
    const added = [...(await seed('new-1')).jobIds, ...(await seed('new-2')).jobIds];
    await rank({ jobIds: added, includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(10);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(4);
    await rank({ jobIds: [], includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(14);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(0);
    await rank({ jobIds: [], includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(14);
  });

  it('ages a lower rules score ahead of newly arrived stronger candidates with stable ties', async () => {
    const old = await seed('old', 'SAP BTP CAP Node.js. Fully remote B2B within the EU.');
    await rank({ jobIds: old.jobIds, rulesOnly: true });
    await cds.run(UPDATE(db().AiAssessmentQueue).set({ queuedAt: '2020-01-01T00:00:00.000Z' }));
    const fresh = await seed('fresh');
    enableReviewAi(loadConfig(), 1);
    const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body)).messages;
      expect(messages.at(-1).content).toContain('Senior SAP BTP Developer old');
      return reviewAiResponse();
    }); vi.stubGlobal('fetch', request);
    await rank({ jobIds: fresh.jobIds, includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(1);
  });

  it.each(['provider error', 'invalid answer'])('finishes and caches a %s until inputs change or an explicit retry', async (failure) => {
    const seeded = await seed('fallback'); enableReviewAi();
    const request = vi.fn(async () => failure === 'provider error'
      ? new Response('Unavailable', { status: 503 }) : new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    vi.stubGlobal('fetch', request);
    await rank({ jobIds: seeded.jobIds, includePendingAi: true });
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Completed' }))).toHaveLength(1);
    await disconnectDb(); resetConfigCache(); await connectDb(file); enableReviewAi();
    await rank({ jobIds: [], includePendingAi: true }); expect(request).toHaveBeenCalledTimes(1);
    await cds.run(UPDATE(db().Jobs).set({ description: `${reviewRecord.description}\nUpdated scope.` }).where({ ID: seeded.jobIds[0] }));
    await rank({ jobIds: [], includePendingAi: true }); expect(request).toHaveBeenCalledTimes(2);
    await rank({ jobIds: seeded.jobIds, force: true }); expect(request).toHaveBeenCalledTimes(3);
  });

  it('enforces the five-call ceiling even if the configured budget is larger', async () => {
    for (let i = 0; i < 8; i++) await seed(`ceiling-${i}`);
    enableReviewAi(loadConfig(), 8);
    const request = vi.fn(async () => reviewAiResponse()); vi.stubGlobal('fetch', request);
    await rank({ includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(5);
    expect(await query(SELECT.from(db().AiAssessmentQueue).where({ status: 'Pending' }))).toHaveLength(3);
  });

  it('uses a stable job-ID tie break for a same-score arrival batch rather than SELECT iteration order', async () => {
    for (const key of ['tie-c', 'tie-a', 'tie-b']) await seed(key);
    await rank({ rulesOnly: true });
    const waiting = await query<any>(SELECT.from(db().AiAssessmentQueue));
    expect(new Set(waiting.map((row) => row.queuedAt)).size).toBe(1);
    const [expected] = await query<any>(SELECT.from(db().Jobs).orderBy('ID asc'));
    enableReviewAi(loadConfig(), 1);
    const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).messages.at(-1).content).toContain(`title: ${expected.title}`);
      return reviewAiResponse();
    }); vi.stubGlobal('fetch', request);
    await rank({ jobIds: [], includePendingAi: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
