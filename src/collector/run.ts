import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import type { AppConfig } from '../config/index.js';
import { log } from '../util/log.js';
import { collectorLineSchema, type CollectorOutput, type CollectorTask } from './types.js';

export interface RunCollectorOptions {
  tasks: CollectorTask[];
  taskTimeoutSeconds: number;
  delayBetweenTasksSeconds: number;
  processTimeoutSeconds: number;
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

  const output: CollectorOutput = { jobspyVersion: undefined, jobs: [], outcomes: [], malformedLines: 0 };
  const pending = new Map<string, CollectorTask>(options.tasks.map((task) => [task.task_id, task]));

  const child = spawn(config.pythonPath, [config.collectorScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    shell: false,
  });

  const killTimer = setTimeout(() => {
    log.warn('Collector exceeded process timeout, killing', { seconds: options.processTimeoutSeconds });
    child.kill('SIGKILL');
  }, options.processTimeoutSeconds * 1000);

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
    stderrChunks.push(chunk);
    for (const line of chunk.split('\n')) if (line.trim()) log.debug(`[collector] ${line.trim()}`);
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
      log.warn('Discarding non-JSON collector line', { line: trimmed.slice(0, 200) });
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
    } else if (record.type === 'job') {
      output.jobs.push({ taskId: record.task_id, source: record.source, job: record.job });
    } else if (record.type === 'task_result') {
      const task = pending.get(record.task_id);
      pending.delete(record.task_id);
      output.outcomes.push({
        taskId: record.task_id,
        source: record.source,
        searchTerm: task?.search_term ?? '',
        location: task?.location,
        countryIndeed: task?.country_indeed,
        status: record.status === 'succeeded' ? 'Succeeded' : 'Failed',
        resultCount: record.count,
        durationMs: record.duration_ms,
        ...(record.error_kind ? { errorKind: record.error_kind } : {}),
        ...(record.message ? { message: record.message } : {}),
      });
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  clearTimeout(killTimer);
  reader.close();

  if (exitCode !== 0) {
    const tail = stderrChunks.join('').split('\n').filter(Boolean).slice(-5).join(' | ');
    log.error('Collector exited with a non-zero code', { exitCode, tail });
  }

  // Any task the collector never reported on is recorded as failed rather than
  // being silently dropped.
  for (const task of pending.values()) {
    output.outcomes.push({
      taskId: task.task_id,
      source: task.source,
      searchTerm: task.search_term,
      location: task.location,
      countryIndeed: task.country_indeed,
      status: 'Failed',
      resultCount: 0,
      durationMs: 0,
      errorKind: exitCode === 0 ? 'parse' : 'error',
      message: `collector produced no result for this task (exit code ${exitCode})`,
    });
  }

  return output;
}
