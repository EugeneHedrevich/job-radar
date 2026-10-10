import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { cds, db, DELETE, SELECT, UPDATE, query, queryOne } from '../src/db/index.js';
import { normalizeJob } from '../src/normalize/index.js';
import type { CollectorJob } from '../src/collector/types.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { notify } from '../src/pipeline/notify.js';
import { rank, readTop } from '../src/pipeline/rank.js';
import { directionCounters } from '../src/pipeline/coverage.js';
import { assessWithLlm } from '../src/matching/llm.js';
import type { NotificationPayload } from '../src/notify/format.js';
import { closeTempDb, useTempDb } from './helpers/db.js';

const strong: CollectorJob = {
  id: 'regression-1', title: 'Senior SAP BTP Developer (CAP / Node.js)',
  company: 'Regression Consulting', location: 'Berlin, Germany',
  job_url: 'https://www.linkedin.com/jobs/view/regression-1',
  job_type: 'contract', is_remote: true, min_amount: 60, max_amount: 75,
  interval: 'hourly', currency: 'EUR',
  description: 'Freelance, fully remote within the EU. Build CAP services with Node.js, TypeScript, CDS, OData V4, SAP HANA Cloud, Cloud Foundry and XSUAA. Nice to have: SAPUI5 and Integration Suite.',
};

async function ingest(overrides: Partial<CollectorJob> = {}, source = 'linkedin', demo = false) {
  return ingestJobs([normalizeJob({ ...strong, ...overrides }, source)!], { runId: null, demo });
}

function sender() {
  return { send: vi.fn(async (_payload: NotificationPayload) => ({ ok: true, messageId: 42, retryable: false })) };
}

function llmResponse(recommendation = 'Apply', fitScore = 95, overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    fit_score: fitScore, recommendation, technical_fit: 95, commercial_fit: 95, location_fit: 95,
    strong_matches: ['CAP'], mandatory_gaps: [], preferred_gaps: [], missing_information: [],
    explanation: 'Mock assessment', suggested_cv_variant: loadConfig().cvVariants.default,
    ...overrides,
  }) } }] }), { status: 200 });
}

function enableLlm(budget: number) {
  const config = loadConfig();
  config.llmAvailable = true;
  config.secrets.openaiApiKey = 'test-only-key';
  config.settings.llm.max_jobs_per_run = budget;
}

// These tests exercise proficiency evidence for a hypothetical candidate who
// declares basic ABAP; the real profile explicitly does not claim ABAP.
function declareBasicAbap() {
  const profile = loadConfig().profile;
  profile.skills.limited = [{ name: 'ABAP', proficiency: 'basic' }];
  profile.not_claimed = profile.not_claimed.filter((claim) => claim !== 'ABAP development');
}

beforeAll(useTempDb);
afterAll(closeTempDb);
beforeEach(async () => {
  vi.unstubAllGlobals();
  resetConfigCache();
  for (const entity of [db().Notifications, db().Assessments, db().SourceListings, db().Jobs]) {
    await cds.run(DELETE.from(entity));
  }
});
afterAll(() => { vi.unstubAllGlobals(); resetConfigCache(); });

describe('vacancy identity and refresh', () => {
  it.each([false, true])('retains same-run description and rates regardless of sparse-result order (%s)', async (reverse) => {
    const sparse = normalizeJob({ ...strong, description: null, currency: null, min_amount: null, max_amount: null }, 'linkedin')!;
    const full = normalizeJob(strong, 'linkedin')!;
    const result = await ingestJobs(reverse ? [full, sparse] : [sparse, full], { runId: null });
    expect(result.created).toBe(1);
    expect(result.jobIds).toHaveLength(1);
    const stored = await queryOne<any>(SELECT.from(db().Jobs));
    expect(stored.description).toBe(strong.description);
    expect(Number(stored.salaryMin)).toBe(60);
    await ingest({ description: null });
    const listing = await queryOne<any>(SELECT.from(db().SourceListings));
    expect(listing.hasDescription).toBeTruthy();
    expect(JSON.parse(listing.rawRecord).description).toBe(strong.description);
  });
  it.each([
    ['Berlin, Germany', 'Austin, TX, US'],
    ['Berlin, Germany', 'Munich, Germany'],
  ])('does not merge recruiter boilerplate across conflicting locations: %s / %s', async (first, second) => {
    await ingest({ location: first });
    const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', location: second }, 'indeed');
    expect(result.created).toBe(1);
    expect(result.mergedAcrossSources).toBe(0);
  });

  it.each(['Client', 'Project ID', 'Duration', 'Start date'])('does not merge different recruiter projects with conflicting %s', async (label) => {
    await ingest({ description: `${strong.description}\n${label}: European client project` });
    const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', description: `${strong.description}\n${label}: US client project` }, 'indeed');
    expect(result.created).toBe(1);
    expect(result.mergedAcrossSources).toBe(0);
  });

  it('keeps distinct same-board IDs separate, even with identical descriptions', async () => {
    await ingest();
    const result = await ingest({ id: 'regression-2', job_url: 'https://www.linkedin.com/jobs/view/regression-2' });
    expect(result.created).toBe(1);
    expect(await query(SELECT.from(db().Jobs))).toHaveLength(2);
  });

  it.each([
    ['Berlin, Germany', 'Munich, Germany'],
    [null, null],
    ['Germany', 'Germany'],
    ['Remote, Germany, DE', 'Remote, Germany, DE'],
  ])('keeps uncertain cross-board duplicates separate: %s / %s', async (first, second) => {
    await ingest({ description: null, location: first });
    const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', description: null, location: second }, 'indeed');
    expect(result.created).toBe(1);
    expect(result.mergedAcrossSources).toBe(0);
  });

  it('keeps same-board IDs with missing descriptions and different German cities separate', async () => {
    await ingest({ description: null, location: 'Berlin, Germany' });
    const result = await ingest({ id: 'regression-2', job_url: 'https://www.linkedin.com/jobs/view/regression-2', description: null, location: 'Munich, Germany' });
    expect(result.created).toBe(1);
    expect(result.mergedAcrossSources).toBe(0);
  });

  it('still merges a cross-board vacancy with the same specific city and near-identical title', async () => {
    await ingest({ description: null });
    const result = await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', description: null }, 'indeed');
    expect(result.created).toBe(0);
    expect(result.mergedAcrossSources).toBe(1);
  });

  it('refreshes known details and invalidates the assessment without changing job identity', async () => {
    const first = await ingest();
    const [original] = await rank({ rulesOnly: true });
    const before = await queryOne<any>(SELECT.from(db().Jobs));
    const updated = await ingest({
      title: 'SAP BTP Architect', description: `${strong.description} No freelancers accepted.`,
      min_amount: 30, max_amount: 40, is_remote: false, job_type: 'fulltime', location: 'Munich, Germany',
    });
    const after = await queryOne<any>(SELECT.from(db().Jobs));
    expect(updated.updated).toBe(1);
    expect(updated.jobIds).toEqual(first.jobIds);
    expect(after).toMatchObject({ title: 'SAP BTP Architect', isRemote: false, jobType: 'fulltime', location: 'Munich, Germany', firstSeenAt: before.firstSeenAt });
    expect(Number(after.salaryMin)).toBe(30);
    expect(Number(after.salaryMax)).toBe(40);
    expect(after.descriptionHash).not.toBe(before.descriptionHash);
    const [reranked] = await rank({ rulesOnly: true });
    expect(reranked!.cached).toBe(false);
    expect(reranked!.assessmentId).not.toBe(original!.assessmentId);
    expect(reranked!.assessment.recommendation).toBe('Skip');
  });

  it('preserves known details when the next observation omits them', async () => {
    await ingest();
    await ingest({ description: null, location: null, min_amount: null, max_amount: null, is_remote: null, job_type: null });
    const current = await queryOne<any>(SELECT.from(db().Jobs));
    expect(current).toMatchObject({ description: strong.description, location: strong.location, isRemote: true, jobType: 'contract' });
    expect(Number(current.salaryMax)).toBe(75);
  });

  it('uses a new cross-board listing only to fill missing information', async () => {
    await ingest();
    await ingest({ id: 'indeed-2', job_url: 'https://indeed.com/viewjob?jk=2', max_amount: 20, is_remote: false }, 'indeed');
    const current = await queryOne<any>(SELECT.from(db().Jobs));
    expect(current.isRemote).toBe(true);
    expect(Number(current.salaryMax)).toBe(75);
  });

  it('does not report an update when stored decimal values are unchanged', async () => {
    await ingest();
    expect((await ingest()).updated).toBe(0);
  });
});

describe('review regressions: read-only results, attempt cache and matching uncertainty', () => {
  it('filters UI5 titles before applying the top limit without re-scoring', async () => {
    await ingest({ description: `${strong.description} REST APIs, OAuth and Destinations.` });
    await ingest({ id: 'ui5-title', title: 'SAPUI5 Developer',
      job_url: 'https://www.linkedin.com/jobs/view/ui5-title',
      description: 'Build SAPUI5 and SAP Fiori apps with JavaScript, TypeScript and OData. Fully remote freelance contract.' });
    await rank({ rulesOnly: true });
    const before = await query(SELECT.from(db().Assessments));
    const [first] = await readTop(1);
    expect(first!.job.title).toBe(strong.title);
    const filtered = await readTop(1, 'ui5');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.job.title).toBe('SAPUI5 Developer');
    expect(await query(SELECT.from(db().Assessments))).toEqual(before);
  });

  it('top reads the current LLM assessment without writing a rules assessment', async () => {
    await ingest(); enableLlm(1);
    const request = vi.fn(async () => llmResponse()); vi.stubGlobal('fetch', request);
    const [ranked] = await rank();
    const before = await query(SELECT.from(db().Assessments));
    const [shown] = await readTop();
    expect(shown!.assessmentId).toBe(ranked!.assessmentId);
    expect(shown!.assessment.engine).toBe('llm');
    expect(await query(SELECT.from(db().Assessments))).toEqual(before);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('an explicit empty job list does not assess the whole database', async () => {
    await ingest(); enableLlm(5);
    const request = vi.fn(async () => llmResponse()); vi.stubGlobal('fetch', request);
    expect(await rank({ jobIds: [] })).toEqual([]);
    expect(await query(SELECT.from(db().Assessments))).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('caches a rejected AI response until explicit retry or changed input', async () => {
    await ingest(); enableLlm(1);
    const request = vi.fn(async () => llmResponse('Skip', 10, { mandatory_gaps: [{
      requirement: 'Rust', vacancy_quote: 'Rust is mandatory.', profile_path: 'not_claimed.0', profile_value: 'RAP ownership',
    }] }));
    vi.stubGlobal('fetch', request);
    const [first] = await rank();
    expect(first!.assessment.engine).toBe('rules');
    expect(first!.assessment.missingInformation.join(' ')).toMatch(/AI assessment uncertainty/);
    const [cached] = await rank();
    expect(cached!.cached).toBe(true);
    expect(cached!.assessmentId).toBe(first!.assessmentId);
    expect(request).toHaveBeenCalledTimes(1);
    await rank({ force: true });
    expect(request).toHaveBeenCalledTimes(2);
    await ingest({ description: `${strong.description}\nA changed project scope.` });
    await rank();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry a cached provider failure when explicitly ranking the same job again', async () => {
    const ingested = await ingest(); enableLlm(5);
    const request = vi.fn(async () => new Response('unavailable', { status: 503 })); vi.stubGlobal('fetch', request);
    await rank({ jobIds: ingested.jobIds });
    const [cached] = await rank({ jobIds: ingested.jobIds });
    expect(cached!.cached).toBe(true);
    expect(cached!.assessment.explanation).toMatch(/AI request failed/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects mandatory RAP without an AI request and matches RAP on word boundaries', async () => {
    await ingest({ description: `${strong.description}\nRAP is required.` }); enableLlm(1);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    const [result] = await rank();
    expect(result!.assessment.mandatoryGaps.join(' ')).toMatch(/RAP ownership/);
    expect(result!.assessment.recommendation).toBe('Skip');
    expect(request).not.toHaveBeenCalled();
    await ingest({ description: `${strong.description}\nMust have wrapper development.` });
    const [changed] = await rank({ rulesOnly: true });
    expect(changed!.assessment.mandatoryGaps.join(' ')).not.toMatch(/RAP ownership/);
  });

  it('does not infer EUR or a below-minimum rejection from a rate with no currency', async () => {
    await ingest({ min_amount: 20, max_amount: 30, currency: null });
    const [result] = await rank({ rulesOnly: true });
    expect(result!.assessment.hardReject).toBe(false);
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/currency not stated/);
  });

  it('does not invent connective skills under a mandatory list heading', async () => {
    await ingest({ description: `${strong.description}\nMust have:\nCAP\nwith\nand\nmit\nyou will\nSuccessFactors integration` });
    const [result] = await rank({ rulesOnly: true });
    expect(result!.assessment.missingInformation.join(' ')).not.toMatch(/required capability "(?:with|and|mit|you will)"/);
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/successfactors integration/);
  });
});

describe('current notification eligibility', () => {
  it('does not notify a weekly onsite schedule above the configured travel limit', async () => {
    await ingest({ description: `${strong.description}\nThree onsite days every week are required.` });
    const [result] = await rank({ rulesOnly: true });
    expect(result!.assessment.recommendation).toBe('Skip');
    const client = sender();
    expect((await notify({ client })).queued).toBe(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('ignores an older high score after the vacancy is reassessed as a rejection', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    await ingest({ description: `${strong.description} No freelancers accepted.` });
    await rank({ rulesOnly: true });
    expect(await query(SELECT.from(db().Assessments))).toHaveLength(2);
    const client = sender();
    const summary = await notify({ client });
    expect(summary.queued).toBe(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('holds delivery if changed job content has not been reassessed yet', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    await ingest({ max_amount: 15 });
    const client = sender();
    expect((await notify({ client })).queued).toBe(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each(['version', 'content'])('invalidates historical assessments after a scoring %s change', async (change) => {
    await ingest();
    await rank({ rulesOnly: true });
    const config = loadConfig();
    if (change === 'version') config.scoring.version = 'new-version';
    else config.scoring.hard_rejects.rules.push({ id: 'test', reason: 'New incompatibility', any: ['btp'], none: [] });
    const client = sender();
    expect((await notify({ client })).sent).toBe(0);
    await rank({ rulesOnly: true });
    const summary = await notify({ client });
    expect(summary.sent).toBe(change === 'version' ? 1 : 0);
  });

  it('cancels a queued preview when the job becomes a rejection before live delivery', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    await notify({ dryRun: true, client: sender() });
    await ingest({ description: `${strong.description} No freelancers accepted.` });
    await rank({ rulesOnly: true });
    const client = sender();
    expect((await notify({ client })).skipped).toBe(1);
    expect(client.send).not.toHaveBeenCalled();
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Skipped' });
  });

  it('rebuilds a pending payload using current details before live delivery', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    await notify({ dryRun: true, client: sender() });
    await ingest({ max_amount: 90 });
    const [current] = await rank({ rulesOnly: true });
    const client = sender();
    expect((await notify({ client })).sent).toBe(1);
    expect(client.send.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringContaining('90') });
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ assessment_ID: current!.assessmentId });
  });

  it('does not deliver fixture previews during a later live notification run', async () => {
    await ingest({}, 'linkedin', true);
    await rank({ rulesOnly: true });
    expect((await notify({ dryRun: true, client: sender() })).sent).toBe(1);
    const client = sender();
    expect((await notify({ client })).sent).toBe(0);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('can queue a previously skipped vacancy once it has a current eligible assessment again', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    await notify({ dryRun: true, client: sender() });
    await ingest({ description: `${strong.description} No freelancers accepted.` });
    await rank({ rulesOnly: true });
    await notify({ client: sender() });
    await ingest();
    await rank({ rulesOnly: true });
    expect((await notify({ client: sender() })).sent).toBe(1);
    expect(await query(SELECT.from(db().Notifications))).toHaveLength(1);
  });
});

describe('overlapping notification runs', () => {
  it.each([false, true])('claims a notification once with an existing queue of %s', async (alreadyQueued) => {
    await ingest();
    await rank({ rulesOnly: true });
    if (alreadyQueued) await notify({ dryRun: true, client: sender() });
    const client = { send: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, messageId: 42, retryable: false };
    }) };
    const results = await Promise.all([notify({ client }), notify({ client })]);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(results.reduce((count, result) => count + result.sent, 0)).toBe(1);
    expect(await query(SELECT.from(db().Notifications))).toHaveLength(1);
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Sent', attempts: 1, claimToken: null });
  });

  it('recovers an expired delivery claim and counts the recovery against the attempt limit', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    await notify({ dryRun: true, client: sender() });
    await cds.run(UPDATE(db().Notifications).set({
      status: 'Sending', attempts: 1, claimToken: 'old-claim', claimUntil: '2020-01-01T00:00:00.000Z',
    }));
    const client = sender();
    expect((await notify({ client })).sent).toBe(1);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Sent', attempts: 2, claimToken: null });
  });

  it('releases the delivery claim when the sender throws, allowing a bounded retry', async () => {
    await ingest();
    await rank({ rulesOnly: true });
    const client = { send: vi.fn(async () => { throw new Error('connection reset'); }) };
    expect((await notify({ client })).failed).toBe(1);
    expect(await queryOne(SELECT.from(db().Notifications))).toMatchObject({ status: 'Failed', attempts: 1, claimToken: null });
    expect((await notify({ client: sender() })).sent).toBe(1);
  });
});

describe('LLM request budget and refreshed evaluations', () => {
  it('counts current LLM and notification eligibility without using obsolete assessments', async () => {
    await ingest();
    enableLlm(1);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    await rank();
    expect((await directionCounters()).find((row) => row.direction === 'CAP/CAPM'))
      .toMatchObject({ collected: 1, described: 1, prescreened: 1, llm: 1, notify: 1 });
    await ingest({ description: `${strong.description}\nClient project changed.` });
    expect((await directionCounters()).find((row) => row.direction === 'CAP/CAPM'))
      .toMatchObject({ collected: 1, described: 1, prescreened: 1, llm: 0, notify: 0 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown diploma level', 'A bachelor degree is mandatory.', 'education.0.qualification', 'unknown'],
    ['unlisted skill', 'SuccessFactors integration is mandatory.', 'skills.integration.99.proficiency', 'absent'],
    ['unrelated known skill', 'SuccessFactors integration is mandatory.', 'skills.core.1.proficiency', 'expert'],
    ['experience floor', 'At least 10 years of SAP experience is required.', 'identity.years_of_sap_experience', '7'],
    ['education alternatives', 'A degree in Computer Science or a related field is mandatory.', 'education.0.field', 'Chemical Engineering'],
    ['unconfirmed additional degree', 'A degree in Computer Science is mandatory.', 'education.0.field', 'Chemical Engineering'],
  ])('uses a rules fallback with uncertainty for %s instead of accepting an unsupported AI gap', async (_case, quote, path, value) => {
    await ingest({ description: `${strong.description}\n${quote}` });
    enableLlm(1);
    const request = vi.fn(async () => llmResponse('Skip', 20, { mandatory_gaps: [{
      requirement: quote, vacancy_quote: quote, profile_path: path, profile_value: value,
    }] }));
    vi.stubGlobal('fetch', request);
    const [result] = await rank();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result!.assessment.engine).toBe('rules');
    expect(result!.assessment.hardReject).toBe(false);
    expect(result!.assessment.mandatoryGaps).toEqual([]);
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/AI assessment uncertainty/);
    expect(result!.assessment.recommendation).toBe('Review');
    expect(await queryOne(SELECT.from(db().Assessments))).toMatchObject({ engine: 'rules' });
  });

  it('retains unknown education when the model omits it and does not invent a degree gap', async () => {
    await ingest({ description: `${strong.description}\nA bachelor degree is mandatory.` });
    enableLlm(1);
    loadConfig().profile.education = [];
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse()));
    const [result] = await rank();
    expect(result!.assessment.engine).toBe('llm');
    expect(result!.assessment.mandatoryGaps).toEqual([]);
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/education is not stated/);
  });

  it('reports an unlisted mandatory skill even when the model omits uncertainty', async () => {
    await ingest({ description: `${strong.description}\nMust have CAP, SuccessFactors integration.` });
    enableLlm(1);
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse()));
    const [result] = await rank();
    expect(result!.assessment.mandatoryGaps).toEqual([]);
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/required capability "successfactors integration"/);
  });

  it('does not use a neighboring preferred proficiency as proof of a mandatory skill gap', async () => {
    declareBasicAbap();
    const quote = 'Expert SAPUI5 is preferred, basic ABAP is mandatory.';
    await ingest({ description: `${strong.description}\n${quote}` });
    enableLlm(1);
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse('Skip', 20, { mandatory_gaps: [{
      requirement: 'expert ABAP', vacancy_quote: quote, profile_path: 'skills.limited.0.proficiency', profile_value: 'basic',
    }] })));
    const [result] = await rank();
    expect(result!.assessment.engine).toBe('rules');
    expect(result!.assessment.mandatoryGaps).toEqual([]);
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/AI assessment uncertainty/);
  });

  it.each([
    ['invented quotation', 'ABAP OO development is mandatory.', 'ABAP OO development is mandatory and 20 years are required.', 'not_claimed.1', 'ABAP OO development'],
    ['preferred requirement', 'ABAP OO development is preferred.', 'ABAP OO development is preferred.', 'not_claimed.1', 'ABAP OO development'],
    ['negated requirement', 'ABAP OO development is not required.', 'ABAP OO development is not required.', 'not_claimed.1', 'ABAP OO development'],
    ['incorrect profile fact', 'ABAP OO development is mandatory.', 'ABAP OO development is mandatory.', 'not_claimed.1', 'expert ABAP'],
  ])('rejects %s and preserves deterministic constraints in the fallback', async (_case, actual, quote, path, value) => {
    await ingest({ description: `${strong.description}\n${actual}\nOnsite attendance is required, at least three days per week.` });
    enableLlm(1);
    const request = vi.fn(async () => llmResponse('Apply', 99, { mandatory_gaps: [{
      requirement: 'ABAP OO development', vacancy_quote: quote, profile_path: path, profile_value: value,
    }] }));
    vi.stubGlobal('fetch', request);
    const job = await queryOne<any>(SELECT.from(db().Jobs));
    const result = await assessWithLlm(loadConfig(), job);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.engine).toBe('rules');
    expect(result.hardReject).toBe(true);
    expect(result.recommendation).toBe('Skip');
    expect(result.hardRejectReason).toMatch(/12\.0 days\//);
    expect(result.missingInformation.join(' ')).toMatch(/AI assessment uncertainty/);
  });

  it.each(['We also use ABAP.', 'SAP MDK is mandatory.'])('keeps an unresolved skill below Apply after a model assessment: %s', async (requirement) => {
    await ingest({ title: 'SAPUI5 Developer', description: `SAPUI5, SAP Fiori, JavaScript, TypeScript and OData. Fully remote B2B contract, EUR 60 per hour. ${requirement}` });
    enableLlm(1);
    const request = vi.fn(async () => llmResponse('Apply', 99));
    vi.stubGlobal('fetch', request);
    const job = await queryOne<any>(SELECT.from(db().Jobs));
    const result = await assessWithLlm(loadConfig(), job);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.hardReject).toBe(false);
    expect(result.mandatoryGaps).toEqual([]);
    expect(result.recommendation).toBe('Review');
    expect(result.fitScore).toBe(loadConfig().scoring.thresholds.apply - 1);
    expect(result.missingInformation.join(' ')).toMatch(/required ABAP capability and level|required capability "sap mdk"/);
  });

  it('persists verified deterministic evidence for an explicitly unclaimed mandatory skill', async () => {
    const quote = 'ABAP OO development is mandatory.';
    await ingest({ description: `${strong.description}\n${quote}` });
    enableLlm(1);
    const request = vi.fn(async () => llmResponse('Apply', 95, { mandatory_gaps: [{
      requirement: 'ABAP OO development', vacancy_quote: quote, profile_path: 'not_claimed.1', profile_value: 'ABAP OO development',
    }] }));
    vi.stubGlobal('fetch', request);
    const [result] = await rank();
    expect(result!.assessment.engine).toBe('rules');
    expect(result!.assessment.recommendation).toBe('Skip');
    expect(result!.assessment.fitScore).toBe(loadConfig().scoring.hard_rejects.score_cap);
    expect(request).not.toHaveBeenCalled();
    expect(result!.assessment.mandatoryGapEvidence).toContainEqual({
      requirement: 'ABAP OO development', vacancyQuote: quote, profilePath: 'not_claimed.1', profileValue: 'ABAP OO development',
    });
    const [cached] = await rank();
    expect(cached!.cached).toBe(true);
    expect(cached!.assessment.mandatoryGapEvidence).toEqual(result!.assessment.mandatoryGapEvidence);
  });

  it('accepts a confirmed insufficient skill level without treating other unlisted skills as absent', async () => {
    declareBasicAbap();
    const quote = 'Expert ABAP knowledge is mandatory.';
    await ingest({ description: `${strong.description}\n${quote}` });
    enableLlm(1);
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse('Apply', 95, { mandatory_gaps: [{
      requirement: 'expert ABAP', vacancy_quote: quote, profile_path: 'skills.limited.0.proficiency', profile_value: 'basic',
    }] })));
    const [result] = await rank();
    expect(result!.assessment.engine).toBe('llm');
    expect(result!.assessment.mandatoryGaps).toContain('expert ABAP');
    expect(result!.assessment.recommendation).toBe('Review');
    expect(result!.assessment.fitScore).toBeLessThan(loadConfig().scoring.thresholds.apply);
  });

  it('accepts a known insufficient qualification level with verified evidence', async () => {
    const quote = "A master's degree is mandatory.";
    await ingest({ description: `${strong.description}\n${quote}` });
    enableLlm(1);
    loadConfig().profile.education = [{ field: 'Chemical Engineering', qualification: 'Bachelor' }];
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse('Apply', 95, { mandatory_gaps: [{
      requirement: 'master degree', vacancy_quote: quote, profile_path: 'education.0.qualification', profile_value: 'Bachelor',
    }] })));
    const [result] = await rank();
    expect(result!.assessment.engine).toBe('llm');
    expect(result!.assessment.mandatoryGaps).toContain('master degree');
    expect(result!.assessment.recommendation).toBe('Review');
  });

  it('falls back once for the old unstructured mandatory-gap response format', async () => {
    await ingest();
    enableLlm(1);
    const request = vi.fn(async () => llmResponse('Skip', 20, { mandatory_gaps: ['candidate lacks an unlisted degree'] }));
    vi.stubGlobal('fetch', request);
    const [result] = await rank();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result!.assessment.engine).toBe('rules');
    expect(result!.assessment.missingInformation.join(' ')).toMatch(/structured requirement evidence/);
  });

  it('includes declared education in the model input without inventing a diploma level', async () => {
    await ingest();
    enableLlm(1);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    await rank();
    const body = JSON.parse((request.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('Education: Chemical Engineering (qualification level: unknown; institution: unknown)');
    expect(body.messages[0].content).toContain('Do not infer a qualification level or institution');
  });

  it.each([
    'Mandatory requirements:\n- ABAP OO development\nPreferred skills:\n- SAPUI5',
    'Must have CAP, Node.js, ABAP OO development. Nice to have SAPUI5.',
    'SAPUI5 is preferred, ABAP OO development is mandatory.',
    '**Profil kandydata**\n* Bardzo dobra znajomość:\n  + ABAP Objects,\n**Oferujemy**\n* Praca w 100% zdalna',
  ])('preserves a deterministic mandatory skill gap when a valid model response omits it: %s', async (requirements) => {
    await ingest({ description: `${strong.description}\n${requirements}` });
    enableLlm(1);
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse()));
    const job = await queryOne<any>(SELECT.from(db().Jobs));
    const result = await assessWithLlm(loadConfig(), job);
    expect(result.engine).toBe('llm');
    expect(result.fitScore).toBe(loadConfig().scoring.hard_rejects.score_cap);
    expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP OO development/);
    expect(result.recommendation).toBe('Skip');
  });

  it.each([
    ['Optional: five onsite days per month.', false],
    ['Five onsite days per month are not required.', false],
    ['Onsite attendance is optional, at least three days per week.', false],
    ['Onsite attendance is not required, at least three days per week.', false],
    ['Five onsite days per month.', true],
    ['Fully remote. Five days per week onsite are not required.', false],
    ['Hybrid: three onsite days per week.', true],
    ['SAPUI5 is required, three onsite days per week.', true],
  ])('keeps travel obligation semantics after a mocked model assessment: %s', async (attendance, unclear) => {
    await ingest({ description: `${strong.description}\n${attendance}` });
    enableLlm(1);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    const [result] = await rank();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result!.assessment.engine).toBe('llm');
    expect(result!.assessment.hardReject).toBe(false);
    expect(result!.assessment.missingInformation.some((item) => /unclear whether onsite attendance/.test(item))).toBe(unclear);
  });

  it('preserves an unknown onsite frequency when the model omits missing information', async () => {
    await ingest({ description: `${strong.description}\nOnsite attendance is required, at least several days per week.` });
    enableLlm(1);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    const [result] = await rank();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result!.assessment.hardReject).toBe(false);
    expect(result!.assessment.missingInformation).toContain('onsite attendance frequency is not stated or unclear');
  });

  it.each([
    'Three onsite days every week are required.',
    'Onsite attendance is required, three days per week.',
    'Onsite attendance is required, at least three days per week.',
    'Three days per week onsite, required.',
    'SAPUI5 is optional, three onsite days every week are required.',
  ])('enforces travel limits even for a directly requested model assessment: %s', async (attendance) => {
    await ingest({ description: `${strong.description}\n${attendance}` });
    enableLlm(1);
    vi.stubGlobal('fetch', vi.fn(async () => llmResponse()));
    const job = await queryOne<any>(SELECT.from(db().Jobs));
    const result = await assessWithLlm(loadConfig(), job);
    expect(result.hardReject).toBe(true);
    expect(result.recommendation).toBe('Skip');
    expect(result.fitScore).toBeLessThanOrEqual(loadConfig().scoring.hard_rejects.score_cap);
    expect(result.hardRejectReason).toMatch(/Required onsite attendance \(12\.0 days\/month\)/);
    expect(result.mandatoryGaps.join(' ')).toMatch(/onsite attendance/);
  });

  it.each(['Fully onsite, SAPUI5 is optional.', 'No remote work allowed. Optional onsite visits.'])
    ('preserves a mandatory work-mode rejection after a mocked model response: %s', async (attendance) => {
      await ingest({ description: `${strong.description}\n${attendance}` });
      enableLlm(1);
      vi.stubGlobal('fetch', vi.fn(async () => llmResponse()));
      const job = await queryOne<any>(SELECT.from(db().Jobs));
      const result = await assessWithLlm(loadConfig(), job);
      expect(result.hardReject).toBe(true);
      expect(result.recommendation).toBe('Skip');
      expect(result.fitScore).toBeLessThanOrEqual(loadConfig().scoring.hard_rejects.score_cap);
      expect(result.hardRejectReason).toMatch(/Heavily onsite/);
    });

  async function seedJobs() {
    for (let index = 0; index < 3; index += 1) {
      await ingest({ id: `budget-${index}`, job_url: `https://linkedin.com/jobs/view/budget-${index}` });
    }
  }

  it.each([1, 3])('stops after the first provider failure with a request budget of %s', async (budget) => {
    await seedJobs();
    enableLlm(budget);
    const request = vi.fn(async () => new Response('provider unavailable', { status: 503 }));
    vi.stubGlobal('fetch', request);
    const results = await rank();
    expect(request).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((row) => row.assessment.engine === 'rules')).toBe(true);
  });

  it('counts successful requests against the limit', async () => {
    await seedJobs();
    enableLlm(1);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    const results = await rank();
    expect(request).toHaveBeenCalledTimes(1);
    expect(results.filter((row) => row.assessment.engine === 'llm')).toHaveLength(1);
  });

  it('reuses cached LLM results after the call budget is exhausted', async () => {
    await seedJobs();
    enableLlm(3);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    await rank();
    loadConfig().settings.llm.max_jobs_per_run = 1;
    // Budget is operational configuration, not an evaluation input.
    request.mockClear();
    const results = await rank();
    expect(request).not.toHaveBeenCalled();
    expect(results.every((row) => row.cached && row.assessment.engine === 'llm')).toBe(true);
  });

  it('persists a forced reassessment instead of returning the old cached recommendation', async () => {
    await ingest();
    enableLlm(1);
    const request = vi.fn().mockResolvedValueOnce(llmResponse()).mockResolvedValueOnce(llmResponse('Skip', 20));
    vi.stubGlobal('fetch', request);
    const [original] = await rank();
    const [updated] = await rank({ force: true });
    expect(updated!.assessmentId).toBe(original!.assessmentId);
    expect(await queryOne(SELECT.from(db().Assessments))).toMatchObject({ recommendation: 'Skip', fitScore: 20 });
    const client = sender();
    expect((await notify({ client })).sent).toBe(0);
  });

  it('never calls the provider for demo records', async () => {
    await ingest({}, 'linkedin', true);
    enableLlm(3);
    const request = vi.fn(async () => llmResponse());
    vi.stubGlobal('fetch', request);
    await rank();
    expect(request).not.toHaveBeenCalled();
  });
});
