import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { cds, db, SELECT, UPDATE, query } from '../src/db/index.js';
import { formatNotification } from '../src/notify/format.js';
import type { TelegramClient, TelegramSendResult } from '../src/notify/telegram.js';
import { normalizeJob } from '../src/normalize/index.js';
import { ingestJobs } from '../src/persist/ingest.js';
import { notify } from '../src/pipeline/notify.js';
import { rank } from '../src/pipeline/rank.js';
import { closeTempDb, useTempDb } from './helpers/db.js';

const STRONG_JOB = {
  id: 'li-strong',
  title: 'Senior SAP BTP Developer (CAP / Node.js)',
  company: 'Northwind Cloud Consulting GmbH',
  location: 'Remote, Germany, DE',
  job_url: 'https://www.linkedin.com/jobs/view/4242',
  date_posted: '2026-10-04',
  job_type: 'contract',
  interval: 'hourly',
  min_amount: 60,
  max_amount: 75,
  currency: 'EUR',
  is_remote: true,
  description:
    'Freelance engagement, 100% remote within the EU. Build CAP services with Node.js, TypeScript and CDS, expose OData V4 and deploy to Cloud Foundry with XSUAA. Must have: CAP, Node.js, SAP HANA Cloud, OData. Nice to have: SAPUI5, SAP Integration Suite.',
};

/** Telegram double whose outcome is scripted per call. */
function scriptedClient(results: TelegramSendResult[]): TelegramClient & { calls: number } {
  const client = {
    calls: 0,
    async send() {
      const result = results[Math.min(client.calls, results.length - 1)]!;
      client.calls += 1;
      return result;
    },
  };
  return client;
}

describe('notification lifecycle', () => {
  beforeAll(async () => {
    await useTempDb();
    const normalized = [normalizeJob(STRONG_JOB as any, 'linkedin')!];
    await ingestJobs(normalized, { runId: null });
    await rank({ rulesOnly: true });
  });
  afterAll(closeTempDb);

  it('records a transient failure and keeps the notification retryable', async () => {
    const client = scriptedClient([{ ok: false, error: 'HTTP 502', retryable: true }]);
    const summary = await notify({ client, minFitScore: 50 });

    expect(summary.queued).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);

    const [row] = await query<any>(SELECT.from(db().Notifications));
    expect(row.status).toBe('Failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('HTTP 502');
    expect(row.telegramMessageId).toBeNull();
  });

  it('retries the failed notification and records the Telegram message id', async () => {
    const client = scriptedClient([{ ok: true, messageId: 987, retryable: false }]);
    const summary = await notify({ client, minFitScore: 50 });

    // Nothing new is queued - the existing notification is retried.
    expect(summary.queued).toBe(0);
    expect(summary.retried).toBe(1);
    expect(summary.sent).toBe(1);

    const [row] = await query<any>(SELECT.from(db().Notifications));
    expect(row.status).toBe('Sent');
    expect(row.attempts).toBe(2);
    expect(row.telegramMessageId).toBe(987);
    expect(row.sentAt).toBeTruthy();
    expect(row.lastError).toBeNull();
  });

  it('does not notify the same job twice on a later run', async () => {
    const client = scriptedClient([{ ok: true, messageId: 1, retryable: false }]);
    const summary = await notify({ client, minFitScore: 50 });

    expect(summary.queued).toBe(0);
    expect(summary.sent).toBe(0);
    expect(client.calls).toBe(0);
    expect(await query(SELECT.from(db().Notifications))).toHaveLength(1);
  });

  it('stops retrying after a permanent error', async () => {
    const { Notifications } = db();
    await cds.run(
      UPDATE(Notifications).set({ status: 'Pending', attempts: 0, telegramMessageId: null, sentAt: null }),
    );

    const permanent = scriptedClient([{ ok: false, error: 'chat not found', retryable: false }]);
    await notify({ client: permanent, minFitScore: 50 });
    const [row] = await query<any>(SELECT.from(Notifications));
    expect(row.status).toBe('Failed');
    expect(row.attempts).toBe(loadConfig().settings.telegram.max_attempts);

    // A further run must not call Telegram again.
    const next = scriptedClient([{ ok: true, messageId: 5, retryable: false }]);
    const summary = await notify({ client: next, minFitScore: 50 });
    expect(next.calls).toBe(0);
    expect(summary.skipped).toBe(1);
  });
});

describe('notification formatting', () => {
  it('shows unknown values as unknown and never invents them', () => {
    const config = loadConfig();
    const message = formatNotification(
      config,
      {
        ID: 'x',
        title: 'SAP Fiori Developer',
        company: null,
        location: null,
        locationCountry: null,
        isRemote: null,
        jobType: null,
        salaryMin: null,
        salaryMax: null,
        salaryInterval: null,
        salaryCurrency: null,
        description: null,
        descriptionHash: null,
        primaryUrl: 'https://example.com/job/1',
        datePosted: null,
      },
      {
        engine: 'rules',
        model: null,
        profileVersion: 'test',
        fitScore: 76,
        recommendation: 'Review',
        technicalFit: 70,
        commercialFit: 50,
        locationFit: 50,
        strongMatches: ['CAP', 'UI5'],
        mandatoryGaps: ['industry experience requires review'],
        preferredGaps: [],
        missingInformation: ['rate not stated'],
        explanation: 'test',
        suggestedCvVariant: 'ui5',
        hardReject: false,
        hardRejectReason: null,
      },
      ['linkedin'],
    );

    expect(message.text).toContain('76/100 — SAP Fiori Developer');
    expect(message.text).toContain('LinkedIn');
    expect(message.text).toContain('Rate: not stated');
    expect(message.text).toContain('Published: unknown');
    expect(message.text).toContain('Company: not stated');
    expect(message.text).toContain('Gap: industry experience requires review');
    expect(message.text).toContain('Suggested CV: UI5/Fiori');
    expect(message.url).toBe('https://example.com/job/1');
    expect(message.buttonText).toBe('Open vacancy');
  });
});
