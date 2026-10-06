import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { cds, db, SELECT, INSERT, UPDATE, query, queryOne } from '../db/index.js';
import { rowToAssessment } from './rank.js';
import { formatNotification } from '../notify/format.js';
import { createDryRunClient, createTelegramClient, type TelegramClient } from '../notify/telegram.js';
import type { MatchableJob } from '../matching/types.js';
import { log, out } from '../util/log.js';

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
  const { Jobs, Assessments, Notifications, SourceListings } = db();

  const assessments = await query<any>(SELECT.from(Assessments).where({ fitScore: { '>=': threshold } }));

  // Highest score first; only the best assessment per job is ever notified.
  assessments.sort((a, b) => b.fitScore - a.fitScore);

  let queued = 0;
  const handledJobs = new Set<string>();

  for (const row of assessments) {
    if (!row.job_ID) continue;
    if (options.jobIds?.length && !options.jobIds.includes(row.job_ID)) continue;
    if (handledJobs.has(row.job_ID)) continue;
    handledJobs.add(row.job_ID);
    if (row.recommendation === 'Skip' || row.hardReject) continue;

    // One notification per job. Repeated collection runs must not re-notify.
    const existing = await queryOne<{ ID: string }>(
      SELECT.from(Notifications).columns('ID').where({ job_ID: row.job_ID, channel: CHANNEL }),
    );
    if (existing) continue;

    const job = await queryOne<MatchableJob>(SELECT.from(Jobs).where({ ID: row.job_ID }));
    if (!job) continue;
    const listings = await query<{ source: string }>(
      SELECT.from(SourceListings).columns('source').where({ job_ID: row.job_ID }),
    );
    const payload = formatNotification(config, job, rowToAssessment(row), listings.map((l) => l.source));

    await cds.run(
      INSERT.into(Notifications).entries({
        ID: randomUUID(),
        job_ID: row.job_ID,
        assessment_ID: row.ID,
        channel: CHANNEL,
        status: 'Pending',
        attempts: 0,
        chatId: config.secrets.telegramChatId ?? null,
        payload: JSON.stringify(payload),
        createdAt: new Date().toISOString(),
      }),
    );
    queued += 1;
  }
  return queued;
}

async function flushQueue(
  config: ReturnType<typeof loadConfig>,
  client: TelegramClient,
  options: NotifyOptions,
): Promise<{ sent: number; failed: number; retried: number; skipped: number }> {
  const { Notifications } = db();
  const maxAttempts = config.settings.telegram.max_attempts;
  const limit = options.limit ?? config.settings.telegram.max_per_run;

  const pending = await query<any>(
    SELECT.from(Notifications)
      .where({ channel: CHANNEL, status: { in: ['Pending', 'Failed'] } })
      .orderBy('createdAt'),
  );

  let sent = 0;
  let failed = 0;
  let retried = 0;
  let skipped = 0;

  for (const [index, row] of pending.entries()) {
    if (sent >= limit) {
      skipped += 1;
      continue;
    }
    if (row.attempts >= maxAttempts) {
      skipped += 1;
      continue;
    }
    if (row.attempts > 0) retried += 1;

    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      await cds.run(
        UPDATE(Notifications)
          .set({ status: 'Failed', attempts: maxAttempts, lastError: 'stored payload is not valid JSON' })
          .where({ ID: row.ID }),
      );
      failed += 1;
      continue;
    }

    const result = await client.send(payload);
    const attempts = row.attempts + 1;

    if (result.ok) {
      await cds.run(
        UPDATE(Notifications)
          .set({
            status: options.dryRun ? 'Pending' : 'Sent',
            attempts: options.dryRun ? row.attempts : attempts,
            telegramMessageId: result.messageId ?? null,
            sentAt: options.dryRun ? null : new Date().toISOString(),
            lastError: null,
          })
          .where({ ID: row.ID }),
      );
      sent += 1;
      continue;
    }

    // Permanent errors burn the remaining attempts so we stop hammering the API.
    const finalAttempts = result.retryable ? attempts : maxAttempts;
    await cds.run(
      UPDATE(Notifications)
        .set({ status: 'Failed', attempts: finalAttempts, lastError: result.error ?? 'unknown error' })
        .where({ ID: row.ID }),
    );
    failed += 1;
    log.warn('Telegram delivery failed', { notification: row.ID, error: result.error, retryable: result.retryable });

    // Back off before the next message, but never after the last one: there is
    // nothing left to protect from a burst.
    if (result.retryable && attempts < maxAttempts && index < pending.length - 1) {
      await sleep(config.settings.telegram.retry_base_delay_seconds * 1000 * attempts);
    }
  }

  return { sent, failed, retried, skipped };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
