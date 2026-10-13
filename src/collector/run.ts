import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { PROJECT_ROOT, type AppConfig } from '../config/index.js';
import { log } from '../util/log.js';
import { collectorLineSchema, type CollectorOutput, type CollectorTask, type TaskOutcome } from './types.js';

export interface RunCollectorOptions {
  tasks: CollectorTask[];
  taskTimeoutSeconds: number;
  delayBetweenTasksSeconds: number;
  processTimeoutSeconds: number;
  onProgress?: (progress: { jobsFound: number; outcomes: TaskOutcome[] }) => Promise<void>;
}

/**
 * Run the Python collector as a subprocess.
 *
 * The command is built as an argument array and the task list is handed over on
 * stdin as JSON, so no configuration value is ever interpolated into a shell.
 */
export async function runCollector(config: AppConfig, options: RunCollectorOptions): Promise<CollectorOutput> {
  if (!existsSync(config.pythonPath)) {
    throw new Error(
      `Python interpreter not found at ${config.pythonPath}. ` +
        `Create the venv (see README) or set JOB_RADAR_PYTHON.`,
    );
  }
  if (!existsSync(config.collectorScript)) {
    throw new Error(`Collector script not found at ${config.collectorScript}`);
  }

  const output: CollectorOutput = { jobspyVersion: undefined, jobs: [], activities: [], outcomes: [], malformedLines: 0 };
  const pending = new Map<string, CollectorTask>(options.tasks.map((task) => [task.task_id, task]));
  const statistics = new Map<string, { searchRequests: number; detailRequests: number }>();
  const progress = new Map<string, NonNullable<TaskOutcome['nextCursor']>>();
  const positions = new Map<string, number>();
  let activeTaskId = options.tasks[0]?.task_id;
  let timedOut = false;
  let taskTimer: ReturnType<typeof setTimeout> | undefined;
  let updates = Promise.resolve();
  let lastUpdate = 0;
  const report = (force = false) => {
    if (!options.onProgress || !force && Date.now() - lastUpdate < 250) return;
    lastUpdate = Date.now();
    const snapshot = { jobsFound: output.jobs.length, outcomes: [...output.outcomes] };
    updates = updates.then(() => options.onProgress!(snapshot));
    void updates.catch(() => child.kill('SIGKILL'));
  };

  const child = spawn(config.pythonPath, [config.collectorScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    shell: false,
    cwd: PROJECT_ROOT,
  });

  const killTimer = setTimeout(() => {
    log.warn('Collector exceeded process timeout, killing', { seconds: options.processTimeoutSeconds });
    timedOut = true;
    activeTaskId ??= pending.keys().next().value;
    child.kill('SIGKILL');
  }, options.processTimeoutSeconds * 1000);
  const armTaskTimer = () => {
    clearTimeout(taskTimer);
    taskTimer = setTimeout(() => {
      timedOut = true;
      log.warn('Collector task deadline expired, terminating source process', { taskId: activeTaskId });
      child.kill('SIGKILL');
    }, options.taskTimeoutSeconds * 1000);
  };
  armTaskTimer();

  child.stdin.end(
    JSON.stringify({
      tasks: options.tasks,
      task_timeout_seconds: options.taskTimeoutSeconds,
      delay_between_tasks_seconds: options.delayBetweenTasksSeconds,
    }),
  );

  const stderrChunks: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const safe = redactProxy(chunk);
    stderrChunks.push(safe);
    for (const line of safe.split('\n')) if (line.trim()) log.debug(`[collector] ${line.trim()}`);
  });

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      output.malformedLines += 1;
      log.warn('Discarding non-JSON collector line', { line: redactProxy(trimmed.slice(0, 200)) });
      return;
    }
    const result = collectorLineSchema.safeParse(parsed);
    if (!result.success) {
      output.malformedLines += 1;
      log.warn('Discarding collector line that failed schema validation', {
        issues: result.error.issues.slice(0, 3).map((issue) => issue.message),
      });
      return;
    }
    const record = result.data;
    if (record.type === 'meta') {
      output.jobspyVersion = record.jobspy_version;
    } else if (record.type === 'task_started' && pending.has(record.task_id)) {
      activeTaskId = record.task_id;
      armTaskTimer();
    } else if (record.type === 'request_stats' && pending.has(record.task_id)) {
      statistics.set(record.task_id, { searchRequests: record.search_requests, detailRequests: record.detail_requests });
    } else if (record.type === 'search_progress' && pending.has(record.task_id)) {
      progress.set(record.task_id, record.cursor);
    } else if (record.type === 'job') {
      if (pending.get(record.task_id)?.source !== record.source) return;
      const key = `${record.task_id}:${record.job.job_url ?? record.job.id ?? positions.size}`;
      const value = { taskId: record.task_id, source: record.source, job: record.job };
      const position = positions.get(key);
      if (position === undefined) { positions.set(key, output.jobs.length); output.jobs.push(value); }
      else output.jobs[position] = value;
      report();
    } else if (record.type === 'listing_activity') {
      const task = pending.get(record.task_id);
      if (task?.source === record.activity.source) output.activities.push(record.activity);
    } else if (record.type === 'task_result') {
      const task = pending.get(record.task_id);
      if (!task || task.source !== record.source) return;
      pending.delete(record.task_id);
      if (activeTaskId === record.task_id) {
        clearTimeout(taskTimer);
        activeTaskId = undefined;
      }
      output.outcomes.push({
        taskId: record.task_id,
        source: record.source,
        searchTerm: task?.search_term ?? '',
        location: task?.location,
        countryIndeed: task?.country_indeed,
        status: record.status === 'succeeded' ? 'Succeeded' : record.status === 'skipped' ? 'Skipped' : 'Failed',
        resultCount: record.count,
        durationMs: record.duration_ms,
        ...(record.error_kind ? { errorKind: record.error_kind } : {}),
        ...(record.message ? { message: redactProxy(record.message) } : {}),
        ...(statistics.get(record.task_id) ?? {}),
        ...(record.search_requests != null ? { searchRequests: record.search_requests } : {}),
        ...(record.detail_requests != null ? { detailRequests: record.detail_requests } : {}),
        ...(record.retry_after_seconds !== undefined ? { retryAfterSeconds: record.retry_after_seconds } : {}),
        ...(progress.has(record.task_id) ? { nextCursor: progress.get(record.task_id) } : {}),
      });
      report(true);
    }
  });

  let exitCode: number;
  try {
    // close means the terminated worker and its pipes have stopped. A caller
    // cannot start a retry while the old source is still making requests.
    exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? -1));
    });
  } finally {
    clearTimeout(killTimer);
    clearTimeout(taskTimer);
    reader.close();
  }

  if (exitCode !== 0) {
    const tail = stderrChunks.join('').split('\n').filter(Boolean).slice(-5).join(' | ');
    log.error('Collector exited with a non-zero code', { exitCode, tail });
  }

  // A streamed search identity may acquire an old date from its later detail.
  // Apply freshness to the final version; explicit activity refreshes retain
  // older stored listings and their observations.
  const taskById = new Map(options.tasks.map((task) => [task.task_id, task]));
  output.jobs = output.jobs.filter((record) => {
    const task = taskById.get(record.taskId);
    const posted = record.job.date_posted;
    if (!task || !posted || !/^\d{4}-\d{2}-\d{2}/.test(posted) ||
      task.detail_jobs?.some((row) => row.activity_refresh && row.job_url === record.job.job_url)) return true;
    return posted.slice(0, 10) >= new Date(Date.now() - task.hours_old * 3_600_000).toISOString().slice(0, 10);
  });
  for (const outcome of output.outcomes) outcome.resultCount = output.jobs.filter((record) => record.taskId === outcome.taskId).length;

  // Any task the collector never reported on is recorded as failed rather than
  // being silently dropped.
  for (const task of pending.values()) {
    output.outcomes.push({
      taskId: task.task_id,
      source: task.source,
      searchTerm: task.search_term,
      location: task.location,
      countryIndeed: task.country_indeed,
      status: timedOut && task.task_id !== activeTaskId ? 'Skipped' : 'Failed',
      resultCount: output.jobs.filter((record) => record.taskId === task.task_id).length,
      durationMs: timedOut && task.task_id === activeTaskId ? options.taskTimeoutSeconds * 1000 : 0,
      ...(timedOut && task.task_id !== activeTaskId ? {} : { errorKind: timedOut ? 'timeout' : exitCode === 0 ? 'parse' : 'error' }),
      message: timedOut ? task.task_id === activeTaskId ? 'Source process terminated after collection deadline expired'
        : 'Source paused after collection deadline expired' : `collector produced no result for this task (exit code ${exitCode})`,
      ...(statistics.get(task.task_id) ?? {}),
      ...(progress.has(task.task_id) ? { nextCursor: progress.get(task.task_id) } : {}),
    });
  }

  report(true);
  await updates;
  return output;
}

function redactProxy(message: string): string {
  const proxy = process.env.JOB_RADAR_PROXY?.trim();
  return (proxy ? message.replaceAll(proxy, '[proxy]') : message)
    .replace(/(https?|socks5):\/\/[^\s/@]+:[^\s/@]+@/gi, '$1://[redacted]@');
}
