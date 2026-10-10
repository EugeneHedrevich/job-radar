import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { validateGapEvidence } from '../src/matching/evidence.js';
import { assessWithRules, prescreen, suggestCvVariant } from '../src/matching/rules.js';
import { jobText, requirementKind } from '../src/matching/signals.js';
import type { MatchableJob } from '../src/matching/types.js';
import { reviewJob } from './helpers/review.js';
const config = loadConfig();
function job(overrides: Partial<MatchableJob> = {}): MatchableJob { return reviewJob('', overrides); }
describe('deterministic matching (no LLM key required)', () => {
    it('does not turn a negated skill requirement into a proven mandatory gap', () => {
        const vacancy = job({ description: `${job().description}\nABAP OO development is not required, CAP is mandatory.` });
        expect(requirementKind(config, jobText(vacancy).all, 'ABAP OO development')).toBe('preferred');
        expect(assessWithRules(config, vacancy).mandatoryGaps).toEqual([]);
    });
    it('scores a strong, remote, contract BTP role highly and recommends Apply', () => {
        const result = assessWithRules(config, job());
        expect(result.engine).toBe('rules');
        expect(result.model).toBeNull();
        expect(result.fitScore).toBeGreaterThanOrEqual(config.scoring.thresholds.apply);
        expect(result.recommendation).toBe('Apply');
        expect(result.strongMatches).toContain('CAP');
        expect(result.hardReject).toBe(false);
    });
});
describe('focused SAPUI5 frontend scoring', () => {
    const frontendDescription = 'Develop SAPUI5 and SAP Fiori applications with JavaScript, TypeScript and OData. Fully remote freelance contract, English-speaking team.';
    it.each(['SAPUI5 Developer', 'SAP UI5 Developer', 'SAP Fiori Developer'])('recognizes a strong frontend match without requiring BTP or CAP: %s', (title) => {
        const result = assessWithRules(config, job({ title, description: frontendDescription }));
        expect(result.fitScore).toBeGreaterThanOrEqual(75);
        expect(result.recommendation).toBe('Apply');
        expect(result.mandatoryGaps).toEqual([]);
        expect(result.strongMatches).not.toContain('CAP');
        expect(result.strongMatches).not.toContain('SAP BTP');
    });
    it('retains a mandatory ABAP rejection even with a strong frontend match', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\n**Profil**\n- ABAP Objects\n**Wir bieten**\nRemote work.` }));
        expect(result.recommendation).toBe('Skip');
        expect(result.fitScore).toBe(config.scoring.hard_rejects.score_cap);
    });
    it('keeps a frontend role eligible when ABAP is explicitly optional', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\nABAP knowledge is nice to have.` }));
        expect(result.recommendation).toBe('Apply');
        expect(result.mandatoryGaps).toEqual([]);
    });
    it('requires review when a frontend role mentions ABAP with an unclear obligation', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\nWe also use ABAP.` }));
        expect(result.hardReject).toBe(false);
        expect(result.mandatoryGaps).toEqual([]);
        expect(result.fitScore).toBe(config.scoring.thresholds.apply - 1);
        expect(result.recommendation).toBe('Review');
        expect(result.missingInformation.join(' ')).toMatch(/required ABAP capability and level/);
    });
    it('recognises ABAP under a combined responsibilities and requirements heading', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\n**Key Responsibilities & Requirements**\n* 6+ years of hands-on experience in SAP ABAP development.\n* Experience with SAP RAP.\n* ABAP Cloud is preferred.` }));
        expect(result.hardReject).toBe(true);
        expect(result.recommendation).toBe('Skip');
        expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP development/);
        expect(result.mandatoryGaps.join(' ')).toMatch(/RAP ownership/);
    });
    it('requires confirmation of an undocumented mandatory skill without rejecting the candidate', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\nSAP MDK is mandatory.` }));
        expect(result.hardReject).toBe(false);
        expect(result.mandatoryGaps).toEqual([]);
        expect(result.recommendation).toBe('Review');
        expect(result.fitScore).toBe(config.scoring.thresholds.apply - 1);
        expect(result.missingInformation.join(' ')).toMatch(/required capability "sap mdk"/);
    });
    it('keeps a match eligible when an undocumented skill is only preferred', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\nSAP MDK is preferred.` }));
        expect(result.recommendation).toBe('Apply');
        expect(result.fitScore).toBeGreaterThanOrEqual(75);
    });
    it('recognises the combined German and English language requirement', () => {
        const result = assessWithRules(config, job({ title: 'SAPUI5 Developer',
            description: `${frontendDescription}\nAnforderungen:\nSehr gute Deutsch- und gute Englischkenntnisse.` }));
        expect(result.recommendation).toBe('Skip');
        expect(result.hardRejectReason).toMatch(/language/i);
    });
    it('requires detailed frontend evidence rather than just a title or incidental UI5 mention', () => {
        for (const vacancy of [
            job({ title: 'SAPUI5 Developer', description: null }),
            job({ title: 'SAPUI5 Developer', description: 'Maintain SAPUI5 applications. Fully remote contract.' }),
            job({ title: 'SAP BTP Developer', description: frontendDescription }),
        ])
            expect(assessWithRules(config, vacancy).technicalFit).toBeLessThan(90);
    });
    it('does not award focused-role points for a skill absent from the candidate profile', () => {
        const withoutUi5 = { ...config, profile: { ...config.profile, skills: { ...config.profile.skills, frontend: [] } } };
        const result = assessWithRules(withoutUi5, job({ title: 'SAPUI5 Developer', description: frontendDescription }));
        expect(result.technicalFit).toBeLessThan(90);
        expect(result.recommendation).not.toBe('Apply');
    });
});
describe('mandatory-gap filtering', () => {
    it.each([
        'Requirements:\n- ABAP OO development is mandatory\n- SAPUI5 is preferred',
        'Mandatory requirements:\n- ABAP OO development\nPreferred skills:\n- SAPUI5',
        'Must have: ABAP OO development, CAP, Node.js. Nice to have: SAPUI5.',
        'Must have CAP, Node.js, ABAP OO development. Nice to have SAPUI5.',
        'Must have CAP, Node.js, ABAP OO development, nice to have SAPUI5.',
        'ABAP OO development is mandatory; SAPUI5 is preferred.',
        'Mandatory: ABAP OO development, preferred: SAPUI5.',
        '<ul><li>ABAP OO development is mandatory</li><li>SAPUI5 is preferred</li></ul>',
    ])('keeps a mandatory skill separate from a preferred skill: %s', (requirements) => {
        const vacancy = job({ description: `${job().description}\n${requirements}` });
        const text = jobText(vacancy);
        expect(requirementKind(config, text.all, 'ABAP OO development')).toBe('mandatory');
        expect(requirementKind(config, text.all, 'SAPUI5')).toBe('preferred');
        const result = assessWithRules(config, vacancy);
        expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP OO/);
        expect(result.preferredGaps.join(' ')).not.toMatch(/ABAP OO/);
        expect(result.recommendation).toBe('Skip');
    });
    it('cites the mandatory occurrence when an earlier occurrence of the same skill is preferred', () => {
        const result = assessWithRules(config, job({ description: 'ABAP OO development is preferred.\nABAP OO development is mandatory for the client project.' }));
        expect(result.mandatoryGapEvidence.find((gap) => gap.requirement === 'ABAP OO development')?.vacancyQuote)
            .toBe('ABAP OO development is mandatory for the client project.');
    });
    it('does not transfer a preferred marker to a neighboring mandatory skill', () => {
        const text = jobText(job({ description: 'SAPUI5 is preferred, ABAP OO development is mandatory.' }));
        expect(requirementKind(config, text.all, 'SAPUI5')).toBe('preferred');
        expect(requirementKind(config, text.all, 'ABAP OO development')).toBe('mandatory');
    });
    it('carries a changed preferred marker through the remaining items of that list', () => {
        const text = 'Must have CAP, Node.js, preferred SAPUI5, ABAP OO development.';
        expect(requirementKind(config, text, 'CAP')).toBe('mandatory');
        expect(requirementKind(config, text, 'Node.js')).toBe('mandatory');
        expect(requirementKind(config, text, 'SAPUI5')).toBe('preferred');
        expect(requirementKind(config, text, 'ABAP OO development')).toBe('preferred');
    });
    it('does not carry an inline list marker into an unrelated sentence', () => {
        expect(requirementKind(config, 'Must have CAP, Node.js. We also use ABAP OO development.', 'ABAP OO development')).toBe('unclear');
    });
    it('keeps mandatory precedence when a skill is repeated in a preferred list', () => {
        const text = 'Must have CAP, Node.js, ABAP OO development. Nice to have SAPUI5, ABAP OO development.';
        expect(requirementKind(config, text, 'ABAP OO development')).toBe('mandatory');
    });
    it.each([
        'No freelancers accepted.',
        'Freelancers are not considered.',
        'No contractors accepted.',
        'No B2B.',
        'Keine Freelancer.',
        'Permanent contract only.',
    ])('rejects explicit contract exclusions: %s', (exclusion) => {
        const result = assessWithRules(config, job({ description: `${job().description} ${exclusion}` }));
        expect(result.hardReject).toBe(true);
        expect(result.recommendation).toBe('Skip');
        expect(result.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
        expect(result.commercialFit).toBeLessThan(assessWithRules(config, job()).commercialFit);
    });
    it('rejects the Michael Page mixed role with mandatory Polish ABAP Objects requirements', () => {
        const vacancy = job({
            title: 'SAP S/4HANA Technical Developer (ABAP, Fiori and SAP BTP)',
            location: 'Warszawa, Polska, PL', locationCountry: 'Poland',
            salaryMin: 170, salaryMax: 190, salaryCurrency: 'PLN',
            description: [
                '**Opis stanowiska**',
                'SAP CAP, Node.js, SAPUI5, SAP Fiori, SAP HANA Cloud, CDS, OData, REST, SAP Integration Suite, SAP Build Process Automation.',
                '* Projektowanie i rozwój rozwiązań opartych o:',
                '  + ABAP Objects,',
                '**Profil kandydata**',
                '* Bardzo dobra znajomość:',
                '  + ABAP Objects,',
                '  + SAPUI5,',
                '  + SAP BTP.',
                '**Oferujemy**',
                '* Praca w 100% zdalna',
            ].join('\n'),
        });
        const result = assessWithRules(config, vacancy);
        expect(result.technicalFit).toBe(95);
        expect(result.fitScore).toBe(config.scoring.hard_rejects.score_cap);
        expect(result.recommendation).toBe('Skip');
        expect(result.mandatoryGaps).toContain('ABAP OO development appears to be mandatory');
        expect(result.mandatoryGapEvidence.find((gap) => gap.requirement === 'ABAP OO development')?.vacancyQuote)
            .toBe('* Bardzo dobra znajomość:\n+ ABAP Objects,');
        for (const gap of result.mandatoryGapEvidence)
            expect(validateGapEvidence(config, vacancy, gap)).toBeNull();
    });
    it('keeps an unspecified ABAP capability unresolved under a shared required marker', () => {
        const vacancy = job({ description: `${job().description}\nThis role requires working and knowledge of SAP RISE, SAP BTP, SAP ABAP, FIORI, BASIS and Cloud Integrator, and SAP standard reports.` });
        const result = assessWithRules(config, vacancy);
        expect(result.mandatoryGaps).not.toContain('ABAP development appears to be mandatory');
        expect(result.hardReject).toBe(false);
        expect(result.missingInformation.join(' ')).toMatch(/required ABAP capability and level/);
        expect(result.recommendation).toBe('Review');
    });
    it.each([
        'Profil kandydata:\n+ ABAP Objects\nMile widziane:\n+ RAP',
        '<h2>Profil kandydata</h2><ul><li>ABAP Objects</li></ul><h2>Mile widziane</h2><ul><li>RAP</li></ul>',
        'Anforderungen:\n- ABAP Objects\nWünschenswert:\n- RAP',
        'Profil recherché:\n- ABAP Objects\nNice to have:\n- RAP',
        'Jouw profiel:\n- ABAP Objects\nNice to have:\n- RAP',
    ])('recognizes recruiter requirement sections and optional alternatives: %s', (description) => {
        const text = jobText(job({ description })).all;
        expect(requirementKind(config, text, 'ABAP Objects')).toBe('mandatory');
        expect(requirementKind(config, text, 'RAP')).toBe('preferred');
    });
    it('ends the Polish requirements section before benefits', () => {
        const text = jobText(job({ description: '**Profil kandydata**\n* SAP BTP\n**Oferujemy**\n* Szkolenia ABAP Objects' })).all;
        expect(requirementKind(config, text, 'SAP BTP')).toBe('mandatory');
        expect(requirementKind(config, text, 'ABAP Objects')).toBe('unclear');
        expect(assessWithRules(config, job({ description: text })).mandatoryGaps).toEqual([]);
    });
    it.each([
        'This role does not require ABAP Objects.',
        'ABAP Objects are not compulsory.',
        'ABAP Objects nie jest wymagany.',
        'ABAP Objects nicht erforderlich.',
        'ABAP Objects non requis.',
        'ABAP Objects niet vereist.',
        'ABAP Objects mile widziane.',
    ])('does not reject optional or negated ABAP requirements: %s', (description) => {
        const vacancy = job({ description: `${job().description}\n${description}` });
        expect(requirementKind(config, jobText(vacancy).all, 'ABAP Objects')).toBe('preferred');
        expect(assessWithRules(config, vacancy).recommendation).toBe('Apply');
    });
    it('keeps Apply for a positive contract offer with only preferred ABAP OO knowledge', () => {
        const result = assessWithRules(config, job({
            description: `${job().description} ABAP OO development is nice to have.`,
        }));
        expect(result.mandatoryGaps).toEqual([]);
        expect(result.recommendation).toBe('Apply');
    });
    it('rejects an ABAP-only role even when the title mentions SAP', () => {
        const result = assessWithRules(config, job({
            title: 'Senior ABAP Developer',
            description: 'Permanent position only. Extensive experience with ABAP OO and the RAP framework is mandatory. Fully on-site in Walldorf. No freelancers.',
            jobType: 'fulltime',
            isRemote: false,
        }));
        expect(result.hardReject).toBe(true);
        expect(result.recommendation).toBe('Skip');
        expect(result.fitScore).toBeLessThanOrEqual(config.scoring.hard_rejects.score_cap);
        expect(result.mandatoryGaps.join(' ')).toMatch(/ABAP/i);
    });
    it('rejects a predominantly functional role', () => {
        const result = assessWithRules(config, job({
            title: 'SAP IS-U Functional Consultant',
            description: 'Deep IS-U functional expertise is mandatory. Mostly on-site in Warsaw. Fluent Polish is required.',
            jobType: 'fulltime',
            isRemote: null,
        }));
        expect(result.hardReject).toBe(true);
        expect(result.recommendation).toBe('Skip');
    });
    it('separates mandatory gaps from preferred ones', () => {
        const mandatory = assessWithRules(config, job({ description: `${job().description} SAP IS-U functional consulting is mandatory for this role.` }));
        expect(mandatory.mandatoryGaps.some((gap) => /IS-U/i.test(gap))).toBe(true);
        const preferred = assessWithRules(config, job({ description: `${job().description} SAP IS-U functional consulting is nice to have.` }));
        expect(preferred.preferredGaps.some((gap) => /IS-U/i.test(gap))).toBe(true);
        expect(preferred.mandatoryGaps.some((gap) => /IS-U/i.test(gap))).toBe(false);
    });
});
describe('onsite obligations and travel limits', () => {
    // Different wording and clause order protect previous attendance regressions.
    it.each([
        ["Three onsite days every week are required.", true, null],
        ["Hybrid: 3 days per week onsite are mandatory.", true, null],
        ["Required on-site presence: 3 days a week.", true, null],
        ["Two to three days in the office per week are required.", true, null],
        ["Five onsite days per month are required.", true, null],
        ["Optional: five onsite days per month.", false, null],
        ["Five onsite days per month are not required.", false, null],
        ["Five onsite days per month are not mandatory.", false, null],
        ["Five onsite days per month aren't required.", false, null],
        ["You do not have to attend five onsite days per month.", false, null],
        ["No mandatory onsite attendance: five days per month.", false, null],
        ["No onsite attendance required: five days per month.", false, null],
        ["There is no need for five onsite days per month.", false, null],
        ["Hybrid: 3 days per week onsite.", false, "unclear whether onsite attendance"],
        ["On-site presence: 3 days a week.", false, "unclear whether onsite attendance"],
        ["Two to three days in the office per week.", false, "unclear whether onsite attendance"],
        ["SAPUI5 is optional. Three onsite days every week.", false, "unclear whether onsite attendance"],
        ["SAPUI5 is not required, three onsite days every week.", false, "unclear whether onsite attendance"],
        ["Optional SAPUI5 knowledge, three onsite days every week are required.", true, null],
        ["Optional SAPUI5 knowledge and three onsite days every week are required.", true, null],
        ["Five onsite days per month are not required, but three onsite days every week are required.", true, null],
        ["Optional: five onsite days per month. Three onsite days every week are required.", true, null],
        ["Three onsite days every week are not optional.", true, null],
        ["Fully remote. Five days per week onsite are not required.", false, null],
        ["Onsite attendance is required, three days per week.", true, null],
        ["Onsite attendance is required, at least three days per week.", true, null],
        ["Fully remote. Onsite attendance is optional, at least three days per week.", false, null],
        ["Fully remote. Onsite attendance is not required, at least three days per week.", false, null],
        ["Three days per week onsite, required.", true, null],
        ["SAPUI5 is optional, three onsite days every week are required.", true, null],
        ["Hybrid: three onsite days per week.", false, "unclear whether onsite attendance"],
        ["Onsite attendance is required and three days per week.", true, null],
        ["Three days per week, onsite, required.", true, null],
        ["SAPUI5 is optional, onsite attendance is required, three days per week.", true, null],
        ["ABAP OO development is preferred, onsite attendance is required, at least three days per week.", true, null],
        ["Onsite attendance is required, at least three days per week, ABAP OO development is preferred.", true, null],
        ["Onsite attendance is required, at least three days per week, ABAP OO development.", true, null],
        ["Mandatory onsite attendance: at least three days per week, ABAP OO development.", true, null],
        ["Onsite attendance is required, at least several days per week.", false, "onsite attendance frequency is not stated or unclear"],
        ["Two or three onsite days per week are required.", false, "onsite attendance frequency is not stated or unclear"],
        ["Three onsite days per week or month are required.", false, "onsite attendance frequency is not stated or unclear"],
        ["SAPUI5 is required, three onsite days per week.", false, "unclear whether onsite attendance"],
        ["Three onsite days per week, SAPUI5 is required.", false, "unclear whether onsite attendance"],
        ["SAPUI5 is optional, three onsite days per week.", false, "unclear whether onsite attendance"],
        ["Overtime is required, three onsite days per week.", false, "unclear whether onsite attendance"],
        ["Three onsite days per week with optional SAPUI5 knowledge.", false, "unclear whether onsite attendance"],
        ["Fully remote. Five days per week onsite, not required.", false, null],
        ["Fully remote. Onsite attendance is optional, five days per week.", false, null],
        ["Fully remote. Five days per week onsite are optional.", false, null],
        ["Fully onsite is not required.", false, null],
        ["Not fully onsite.", false, null],
        ["Fully onsite, optional.", false, null],
        ["100% onsite is optional.", false, null],
        ["No relocation is required.", false, null],
        ["SAPUI5 is optional, fully onsite.", true, null],
        ["Fully onsite with optional SAPUI5 knowledge.", true, null],
        ["Fully onsite, SAPUI5 is optional.", true, null],
        ["100% onsite. SAPUI5 is not required.", true, null],
        ["Optional onsite visits. No remote work allowed.", true, null],
        ["Five onsite days per month are not required, but remote work is not possible.", true, null],
        ["Optional SAPUI5, remote work is not offered.", true, null],
        ["SAPUI5 is optional, must relocate.", true, null],
        ["Relocation is required, SAPUI5 is optional.", true, null],
    ] as const)('uses the stated attendance obligation: %s', (condition, rejected, missing) => {
        const result = assessWithRules(config, job({ description: job().description + '\n' + condition }));
        expect(result.hardReject).toBe(rejected);
        if (rejected)
            expect(result.recommendation).toBe('Skip');
        if (missing)
            expect(result.missingInformation.join(' ')).toContain(missing);
        if (condition.includes('ABAP OO'))
            expect(result.mandatoryGaps.join(' ')).not.toMatch(/ABAP OO/);
    });
    it('allows explicitly stated attendance at the configured limit', () => {
        const result = assessWithRules(config, job({ description: `${job().description} Four onsite days per month are required.` }));
        expect(result.hardReject).toBe(false);
    });
    it('uses the edited travel limit rather than a fixed weekly rejection rule', () => {
        const changed = structuredClone(config);
        changed.profile.travel!.max_onsite_days_per_month = 12;
        const result = assessWithRules(changed, job({ description: `${job().description} Three onsite days every week are required.` }));
        expect(result.hardReject).toBe(false);
    });
    it('does not count remote days as onsite attendance', () => {
        const result = assessWithRules(config, job({ description: `${job().description} Three days per week remote and one day per week onsite.` }));
        expect(result.hardReject).toBe(false);
    });
    it('keeps an unspecified attendance frequency unknown', () => {
        const result = assessWithRules(config, job({ description: `${job().description} Occasional onsite meetings.` }));
        expect(result.hardReject).toBe(false);
        expect(result.missingInformation).toContain('onsite attendance frequency is not stated or unclear');
    });
    it('reports an unqualified five-day schedule as uncertain without the old weekly hard reject', () => {
        const result = assessWithRules(config, job({ description: 'Five days per week onsite.' }));
        expect(result.hardReject).toBe(false);
        expect(result.missingInformation).toContain('unclear whether onsite attendance (20.0 days/month) is mandatory');
    });
    it('uses the configured monthly limit even for a required five-day weekly schedule', () => {
        const changed = structuredClone(config);
        changed.profile.travel!.max_onsite_days_per_month = 20;
        expect(assessWithRules(changed, job({ description: 'Five days per week onsite are required.' })).hardReject).toBe(false);
        expect(assessWithRules(config, job({ description: 'Five days per week onsite are required.' })).hardReject).toBe(true);
    });
});
describe('uncertainty handling', () => {
    it('never recommends Apply for a job whose description was not retrieved', () => {
        const result = assessWithRules(config, job({ description: null, descriptionHash: null }));
        expect(result.recommendation).not.toBe('Apply');
        expect(result.fitScore).toBeLessThanOrEqual(config.scoring.uncertainty.cap_without_description);
        expect(result.missingInformation.join(' ')).toMatch(/description/i);
    });
    it('reports an unknown rate as missing information rather than rejecting or accepting', () => {
        const result = assessWithRules(config, job({ salaryMin: null, salaryMax: null, salaryInterval: null, salaryCurrency: null }));
        expect(result.missingInformation).toContain('rate not stated');
        expect(result.hardReject).toBe(false);
    });
    it('reports an unknown contract type and work mode without rejecting the job', () => {
        const unknown = job({
            jobType: null,
            isRemote: null,
            description: 'SAP BTP role. CAP and Node.js are used. No further details provided.',
        });
        const result = assessWithRules(config, unknown);
        expect(result.missingInformation.join(' ')).toMatch(/contract type not stated/);
        expect(result.missingInformation.join(' ')).toMatch(/work mode/);
        expect(result.hardReject).toBe(false);
        // Unknown must sit between a clearly bad and a clearly good posting,
        // never collapse to either extreme.
        const bad = assessWithRules(config, job({
            jobType: 'fulltime',
            isRemote: false,
            description: 'SAP BTP role. CAP and Node.js are used. Permanent position, fully on-site in Munich.',
        }));
        const good = assessWithRules(config, job({ description: 'SAP BTP role. CAP and Node.js are used. Freelance contract, 100% remote.' }));
        expect(result.fitScore).toBeGreaterThan(bad.fitScore);
        expect(result.fitScore).toBeLessThan(good.fitScore);
    });
    it('does not assume work authorisation outside the preferred region', () => {
        const result = assessWithRules(config, job({ location: 'Austin, TX, US', locationCountry: 'United States' }));
        expect(result.missingInformation.join(' ')).toMatch(/work authorisation/i);
    });
});
describe('prescreen', () => {
    it('drops obviously irrelevant titles cheaply', () => {
        expect(prescreen(config, job({ title: 'Technical Recruiter', description: 'We hire SAP people.' })).passed).toBe(false);
        expect(prescreen(config, job({ title: 'Working Student SAP', description: 'Support our SAP team with small tasks.' }))
            .passed).toBe(false);
    });
    it('rescues an excluded title when the body is clearly in scope', () => {
        expect(prescreen(config, job({ title: 'ABAP and BTP Developer', description: 'CAP, Node.js and BTP work.' })).passed).toBe(true);
    });
});
describe('CV variant recommendation', () => {
    it('only ever returns a configured variant id', () => {
        const ids = config.cvVariants.variants.map((variant) => variant.id);
        for (const title of ['SAP CPI Developer', 'SAP Fiori Developer', 'SAP AI Developer', 'SAP BTP Architect', 'Chef']) {
            expect(ids).toContain(suggestCvVariant(config, jobText(job({ title }))));
        }
    });
    it('picks the integration CV for a CPI role', () => {
        expect(suggestCvVariant(config, jobText(job({
            title: 'SAP Integration Suite / CPI Developer',
            description: 'Design iFlows in SAP CPI, configure destinations, OAuth and principal propagation to S/4HANA.',
        })))).toBe('cpi');
    });
});
describe('sparse metadata and requirement word boundaries', () => {
    it('does not infer currency or a low-rate rejection from an unqualified amount', () => {
        const result = assessWithRules(config, job({ salaryMin: 20, salaryMax: 30, salaryCurrency: null }));
        expect(result.hardReject).toBe(false);
        expect(result.missingInformation.join(' ')).toMatch(/currency not stated/);
    });
    it('distinguishes RAP from wrapper and ignores connective words in lists', () => {
        const result = assessWithRules(config, job({ description: job().description + '\nMust have:\nCAP\nwith\nand\nmit\nyou will\nSuccessFactors integration\nwrapper development' }));
        expect(result.mandatoryGaps.join(' ')).not.toMatch(/RAP/);
        expect(result.missingInformation.join(' ')).not.toMatch(/required capability "(?:with|and|mit|you will)"/);
        expect(result.missingInformation.join(' ')).toMatch(/successfactors integration/);
    });
});
