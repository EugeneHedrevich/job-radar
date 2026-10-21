import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache, type AppConfig } from '../src/config/index.js';
import { validateGapEvidence } from '../src/matching/evidence.js';
import { assessWithLlm } from '../src/matching/llm.js';
import { assessWithRules } from '../src/matching/rules.js';
import { analyzeVacancy } from '../src/matching/analysis.js';
import { detectEngagement, detectWorkMode, jobText, requirementKind } from '../src/matching/signals.js';
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
    it('keeps technical terms and Gulf employer locations separate from employment and candidate restrictions', async () => {
        enableReviewAi(config);
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse()));
        const technical = reviewJob('', { jobType: null, description: 'SAP CAP and Node.js. Contract testing. SAP Payroll integrations.' });
        expect(analyzeVacancy(config, technical).engagement).toBe('unknown');
        const permanent = reviewJob('', { jobType: null, description: 'SAP CAP and Node.js. **Type:** Permanent. **Location:** Remote.' });
        for (const result of [assessWithRules(config, permanent), await assessWithLlm(config, permanent)])
            expect(result).toMatchObject({ hardReject: true, recommendation: 'Skip' });
        expect(analyzeVacancy(config, reviewJob('Build CI/CD pipelines.')).profileEvidence.some((item) => item.name === 'SAP CPI')).toBe(false);
        const gulf = reviewJob('', { location: 'Dubai', locationCountry: 'United Arab Emirates',
            description: 'SAP CAP, Node.js, TypeScript. Contract: Freelance. Location: Remote. Our office is in Dubai.' });
        const analysis = analyzeVacancy(config, gulf);
        for (const result of [assessWithRules(config, gulf, analysis), await assessWithLlm(config, gulf, analysis)]) {
            expect(result).toMatchObject({ hardReject: false, recommendation: 'Review' });
            expect(result.missingInformation.join(' ')).toMatch(/permission.*Bulgaria.*not stated/);
        }
    });
    it('does not restore a negated permanent offer from coarse source metadata', () => {
        const job = reviewJob('', { jobType: 'permanent', description: 'SAP CAP and Node.js. Fully remote. No permanent employment.' });
        const analysis = analyzeVacancy(config, job);
        expect(analysis.engagement).toBe('unknown');
        expect(assessWithRules(config, job, analysis)).toMatchObject({ hardReject: false, recommendation: 'Review' });
    });
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
        expect(rules.hardRejectReason).not.toMatch(/days\/month/);
        expect(rules.missingInformation).toContain('onsite attendance frequency is not stated or unclear');
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
    it('keeps a capped Homeoffice schedule uncertain without assuming a five-day working week', () => {
        const job = reviewJob('Homeoffice (max. 2 Tage pro Woche).');
        expect(assessWithRules(config, job)).toMatchObject({ recommendation: 'Review', hardReject: false });
        expect(analyzeVacancy(config, job).attendance.mandatory).toBeNull();
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
    // One matrix verifies the final policy for both engines. Model output is
    // deliberately optimistic and includes a capability with no profile fact.
    it.each([
        ['Nice-to-haves:\n- ABAP OO development\n- RAP ownership', 'Apply'],
        ['No ABAP OO development is required. CAP is mandatory.', 'Apply'],
        ['This role is not suitable for candidates with only ABAP OO development experience.', 'Apply'],
        ['This role is unsuitable for candidates without SAP CAP experience.', 'Apply'],
        ['Contract testing and SAP Payroll integrations.', 'Apply'],
        ['**Contract:** Freelance\n**Location:** Remote', 'Apply'],
        ['Candidate required location: Canada', 'Skip'], ['Candidate required location: Mexico', 'Skip'],
        ['Start ASAP.', 'Review'],
        ['Privacy policy:\nABAP OO development and German are mandatory for processing personal data.', 'Apply'],
        ['About us:\nRAP ownership is mandatory for our marketing team.\nRequirements:\nSAP CAP experience.', 'Apply'],
        ['German optional. French is mandatory.', 'Skip'],
        ['### **Requirements**\n* German - Fluent (C1)', 'Skip'],
        ['**Was Dich auszeichnet**\n* Deine Deutschkenntnisse sind sehr gut, Deine Englischkenntnisse gut', 'Skip'],
        ['### **Nice to have**\n* German - Fluent (C1)', 'Apply'],
        ['Basic ABAP reading is mandatory.', 'Review'], ['English C1 is required.', 'Review'],
        ['Workload: 50 hours per week is mandatory.', 'Skip'], ['Remote, UK residents only.', 'Skip'],
        ['Candidates must reside within the EU, excluding Bulgaria.', 'Skip'], ['UK right to work is mandatory.', 'Review'],
        ['Must have SAP CAP / Kafka.', 'Review'], ['SAP CAP + Kafka are mandatory.', 'Review'],
        ['Must have 5 years of React experience.', 'Review'],
        ['Must have five years of React experience.', 'Review'], ['Must have 5-year React experience.', 'Review'],
        ['Must have SAP CAP and 5 years of React experience.', 'Review'],
        ['5 years of React experience is optional.', 'Apply'],
        ['Required: (5 years of React experience and SAP CAP) or RAP ownership', 'Review', 'uncertain'],
        ['SAP CAP experience with Kafka is mandatory.', 'Review'],
        ['Requirements:\nSAP CAP experience with Kafka', 'Review'],
        ['SAP CAP certification is mandatory.', 'Review'],
        ['SAP CAP experience and SAP CAP certification are required.', 'Review'],
        ['Certification in SAP CAP is mandatory.', 'Review'],
        ['ABAP OO development certification is mandatory.', 'Review'],
        ['Requirements:\n- SAP CAP/Kafka', 'Review'], ['Required: Kafka + SAP CAP.', 'Review'],
        ['SAP CAP + Kafka are not optional.', 'Review'],
        ['SAP CAP is required and Kafka or RabbitMQ is required.', 'Review'],
        ['SAP CAP or Kafka is required.', 'Apply'], ['SAP CAP is required; Kafka is optional.', 'Apply'],
        ['Expert SAPUI5 or Kafka is required.', 'Review'],
        ['ABAP OO development or RAP ownership is required.', 'Skip', 'incompatible'],
        ['SAP CAP + ABAP OO development or RAP ownership is required.', 'Skip', 'incompatible'],
        ['SAP CAP experience with Kafka or ABAP OO development is required.', 'Review', 'uncertain'],
        ['ABAP OO development or SAP CAP with Kafka is required.', 'Review', 'uncertain'],
        ['ABAP OO development or SAP CAP + Node.js is required.', 'Apply', 'satisfied'],
        ['SAP CAP / Node.js or RAP ownership is required.', 'Apply', 'satisfied'],
        ['SAP CAP certification or RAP ownership is required.', 'Review', 'uncertain'],
        ['SAP CAP certification or Node.js experience is required.', 'Apply', 'satisfied'],
        ['SAP CAP experience and certification or RAP ownership is required.', 'Review', 'uncertain'],
        ['SAP CAP or Kafka is required and RAP ownership is required.', 'Skip', 'satisfied'],
        ['Required: (SAP CAP or Node.js) and RAP ownership', 'Skip', 'satisfied'],
        ['Required: (SAP CAP and Node.js) or RAP ownership', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and optional RAP ownership) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and RAP ownership is optional) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and RAP ownership is not required) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and not required RAP ownership) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (optional RAP ownership and SAP CAP) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and optional Kafka) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and Kafka is not required) or ABAP OO development.', 'Apply', 'satisfied'],
        ['Required: (SAP CAP and RAP ownership is not optional) or ABAP OO development.', 'Skip', 'incompatible'],
        ['Required: (SAP CAP and optional RAP ownership or ABAP OO development.', 'Review', 'uncertain'],
        ['Required: SAP CAP and optional RAP ownership or ABAP OO development.', 'Review', 'uncertain'],
        ['Required: RAP ownership and (SAP CAP or Node.js)', 'Skip', 'satisfied'],
        ['Required: ((SAP CAP or Node.js) and RAP ownership)', 'Skip', 'satisfied'],
        ['Required: (SAP CAP and Kafka) or RAP ownership', 'Review', 'uncertain'],
        ['Required: (SAP CAP or Node.js) and', 'Review', 'uncertain'],
        ['Required: (SAP CAP or Node.js and RAP ownership', 'Review', 'uncertain'],
        ['Required: SAP CAP or Node.js and RAP ownership', 'Review', 'uncertain'],
        ['Fully remote; hybrid attendance is optional.', 'Apply'], ['No permanent employment.', 'Apply'],
        ['This position is not fully remote.', 'Review'], ["This position isn't fully remote.", 'Review'],
        ['Fully remote is not offered.', 'Review'],
        ['Fully remote; optional hybrid attendance with Homeoffice (max. 2 Tage pro Woche).', 'Apply'],
        ['Homeoffice (max. 2 Tage pro Woche).', 'Review'],
        ['Optional: five onsite days per month.', 'Apply'], ['Five onsite days per month are not required.', 'Apply'],
        ['Onsite attendance is optional, at least three days per week.', 'Apply'],
        ['Five onsite days per month.', 'Review'], ['Hybrid: three onsite days per week.', 'Review'],
        ['Onsite attendance is required, at least several days per week.', 'Review'],
        ['Onsite attendance is required, three days per week.', 'Skip'], ['Three days per week onsite, required.', 'Skip'],
        ['Fully onsite, SAPUI5 is optional.', 'Skip'], ['No remote work allowed. Optional onsite visits.', 'Skip'],
        ['Expert SAPUI5 knowledge is mandatory.', 'Skip'],
    ])('preserves %s', async (condition, recommendation, alternativeStatus?: string) => {
        enableReviewAi(config);
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse('Apply', 99, { strong_matches: ['CAP', 'Kafka', 'SAP CAP certification'] })));
        const job = reviewJob(condition), analysis = analyzeVacancy(config, job);
        const rules = assessWithRules(config, job, analysis), ai = await assessWithLlm(config, job, analysis);
        expect(rules.recommendation).toBe(recommendation);
        expect(ai.recommendation).toBe(recommendation);
        expect(ai.hardReject).toBe(rules.hardReject);
        expect(ai.strongMatches).not.toContain('Kafka');
        expect(ai.mandatoryGapEvidence).toEqual(rules.mandatoryGapEvidence);
        for (const evidence of ai.mandatoryGapEvidence) expect(validateGapEvidence(config, job, evidence, analysis)).toBeNull();
        for (const missing of rules.missingInformation)
            expect(ai.missingInformation).toContain(missing);
        if (rules.hardReject) {
            expect(ai.recommendation).toBe('Skip');
            expect(ai.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
            expect(rules.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
        }
        else if (recommendation === 'Review') {
            expect(ai.fitScore).toBeLessThan(75);
            expect(rules.fitScore).toBeLessThan(75);
        } else {
            expect(ai.fitScore).toBeGreaterThanOrEqual(75);
            expect(analysis.attendance.mandatory).toBeNull();
        }
        if (condition.includes('Kafka') && recommendation === 'Review') {
            expect(analysis.requirements).toContainEqual(expect.objectContaining({ name: 'kafka', profileEvidence: 'unknown' }));
            expect(ai.mandatoryGaps.join(' ')).not.toMatch(/Kafka/i);
            expect(ai.missingInformation.join(' ')).toMatch(/required capability "kafka"/);
        }
        if (condition.includes('React')) {
            expect(analysis.requirements).toContainEqual(expect.objectContaining({ name: 'react', profileEvidence: 'unknown',
                kind: recommendation === 'Apply' ? 'preferred' : alternativeStatus ? 'unclear' : 'mandatory' }));
            expect(ai.strongMatches).not.toContain('React');
            expect(ai.mandatoryGaps.join(' ')).not.toMatch(/React/i);
            expect(ai.mandatoryGapEvidence).toEqual([]);
        }
        if (condition.includes('certification')) {
            const certification = analysis.requirements.find((item) => item.name.includes('certification'));
            expect(certification).toMatchObject({ profileEvidence: 'unknown' });
            expect(ai.strongMatches).not.toContain(certification!.name);
            expect(ai.strongMatches.some((match) => /certificat/i.test(match))).toBe(false);
            expect(ai.missingInformation.join(' ')).toMatch(/profile evidence.*certification/);
        }
        if (alternativeStatus) {
            const groups = analysis.requirements.flatMap((item) => item.mentions).filter((mention) => mention.alternativeGroup);
            expect(groups.length).toBeGreaterThan(0);
            expect(new Set(groups.map((mention) => mention.alternativeStatus))).toEqual(new Set([alternativeStatus]));
            if (alternativeStatus === 'incompatible') expect(rules.hardRejectReason).toContain('Every alternative');
        }
        if (condition === 'Required: (SAP CAP or Node.js) and RAP ownership') {
            const rap = analysis.requirements.find((item) => item.name === 'RAP ownership');
            expect(rap).toMatchObject({ kind: 'mandatory' });
            expect(rap!.mentions.some((mention) => mention.kind === 'mandatory' && !mention.alternativeGroup)).toBe(true);
            expect(rules.preferredGaps.join(' ')).not.toContain('RAP ownership');
            expect(ai.mandatoryGapEvidence).toContainEqual(expect.objectContaining({ requirement: 'RAP ownership', vacancyQuote: condition }));
            expect(rules.fitScore).toBe(config.scoring.hard_rejects.score_cap);
            expect(ai.fitScore).toBe(config.scoring.hard_rejects.score_cap);
        }
        if (condition.startsWith('Required:') && condition.includes('ABAP OO development') && recommendation === 'Apply') {
            const optional = condition.includes('Kafka') ? 'Kafka' : 'RAP ownership';
            expect(requirementKind(config, condition, optional)).toBe('preferred');
            const requirement = analysis.requirements.find((item) => item.name.toLowerCase() === optional.toLowerCase());
            expect(requirement).toMatchObject({ kind: 'preferred', profileEvidence: optional === 'Kafka' ? 'unknown' : 'not_claimed' });
            expect(ai.hardReject).toBe(false);
            expect(ai.mandatoryGapEvidence).toEqual([]);
            expect(ai.strongMatches).not.toContain(optional);
        }
        if (condition.startsWith('Required:') && alternativeStatus === 'uncertain') {
            expect(analysis.requiresReview).toBe(true);
            expect(ai.missingInformation.join(' ')).toContain('mandatory capability grouping');
        }
        if (/not fully remote|isn't fully remote|fully remote is not offered/i.test(condition)) {
            expect(analysis.workMode).toBe('unknown');
            expect(analysis.attendance.mandatory).toBeNull();
            expect(rules.locationFit).toBeLessThan(assessWithRules(config, reviewJob()).locationFit);
            expect(ai.missingInformation.join(' ')).toMatch(/Work mode and attendance are not verified/);
        }
        const request = vi.mocked(fetch).mock.calls[0];
        expect(JSON.parse(String(request?.[1]?.body)).messages[1].content).toContain('Availability:');
    });
    it.each([
        ['CAP Developer', 'SAP BTP applications with CAP and Node.js.', true],
        ['CAP Developer', 'Common Agricultural Policy tooling, including SAP BTP reporting.', false],
        ['CAP Developer', 'Capital allocation tooling with Node.js.', false],
        ['SAP CAP Internship', 'SAP BTP applications with CAP and Node.js.', false],
    ])('checks relevance before a direct paid assessment: %s / %s', async (title, description, accepted) => {
        enableReviewAi(config);
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse()));
        const job = reviewJob('', { title, description });
        expect(analyzeVacancy(config, job).relevance.accepted).toBe(accepted);
        if (accepted) await assessWithLlm(config, job);
        else await expect(assessWithLlm(config, job)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(accepted ? 1 : 0);
    });
    it.each([
        [20, 30, 'hourly', 'EUR', true], [160, 240, 'daily', 'EUR', true],
        [30, 60, 'hourly', 'EUR', false], [20, 45, 'hourly', 'EUR', false],
        [20, null, 'hourly', 'EUR', false], [70, 30, 'hourly', 'EUR', false],
        [20, 30, 'hourly', 'USD', false], [20, 30, 'hourly', null, false],
        [null, null, 'hourly', 'EUR', false],
    ])('enforces only a comparable upper rate bound: %s–%s %s %s', async (salaryMin, salaryMax, salaryInterval, salaryCurrency, blocked) => {
        enableReviewAi(config);
        vi.stubGlobal('fetch', vi.fn(async () => reviewAiResponse('Apply', 99)));
        const job = reviewJob('', { salaryMin, salaryMax, salaryInterval, salaryCurrency });
        const analysis = analyzeVacancy(config, job), rules = assessWithRules(config, job, analysis), ai = await assessWithLlm(config, job, analysis);
        for (const result of [rules, ai]) {
            expect(result.hardReject).toBe(blocked);
            if (blocked) {
                expect(result.recommendation).toBe('Skip');
                expect(result.fitScore).toBe(config.scoring.hard_rejects.score_cap);
                expect(result.hardRejectReason).toContain('below the profile minimum');
            }
        }
    });
});
