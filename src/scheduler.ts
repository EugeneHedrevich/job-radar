import path from 'node:path';
import cron from 'node-cron';
import { loadConfig, PROJECT_ROOT } from './config/index.js';
import { loadFixture } from './fixtures/load.js';
import { collect } from './pipeline/collect.js';
import { notify } from './pipeline/notify.js';
import { rank } from './pipeline/rank.js';
import { log, out } from './util/log.js';

export interface SchedulerOptions {
  demo?: boolean;
  dryRun?: boolean;
}

/** One complete monitoring cycle: collect -> rank -> notify. */
export async function runCycle(options: SchedulerOptions = {}): Promise<void> {
  const fixture = options.demo ? loadFixture(path.join(PROJECT_ROOT, 'fixtures', 'demo-jobs.jsonl')) : undefined;
  const collected = await collect({
    trigger: 'scheduled',
    ...(fixture ? { fixture } : {}),
  });
  log.info('Collection finished', {
    batch: collected.batchKey,
    found: collected.jobsFound,
    created: collected.ingest.created,
    merged: collected.ingest.mergedAcrossSources,
  });

  const ranked = await rank({ jobIds: collected.ingest.jobIds, rulesOnly: Boolean(options.demo) });
  log.info('Ranking finished', { assessed: ranked.length });

  const sent = await notify({ dryRun: Boolean(options.demo || options.dryRun) });
  log.info('Notification finished', sent);
}

/** Start the cron schedule. Cycles never overlap. */
export async function startScheduler(options: SchedulerOptions = {}): Promise<void> {
  const config = loadConfig();
  const { cron: expression, timezone, run_on_start } = config.settings.scheduler;

  if (!cron.validate(expression)) throw new Error(`settings.yaml: invalid cron expression "${expression}"`);

  let running = false;
  const tick = async () => {
    if (running) {
      log.warn('Previous cycle is still running; skipping this tick');
      return;
    }
    running = true;
    try {
      await runCycle(options);
    } catch (error) {
      log.error('Cycle failed', { message: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };

  out(`Scheduler started: "${expression}" (${timezone}). Press Ctrl+C to stop.`);
  const task = cron.schedule(expression, tick, { timezone });

  const stop = () => {
    out('Scheduler stopping...');
    task.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (run_on_start) await tick();
}
