import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activeCooldowns, recordOutcomes } from "../src/collector/health.js";
import { recoverInterruptedRuns, startRunHeartbeat } from "../src/collector/lifecycle.js";
import { planBatch, selectBatchIndex, type DescriptionRotation } from "../src/collector/plan.js";
import { recordSearchProgress, reserveBatchPlan } from "../src/collector/rotation.js";
import { runCollector } from "../src/collector/run.js";
import { type CollectorTask } from "../src/collector/types.js";
import { loadConfig, PROJECT_ROOT, resetConfigCache } from "../src/config/index.js";
import { cds, connectDb, db, DELETE, disconnectDb, INSERT, query, SELECT } from "../src/db/index.js";
import { PRIORITY_DIRECTIONS, priorityDirections } from "../src/matching/directions.js";
import { assessWithRules, prescreen } from "../src/matching/rules.js";
import { type MatchableJob } from "../src/matching/types.js";
import { normalizeJob } from "../src/normalize/index.js";
import { ingestJobs } from "../src/persist/ingest.js";
import { summarizeDirections } from "../src/pipeline/coverage.js";
import { closeTempDb, useTempDb } from "./helpers/db.js";
const here = path.dirname(fileURLToPath(import.meta.url));
function task(id: string, source = 'linkedin'): CollectorTask {
    return {
        task_id: id,
        source,
        search_term: 'SAP BTP Developer',
        location: 'European Union',
        results_wanted: 5,
        hours_old: 72,
        distance: 50,
        description_format: 'markdown',
        fetch_description: false,
        is_remote: false,
    };
}
function configWith(script: string) {
    process.env.JOB_RADAR_PYTHON = process.execPath;
    process.env.JOB_RADAR_COLLECTOR_SCRIPT = path.join(here, 'helpers', script);
    resetConfigCache();
    return loadConfig({ reload: true });
}
afterEach(() => {
    delete process.env.JOB_RADAR_PYTHON;
    delete process.env.JOB_RADAR_COLLECTOR_SCRIPT;
    resetConfigCache();
});
describe('malformed collector output', () => {
    it('kills an expired worker before returning, retaining records, request counts and progress', async () => {
        const output = await runCollector(configWith('fake-collector.mjs'), {
            tasks: [{ ...task('hang'), search_term: 'hang' }, task('postponed')],
            taskTimeoutSeconds: 1, delayBetweenTasksSeconds: 0, processTimeoutSeconds: 5,
        });
        expect(output.jobs).toHaveLength(1);
        expect(output.outcomes[0]).toMatchObject({ taskId: 'hang', errorKind: 'timeout', resultCount: 1,
            searchRequests: 2, detailRequests: 1, nextCursor: { offset: 10 } });
        expect(output.outcomes[1]).toMatchObject({ taskId: 'postponed', status: 'Skipped' });
        expect(() => process.kill(Number(output.jobs[0]!.job.id), 0)).toThrow();
    });
    it('keeps the valid records and counts the bad lines instead of throwing', async () => {
        const config = configWith('fake-collector.mjs');
        const output = await runCollector(config, {
            tasks: [task('t1')],
            taskTimeoutSeconds: 10,
            delayBetweenTasksSeconds: 0,
            processTimeoutSeconds: 30,
        });
        expect(output.jobspyVersion).toBe('test-double');
        expect(output.jobs).toHaveLength(1);
        expect(output.jobs[0]!.job.id).toBe('ok-1');
        expect(output.activities).toEqual([expect.objectContaining({ status: 'closed', reason: 'http_410', source_job_id: 'closed-1' })]);
        // not-JSON, schema violation and unknown discriminator - the blank line is ignored.
        expect(output.malformedLines).toBe(3);
        expect(output.outcomes).toHaveLength(1);
        expect(output.outcomes[0]!.status).toBe('Succeeded');
    });
    it('records tasks the collector never reported on as failed', async () => {
        const config = configWith('failing-collector.mjs');
        const output = await runCollector(config, {
            tasks: [task('a'), task('b'), task('c')],
            taskTimeoutSeconds: 10,
            delayBetweenTasksSeconds: 0,
            processTimeoutSeconds: 30,
        });
        expect(output.outcomes).toHaveLength(3);
        expect(output.outcomes.filter((outcome) => outcome.status === 'Failed')).toHaveLength(3);
        expect(output.outcomes.find((outcome) => outcome.taskId === 'a')!.errorKind).toBe('blocked');
        expect(output.outcomes.find((outcome) => outcome.taskId === 'b')!.errorKind).toBe('parse');
    });
    it('fails loudly when the interpreter does not exist', async () => {
        const config = loadConfig();
        await expect(runCollector({ ...config, pythonPath: '/nonexistent/python' }, {
            tasks: [task('x')],
            taskTimeoutSeconds: 5,
            delayBetweenTasksSeconds: 0,
            processTimeoutSeconds: 10,
        })).rejects.toThrow(/not found/i);
    });
});
describe('source failure isolation', () => {
    beforeAll(async () => {
        await useTempDb();
    });
    afterAll(closeTempDb);
    it('grows rate-limit cooldowns once per cycle, honours Retry-After and resets after recovery', async () => {
        const config = loadConfig();
        const now = new Date('2026-10-06T12:00:00Z');
        const outcome = { taskId: 'limited', source: 'rate-test', searchTerm: 'SAP', location: undefined,
            countryIndeed: undefined, status: 'Failed' as const, resultCount: 1, durationMs: 1,
            errorKind: 'rate_limit' as const };
        await recordOutcomes(config, [outcome, { ...outcome, taskId: 'paused', status: 'Skipped' }], now);
        expect(await query(SELECT.from(db().SourceHealth).where({ source: outcome.source })))
            .toEqual([expect.objectContaining({ rateLimitStreak: 1, cooldownUntil: '2026-10-06T14:00:00.000Z' })]);
        await recordOutcomes(config, [{ ...outcome, retryAfterSeconds: 36000 }], now);
        expect(await query(SELECT.from(db().SourceHealth).where({ source: outcome.source })))
            .toEqual([expect.objectContaining({ rateLimitStreak: 2, cooldownUntil: '2026-10-06T22:00:00.000Z' })]);
        await recordOutcomes(config, [{ ...outcome, status: 'Succeeded', errorKind: undefined }], now);
        await recordOutcomes(config, [outcome], now);
        expect(await query(SELECT.from(db().SourceHealth).where({ source: outcome.source })))
            .toEqual([expect.objectContaining({ rateLimitStreak: 1, cooldownUntil: '2026-10-06T14:00:00.000Z' })]);
    });
    it('puts a blocked source on cooldown and leaves the others usable', async () => {
        const config = loadConfig();
        const now = new Date('2026-10-06T12:00:00Z');
        await recordOutcomes(config, [
            {
                taskId: 'a',
                source: 'linkedin',
                searchTerm: 'x',
                location: 'EU',
                countryIndeed: undefined,
                status: 'Failed',
                resultCount: 0,
                durationMs: 1,
                errorKind: 'blocked',
                message: '403',
            },
            {
                taskId: 'b',
                source: 'indeed',
                searchTerm: 'x',
                location: 'Germany',
                countryIndeed: 'Germany',
                status: 'Succeeded',
                resultCount: 4,
                durationMs: 1,
            },
        ], now);
        const cooldowns = await activeCooldowns(now);
        expect(cooldowns.has('linkedin')).toBe(true);
        expect(cooldowns.has('indeed')).toBe(false);
        const plan = planBatch(config, { batchKey: 'btp-core', skipSources: cooldowns });
        expect(plan.tasksBySource.has('linkedin')).toBe(false);
        expect(plan.tasksBySource.has('indeed')).toBe(true);
        expect(plan.skipped.map((entry) => entry.source)).toContain('linkedin');

        const later = new Date('2026-10-08T12:00:00Z');
        expect((await activeCooldowns(later)).has('linkedin')).toBe(false);
    });
});
describe('batch planning', () => {
    it('rejects unknown source names before creating a zero-task plan', () => {
        expect(() => planBatch(loadConfig(), { onlySources: ['michaeil'] })).toThrow(/Unknown source.*michaeil/);
    });
    it('explains which batch to use when a configured source is absent from the active batch', () => {
        const plan = planBatch(loadConfig(), { batchKey: 'btp-core', onlySources: ['michaelpage'] });
        expect(plan.tasksBySource.size).toBe(0);
        expect(plan.skipped).toEqual([{ source: 'michaelpage', reason: 'not in batch "btp-core"; use --batch sap-public' }]);
    });
    it('plans SAP specialists without assumed geography and within the existing budgets', () => {
        const config = loadConfig();
        const plan = planBatch(config, { batchKey: 'sap-specialists' });
        expect([...plan.tasksBySource.keys()]).toEqual(['redglobal', 'eursap', 'whitehall']);
        const tasks = [...plan.tasksBySource.values()].flat();
        expect(tasks).toHaveLength(15);
        expect(tasks.every((entry) => entry.location === undefined && entry.country_indeed === undefined)).toBe(true);
        expect(tasks.filter((entry) => entry.fetch_description).length).toBeLessThanOrEqual(config.searches.description_budget.max_tasks_per_run);
        expect(tasks.length).toBeLessThanOrEqual(config.searches.resilience.max_tasks_per_run);
    });
    it.each(['redglobal', 'eursap', 'whitehall'])('collects %s independently with a description budget', (source) => {
        const plan = planBatch(loadConfig(), { batchKey: 'sap-specialists', onlySources: [source] });
        expect([...plan.tasksBySource.keys()]).toEqual([source]);
        expect(plan.tasksBySource.get(source)!.some((entry) => entry.fetch_description)).toBe(true);
    });
    it('never pre-filters on remote or contract, so incomplete listings survive', () => {
        const config = loadConfig();
        const tasks = [...planBatch(config, { batchKey: 'btp-core' }).tasksBySource.values()].flat();
        expect(tasks.every((entry) => entry.is_remote === false)).toBe(true);
        expect(tasks.every((entry) => entry.job_type === undefined)).toBe(true);
    });
    it('uses source-specific geography', () => {
        const config = loadConfig();
        const plan = planBatch(config, { batchKey: 'btp-core' });
        expect(plan.tasksBySource.get('linkedin')!.every((entry) => entry.country_indeed === undefined)).toBe(true);
        expect(plan.tasksBySource.get('indeed')!.every((entry) => typeof entry.country_indeed === 'string')).toBe(true);
    });
});
describe("priority-coverage", () => {
    function job(title: string, description: string | null = null): MatchableJob {
        return { ID: title, title, description, descriptionHash: null, company: null, location: null,
            locationCountry: null, isRemote: null, jobType: null, salaryMin: null, salaryMax: null,
            salaryInterval: null, salaryCurrency: null, primaryUrl: 'https://example.com/job', datePosted: null };
    }
    describe('priority search coverage within operational limits', () => {
        it('keeps complete non-LinkedIn batches and caps LinkedIn search tasks separately', () => {
            const config = loadConfig();
            const seen = new Set<string>();
            const count = config.searches.rotation.sequence?.length ?? config.searches.rotation.batches.length;
            expect(count * config.searches.rotation.interval_hours).toBeLessThan(config.searches.defaults.hours_old);
            for (let slot = 0; slot < count; slot += 1) {
                const at = new Date(slot * config.searches.rotation.interval_hours * 3600000);
                const index = selectBatchIndex(config, at);
                const batch = config.searches.rotation.batches[index]!;
                const plan = planBatch(config, { at });
                const expected = Object.entries(batch.targets).flatMap(([source, geos]) => geos.flatMap((geo) => batch.keywords.map((keyword) => `${source}:${geo}:${keyword}`)));
                const tasks = [...plan.tasksBySource.values()].flat();
                const linkedinCount = (batch.targets.linkedin?.length ?? 0) * batch.keywords.length;
                expect(tasks).toHaveLength(expected.length - linkedinCount + Math.min(2, linkedinCount));
                expect(tasks.length).toBeLessThanOrEqual(18);
                expect(tasks.filter((task) => task.fetch_description).length).toBeLessThanOrEqual(2);
                for (const [source, geos] of Object.entries(batch.targets)) {
                    if (source === 'linkedin') continue;
                    expect(plan.tasksBySource.get(source)).toHaveLength(geos.length * batch.keywords.length);
                    for (const keyword of batch.keywords)
                        expect(plan.tasksBySource.get(source)!.some((task) => task.search_term === keyword)).toBe(true);
                }
                seen.add(batch.key);
            }
            expect(seen.size).toBe(config.searches.rotation.batches.length);
        });
        it('revisits every broad priority group and public catalogue within 36 hours', () => {
            const config = loadConfig();
            const sequence = config.searches.rotation.sequence!;
            for (const key of ['cap-broad', 'ui5-broad', 'joule-broad', 'btp-ai-broad', 'sap-public']) {
                const positions = sequence.flatMap((item, index) => item === key ? [index] : []);
                expect(positions).toHaveLength(3);
                const wrapped = [...positions, positions[0]! + sequence.length];
                expect(Math.max(...positions.map((position, i) => (wrapped[i + 1]! - position) * config.searches.rotation.interval_hours))).toBe(36);
            }
        });
        it('covers broad technologies, roles and engagement variants on all six sources', () => {
            const config = loadConfig();
            const allSources = ['linkedin', 'indeed', 'glassdoor', 'redglobal', 'eursap', 'whitehall'];
            const required = ['SAP CAP', 'SAP CAPM', 'SAP Cloud Application Programming Model', 'SAPUI5', 'SAP UI5', 'SAP Fiori', 'Fiori Elements',
                'SAP Joule', 'Joule Studio', 'SAP Joule Developer', 'SAP Business AI', 'SAP AI Core', 'SAP Generative AI Hub', 'SAP BTP AI'];
            for (const source of allSources) {
                const terms = config.searches.rotation.batches.flatMap((batch) => {
                    let state: DescriptionRotation | undefined;
                    return Array.from({ length: 9 }, () => {
                        const plan = planBatch(config, { batchKey: batch.key, onlySources: [source], descriptionRotation: state });
                        state = plan.descriptionRotation;
                        return plan.tasksBySource.get(source)?.map((task) => task.search_term) ?? [];
                    }).flat();
                });
                expect(terms).toEqual(expect.arrayContaining(required));
                for (const prefix of ['cap-', 'ui5-', 'joule-', 'btp-ai-']) {
                    const queries = config.searches.rotation.batches.filter((batch) => batch.key.startsWith(prefix)).flatMap((batch) => batch.keywords);
                    for (const variant of ['Developer', 'Consultant', 'Architect', 'freelance', 'contract', 'B2B']) {
                        expect(queries.some((term) => term.includes(variant))).toBe(true);
                    }
                }
            }
            const firstFour = config.searches.rotation.batches.slice(0, 4).map((batch) => batch.key);
            expect(firstFour).toEqual(['cap-broad', 'ui5-broad', 'joule-broad', 'btp-ai-broad']);
            expect(config.settings.llm.max_jobs_per_run).toBe(5);
            expect(config.settings.telegram.max_per_run).toBe(3);
            expect(config.settings.telegram.min_fit_score).toBe(75);
        });
        it('covers public providers and their stored-listing refresh within two slots', () => {
            const config = loadConfig();
            const plan = planBatch(config, { batchKey: 'sap-public' });
            expect([...plan.tasksBySource.keys()]).toEqual(['michaelpage', 'nextventures', 'remotive', 'arbeitnow', 'remoteok', 'jobicy']);
            expect(plan.tasksBySource.get('michaelpage')!.map((task) => task.location)).toEqual(['Poland', 'Germany', 'Netherlands', 'United Kingdom', 'Switzerland', 'France', 'United Arab Emirates']);
            expect([...plan.tasksBySource.values()].flat()).toHaveLength(12);
            expect([...plan.tasksBySource.values()].flat().every((task) => task.search_term === 'SAP')).toBe(true);
            const descriptions = [...plan.tasksBySource.values()].flat().filter((task) => task.fetch_description);
            expect(descriptions.map((task) => task.source)).toEqual(['michaelpage', 'nextventures']);
            expect(plan.tasksBySource.get('michaelpage')!.every((task) => task.hours_old === 2160)).toBe(true);
            expect(planBatch(config, { batchKey: 'sap-public', hoursOld: 168 }).tasksBySource.get('michaelpage')!
                .every((task) => task.hours_old === 168)).toBe(true);
        });
        it('covers all three EMEA regions and uses supported UAE endpoints', () => {
            const config = loadConfig();
            const frontend = planBatch(config, { batchKey: 'emea-frontend' });
            expect([...frontend.tasksBySource.values()].flat()).toHaveLength(2);
            let state = frontend.descriptionRotation;
            const locations = frontend.tasksBySource.get('linkedin')!.map((task) => task.location);
            for (let cycle = 0; cycle < 8; cycle++) {
                const next = planBatch(config, { batchKey: 'emea-frontend', descriptionRotation: state });
                state = next.descriptionRotation;
                locations.push(...next.tasksBySource.get('linkedin')!.map((task) => task.location));
            }
            expect(locations)
                .toEqual(expect.arrayContaining(['EMEA', 'Europe', 'Middle East', 'Africa', 'United Arab Emirates', 'Dubai, United Arab Emirates']));
            const core = planBatch(config, { batchKey: 'emea-core' });
            expect(core.tasksBySource.get('indeed')!.map((task) => task.country_indeed))
                .toEqual(expect.arrayContaining(['United Arab Emirates', 'South Africa', 'Egypt']));
            const uae = planBatch(config, { batchKey: 'uae-frontend' });
            expect([...uae.tasksBySource.values()].flat()).toHaveLength(8);
            expect(uae.tasksBySource.get('indeed')!.every((task) => task.country_indeed === 'United Arab Emirates')).toBe(true);
            expect(planBatch(config, { batchKey: 'sap-public' }).tasksBySource.get('michaelpage')!
                .some((task) => task.location === 'United Arab Emirates' && task.search_term === 'SAP')).toBe(true);
            expect(config.searches.sources.glassdoor!.geos.ae).toBeUndefined();
        });
        it.each(['SAP Joule Developer', 'SAP Joule Architect', 'SAPUI5 Developer', 'SAP BTP AI Consultant'])('retains relevant SAP titles: %s', (title) => {
            const config = loadConfig();
            const vacancy = job(title);
            expect(prescreen(config, vacancy).passed).toBe(true);
            expect(assessWithRules(config, vacancy).technicalFit).toBeGreaterThanOrEqual(config.scoring.technical.relevant_title_floor);
        });
        it('requires SAP context for standalone Joule and generic AI roles', () => {
            const config = loadConfig();
            for (const title of ['Joule Developer', 'Generative AI Architect', 'RAG Developer']) {
                expect(prescreen(config, job(title)).passed).toBe(false);
                expect(priorityDirections(job(title))).toEqual([]);
            }
            expect(prescreen(config, job('Joule Studio Consultant', 'Work on SAP integrations.')).passed).toBe(true);
            expect(priorityDirections(job('Joule Studio Consultant', 'Work on SAP integrations.'))).toEqual(['Joule']);
        });
        it('counts processing stages independently, including multi-direction roles', () => {
            const config = loadConfig();
            const full = job('SAP CAP and Joule Developer', 'SAP CAP and Joule Studio, fully remote contract.');
            const assessment = { ...assessWithRules(config, full), engine: 'llm' as const };
            const counts = summarizeDirections(config, [
                { job: full, assessment, deliveryAvailable: true },
                { job: job('SAP CAPM Consultant'), deliveryAvailable: false },
                { job: job('Generic AI Developer'), deliveryAvailable: false },
            ]);
            expect(counts.map((count) => count.direction)).toEqual([...PRIORITY_DIRECTIONS]);
            expect(counts[0]).toMatchObject({ collected: 2, described: 1, prescreened: 2, llm: 1, notify: 1 });
            expect(counts[2]).toMatchObject({ collected: 1, described: 1, prescreened: 1, llm: 1, notify: 1 });
            expect(counts[3]!.collected).toBe(0);
        });
    });
});
describe("description-rotation", () => {
    const selected = (plan: ReturnType<typeof planBatch>) => [...plan.tasksBySource.values()].flat()
        .filter((task) => task.fetch_description);
    let dbPath: string;
    beforeAll(async () => { dbPath = await useTempDb(); });
    beforeEach(async () => {
        for (const entity of [db().DescriptionRotation, db().SearchProgress, db().SourceListings, db().Jobs])
            await cds.run(DELETE.from(entity));
    });
    afterAll(closeTempDb);
    describe('bounded persistent description rotation', () => {
        it('persists fair search combinations and bounded search progress across restart', async () => {
            const config = loadConfig(), at = new Date();
            const first = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['linkedin'], at });
            const tasks = first.tasksBySource.get('linkedin')!;
            expect(tasks).toHaveLength(2);
            expect(tasks.reduce((sum, task) => sum + (task.detail_request_limit ?? 0), 0)).toBe(5);
            await recordSearchProgress([{ taskId: tasks[0]!.task_id, source: 'linkedin', searchTerm: 'SAP',
                location: undefined, countryIndeed: undefined, status: 'Succeeded', resultCount: 25,
                durationMs: 1, nextCursor: { offset: 20 } }], at);
            await disconnectDb();
            await connectDb(dbPath);
            const resumed = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['linkedin'], at });
            expect(resumed.tasksBySource.get('linkedin')!.some((task) => !tasks.some((old) => old.task_id === task.task_id))).toBe(true);
            expect(resumed.tasksBySource.get('linkedin')!.find((task) => task.task_id === tasks[0]!.task_id)?.offset).toBe(20);
            const expired = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['linkedin'],
                at: new Date(at.getTime() + 217 * 3600000) });
            expect(expired.tasksBySource.get('linkedin')!.every((task) => task.offset === undefined)).toBe(true);
        });
        it('reserves stored descriptions without searches and keeps the two-task budget', async () => {
            const at = new Date();
            await ingestJobs([normalizeJob({ id: '7097972', title: 'SAP BTP Developer',
                    job_url: 'https://www.michaelpage.pl/job-detail/sap-btp/ref/jn-092026-7097972',
                    date_posted: '2026-09-07', description: null }, 'michaelpage')!], { runId: null, seenAt: at });
            const plan = await reserveBatchPlan(loadConfig(), { enrichOnly: true, onlySources: ['michaelpage'], resultsWanted: 5, at });
            const tasks = [...plan.tasksBySource.values()].flat();
            expect(plan.batchKey).toBe('description-backlog');
            expect(tasks).toHaveLength(1);
            expect(tasks[0]).toMatchObject({ enrich_only: true, fetch_description: true });
            expect(tasks[0]!.detail_jobs).toHaveLength(1);
            expect(tasks[0]!.hours_old).toBe(2160);
            const empty = await reserveBatchPlan(loadConfig(), { enrichOnly: true, onlySources: ['whitehall'], at });
            expect(empty.tasksBySource.size).toBe(0);
        });
        it('enriches stored listings independently of the active keyword and moves failed reservations to the queue tail', async () => {
            const at = new Date('2026-10-09T12:00:00Z');
            const config = loadConfig();
            for (let index = 0; index < 6; index += 1) {
                await ingestJobs([normalizeJob({ id: `pending-${index}`, title: 'SAP CAP Developer',
                        job_url: `https://eursap.eu/jobs/pending-${index}`, date_posted: '2026-10-09', description: null }, 'eursap')!], { runId: null, seenAt: at });
            }
            const first = await reserveBatchPlan(config, { batchKey: 'ui5-broad', onlySources: ['eursap'], resultsWanted: 5, at });
            const firstDetails = selected(first).flatMap((task) => task.detail_jobs ?? []);
            expect(firstDetails).toHaveLength(4);
            expect(firstDetails.every((record) => record.title === 'SAP CAP Developer')).toBe(true);
            expect([...first.tasksBySource.values()].flat().every((task) => /UI5/i.test(task.search_term))).toBe(true);
            const next = await reserveBatchPlan(config, { batchKey: 'joule-broad', onlySources: ['eursap'], resultsWanted: 5,
                at: new Date(at.getTime() + 3600000) });
            const nextDetails = selected(next).flatMap((task) => task.detail_jobs ?? []);
            expect(nextDetails.slice(0, 2).every((record) => !firstDetails.some((previous) => previous.id === record.id))).toBe(true);
            expect(selected(next)).toHaveLength(2);
            expect([...next.tasksBySource.values()].flat().length).toBeLessThanOrEqual(18);
            const cooling = await reserveBatchPlan(config, { batchKey: 'cap-broad', onlySources: ['eursap'],
                skipSources: new Map([['eursap', 'cooldown']]), at });
            expect(selected(cooling)).toEqual([]);
        });
        it('preserves keyword cursors from legacy per-batch rotation state', async () => {
            await cds.run(INSERT.into(db().DescriptionRotation).entries({ batchKey: 'sap-specialists',
                state: JSON.stringify({ lastSource: 'eursap', lastTaskBySource: { redglobal: 'sap-specialists:redglobal:all:btp' } }),
                updatedAt: new Date().toISOString() }));
            const resumed = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists', onlySources: ['redglobal'] });
            expect(selected(resumed).map((task) => task.search_term)).toEqual(['CAP', 'CPI']);
        });
        it('keeps Glassdoor description fetching in its existing JobSpy search session', async () => {
            await ingestJobs([normalizeJob({ id: 'glassdoor-pending', title: 'SAP CAP Developer',
                    job_url: 'https://www.glassdoor.nl/job-listing/j?jl=123', description: null }, 'glassdoor')!], { runId: null });
            const plan = await reserveBatchPlan(loadConfig(), { batchKey: 'cap-broad', onlySources: ['glassdoor'] });
            expect(selected(plan)).toHaveLength(2);
            expect(selected(plan).every((task) => task.detail_jobs === undefined)).toBe(true);
        });
        it('covers all three agencies and all five keywords in eight two-slot cycles', () => {
            const config = loadConfig();
            let state: DescriptionRotation | undefined;
            const seen = new Set<string>();
            for (let cycle = 0; cycle < 8; cycle += 1) {
                const plan = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: state });
                const descriptions = selected(plan);
                expect(descriptions).toHaveLength(2);
                descriptions.forEach((task) => seen.add(task.task_id));
                state = plan.descriptionRotation;
            }
            expect(seen.size).toBe(15);
        });
        it('skips disabled/cooling/restricted sources without consuming their keyword cursors', () => {
            const config = structuredClone(loadConfig());
            const first = planBatch(config, { batchKey: 'sap-specialists' });
            const restricted = planBatch(config, { batchKey: 'sap-specialists', onlySources: ['whitehall'], descriptionRotation: first.descriptionRotation });
            expect(selected(restricted).map((task) => task.search_term)).toEqual(['BTP', 'CAP']);
            expect(restricted.descriptionRotation.lastTaskBySource['sap-specialists:redglobal']).toBe(first.descriptionRotation.lastTaskBySource['sap-specialists:redglobal']);
            config.searches.sources.redglobal!.enabled = false;
            const blocked = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: restricted.descriptionRotation,
                skipSources: new Map([['eursap', 'cooldown']]) });
            expect(selected(blocked).every((task) => task.source === 'whitehall')).toBe(true);
            expect(selected(blocked).map((task) => task.search_term)).toEqual(['CPI', 'UI5']);
            config.searches.sources.redglobal!.enabled = true;
            const recovered = planBatch(config, { batchKey: 'sap-specialists', onlySources: ['redglobal'], descriptionRotation: blocked.descriptionRotation });
            expect(selected(recovered).map((task) => task.search_term)).toEqual(['CAP', 'CPI']);
        });
        it('preserves state when there are no available sources and never grants the same task twice', () => {
            const config = structuredClone(loadConfig());
            const first = planBatch(config, { batchKey: 'sap-specialists' });
            const none = planBatch(config, { batchKey: 'sap-specialists', descriptionRotation: first.descriptionRotation,
                skipSources: new Map(['redglobal', 'eursap', 'whitehall'].map((source) => [source, 'cooldown'])) });
            expect(selected(none)).toEqual([]);
            expect(none.descriptionRotation).toEqual(first.descriptionRotation);
            config.searches.rotation.batches.find((batch) => batch.key === 'sap-specialists')!.keywords = ['CAP'];
            const single = planBatch(config, { batchKey: 'sap-specialists', onlySources: ['whitehall'] });
            expect(selected(single)).toHaveLength(1);
        });
        it('resumes the persisted batch in a fresh process instead of selecting the first tasks again', async () => {
            const first = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
            await disconnectDb();
            try {
                const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.join(PROJECT_ROOT, 'test/helpers/rotation-worker.ts'), dbPath], { cwd: PROJECT_ROOT, env: { ...process.env, OPENAI_API_KEY: '', TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' } });
                const result = JSON.parse(stdout.split('\n').find((line) => line.startsWith('ROTATION '))!.slice(9));
                expect(result).toEqual(['redglobal:CAP', 'whitehall:BTP']);
                expect(selected(first).map((task) => `${task.source}:${task.search_term}`)).not.toEqual(result);
            }
            finally {
                await connectDb(dbPath);
            }
            const third = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
            expect(selected(third).map((task) => `${task.source}:${task.search_term}`)).toEqual(['eursap:CAP', 'whitehall:CAP']);
        });
        it('advances sources across different batches while preserving their keyword cursors', async () => {
            const first = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
            const other = await reserveBatchPlan(loadConfig(), { batchKey: 'cap-broad' });
            expect(selected(other).map((task) => task.source)).toEqual(['linkedin', 'whitehall']);
            const next = await reserveBatchPlan(loadConfig(), { batchKey: 'sap-specialists' });
            expect(next.descriptionRotation).not.toEqual(first.descriptionRotation);
            expect(selected(next).map((task) => `${task.source}:${task.search_term}`)).toEqual(['redglobal:CAP', 'eursap:CAP']);
        });
        it('gives every eligible description source a slot within three mixed priority cycles', async () => {
            const seen = new Set<string>();
            for (const batchKey of ['cap-broad', 'ui5-broad', 'joule-broad']) {
                const plan = await reserveBatchPlan(loadConfig(), { batchKey });
                expect(selected(plan)).toHaveLength(2);
                selected(plan).forEach((task) => seen.add(task.source));
            }
            expect([...seen].sort()).toEqual(['eursap', 'glassdoor', 'linkedin', 'redglobal', 'whitehall']);
        });
    });
});
describe("collection-lifecycle", () => {
    beforeAll(async () => { await useTempDb(); });
    beforeEach(async () => {
        for (const entity of [db().CollectionErrors, db().CollectionRuns])
            await cds.run(DELETE.from(entity));
    });
    afterAll(closeTempDb);
    describe('collection run recovery', () => {
        it('recovers stale heartbeats and old legacy runs while preserving live and recent runs', async () => {
            const now = new Date('2026-10-09T20:00:00Z');
            const records = [
                { ID: 'old-legacy', startedAt: '2026-10-09T10:00:00Z', heartbeatAt: null },
                { ID: 'recent-legacy', startedAt: '2026-10-09T19:00:00Z', heartbeatAt: null },
                { ID: 'stale', startedAt: '2026-10-09T10:00:00Z', heartbeatAt: '2026-10-09T19:54:00Z' },
                { ID: 'active', startedAt: '2026-10-09T10:00:00Z', heartbeatAt: '2026-10-09T19:59:30Z' },
            ];
            await cds.run(INSERT.into(db().CollectionRuns).entries(records.map((row) => ({ ...row, batchKey: 'btp-core', status: 'Running' }))));
            expect(await recoverInterruptedRuns(loadConfig(), now)).toBe(2);
            expect(await recoverInterruptedRuns(loadConfig(), now)).toBe(0);
            const runs = await query<any>(SELECT.from(db().CollectionRuns));
            expect(runs.filter((run) => run.status === 'Failed').map((run) => run.ID).sort()).toEqual(['old-legacy', 'stale']);
            expect(runs.filter((run) => run.status === 'Running').map((run) => run.ID).sort()).toEqual(['active', 'recent-legacy']);
            expect(await query(SELECT.from(db().CollectionErrors))).toHaveLength(2);
        });
        it('updates active heartbeats and stops its timer after completion', async () => {
            const id = randomUUID();
            await cds.run(INSERT.into(db().CollectionRuns).entries({ ID: id, status: 'Running',
                startedAt: '2026-10-09T10:00:00Z', heartbeatAt: '2026-10-09T10:00:00Z' }));
            vi.useFakeTimers();
            const stop = startRunHeartbeat(id);
            try {
                await vi.advanceTimersByTimeAsync(30000);
                await stop();
                const [row] = await query<any>(SELECT.from(db().CollectionRuns).where({ ID: id }));
                expect(row.heartbeatAt).not.toBe('2026-10-09T10:00:00Z');
                const timestamp = row.heartbeatAt;
                await vi.advanceTimersByTimeAsync(60000);
                const [unchanged] = await query<any>(SELECT.from(db().CollectionRuns).where({ ID: id }));
                expect(unchanged.heartbeatAt).toBe(timestamp);
            }
            finally {
                await stop();
                vi.useRealTimers();
            }
        });
    });
});
describe('hard collection ceilings and public activity rotation', () => {
    it('retains 18 search tasks and two description tasks even with higher configured limits', () => {
        const config = structuredClone(loadConfig());
        config.searches.resilience.max_tasks_per_run = 99;
        config.searches.description_budget.max_tasks_per_run = 99;
        const tasks = [...planBatch(config, { batchKey: 'cap-broad' }).tasksBySource.values()].flat();
        expect(tasks.length).toBeLessThanOrEqual(18);
        expect(tasks.filter((task) => task.fetch_description)).toHaveLength(2);
    });
    it('gives every public provider a bounded refresh slot across rotation', () => {
        const config = loadConfig(), seen = new Set<string>();
        let state: DescriptionRotation | undefined;
        for (let cycle = 0; cycle < 6; cycle++) {
            const plan = planBatch(config, { batchKey: 'sap-public', descriptionRotation: state });
            const selected = [...plan.tasksBySource.values()].flat().filter((task) => task.fetch_description);
            expect(selected.length).toBeLessThanOrEqual(2);
            selected.forEach((task) => seen.add(task.source));
            state = plan.descriptionRotation;
        }
        expect([...seen].sort()).toEqual(['arbeitnow', 'jobicy', 'michaelpage', 'nextventures', 'remoteok', 'remotive']);
    });
});
