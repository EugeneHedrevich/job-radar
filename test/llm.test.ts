import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';
import { db, queryOne, SELECT } from '../src/db/index.js';
import { assessWithLlm } from '../src/matching/llm.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, resetTestDb, useTempDb } from './helpers/db.js';
import { enableReviewAi, ingestReview as ingest, reviewAiResponse as llmResponse, reviewRecord as strong } from './helpers/review.js';
beforeAll(useTempDb);
beforeEach(async () => { vi.unstubAllGlobals(); resetConfigCache(); await resetTestDb(); });
afterAll(async () => { vi.unstubAllGlobals(); resetConfigCache(); await closeTempDb(); });
const enableLlm = (budget: number) => enableReviewAi(loadConfig(), budget);
function declareBasicAbap() {
    const profile = loadConfig().profile;
    profile.skills.limited = [{ name: 'ABAP', proficiency: 'basic' }];
    profile.not_claimed = profile.not_claimed.filter((claim) => claim !== 'ABAP development');
}
describe("AI evidence and deterministic safeguards", () => {
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
        expect(result!.assessment.engine).toBe('rules');
        expect(fetch).not.toHaveBeenCalled();
        expect(result!.assessment.mandatoryGapEvidence).toContainEqual(expect.objectContaining({ requirement: 'expert ABAP' }));
        expect(result!.assessment.recommendation).toBe('Skip');
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
        expect(result!.assessment.engine).toBe('rules');
        expect(fetch).not.toHaveBeenCalled();
        expect(result!.assessment.mandatoryGapEvidence).toContainEqual(expect.objectContaining({ requirement: 'master degree' }));
        expect(result!.assessment.recommendation).toBe('Skip');
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
        const body = JSON.parse((request.mock.calls[0] as unknown as [
            string,
            RequestInit
        ])[1].body as string);
        expect(body.messages[1].content).toContain('Education: Chemical Engineering (qualification level: unknown; institution: unknown)');
        expect(body.messages[0].content).toContain('Do not infer a qualification level or institution');
        expect(body.messages[0].content).toContain('If the verified list is empty, output mandatory_gaps: []');
        const verified = JSON.parse(body.messages[1].content.split('VERIFIED VACANCY ANALYSIS\n')[1]);
        expect(verified.verified_mandatory_gaps).toEqual([]);
    });
    it.each([
        'Mandatory requirements:\n- ABAP OO development\nPreferred skills:\n- SAPUI5',
        '### **Requirements**\n* ABAP OO development\n### **Nice to have**\n* SAPUI5',
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
        const request = vi.mocked(fetch).mock.calls[0];
        const body = JSON.parse(String(request?.[1]?.body));
        const verified = JSON.parse(body.messages[1].content.split('VERIFIED VACANCY ANALYSIS\n')[1]);
        expect(verified.verified_mandatory_gaps).toContainEqual(expect.objectContaining({
            requirement: 'ABAP OO development', profile_path: 'not_claimed.1', profile_value: 'ABAP OO development',
        }));
    });
});
