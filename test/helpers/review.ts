import { loadConfig, type AppConfig } from '../../src/config/index.js';
import { normalizeJob } from '../../src/normalize/index.js';
import type { CollectorJob } from '../../src/collector/types.js';
import type { MatchableJob } from '../../src/matching/types.js';
import type { NotificationPayload } from '../../src/notify/format.js';
import { ingestJobs } from '../../src/persist/ingest.js';
import { vi } from 'vitest';

export const reviewRecord: CollectorJob = {
  id: 'review-1', title: 'Senior SAP BTP Developer', company: 'Review Client',
  location: 'Berlin, Germany', job_url: 'https://www.linkedin.com/jobs/view/123456',
  job_type: 'contract', is_remote: true, min_amount: 60, max_amount: 75, interval: 'hourly', currency: 'EUR',
  description: 'Fully remote freelance B2B within the EU. Build CAP, Node.js, TypeScript, CDS, OData, SAP HANA Cloud, Cloud Foundry, XSUAA, SAPUI5 and SAP Fiori.',
};

export function reviewJob(description = '', overrides: Partial<MatchableJob> = {}): MatchableJob {
  return { ...normalizeJob(reviewRecord, 'linkedin')!, ID: 'review-job',
    description: `${reviewRecord.description}\n${description}`, ...overrides };
}

export function enableReviewAi(config: AppConfig = loadConfig(), budget = 5): void {
  config.llmAvailable = true;
  config.secrets.openaiApiKey = 'offline-test-key';
  config.settings.llm.max_jobs_per_run = budget;
}

export function reviewAiResponse(recommendation = 'Apply', fitScore = 99, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    fit_score: fitScore, recommendation, technical_fit: 99, commercial_fit: 99, location_fit: 99,
    strong_matches: ['CAP'], mandatory_gaps: [], preferred_gaps: [], missing_information: [],
    explanation: 'Offline assessment', suggested_cv_variant: loadConfig().cvVariants.default, ...overrides,
  }) } }] }), { status: 200 });
}

export function ingestReview(overrides: Partial<CollectorJob> = {}, source = 'linkedin', demo = false) {
  return ingestJobs([normalizeJob({ ...reviewRecord, ...overrides }, source)!], { runId: null, demo });
}

export function reviewSender() {
  return { send: vi.fn(async (_payload: NotificationPayload) => ({ ok: true, messageId: 42, retryable: false })) };
}
