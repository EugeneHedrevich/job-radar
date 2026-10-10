import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { activeCooldowns, recordOutcomes } from '../collector/health.js';
import { planBatch, type PlanOptions } from '../collector/plan.js';
import { reserveBatchPlan } from '../collector/rotation.js';
import { runCollector } from '../collector/run.js';
import type { CollectorJob, CollectorTask, TaskOutcome } from '../collector/types.js';
import { cds, db, INSERT, UPDATE } from '../db/index.js';
import { normalizeJob, type NormalizedJob } from '../normalize/index.js';
import { ingestJobs, type IngestResult } from '../persist/ingest.js';
import { log } from '../util/log.js';
import { recoverInterruptedRuns, startRunHeartbeat } from '../collector/lifecycle.js';

export interface CollectOptions extends PlanOptions {
  trigger?: 'manual' | 'scheduled';
  /** Use a fixture file instead of calling the live sources. */
  fixture?: Array<{ taskId: string; source: string; job: CollectorJob }>;
}

export interface CollectSummary {
  runId: string;
  batchKey: string;
  jobsFound: number;
  ingest: IngestResult;
  outcomes: TaskOutcome[];
  skipped: Array<{ source: string; reason: string }>;
  malformedLines: number;
}

export async function collect(options: CollectOptions = {}): Promise<CollectSummary> {
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
  const stopHeartbeat = startRunHeartbeat(runId);
  try {
    for (const skipped of plan.skipped) {
      log.warn(`Skipping source "${skipped.source}": ${skipped.reason}`);
    }

    const collected: Array<{ taskId: string; source: string; job: CollectorJob }> = [];
    // Keyed by task id so a successful retry replaces the earlier failure.
    const outcomeByTask = new Map<string, TaskOutcome>();
    let malformedLines = 0;

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
          });
          malformedLines += output.malformedLines;
          collected.push(...output.jobs);
          for (const outcome of output.outcomes) outcomeByTask.set(outcome.taskId, outcome);

          const retryable = output.outcomes.filter((outcome) => outcome.status === 'Failed' && isRetryable(outcome));
          if (retryable.length && config.searches.resilience.max_retries_per_task > 0) {
            const retried = await retryTasks(config, source, tasks, retryable, collected);
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

    const normalized: NormalizedJob[] = [];
    let unusable = 0;
    for (const record of collected) {
      const job = normalizeJob(record.job, record.source);
      if (job) normalized.push(job);
      else unusable += 1;
    }

    const ingest = await ingestJobs(normalized, { runId, seenAt: new Date(), demo: Boolean(options.fixture) });
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
          message: outcome.message?.slice(0, 1900) ?? null,
        }),
      );
      if (outcome.status === 'Failed') {
        await recordError(runId, outcome.source, outcome.errorKind ?? 'error', outcome.message ?? '', new Date());
      }
    }
    await recordOutcomes(config, outcomes);

    const failedAll = outcomes.length > 0 && outcomes.every((outcome) => outcome.status === 'Failed');
    await cds.run(
      UPDATE(db().CollectionRuns)
        .set({
          finishedAt: new Date().toISOString(),
          status: failedAll ? 'Failed' : 'Completed',
          jobsFound: collected.length,
          jobsNew: ingest.created,
          jobsUpdated: ingest.updated + ingest.mergedAcrossSources,
        })
        .where({ ID: runId }),
    );

    return {
      runId,
      batchKey: plan.batchKey,
      jobsFound: collected.length,
      ingest,
      outcomes,
      skipped: plan.skipped,
      malformedLines,
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
  });
  collected.push(...output.jobs);
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
