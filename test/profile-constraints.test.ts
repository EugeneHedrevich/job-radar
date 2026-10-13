import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache, type AppConfig } from '../src/config/index.js';
import { validateGapEvidence } from '../src/matching/evidence.js';
import { assessWithLlm } from '../src/matching/llm.js';
import { assessWithRules } from '../src/matching/rules.js';
import { detectEngagement, detectWorkMode, jobText } from '../src/matching/signals.js';
import { enableReviewAi, reviewAiResponse, reviewJob } from './helpers/review.js';
let config: AppConfig;
beforeEach(() => { resetConfigCache(); config = loadConfig(); });
afterEach(() => { vi.unstubAllGlobals(); resetConfigCache(); });
describe('language obligations use the actual profile and local context', () => {
    it.each([
        ['Professional English required.', false], ['Business English required.', false],
        ['Fluent English required.', true], ['Native English required.', true], ['English C1 required.', true],
    ])('keeps declared professional proficiency distinct from stronger requirements: %s', (condition, review) => {
        const result = assessWithRules(config, reviewJob(condition));
        expect(result.hardReject).toBe(false);
        expect(result.recommendation).toBe(review ? 'Review' : 'Apply');
        expect(result.fitScore >= 75).toBe(!review);
    });
    it.each(['Fluent German preferred.', 'German optional. English is mandatory.', 'This German client needs CAP developers.',
        'Entwickle SAP BTP Anwendungen. Wir bieten spannende Projekte.', 'Nice to have:\n- German'])('does not reject %s', (condition) => {
        expect(assessWithRules(config, reviewJob(condition)).hardReject).toBe(false);
    });
    it.each(['German is mandatory.', 'German optional. French is mandatory.',
        'German is preferred, French is required.', 'Requirements:\n- German',
        'Das bringst du mit:\nGute Deutsch- und Englischkenntnisse.', 'Profil kandydata:\n- język niemiecki',
        'Profil recherché:\n- allemand', 'Jouw profiel:\n- Duits'])('rejects independent unheld requirements: %s', (condition) => {
        const job = reviewJob(condition), result = assessWithRules(config, job);
        expect(result.hardReject).toBe(true);
        expect(result.mandatoryGapEvidence.length).toBeGreaterThan(0);
        for (const gap of result.mandatoryGapEvidence)
            expect(validateGapEvidence(config, job, gap)).toBeNull();
    });
    it('accepts a held language and does not infer a CEFR level from professional', () => {
        config.profile.languages.push({ code: 'de', proficiency: 'professional' });
        expect(assessWithRules(config, reviewJob('German is mandatory.')).hardReject).toBe(false);
        expect(assessWithRules(config, reviewJob('Das bringst du mit:\nGute Deutsch- und Englischkenntnisse.')).recommendation).toBe('Apply');
        const result = assessWithRules(config, reviewJob('German C1 is mandatory.'));
        expect(result.hardReject).toBe(false);
        expect(result.recommendation).toBe('Review');
        expect(result.missingInformation.join(' ')).toMatch(/C1.*CEFR/);
    });
    it('rejects only a proven lower CEFR level', () => {
        config.profile.languages.push({ code: 'de', proficiency: 'B1' });
        const job = reviewJob('German C1 is mandatory.'), result = assessWithRules(config, job);
        expect(result.hardReject).toBe(true);
        for (const gap of result.mandatoryGapEvidence)
            expect(validateGapEvidence(config, job, gap)).toBeNull();
    });
});
describe('employment and limited remote work use description evidence', () => {
    it.each(['B2B integrations and EDI experience.', 'A2A/B2B/B2G integration experience.',
        'Customer/supplier B2B integration experience.'])('does not interpret technical terms as an employment offer: %s', (technical) => {
        const job = reviewJob('', { jobType: null, description: `SAP BTP and SAP Integration Suite. ${technical}` });
        expect(detectEngagement(config, job, jobText(job))).toBe('unknown');
        expect(detectWorkMode(config, job, jobText(job))).toBe('unknown'); // Coarse source remote=true is insufficient.
        const permanent = { ...job, description: `${job.description}\nUnbefristete Anstellung.` };
        expect(assessWithRules(config, permanent)).toMatchObject({ hardReject: true, recommendation: 'Skip' });
    });
    it('retains real contract/permanent alternatives for review and still recognises employment B2B', () => {
        const contract = reviewJob('B2B contract engagement.');
        expect(detectEngagement(config, contract, jobText(contract))).toBe('contract');
        const alternatives = { ...contract, description: 'SAP BTP, CAP, Node.js and TypeScript. Fully remote. Permanent role or freelance contract.' };
        expect(assessWithRules(config, alternatives)).toMatchObject({ hardReject: false, recommendation: 'Review' });
    });
    it('keeps the verified Einhell blockers when AI evidence is invalid, without inventing experience gaps', async () => {
        const job = reviewJob('', { title: 'SAP Integration Expert (m/w/d)', company: 'Einhell Germany AG',
            jobType: 'fulltime', isRemote: true, description: [
                '**Das bringst du mit:**',
                'Fundierte, mehrjährige Erfahrung mit der SAP Integration Suite, insbesondere Cloud Integration, API Management und Event Mesh.',
                'Sehr gute Erfahrung in der Integration von SAP-Cloud-Lösungen, insbesondere SAP Commerce Cloud, sowie von Non-SAP-Systemen wie Salesforce.',
                'Erfahrung mit B2B-Integrationen und EDI-Anbindungen an Kunden und Lieferanten.',
                'Gute Deutsch- und Englischkenntnisse in Wort und Schrift;',
                '**Was dich erwartet:**',
                'Flexible Arbeitszeiten ohne Kernzeiten, die Möglichkeit zum mobilen Arbeiten (max. 2 Tage pro Woche).',
                'Attraktive Vergütung – selbstverständlich in unbefristeter Anstellung.',
            ].join('\n') });
        const rules = assessWithRules(config, job);
        expect(detectEngagement(config, job, jobText(job))).toBe('permanent');
        expect(detectWorkMode(config, job, jobText(job))).toBe('hybrid');
        expect(rules).toMatchObject({ recommendation: 'Skip', hardReject: true, fitScore: config.scoring.hard_rejects.score_cap });
        expect(rules.hardRejectReason).toMatch(/Permanent/);
        expect(rules.hardRejectReason).toMatch(/German/);
        expect(rules.hardRejectReason).toMatch(/12\.0 days\/month/);
        for (const skill of ['Commerce Cloud', 'Salesforce', 'EDI']) {
            expect(rules.missingInformation.join(' ')).toContain(`required capability "${skill}"`);
            expect(rules.mandatoryGaps.join(' ')).not.toContain(skill);
        }
        for (const evidence of rules.mandatoryGapEvidence) expect(validateGapEvidence(config, job, evidence)).toBeNull();
        enableReviewAi(config);
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse('Apply', 99, { mandatory_gaps: [{
            requirement: 'Invented skill', vacancy_quote: 'Not in this vacancy', profile_path: 'skills.core.0.proficiency', profile_value: 'expert',
        }] })));
        const fallback = await assessWithLlm(config, job);
        expect(fallback).toMatchObject({ engine: 'rules', recommendation: 'Skip', hardReject: true, mandatoryGaps: rules.mandatoryGaps });
    });
    it('treats a capped Homeoffice schedule as attendance evidence despite a fully-remote source flag', () => {
        const job = reviewJob('Homeoffice (max. 2 Tage pro Woche).');
        expect(assessWithRules(config, job)).toMatchObject({ recommendation: 'Skip', hardReject: true });
        expect(detectWorkMode(config, job, jobText(job))).toBe('hybrid');
    });
    it('evaluates each named experience requirement and keeps preferred uncertainty separate', () => {
        const job = reviewJob('Requirements:\nSAP CPI and Commerce Cloud experience.\nSalesforce and EDI are preferred.');
        const result = assessWithRules(config, job);
        expect(result).toMatchObject({ hardReject: false, mandatoryGaps: [], recommendation: 'Review' });
        expect(result.fitScore).toBeLessThan(config.scoring.thresholds.apply);
        expect(result.missingInformation).toContain('profile evidence for required capability "Commerce Cloud" is not stated');
        for (const name of ['Salesforce', 'EDI']) expect(result.missingInformation).toContain(`profile evidence for preferred capability "${name}" is not stated`);
    });
    it('keeps technical overlap below Apply when mandatory employment/work conditions are unresolved', () => {
        const result = assessWithRules(config, reviewJob('', { jobType: null, isRemote: true,
            description: 'SAP BTP, CAP, Node.js, TypeScript, CDS, SAP HANA Cloud, OData, REST, Cloud Foundry, SAPUI5, SAP Fiori and SAP Integration Suite.' }));
        expect(result).toMatchObject({ hardReject: false, mandatoryGaps: [], recommendation: 'Review' });
        expect(result.fitScore).toBeLessThan(config.scoring.thresholds.apply);
        expect(result.missingInformation.join(' ')).toMatch(/Employment format/);
        expect(result.missingInformation.join(' ')).toMatch(/Work mode and attendance/);
    });
});
describe('ABAP capability scope', () => {
    it.each(['Basic understanding of ABAP is mandatory.', 'Reading existing ABAP is required.',
        'Debugging ABAP is mandatory.', 'Requirements:\n- Basic ABAP understanding',
        'Requirements:\n- Reading ABAP OO code', 'Must develop CAP applications and have basic understanding of ABAP.',
        'ABAP debugging is required for developing CAP integrations.'])('reports unconfirmed basic capability without a development rejection: %s', (condition) => {
        const job = reviewJob(condition), result = assessWithRules(config, job);
        expect(result.hardReject).toBe(false);
        expect(result.mandatoryGaps).toEqual([]);
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
        expect(result.mandatoryGaps).toEqual([]);
        expect(result.preferredGaps.join(' ')).toMatch(/ABAP development/);
    });
    it('uses a basic capability only when a hypothetical profile explicitly declares it', () => {
        config.profile.skills.limited = [{ name: 'ABAP', proficiency: 'basic' }];
        const result = assessWithRules(config, reviewJob('Basic understanding of ABAP is mandatory.'));
        expect(result.hardReject).toBe(false);
        expect(result.missingInformation.join(' ')).not.toMatch(/basic ABAP/);
    });
});
describe('availability and remote eligibility', () => {
    it.each([
        ['Candidates must work from home and collaborate with us.', false],
        ['Candidates must work from home and collaborate with US.', false],
        ['Candidates must reside in the US.', true], ['US residents only.', true],
        ['Candidates must reside within the EU, excluding Bulgaria.', true],
        ['Candidates must reside in Europe except Bulgaria.', true],
        ['Remote worldwide, but not Bulgaria.', true],
        ['Candidates must reside within the EU, excluding Germany.', false],
    ])('uses country abbreviations and exclusions in geographic context: %s', (condition, rejected) => {
        const job = reviewJob(condition), result = assessWithRules(config, job);
        expect(result.hardReject).toBe(rejected);
        if (rejected) {
            expect(result.mandatoryGapEvidence).toContainEqual(expect.objectContaining({ profilePath: 'identity.base_location', vacancyQuote: condition }));
            for (const gap of result.mandatoryGapEvidence)
                expect(validateGapEvidence(config, job, gap)).toBeNull();
        }
        else
            expect(result.fitScore).toBeGreaterThanOrEqual(75);
    });
    it.each(['Workload: 50 hours per week is mandatory.', 'Must start within 7 days.', 'Start: immediately.'])('keeps proven availability contradictions: %s', (condition) => {
        const job = reviewJob(condition), result = assessWithRules(config, job);
        expect(result.hardReject).toBe(true);
        for (const gap of result.mandatoryGapEvidence)
            expect(validateGapEvidence(config, job, gap)).toBeNull();
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
        for (const gap of result.mandatoryGapEvidence)
            expect(validateGapEvidence(config, job, gap)).toBeNull();
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
            for (const evidence of result.mandatoryGapEvidence)
                expect(validateGapEvidence(config, job, evidence)).toBeNull();
        }
    });
});
describe('deterministic constraints survive a positive AI answer', () => {
    it.each(['German optional. French is mandatory.', 'Basic ABAP reading is mandatory.', 'English C1 is required.',
        'Workload: 50 hours per week is mandatory.', 'Remote, UK residents only.',
        'Candidates must reside within the EU, excluding Bulgaria.', 'UK right to work is mandatory.'])('preserves %s', async (condition) => {
        enableReviewAi(config);
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse()));
        const job = reviewJob(condition), rules = assessWithRules(config, job), ai = await assessWithLlm(config, job);
        expect(ai.hardReject).toBe(rules.hardReject);
        for (const missing of rules.missingInformation)
            expect(ai.missingInformation).toContain(missing);
        if (rules.hardReject) {
            expect(ai.recommendation).toBe('Skip');
            expect(ai.fitScore).toBeLessThanOrEqual(30);
        }
        else {
            expect(ai.recommendation).toBe('Review');
            expect(ai.fitScore).toBeLessThan(75);
        }
        const request = vi.mocked(fetch).mock.calls[0];
        expect(JSON.parse(String(request?.[1]?.body)).messages[1].content).toContain('Availability:');
    });
});
