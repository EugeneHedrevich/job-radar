import { loadConfig, type AppConfig } from '../config/index.js';
import { db, SELECT, query } from '../db/index.js';
import { PRIORITY_DIRECTIONS, priorityDirections } from '../matching/directions.js';
import { prescreen } from '../matching/rules.js';
import type { AssessmentResult, MatchableJob } from '../matching/types.js';
import { findCurrentAssessment, rowToAssessment } from './rank.js';
import { closedJobIds } from '../persist/activity.js';

export interface DirectionEntry {
  job: MatchableJob;
  assessment?: AssessmentResult;
  deliveryAvailable: boolean;
}

export function summarizeDirections(config: AppConfig, entries: DirectionEntry[]) {
  return PRIORITY_DIRECTIONS.map((direction) => {
    const selected = entries.filter(({ job }) => priorityDirections(job).includes(direction));
    return {
      direction,
      collected: selected.length,
      described: selected.filter(({ job }) => Boolean(job.description?.trim())).length,
      prescreened: selected.filter(({ job }) => prescreen(config, job).passed).length,
      llm: selected.filter(({ assessment }) => assessment?.engine === 'llm').length,
      notify: selected.filter(({ deliveryAvailable }) => deliveryAvailable).length,
    };
  });
}

/** Read-only counters, based on current cache keys and notification history. */
export async function directionCounters(runId?: string) {
  const config = loadConfig();
  let jobs: MatchableJob[];
  if (runId) {
    const listings = await query<{ job_ID: string }>(SELECT.from(db().SourceListings).columns('job_ID').where({ run_ID: runId }));
    const ids = [...new Set(listings.map((listing) => listing.job_ID))];
    jobs = ids.length ? await query(SELECT.from(db().Jobs).where({ ID: { in: ids } })) : [];
  } else jobs = await query(SELECT.from(db().Jobs).where({ isDemo: false }));
  const notifications = await query<any>(SELECT.from(db().Notifications)
    .where({ channel: 'telegram', status: { '!=': 'Superseded' } }));
  const entries: DirectionEntry[] = [];
  const closed = await closedJobIds();
  for (const job of jobs) {
    const row = await findCurrentAssessment(config, job);
    const pending = notifications.find((notification) => notification.job_ID === job.ID);
    const canClaim = !pending || pending.status === 'Skipped' ||
      pending.attempts < config.settings.telegram.max_attempts &&
      (['Pending', 'Failed'].includes(pending.status) ||
        pending.status === 'Sending' && pending.claimUntil && new Date(pending.claimUntil) <= new Date());
    entries.push({ job, ...(row ? { assessment: rowToAssessment(row) } : {}),
      deliveryAvailable: Boolean(job.status !== 'Ignored' && !closed.has(job.ID) && !job.isDemo && row && row.fitScore >= config.settings.telegram.min_fit_score &&
        row.recommendation !== 'Skip' && !row.hardReject && canClaim) });
  }
  return summarizeDirections(config, entries);
}
