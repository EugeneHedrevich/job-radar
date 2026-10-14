import { z } from 'zod';

/** Schema of a single record emitted by python/collector.py. */
export const collectorJobSchema = z.object({
  id: z.string().nullable().optional(),
  site: z.string().nullable().optional(),
  job_url: z.string().nullable().optional(),
  job_url_direct: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  date_posted: z.string().nullable().optional(),
  job_type: z.string().nullable().optional(),
  salary_source: z.string().nullable().optional(),
  interval: z.string().nullable().optional(),
  min_amount: z.union([z.number(), z.string()]).nullable().optional(),
  max_amount: z.union([z.number(), z.string()]).nullable().optional(),
  currency: z.string().nullable().optional(),
  is_remote: z.union([z.boolean(), z.string()]).nullable().optional(),
  job_level: z.string().nullable().optional(),
  job_function: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  company_industry: z.string().nullable().optional(),
  company_url: z.string().nullable().optional(),
});
export type CollectorJob = z.infer<typeof collectorJobSchema>;

export const listingActivitySchema = z.object({
  source: z.string().min(1),
  source_job_id: z.string().nullable().optional(),
  job_url: z.string().url(),
  status: z.enum(['active', 'closed']),
  reason: z.enum(['valid_through', 'http_404', 'http_410', 'closed_message']).optional(),
  evidence: z.string().min(1).max(2000),
  checked_at: z.iso.datetime({ offset: true }),
  valid_through: z.iso.datetime({ offset: true }).nullable().optional(),
}).refine((value) => value.status !== 'closed' || Boolean(value.reason), {
  message: 'Closure requires explicit evidence and a reason',
});
export type ListingActivity = z.infer<typeof listingActivitySchema>;

export const collectorLineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), jobspy_version: z.string(), tasks: z.number() }),
  z.object({ type: z.literal('task_started'), task_id: z.string() }),
  z.object({ type: z.literal('search_head_checked'), task_id: z.string() }),
  z.object({ type: z.literal('request_stats'), task_id: z.string(),
    search_requests: z.number().int().nonnegative(), detail_requests: z.number().int().nonnegative() }),
  z.object({ type: z.literal('search_progress'), task_id: z.string(), cursor: z.object({
    offset: z.number().int().nonnegative().optional(), page: z.number().int().min(1).optional(),
    index: z.number().int().nonnegative().optional(),
  }) }),
  z.object({ type: z.literal('listing_activity'), task_id: z.string(), activity: listingActivitySchema }),
  z.object({
    type: z.literal('job'),
    task_id: z.string(),
    source: z.string(),
    job: collectorJobSchema,
  }),
  z.object({
    type: z.literal('task_result'),
    task_id: z.string(),
    source: z.string(),
    status: z.enum(['succeeded', 'failed', 'skipped']),
    error_kind: z.enum(['rate_limit', 'blocked', 'timeout', 'network', 'error', 'parse']).optional(),
    message: z.string().optional(),
    count: z.number(),
    head_checked: z.boolean().optional(),
    duration_ms: z.number(),
    search_requests: z.number().int().nonnegative().nullable().optional(),
    detail_requests: z.number().int().nonnegative().nullable().optional(),
    retry_after_seconds: z.number().nonnegative().optional(),
  }),
  z.object({ type: z.literal('done'), tasks: z.number() }),
]);
export type CollectorLine = z.infer<typeof collectorLineSchema>;

export type ErrorKind = 'rate_limit' | 'blocked' | 'timeout' | 'network' | 'error' | 'parse' | 'local_startup';
export interface SourceFailure { kind: ErrorKind; message: string; httpStatus?: number; retryAfterSeconds?: number }

export interface CollectorTask {
  task_id: string;
  source: string;
  search_term: string;
  location?: string;
  country_indeed?: string;
  results_wanted: number;
  hours_old: number;
  distance: number;
  description_format: 'markdown' | 'html';
  fetch_description: boolean;
  offset?: number;
  /** When only one search request is allocated, check the head before backfill. */
  head_only?: boolean;
  search_cursor?: SearchCursor;
  detail_request_limit?: number;
  search_request_limit?: number;
  /** Stored listings for enrichment or activity refresh within the same budget. */
  detail_jobs?: Array<CollectorJob & { activity_refresh?: boolean }>;
  enrich_only?: boolean;
  is_remote: boolean;
  job_type?: string;
}

export interface TaskOutcome {
  httpStatus?: number;
  taskId: string;
  source: string;
  searchTerm: string;
  location: string | undefined;
  countryIndeed: string | undefined;
  status: 'Succeeded' | 'Failed' | 'Skipped';
  /** False when the source worker never started this task. */
  executed?: boolean;
  resultCount: number;
  durationMs: number;
  errorKind?: ErrorKind;
  message?: string;
  searchRequests?: number;
  detailRequests?: number;
  retryAfterSeconds?: number;
  nextCursor?: SearchCursor;
  headChecked?: boolean;
}

export interface SearchCursor { offset?: number; page?: number; index?: number }

export interface CollectorOutput {
  jobspyVersion: string | undefined;
  jobs: Array<{ taskId: string; source: string; job: CollectorJob }>;
  activities: ListingActivity[];
  outcomes: TaskOutcome[];
  malformedLines: number;
}
