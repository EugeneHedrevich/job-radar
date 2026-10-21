import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { activeCooldowns, claimSourceRequests, recordOutcomes, settleSourceRequests } from '../collector/health.js';
import { planBatch, type PlanOptions } from '../collector/plan.js';
import { recordQueryRotation, recordSearchProgress, reserveBatchPlan } from '../collector/rotation.js';
import { CollectorStartupError, runCollector } from '../collector/run.js';
import type { CollectorJob, CollectorTask, ListingActivity, TaskOutcome } from '../collector/types.js';
import { cds, db, INSERT, UPDATE } from '../db/index.js';
import { normalizeJob, type NormalizedJob } from '../normalize/index.js';
import { ingestJobs, type IngestResult } from '../persist/ingest.js';
import { applyListingActivity } from '../persist/activity.js';
import { log } from '../util/log.js';
import { recoverInterruptedRuns, startRunHeartbeat } from '../collector/lifecycle.js';
import { claimCollection, CollectionBusyError, finishOperation, startLeaseHeartbeat, updateOperation,
  type CollectionClaim } from '../collector/lease.js';
import type { CollectionOperation } from '../dashboard/types.js';
import { codeRevision, commitWeeklyProgress, publicationRange, reviewConfiguration, weeklyTasks, type WeeklyState } from './weekly.js';
import { vacancyRelevance } from '../matching/relevance.js';
import { analysisCacheStats } from '../matching/analysis.js';

export interface CollectOptions extends PlanOptions {
  weekly?: WeeklyState;
  trigger?: 'manual' | 'scheduled';
  /** Use a fixture file instead of calling the live sources. */
  fixture?: Array<{ taskId: string; source: string; job: CollectorJob }>;
  /** Internal ownership when collection and assessment share one operation. */
  claim?: CollectionClaim;
}

export interface CollectSummary {
  runId: string;
  batchKey: string;
  jobsFound: number;
  ingest: IngestResult;
  outcomes: TaskOutcome[];
  skipped: Array<{ source: string; reason: string }>;
  malformedLines: number;
  outcome: CollectionOperation['outcome'];
}

export async function collect(options: CollectOptions = {}): Promise<CollectSummary> {
  let claim = options.claim;
  if (!claim) {
    const reservation = await claimCollection(options.trigger ?? 'manual');
    if (!reservation.acquired) throw new CollectionBusyError(reservation.operationId);
    claim = reservation.claim;
  }
  const stop = options.claim ? async () => {} : startLeaseHeartbeat(claim);
  try {
    const summary = await collectOwned(options, claim);
    if (!options.claim) await finishOperation(claim, { stage: summary.outcome === 'Failed' ? 'Error' : 'Finished',
      outcome: summary.outcome, message: outcomeMessage(summary.outcome) });
    return summary;
  } catch (error) {
    if (!options.claim) await finishOperation(claim, { stage: 'Error', outcome: 'Failed',
      message: String(error).slice(0, 1900) }).catch(() => undefined);
    throw error;
  } finally { await stop(); }
}

export function collectionOutcome(outcomes: TaskOutcome[], jobsFound: number, fixture = false): CollectionOperation['outcome'] {
  if (fixture) return jobsFound ? 'Completed' : 'Empty';
  const succeeded = outcomes.filter((row) => row.status === 'Succeeded').length;
  const failed = outcomes.filter((row) => row.status === 'Failed').length;
  if (!succeeded && !failed) return 'NoSources';
  if (failed) return succeeded || jobsFound > 0 ? 'Partial' : 'Failed';
  return jobsFound > 0 ? 'Completed' : 'Empty';
}

export function outcomeMessage(outcome: CollectionOperation['outcome']): string {
  return { Running: 'Collection is running.', Completed: 'Collection finished.',
    Empty: 'Searches succeeded and returned no vacancies.', Partial: 'Some source tasks failed; available results were saved.',
    Failed: 'Every executed source task failed.', NoSources: 'No sources available: disabled, on cooldown or skipped.' }[outcome];
}

async function collectOwned(options: CollectOptions, claim: CollectionClaim): Promise<CollectSummary> {
  const clock = performance.now();
  const config = loadConfig();
  const startedAt = new Date();
  const runId = randomUUID();
  await recoverInterruptedRuns(config, startedAt);

  const cooldowns = await activeCooldowns(startedAt, options.enrichOnly);
  const skipSources = new Map([...cooldowns, ...(options.skipSources ?? new Map())]);
  const preparationTimings: Record<string, number> = {};
  const analysisBefore = { ...analysisCacheStats };
  options = { ...options, preparationTimings };
  if (options.weekly) options = { ...options, searchTasks: weeklyTasks(config, options.weekly, skipSources, startedAt) };
  const plan = options.fixture
    ? planBatch(config, { ...options, skipSources })
    : await reserveBatchPlan(config, { ...options, skipSources });

  await cds.run(
    INSERT.into(db().CollectionRuns).entries({
      ID: runId,
      operationId: claim.operationId,
      startedAt: startedAt.toISOString(),
      heartbeatAt: startedAt.toISOString(),
      trigger: options.trigger ?? 'manual',
      batchKey: plan.batchKey,
      status: 'Running',
      jobsFound: 0,
      jobsNew: 0,
      jobsUpdated: 0,
    }),
  );
  await updateOperation(claim, { stage: 'Collecting', run_ID: runId,
    tasksTotal: options.fixture ? 0 : [...plan.tasksBySource.values()].flat().length });
  const stopHeartbeat = startRunHeartbeat(runId);
  const diagnostic: Record<string, any> = { revision: codeRevision(), configuration: reviewConfiguration(config),
    requestedInterval: options.weekly ? { start: options.weekly.start, end: options.weekly.end } : null,
    plannedTasks: [...plan.tasksBySource.values()].flat(), skipped: plan.skipped, attempts: [],
    memoryStart: process.memoryUsage(), sourceDurationsMs: {}, stagesMs: { preparing: Math.round(performance.now() - clock) },
    preparation: { timingsMs: preparationTimings, analysisCacheHits: analysisCacheStats.hits - analysisBefore.hits,
      analyses: analysisCacheStats.misses - analysisBefore.misses }, committed: false };
  const collected: Array<{ taskId: string; source: string; job: CollectorJob }> = [];
  const searchProgress: TaskOutcome[] = [];
  diagnostic.attempts = searchProgress;
  try {
    for (const skipped of plan.skipped) {
      log.warn(`Skipping source "${skipped.source}": ${skipped.reason}`);
    }

    const activities: ListingActivity[] = [];
    // Keyed by task id so a successful retry replaces the earlier failure.
    const outcomeByTask = new Map<string, TaskOutcome>();
    let malformedLines = 0;
    let retrySearchSlots = Math.max(0, Math.min(18, config.searches.resilience.max_tasks_per_run) -
      [...plan.tasksBySource.values()].flat().filter((task) => !task.enrich_only).length);
    let retryDescriptionSlots = Math.max(0, Math.min(2, config.searches.description_budget.max_tasks_per_run) -
      [...plan.tasksBySource.values()].flat().filter((task) => task.fetch_description).length);
    const progress = async (current: { jobsFound: number; outcomes: TaskOutcome[] }) => {
      const merged = new Map(outcomeByTask);
      for (const row of current.outcomes) merged.set(row.taskId, row);
      const rows = [...merged.values()];
      await updateOperation(claim, { jobsFound: collected.length + current.jobsFound,
        tasksDone: rows.length, tasksSucceeded: rows.filter((row) => row.status === 'Succeeded').length,
        tasksFailed: rows.filter((row) => row.status === 'Failed').length,
        tasksSkipped: rows.filter((row) => row.status === 'Skipped').length });
    };

    if (options.fixture) {
      collected.push(...options.fixture);
      log.info('Using offline fixture data instead of live sources', { records: options.fixture.length });
    } else {
      // One subprocess per source keeps failures isolated: a blocked or hanging
      // board cannot take the other boards down with it.
      for (const [source, plannedTasks] of plan.tasksBySource) {
        await updateOperation(claim, { currentSource: source });
        let tasks = plannedTasks;
        const cooling = (await activeCooldowns(new Date(), options.enrichOnly)).get(source);
        if (cooling) {
          for (const task of tasks) outcomeByTask.set(task.task_id, { taskId: task.task_id, source,
            searchTerm: task.search_term, location: task.location, countryIndeed: task.country_indeed,
            status: 'Skipped', resultCount: 0, durationMs: 0, message: cooling });
          continue;
        }
        const sourceConfig = config.searches.sources[source];
        if (!sourceConfig) continue;
        const requestClaim = await claimSourceRequests(source,
          source === 'linkedin' ? tasks.reduce((sum, task) => sum + (task.enrich_only ? 0 : task.search_request_limit ?? 3), 0) : 0,
          source === 'linkedin' ? tasks.reduce((sum, task) => sum + (task.fetch_description ? task.detail_request_limit ?? 0 : 0), 0) : 0,
          (config.searches.resilience.process_timeout_seconds * (source !== 'linkedin' && config.searches.resilience.max_retries_per_task > 0 ? 2 : 1) +
            config.searches.resilience.retry_delay_seconds + 60) * 1000);
        let sourceOutcomes: TaskOutcome[] | undefined;
        if (!requestClaim.token) {
          for (const task of tasks) outcomeByTask.set(task.task_id, { taskId: task.task_id, source,
            searchTerm: task.search_term, location: task.location, countryIndeed: task.country_indeed,
            status: 'Skipped', resultCount: 0, durationMs: 0, message: requestClaim.reason });
          continue;
        }
        if (source === 'linkedin') {
          let searches = requestClaim.searchLimit, details = requestClaim.detailLimit;
          const ready: CollectorTask[] = [];
          for (const [index, task] of tasks.entries()) {
            const searchLimit = task.enrich_only ? 0 : Math.min(task.search_request_limit ?? 3, Math.ceil(searches / (tasks.length - index)));
            const detailLimit = task.fetch_description ? Math.min(task.detail_request_limit ?? 0, details) : 0;
            if (task.enrich_only ? !detailLimit : !searchLimit) {
              outcomeByTask.set(task.task_id, { taskId: task.task_id, source, searchTerm: task.search_term,
                location: task.location, countryIndeed: task.country_indeed, status: 'Skipped', resultCount: 0, durationMs: 0,
                message: requestClaim.reason ?? (requestClaim.recovery ? 'LinkedIn recovery probe is limited to one task' : 'LinkedIn shared request allowance exhausted') });
              continue;
            }
            ready.push({ ...task, search_request_limit: searchLimit, detail_request_limit: detailLimit,
              fetch_description: Boolean(detailLimit), detail_jobs: detailLimit ? task.detail_jobs : undefined,
              // Recovery always checks the head. Ordinary one-request visits
              // use the persisted head observation, regardless of the planned limit.
              ...(requestClaim.recovery ? { head_only: true } : {}) });
            searches -= searchLimit; details -= detailLimit;
            if (requestClaim.recovery) { searches = 0; details = 0; }
          }
          tasks = ready;
        }
        const sourceStarted = performance.now();
        try {
          if (!tasks.length) continue;
          const output = await runCollector(config, {
            tasks,
            taskTimeoutSeconds: sourceConfig.task_timeout_seconds,
            delayBetweenTasksSeconds: sourceConfig.delay_between_tasks_seconds,
            processTimeoutSeconds: config.searches.resilience.process_timeout_seconds,
            onProgress: progress,
          });
          malformedLines += output.malformedLines;
          sourceOutcomes = output.outcomes;
          (diagnostic.quarantinedCandidates ??= []).push(...(output.rejectedCandidates ?? []));
          collected.push(...output.jobs);
          activities.push(...output.activities);
          for (const outcome of output.outcomes) outcomeByTask.set(outcome.taskId, outcome);
          searchProgress.push(...output.outcomes);

          const retryable = output.outcomes.filter((outcome) => outcome.status === 'Failed' && isRetryable(outcome));
          if (source !== 'linkedin' && !output.outcomes.some((outcome) => ['rate_limit', 'blocked'].includes(outcome.errorKind ?? '')) &&
            retryable.length && config.searches.resilience.max_retries_per_task > 0) {
            const retryTasksPlan: CollectorTask[] = [];
            for (const task of tasks) {
              if (!retryable.some((outcome) => outcome.taskId === task.task_id)) continue;
              if (task.enrich_only ? retryDescriptionSlots <= 0 : retrySearchSlots <= 0) continue;
              if (!task.enrich_only) retrySearchSlots -= 1;
              const fetchDescription = task.fetch_description && retryDescriptionSlots > 0;
              if (fetchDescription) retryDescriptionSlots -= 1;
              const last = outcomeByTask.get(task.task_id)?.nextCursor;
              retryTasksPlan.push({ ...task, fetch_description: fetchDescription,
                detail_jobs: fetchDescription ? task.detail_jobs : undefined,
                ...(last?.offset !== undefined ? { offset: last.offset } : last ? { search_cursor: last } : {}) });
            }
            const retried = await retryTasks(config, source, retryTasksPlan, retryable, collected, activities, progress,
              diagnostic.quarantinedCandidates ??= []);
            searchProgress.push(...retried);
            for (const outcome of retried) outcomeByTask.set(outcome.taskId, outcome);
          }
          await recordOutcomes(config, tasks.map((task) => outcomeByTask.get(task.task_id)!), new Date(), startedAt);
        } catch (error) {
          // A startup error from a retry cannot prove the earlier worker used zero requests.
          const localStartup = error instanceof CollectorStartupError && sourceOutcomes === undefined;
          const message = `${localStartup ? 'Local collector startup failed: ' : ''}${error instanceof Error ? error.message : String(error)}`;
          log.error(`Collector failed for source "${source}"`, { message });
          for (const task of tasks) {
            outcomeByTask.set(task.task_id, {
              taskId: task.task_id,
              source,
              searchTerm: task.search_term,
              location: task.location,
              countryIndeed: task.country_indeed,
              status: 'Failed',
              executed: sourceOutcomes?.some((row) => row.taskId === task.task_id && row.status !== 'Skipped' && row.executed !== false) ?? false,
              resultCount: 0,
              durationMs: 0,
              errorKind: localStartup ? 'local_startup' : 'error',
              ...(localStartup ? { searchRequests: 0, detailRequests: 0 } : {}),
              message,
            });
          }
          sourceOutcomes = tasks.map((task) => outcomeByTask.get(task.task_id)!);
          searchProgress.push(...sourceOutcomes);
          await recordOutcomes(config, sourceOutcomes, new Date(), startedAt);
        } finally {
          diagnostic.sourceDurationsMs[source] = Math.round(performance.now() - sourceStarted);
          if (requestClaim?.token) await settleSourceRequests(source, requestClaim.token,
            sourceOutcomes && sourceOutcomes.every((row) => row.searchRequests !== undefined)
              ? sourceOutcomes.reduce((sum, row) => sum + row.searchRequests!, 0) : undefined,
            sourceOutcomes && sourceOutcomes.every((row) => row.detailRequests !== undefined)
              ? sourceOutcomes.reduce((sum, row) => sum + row.detailRequests!, 0) : undefined);
        }
      }
    }

    const outcomes = [...outcomeByTask.values()];
    diagnostic.stagesMs.collecting = Math.round(performance.now() - clock) - diagnostic.stagesMs.preparing;
    const normalizeStarted = performance.now();
    await updateOperation(claim, { stage: 'Saving', currentSource: null, jobsFound: collected.length, tasksDone: outcomes.length,
      tasksSucceeded: outcomes.filter((row) => row.status === 'Succeeded').length,
      tasksFailed: outcomes.filter((row) => row.status === 'Failed').length,
      tasksSkipped: outcomes.filter((row) => row.status === 'Skipped').length });

    const normalized: NormalizedJob[] = [];
    let unusable = 0;
    let outsideInterval = 0;
    const candidates = [];
    for (const record of collected) {
      const job = normalizeJob(record.job, record.source);
      const range = options.weekly ? publicationRange(record.job.date_posted, options.weekly) : null;
      candidates.push({ ...record, publicationRange: range, normalized: job,
        relevance: job ? vacancyRelevance(config, job) : null,
        exclusion: !job ? 'Normalization failed: missing valid title or URL' : range === 'outside' ? 'Outside requested interval' : null });
      if (job && range !== 'outside') normalized.push(job);
      else if (job) outsideInterval += 1;
      else unusable += 1;
    }
    diagnostic.candidates = candidates;
    diagnostic.attempts = searchProgress;
    diagnostic.outcomes = outcomes;
    diagnostic.activities = activities;
    diagnostic.malformedLines = malformedLines;
    diagnostic.stagesMs.normalizing = Math.round(performance.now() - normalizeStarted);
    diagnostic.counts = { received: collected.length, normalized: collected.length - unusable, withinInterval: normalized.length, unusable, outsideInterval,
      unknownDates: candidates.filter((c) => c.publicationRange === 'unknown').length,
      boundaryDates: candidates.filter((c) => c.publicationRange === 'boundary-day').length,
      described: normalized.filter((job) => Boolean(job.description?.trim())).length };
    // Keep filtered observations even when saving later fails. No cursor moves here.
    await cds.run(UPDATE(db().CollectionRuns).set({ diagnostics: JSON.stringify(diagnostic) }).where({ ID: runId }));
    const savingStarted = performance.now();

    // All network work is complete. Results, activity and their continuation
    // commit together; a failed import rolls back cursors for idempotent replay.
    const ingest = await cds.tx(async (tx: any) => {
      await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
      const saved = await ingestJobs(normalized, { runId, seenAt: new Date(), demo: Boolean(options.fixture), automatic: true, connection: tx });
      await applyListingActivity(activities, tx);
      if (options.weekly) await commitWeeklyProgress(claim.operationId, options.weekly, outcomes, tx,
        new Map([...skipSources, ...Object.entries(config.searches.sources)
          .filter(([, settings]) => !settings.enabled).map(([source]) => [source, 'Source is currently disabled'] as const)]), saved.jobIds);
      else {
        await recordSearchProgress(searchProgress, new Date(), tx);
        await recordQueryRotation(plan, outcomes, tx);
      }
      await tx.run(UPDATE(db().CollectionRuns).set({ diagnostics: JSON.stringify({ ...diagnostic, ingest: saved, committed: true }) }).where({ ID: runId }));
      return saved;
    });
    diagnostic.ingest = ingest;
    diagnostic.committed = true;
    diagnostic.stagesMs.saving = Math.round(performance.now() - savingStarted);
    ingest.unusable = unusable;

    for (const outcome of outcomes) {
      await cds.run(
        INSERT.into(db().CollectionTasks).entries({
          ID: randomUUID(),
          run_ID: runId,
          taskKey: outcome.taskId,
          source: outcome.source,
          searchTerm: outcome.searchTerm,
          location: outcome.location ?? null,
          countryIndeed: outcome.countryIndeed ?? null,
          status: outcome.status,
          resultCount: outcome.resultCount,
          durationMs: outcome.durationMs,
          searchRequests: outcome.searchRequests ?? null,
          detailRequests: outcome.detailRequests ?? null,
          coverage: outcome.coverage ?? (outcome.status === 'Failed' ? 'incomplete' : 'unknown'),
          coverageReason: outcome.coverageReason?.slice(0, 490) ?? null,
          message: outcome.message?.slice(0, 1900) ?? null,
        }),
      );
      if (outcome.status === 'Failed') {
        await recordError(runId, outcome.source, outcome.errorKind ?? 'error', outcome.message ?? '', new Date());
      }
    }

    const outcome = collectionOutcome(outcomes, collected.length, Boolean(options.fixture));
    await cds.run(
      UPDATE(db().CollectionRuns)
        .set({
          finishedAt: new Date().toISOString(),
          status: outcome,
          jobsFound: collected.length,
          jobsNew: ingest.created,
          jobsUpdated: ingest.updatedJobIds.length,
          jobsAccepted: ingest.accepted,
          jobsFiltered: ingest.filtered,
          exclusionReasons: JSON.stringify(ingest.exclusionReasons),
          diagnostics: JSON.stringify({ ...diagnostic, totalMs: Math.round(performance.now() - clock), memoryEnd: process.memoryUsage() }),
        })
        .where({ ID: runId }),
    );
    await updateOperation(claim, { jobsNew: ingest.created, jobsUpdated: ingest.updatedJobIds.length,
      jobsAccepted: ingest.accepted, jobsFiltered: ingest.filtered, exclusionReasons: ingest.exclusionReasons });

    return {
      runId,
      batchKey: plan.batchKey,
      jobsFound: collected.length,
      ingest,
      outcomes,
      skipped: plan.skipped,
      malformedLines,
      outcome,
    };
  } catch (error) {
    await cds.run(UPDATE(db().CollectionRuns).set({ diagnostics: JSON.stringify({ ...diagnostic,
      candidates: diagnostic.candidates ?? collected, error: String(error),
      totalMs: Math.round(performance.now() - clock), memoryEnd: process.memoryUsage() }) }).where({ ID: runId }));
    await cds.run(UPDATE(db().CollectionRuns).set({ status: 'Failed', finishedAt: new Date().toISOString() }).where({ ID: runId }));
    await recordError(runId, '', 'error', error instanceof Error ? error.message : String(error), new Date());
    throw error;
  } finally {
    await stopHeartbeat();
  }
}

function isRetryable(outcome: TaskOutcome): boolean {
  // Blocking and rate limiting are not retried: retrying is exactly what makes
  // them worse. Those sources go on cooldown instead.
  return outcome.errorKind === 'timeout' || outcome.errorKind === 'network' || outcome.errorKind === 'error';
}

async function retryTasks(
  config: ReturnType<typeof loadConfig>,
  source: string,
  allTasks: CollectorTask[],
  failed: TaskOutcome[],
  collected: Array<{ taskId: string; source: string; job: CollectorJob }>,
  activities: ListingActivity[],
  onProgress: (progress: { jobsFound: number; outcomes: TaskOutcome[] }) => Promise<void>,
  quarantined: NonNullable<import('../collector/types.js').CollectorOutput['rejectedCandidates']>,
): Promise<TaskOutcome[]> {
  const sourceConfig = config.searches.sources[source]!;
  const retryTaskIds = new Set(failed.map((outcome) => outcome.taskId));
  const tasks = allTasks.filter((task) => retryTaskIds.has(task.task_id));
  if (!tasks.length) return [];

  const delay = config.searches.resilience.retry_delay_seconds * 1000;
  log.info(`Retrying ${tasks.length} failed task(s) on "${source}" after ${delay}ms`);
  await sleep(delay);

  const output = await runCollector(config, {
    tasks,
    taskTimeoutSeconds: sourceConfig.task_timeout_seconds,
    delayBetweenTasksSeconds: sourceConfig.delay_between_tasks_seconds,
    processTimeoutSeconds: config.searches.resilience.process_timeout_seconds,
    onProgress,
  });
  collected.push(...output.jobs);
  activities.push(...output.activities);
  quarantined.push(...(output.rejectedCandidates ?? []));
  return output.outcomes;
}

async function recordError(
  runId: string,
  source: string,
  kind: string,
  message: string,
  at: Date,
): Promise<void> {
  await cds.run(
    INSERT.into(db().CollectionErrors).entries({
      ID: randomUUID(),
      run_ID: runId,
      source,
      kind,
      message: message.slice(0, 1900),
      occurredAt: at.toISOString(),
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
