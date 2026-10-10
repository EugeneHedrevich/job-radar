import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache, type AppConfig } from '../src/config/index.js';
import { assessWithRules } from '../src/matching/rules.js';
import { assessWithLlm } from '../src/matching/llm.js';
import { validateGapEvidence } from '../src/matching/evidence.js';
import { enableReviewAi, reviewAiResponse, reviewJob } from './helpers/review.js';

let config: AppConfig;
beforeEach(() => { resetConfigCache(); config = loadConfig(); });
afterEach(() => { vi.unstubAllGlobals(); resetConfigCache(); });

describe('language obligations use the actual profile and local context', () => {
  it.each(['Fluent German preferred.', 'German optional. English is mandatory.', 'This German client needs CAP developers.',
    'Entwickle SAP BTP Anwendungen. Wir bieten spannende Projekte.', 'Nice to have:\n- German'])('does not reject %s', (condition) => {
    expect(assessWithRules(config, reviewJob(condition)).hardReject).toBe(false);
  });
  it.each(['German is mandatory.', 'German optional. French is mandatory.',
    'German is preferred, French is required.', 'Requirements:\n- German',
    'Anforderungen:\n- Deutschkenntnisse', 'Profil kandydata:\n- język niemiecki',
    'Profil recherché:\n- allemand', 'Jouw profiel:\n- Duits'])('rejects independent unheld requirements: %s', (condition) => {
    const job = reviewJob(condition), result = assessWithRules(config, job);
    expect(result.hardReject).toBe(true);
    expect(result.mandatoryGapEvidence.length).toBeGreaterThan(0);
    for (const gap of result.mandatoryGapEvidence) expect(validateGapEvidence(config, job, gap)).toBeNull();
  });
  it('accepts a held language and does not infer a CEFR level from professional', () => {
    config.profile.languages.push({ code: 'de', proficiency: 'professional' });
    expect(assessWithRules(config, reviewJob('German is mandatory.')).hardReject).toBe(false);
    const result = assessWithRules(config, reviewJob('German C1 is mandatory.'));
    expect(result.hardReject).toBe(false);
    expect(result.recommendation).toBe('Review');
    expect(result.missingInformation.join(' ')).toMatch(/C1.*CEFR/);
  });
  it('rejects only a proven lower CEFR level', () => {
    config.profile.languages.push({ code: 'de', proficiency: 'B1' });
    const job = reviewJob('German C1 is mandatory.'), result = assessWithRules(config, job);
    expect(result.hardReject).toBe(true);
    for (const gap of result.mandatoryGapEvidence) expect(validateGapEvidence(config, job, gap)).toBeNull();
  });
});

describe('ABAP capability scope', () => {
  it.each(['Basic understanding of ABAP is mandatory.', 'Reading existing ABAP is required.',
    'Debugging ABAP is mandatory.', 'Requirements:\n- Basic ABAP understanding',
    'Requirements:\n- Reading ABAP OO code', 'Must develop CAP applications and have basic understanding of ABAP.',
    'ABAP debugging is required for developing CAP integrations.'])('reports unconfirmed basic capability without a development rejection: %s', (condition) => {
    const job = reviewJob(condition), result = assessWithRules(config, job);
    expect(result.hardReject).toBe(false); expect(result.mandatoryGaps).toEqual([]);
    expect(result.recommendation).toBe('Review');
    expect(result.missingInformation.join(' ')).toMatch(/basic ABAP/);
    const index = config.profile.not_claimed.indexOf('ABAP development');
    expect(validateGapEvidence(config, job, { requirement: 'ABAP development', vacancyQuote: condition,
      profilePath: `not_claimed.${index}`, profileValue: 'ABAP development' })).not.toBeNull();
  });
  it.each(['ABAP development is mandatory.', 'Must develop ABAP independently.', 'Requirements:\n- ABAP Objects',
    'RAP ownership is required.', 'Requirements:\n- RAP'])('preserves the development / RAP rejection: %s', (condition) => {
    expect(assessWithRules(config, reviewJob(condition)).hardReject).toBe(true);
  });
  it('keeps development preferred while basic understanding is mandatory', () => {
    const result = assessWithRules(config, reviewJob('Basic ABAP understanding is mandatory. ABAP development is preferred. RAP is optional.'));
    expect(result.hardReject).toBe(false);
    expect(result.mandatoryGaps).toEqual([]); expect(result.preferredGaps.join(' ')).toMatch(/ABAP development/);
  });
  it('uses a basic capability only when a hypothetical profile explicitly declares it', () => {
    config.profile.skills.limited = [{ name: 'ABAP', proficiency: 'basic' }];
    const result = assessWithRules(config, reviewJob('Basic understanding of ABAP is mandatory.'));
    expect(result.hardReject).toBe(false);
    expect(result.missingInformation.join(' ')).not.toMatch(/basic ABAP/);
  });
});

describe('availability and remote eligibility', () => {
  it.each(['Workload: 50 hours per week is mandatory.', 'Must start within 7 days.', 'Start: immediately.'])('keeps proven availability contradictions: %s', (condition) => {
    const job = reviewJob(condition), result = assessWithRules(config, job);
    expect(result.hardReject).toBe(true);
    for (const gap of result.mandatoryGapEvidence) expect(validateGapEvidence(config, job, gap)).toBeNull();
  });
  it('matches known capacity and notice without inventing an earliest date', () => {
    const result = assessWithRules(config, reviewJob('Required workload: 40 hours per week. Must start within 30 days.'));
    expect(result.hardReject).toBe(false);
    expect(result.missingInformation.join(' ')).toMatch(/earliest start date is unknown/);
  });
  it('leaves unknown capacity and notice pending confirmation', () => {
    config.profile.availability = { status: 'unknown', weekly_capacity_hours: 'unknown', notice_period_days: 'unknown' };
    const result = assessWithRules(config, reviewJob('Required workload: 50 hours per week. Must start within 7 days.'));
    expect(result.hardReject).toBe(false);
    expect(result.recommendation).toBe('Review');
    expect(result.missingInformation.join(' ')).toMatch(/weekly capacity is unknown/);
    expect(result.missingInformation.join(' ')).toMatch(/notice period is unknown/);
  });
  it('compares an explicit earliest date with the required start and respects preferred dates', () => {
    config.profile.availability = { earliest_start: '2026-12-15' };
    expect(assessWithRules(config, reviewJob('Must start on 2026-12-01.')).hardReject).toBe(true);
    expect(assessWithRules(config, reviewJob('Start on 2026-12-01 preferred.')).hardReject).toBe(false);
  });
  it.each(['Remote, UK residents only.', 'Remote within the EU, UK residents only.', 'Candidate required location: United Kingdom only.',
    'Candidates must be based in Germany.'])('compares candidate residence separately from job location: %s', (condition) => {
    const job = reviewJob(condition), result = assessWithRules(config, job);
    expect(result.hardReject).toBe(true);
    for (const gap of result.mandatoryGapEvidence) expect(validateGapEvidence(config, job, gap)).toBeNull();
  });
  it('does not infer residence restrictions or local employment rights from a German office location', () => {
    const result = assessWithRules(config, reviewJob('', { jobType: 'fulltime', description: 'SAP CAP, Node.js, fully remote position. Office location: Germany.' }));
    expect(result.hardReject).toBe(false);
    expect(result.missingInformation.join(' ')).toMatch(/from Bulgaria/);
    expect(result.missingInformation.join(' ')).toMatch(/local employment work authorization/);
  });
  it('preserves unknown authorization and schedule compatibility without treating them as absence', () => {
    const result = assessWithRules(config, reviewJob('UK right to work is mandatory. Required working hours: 14:00-22:00 EST.'));
    expect(result.hardReject).toBe(false);
    expect(result.missingInformation.join(' ')).toMatch(/work authorization.*not established/);
    expect(result.missingInformation.join(' ')).toMatch(/timezone compatibility/);
  });
  it('keeps EU remote contractor permission separate from local employment permission', () => {
    const result = assessWithRules(config, reviewJob('EU right to work is mandatory for local employment.'));
    expect(result.hardReject).toBe(false);
    expect(result.missingInformation.join(' ')).toMatch(/work authorization.*not established/);
  });
  it('validates structured evidence for explicitly missing authorization and excluded sponsorship', () => {
    config.profile.work_authorization = { uk: 'not_authorized', requires_sponsorship: true };
    for (const condition of ['UK right to work is mandatory.', 'No visa sponsorship.']) {
      const job = reviewJob(condition), result = assessWithRules(config, job);
      expect(result.hardReject).toBe(true);
      for (const evidence of result.mandatoryGapEvidence) expect(validateGapEvidence(config, job, evidence)).toBeNull();
    }
  });
});

describe('deterministic constraints survive a positive AI answer', () => {
  it.each(['German optional. French is mandatory.', 'Basic ABAP reading is mandatory.', 'English C1 is required.',
    'Workload: 50 hours per week is mandatory.', 'Remote, UK residents only.', 'UK right to work is mandatory.'])('preserves %s', async (condition) => {
    enableReviewAi(config); vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse()));
    const job = reviewJob(condition), rules = assessWithRules(config, job), ai = await assessWithLlm(config, job);
    expect(ai.hardReject).toBe(rules.hardReject);
    for (const missing of rules.missingInformation) expect(ai.missingInformation).toContain(missing);
    if (rules.hardReject) { expect(ai.recommendation).toBe('Skip'); expect(ai.fitScore).toBeLessThanOrEqual(30); }
    else { expect(ai.recommendation).toBe('Review'); expect(ai.fitScore).toBeLessThan(75); }
    const request = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(request?.[1]?.body)).messages[1].content).toContain('Availability:');
  });
});
