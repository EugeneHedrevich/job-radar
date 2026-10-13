import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { activeCooldowns, recordOutcomes } from '../collector/health.js';
import { planBatch, type PlanOptions } from '../collector/plan.js';
import { recordSearchProgress, reserveBatchPlan } from '../collector/rotation.js';
import { runCollector } from '../collector/run.js';
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

export interface CollectOptions extends PlanOptions {
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
  const config = loadConfig();
  const startedAt = new Date();
  const runId = randomUUID();
  await recoverInterruptedRuns(config, startedAt);

  const cooldowns = await activeCooldowns(startedAt);
  const skipSources = new Map([...cooldowns, ...(options.skipSources ?? new Map())]);
  const plan = options.fixture
    ? planBatch(config, { ...options, skipSources })
    : await reserveBatchPlan(config, { ...options, skipSources });

  await cds.run(
    INSERT.into(db().CollectionRuns).entries({
      ID: runId,
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
    tasksTotal: [...plan.tasksBySource.values()].flat().length });
  const stopHeartbeat = startRunHeartbeat(runId);
  try {
    for (const skipped of plan.skipped) {
      log.warn(`Skipping source "${skipped.source}": ${skipped.reason}`);
    }

    const collected: Array<{ taskId: string; source: string; job: CollectorJob }> = [];
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
      for (const [source, tasks] of plan.tasksBySource) {
        const sourceConfig = config.searches.sources[source];
        if (!sourceConfig) continue;
        try {
          const output = await runCollector(config, {
            tasks,
            taskTimeoutSeconds: sourceConfig.task_timeout_seconds,
            delayBetweenTasksSeconds: sourceConfig.delay_between_tasks_seconds,
            processTimeoutSeconds: config.searches.resilience.process_timeout_seconds,
            onProgress: progress,
          });
          malformedLines += output.malformedLines;
          collected.push(...output.jobs);
          activities.push(...output.activities);
          for (const outcome of output.outcomes) outcomeByTask.set(outcome.taskId, outcome);
          await recordSearchProgress(output.outcomes);

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
            const retried = await retryTasks(config, source, retryTasksPlan, retryable, collected, activities, progress);
            await recordSearchProgress(retried);
            for (const outcome of retried) outcomeByTask.set(outcome.taskId, outcome);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error(`Collector failed for source "${source}"`, { message });
          for (const task of tasks) {
            outcomeByTask.set(task.task_id, {
              taskId: task.task_id,
              source,
              searchTerm: task.search_term,
              location: task.location,
              countryIndeed: task.country_indeed,
              status: 'Failed',
              resultCount: 0,
              durationMs: 0,
              errorKind: 'error',
              message,
            });
          }
        }
      }
    }

    const outcomes = [...outcomeByTask.values()];
    await updateOperation(claim, { stage: 'Saving', jobsFound: collected.length, tasksDone: outcomes.length,
      tasksSucceeded: outcomes.filter((row) => row.status === 'Succeeded').length,
      tasksFailed: outcomes.filter((row) => row.status === 'Failed').length,
      tasksSkipped: outcomes.filter((row) => row.status === 'Skipped').length });

    const normalized: NormalizedJob[] = [];
    let unusable = 0;
    for (const record of collected) {
      const job = normalizeJob(record.job, record.source);
      if (job) normalized.push(job);
      else unusable += 1;
    }

    const ingest = await ingestJobs(normalized, { runId, seenAt: new Date(), demo: Boolean(options.fixture) });
    ingest.unusable = unusable;
    await applyListingActivity(activities);

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
          message: outcome.message?.slice(0, 1900) ?? null,
        }),
      );
      if (outcome.status === 'Failed') {
        await recordError(runId, outcome.source, outcome.errorKind ?? 'error', outcome.message ?? '', new Date());
      }
    }
    await recordOutcomes(config, outcomes);

    const outcome = collectionOutcome(outcomes, collected.length, Boolean(options.fixture));
    await cds.run(
      UPDATE(db().CollectionRuns)
        .set({
          finishedAt: new Date().toISOString(),
          status: outcome,
          jobsFound: collected.length,
          jobsNew: ingest.created,
          jobsUpdated: ingest.updated + ingest.mergedAcrossSources,
        })
        .where({ ID: runId }),
    );
    await updateOperation(claim, { jobsNew: ingest.created, jobsUpdated: ingest.updated + ingest.mergedAcrossSources });

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
