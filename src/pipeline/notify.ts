import { loadConfig } from '../config/index.js';
import { cds, db, SELECT, UPDATE, query, queryOne } from '../db/index.js';
import { findCurrentAssessment, rowToAssessment } from './rank.js';
import { formatNotification } from '../notify/format.js';
import { createDryRunClient, createTelegramClient, type TelegramClient, type TelegramSendResult } from '../notify/telegram.js';
import { claimNotification, queueNotification } from './notification-store.js';
import type { MatchableJob } from '../matching/types.js';
import { log, out } from '../util/log.js';
import { closedJobIds, expireListingDeadlines, isJobClosed, listingIsClosed } from '../persist/activity.js';
import { suppressIgnoredWork } from './ignored.js';

export interface NotifyOptions {
  dryRun?: boolean;
  /** Restrict to these job ids. */
  jobIds?: string[];
  /** Override the configured minimum fit score. */
  minFitScore?: number;
  limit?: number;
  client?: TelegramClient;
}

export interface NotifySummary {
  queued: number;
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
  dryRun: boolean;
}

const CHANNEL = 'telegram';

/**
 * Queue notifications for new high-scoring jobs, then flush the queue.
 * Pending and previously failed notifications from earlier runs are retried
 * first, so a Telegram outage never loses a match.
 */
export async function notify(options: NotifyOptions = {}): Promise<NotifySummary> {
  await expireListingDeadlines();
  await suppressIgnoredWork();
  const config = loadConfig();
  const summary: NotifySummary = {
    queued: 0,
    sent: 0,
    failed: 0,
    retried: 0,
    skipped: 0,
    dryRun: Boolean(options.dryRun),
  };

  const threshold = options.minFitScore ?? config.settings.telegram.min_fit_score;
  summary.queued = await queueCandidates(config, threshold, options);

  let client = options.client;
  if (!client) {
    if (options.dryRun) {
      client = createDryRunClient(out);
    } else if (!config.telegramAvailable) {
      log.warn('Telegram is not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID); queued only');
      return summary;
    } else {
      client = createTelegramClient({
        botToken: config.secrets.telegramBotToken!,
        chatId: config.secrets.telegramChatId!,
        disableWebPagePreview: config.settings.telegram.disable_web_page_preview,
      });
    }
  }

  const flushed = await flushQueue(config, client, options);
  summary.sent = flushed.sent;
  summary.failed = flushed.failed;
  summary.retried = flushed.retried;
  summary.skipped = flushed.skipped;
  return summary;
}

async function queueCandidates(
  config: ReturnType<typeof loadConfig>,
  threshold: number,
  options: NotifyOptions,
): Promise<number> {
  const { Jobs } = db();
  const candidates: Array<{ job: MatchableJob; assessment: any }> = [];
  const closed = await closedJobIds();
  for (const job of await query<MatchableJob>(SELECT.from(Jobs))) {
    if (job.status === 'Ignored' || closed.has(job.ID)) continue;
    if (options.jobIds?.length && !options.jobIds.includes(job.ID)) continue;
    if (job.isDemo && !options.dryRun) continue;
    const assessment = await findCurrentAssessment(config, job);
    if (eligible(assessment, threshold)) candidates.push({ job, assessment });
  }
  candidates.sort((a, b) => b.assessment.fitScore - a.assessment.fitScore);

  let queued = 0;
  for (const { job, assessment: row } of candidates) {
    const payload = await notificationPayload(config, job, row);
    if (await queueNotification({
      jobId: job.ID,
      assessmentId: row.ID,
      channel: CHANNEL,
      chatId: config.secrets.telegramChatId ?? null,
      payload: JSON.stringify(payload),
    })) queued += 1;
  }
  return queued;
}

function eligible(assessment: any, threshold: number): boolean {
  return Boolean(assessment && assessment.fitScore >= threshold &&
    assessment.recommendation !== 'Skip' && !assessment.hardReject);
}

async function notificationPayload(
  config: ReturnType<typeof loadConfig>, job: MatchableJob, assessment: any,
) {
  const listings = (await query<{ source: string; canonicalUrl: string; rawUrl: string | null; activityState: string | null; validThrough: string | null }>(
    SELECT.from(db().SourceListings).where({ job_ID: job.ID }).orderBy('firstSeenAt', 'ID'),
  )).filter((listing) => !listingIsClosed(listing));
  const available = listings.find((listing) => listing.rawUrl === job.primaryUrl || listing.canonicalUrl === job.primaryUrl) ??
    listings.find((listing) => listing.activityState === 'Active') ?? listings[0];
  return formatNotification(config, { ...job, primaryUrl: available?.rawUrl ?? available?.canonicalUrl ?? job.primaryUrl },
    rowToAssessment(assessment), listings.map((listing) => listing.source));
}

async function flushQueue(
  config: ReturnType<typeof loadConfig>,
  client: TelegramClient,
  options: NotifyOptions,
): Promise<{ sent: number; failed: number; retried: number; skipped: number }> {
  const { Notifications } = db();
  const maxAttempts = config.settings.telegram.max_attempts;
  const limit = Math.min(3, options.limit ?? config.settings.telegram.max_per_run, config.settings.telegram.max_per_run);

  const pending = await query<any>(
    SELECT.from(Notifications)
      .where({ channel: CHANNEL, status: { in: ['Pending', 'Failed', 'Sending'] } })
      .orderBy('createdAt'),
  );

  let sent = 0;
  let failed = 0;
  let retried = 0;
  let skipped = 0;
  let deliveryAttempts = 0;

  for (const [index, candidate] of pending.entries()) {
    if (options.jobIds?.length && !options.jobIds.includes(candidate.job_ID)) continue;
    if (deliveryAttempts >= limit) {
      skipped += 1;
      continue;
    }
    const row = await claimNotification(candidate.ID, maxAttempts, Boolean(options.dryRun));
    if (!row) {
      skipped += 1;
      continue;
    }
    const owned = { ID: row.ID, status: 'Sending', claimToken: row.claimToken };
    let delivered = false;
    try {
      // Revalidate retries and dry-run queues, not just newly queued candidates.
      const job = await queryOne<MatchableJob>(SELECT.from(db().Jobs).where({ ID: row.job_ID }));
      const assessment = job && await findCurrentAssessment(config, job);
      const closed = job && await isJobClosed(job.ID);
      if (!job || job.status === 'Ignored' || closed || (job.isDemo && !options.dryRun) ||
        !eligible(assessment, options.minFitScore ?? config.settings.telegram.min_fit_score)) {
        await cds.run(UPDATE(Notifications).set({
          status: 'Skipped',
          claimToken: null, claimUntil: null,
          lastError: job?.status === 'Ignored' ? 'Job is Ignored' : closed ? 'All source listings are confirmed closed' : job?.isDemo && !options.dryRun
            ? 'Demo data cannot be delivered live'
            : 'No eligible assessment for the current job and configuration',
        }).where(owned));
        skipped += 1;
        continue;
      }
      const attempts = row.attempts;
      if (attempts > (options.dryRun ? 0 : 1)) retried += 1;

      const payload = await notificationPayload(config, job, assessment);
      const prepared = await cds.run(UPDATE(Notifications).set({
        assessment_ID: assessment.ID, payload: JSON.stringify(payload),
      }).where(owned));
      if (!prepared) { skipped += 1; continue; }
      // Activity can change while a payload or a retry is being prepared.
      const latest = await queryOne<MatchableJob>(SELECT.from(db().Jobs).where({ ID: job.ID }));
      if (latest?.status === 'Ignored' || await isJobClosed(job.ID)) {
        await cds.run(UPDATE(Notifications).set({ status: 'Skipped', claimToken: null, claimUntil: null,
          lastError: latest?.status === 'Ignored' ? 'Job is Ignored' : 'All source listings are confirmed closed' }).where(owned));
        skipped += 1;
        continue;
      }

      let result: TelegramSendResult;
      try {
        deliveryAttempts += 1;
        result = await client.send(payload);
      } catch (error) {
        result = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
      }

      if (result.ok) {
        delivered = !options.dryRun;
        await cds.run(
          UPDATE(Notifications)
            .set({
              status: options.dryRun ? 'Pending' : 'Sent',
              claimToken: null, claimUntil: null,
              telegramMessageId: result.messageId ?? null,
              sentAt: options.dryRun ? null : new Date().toISOString(),
              lastError: null,
            })
            .where(owned),
        );
        sent += 1;
        continue;
      }

      // Permanent errors burn the remaining attempts so we stop hammering the API.
      const finalAttempts = result.retryable ? attempts : maxAttempts;
      await cds.run(
        UPDATE(Notifications)
          .set({ status: 'Failed', attempts: finalAttempts, lastError: result.error ?? 'unknown error', claimToken: null, claimUntil: null })
          .where(owned),
      );
      failed += 1;
      log.warn('Telegram delivery failed', { notification: row.ID, error: result.error, retryable: result.retryable });

      if (result.retryable && attempts < maxAttempts && index < pending.length - 1) {
        await sleep(config.settings.telegram.retry_base_delay_seconds * 1000 * attempts);
      }
    } catch (error) {
      // Release preparation failures, but don't immediately make an acknowledged
      // delivery retryable if persisting its result failed.
      if (!delivered) await cds.run(UPDATE(Notifications).set({
        status: 'Failed', claimToken: null, claimUntil: null,
        lastError: error instanceof Error ? error.message : String(error),
      }).where(owned));
      throw error;
    }
  }

  return { sent, failed, retried, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
