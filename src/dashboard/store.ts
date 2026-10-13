import { z } from 'zod';
import { loadConfig, resetConfigCache, type AppConfig } from '../config/index.js';
import { cds, db, SELECT, UPDATE, query, queryOne } from '../db/index.js';
import { listingIsClosed } from '../persist/activity.js';
import { assessmentCacheKey, currentAssessmentKeys, findCurrentAssessment, rowToAssessment } from '../pipeline/rank.js';
import { suppressIgnoredWork } from '../pipeline/ignored.js';
import { APPLICATION_STATUSES, type Activity, type AssessmentKind, type CollectionStatus,
  type JobDetail, type JobList, type JobSummary, type SavedAssessment, type Tracking } from './types.js';
import { ApiError } from './errors.js';
import { listReminders, syncCvFollowUp } from './reminders.js';
import { aiOutcomeOf, MAX_AI_ATTEMPTS, PENDING_AI_STATUSES } from '../pipeline/ai-queue.js';
import { eligibleForAiRetry } from './assessment-retry.js';
import { linkedinCoverage } from '../collector/plan.js';

export { ApiError } from './errors.js';

export const trackingPatchSchema = z.object({
  status: z.enum(APPLICATION_STATUSES).optional(),
  personalNotes: z.string().max(20_000).optional(),
  applicationDate: z.iso.date().nullable().optional(),
  cvSent: z.boolean().optional(),
  cvSentAt: z.iso.datetime({ offset: true }).nullable().optional(),
  sentCvLabel: z.string().max(500).nullable().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, 'No tracking fields supplied');

const listSchema = z.object({
  view: z.enum(['vacancies', 'applications', 'imports']).default('vacancies'),
  q: z.string().max(500).default(''),
  source: z.array(z.string().min(1).max(50)).max(50).default([]),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  status: z.enum(APPLICATION_STATUSES).optional(),
  activity: z.enum(['Active', 'Unknown', 'Closed']).optional(),
  sort: z.enum(['firstSeenAt', 'lastSeenAt', 'datePosted', 'fitScore', 'title', 'company']).default('firstSeenAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '));
  return parsed.data;
}

function tracking(row: any): Tracking {
  return { status: row.status ?? 'New', personalNotes: row.personalNotes ?? '',
    applicationDate: row.applicationDate ?? null, cvSent: Boolean(row.cvSent), cvSentAt: row.cvSentAt ?? null,
    sentCvLabel: row.sentCvLabel ?? null };
}

function listingActivity(row: any, at: Date): Activity {
  return listingIsClosed(row, at) ? 'Closed' : row.activityState === 'Active' ? 'Active' : 'Unknown';
}

/** All listings must be closed to close a deduplicated job; absence proves nothing. */
function jobActivity(listings: any[], at: Date): Activity {
  if (listings.length && listings.every((row) => listingIsClosed(row, at))) return 'Closed';
  return listings.some((row) => listingActivity(row, at) === 'Active') ? 'Active' : 'Unknown';
}

function assessmentKind(config: AppConfig, job: any, row: any): AssessmentKind {
  if (row.engine === 'llm') return 'ai';
  // Failed/rejected AI attempts deliberately use the paid attempt key but retain
  // the rules engine. The stored explanation also identifies historical fallbacks.
  return row.cacheKey === assessmentCacheKey(config, job, 'llm') ||
    /AI request failed|AI assessment unavailable|rules fallback used|AI assessment uncertainty:/i
      .test(`${row.explanation ?? ''} ${row.missingInformation ?? ''}`) ? 'ai-fallback' : 'rules';
}

function score(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function savedAssessment(config: AppConfig, job: any, row: any, current: boolean): SavedAssessment {
  return { ...rowToAssessment(row), ID: row.ID, fitScore: score(row.fitScore),
    createdAt: row.createdAt ?? null, kind: assessmentKind(config, job, row), current,
    aiOutcome: aiOutcomeOf(row), aiReason: row.aiReason ?? null };
}

async function summarize(config: AppConfig, job: any, listings: any[], assessments: any[], queue: any[], at: Date): Promise<JobSummary> {
  const current = await findCurrentAssessment(config, job, assessments);
  const activity = jobActivity(listings, at);
  const aiKey = assessmentCacheKey(config, job, 'llm');
  const pending = job.status !== 'Ignored' && activity !== 'Closed' && queue.find((row) =>
    ['Pending', 'RetryPending', 'Attempting'].includes(row.status) && row.cacheKey === aiKey &&
    (row.status !== 'Pending' || !assessments.some((saved) => saved.cacheKey === aiKey)));
  return { ID: job.ID, title: job.title, company: job.company, location: job.location,
    isRemote: job.isRemote ?? null, manuallyImportedAt: job.manuallyImportedAt ?? null, nextFollowUp: null,
    jobType: job.jobType, salaryMin: score(job.salaryMin), salaryMax: score(job.salaryMax),
    salaryCurrency: job.salaryCurrency, salaryInterval: job.salaryInterval,
    sources: [...new Set<string>(listings.map((row) => row.source))].sort(), activity,
    datePosted: job.datePosted, firstSeenAt: job.firstSeenAt, lastSeenAt: job.lastSeenAt,
    fitScore: current ? score(current.fitScore) : null,
    recommendation: current?.recommendation ?? null,
    assessmentState: current ? assessmentKind(config, job, current) : assessments.length ? 'outdated' : 'unassessed',
    assessedAt: current?.createdAt ?? null, aiPending: Boolean(pending), aiQueuedAt: pending?.queuedAt ?? null,
    isDemo: Boolean(job.isDemo), ...tracking(job) };
}

function groupByJob(rows: any[]): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const row of rows) {
    const group = groups.get(row.job_ID) ?? [];
    group.push(row); groups.set(row.job_ID, group);
  }
  return groups;
}

function dashboardConfig(): AppConfig {
  // This server is long-lived; edited YAML must invalidate saved assessments
  // on the next read just as it does on the next CLI invocation.
  resetConfigCache();
  return loadConfig();
}

/** A small single-user dataset: bulk stored reads, then filter/page valid scores. */
export async function listJobs(params = new URLSearchParams()): Promise<JobList> {
  const input = parseInput(listSchema, { ...Object.fromEntries(params),
    source: [...new Set(params.getAll('source').flatMap((value) => value.split(','))
      .map((value) => value.trim()).filter(Boolean))] });
  const config = dashboardConfig();
  const [jobs, listings, assessments, queue, reminders] = await Promise.all([
    query(SELECT.from(db().Jobs)),
    query(SELECT.from(db().SourceListings).columns('job_ID', 'source', 'activityState', 'validThrough')),
    query(SELECT.from(db().Assessments).columns('ID', 'job_ID', 'cacheKey', 'engine', 'fitScore', 'recommendation',
      'createdAt', 'explanation', 'missingInformation', 'aiOutcome', 'aiReason')),
    query(SELECT.from(db().AiAssessmentQueue).where({ status: { in: PENDING_AI_STATUSES.concat('Attempting') } })),
    listReminders(),
  ]);
  const byListing = groupByJob(listings), byAssessment = groupByJob(assessments), byQueue = groupByJob(queue);
  const at = new Date();
  const summaries = await Promise.all(jobs.map((job) => summarize(config, job,
    byListing.get(job.ID) ?? [], byAssessment.get(job.ID) ?? [], byQueue.get(job.ID) ?? [], at)));
  for (const job of summaries) {
    const next = reminders.find((reminder) => reminder.jobId === job.ID);
    job.nextFollowUp = next ? { ID: next.ID, dueDate: next.dueDate } : null;
  }
  const needle = input.q.trim().toLocaleLowerCase();
  const filtered = summaries.filter((job) =>
    (input.view !== 'applications' || job.cvSent || job.applicationDate || Boolean(job.personalNotes.trim()) || job.status !== 'New') &&
    (input.view !== 'imports' || Boolean(job.manuallyImportedAt)) &&
    (!needle || [job.title, job.company, job.location, job.personalNotes].some((value) => value?.toLocaleLowerCase().includes(needle))) &&
    (!input.source.length || job.sources.some((source) => input.source.includes(source))) &&
    (input.view !== 'vacancies' || input.minScore === undefined || job.fitScore !== null && job.fitScore >= input.minScore ||
      Boolean(job.manuallyImportedAt) && (job.assessmentState === 'unassessed' || job.assessmentState === 'outdated' || job.aiPending)) &&
    (!input.status || job.status === input.status) && (input.view === 'applications' || !input.activity || job.activity === input.activity));
  filtered.sort((a, b) => {
    const left = a[input.sort], right = b[input.sort];
    // Unknown scores/dates remain last in both directions; a real zero is valid.
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    const order = typeof left === 'number' && typeof right === 'number' ? left - right :
      String(left ?? '').localeCompare(String(right ?? ''));
    return order * (input.direction === 'asc' ? 1 : -1) || a.ID.localeCompare(b.ID);
  });
  const page = Math.min(input.page, Math.max(1, Math.ceil(filtered.length / input.pageSize)));
  return { items: filtered.slice((page - 1) * input.pageSize, page * input.pageSize),
    total: filtered.length, storedTotal: summaries.length, page, pageSize: input.pageSize,
    sources: [...new Set(summaries.flatMap((job) => job.sources))].sort() };
}

export async function readJob(id: string): Promise<JobDetail> {
  const job = await queryOne(SELECT.from(db().Jobs).where({ ID: id }));
  if (!job) throw new ApiError(404, 'Vacancy not found');
  const config = dashboardConfig();
  const [listings, assessments, queue] = await Promise.all([
    query(SELECT.from(db().SourceListings).where({ job_ID: id })),
    query(SELECT.from(db().Assessments).where({ job_ID: id }).orderBy('createdAt desc')),
    query(SELECT.from(db().AiAssessmentQueue).where({ job_ID: id })),
  ]);
  const at = new Date();
  const current = await findCurrentAssessment(config, job, assessments);
  const validKeys = currentAssessmentKeys(config, job);
  const reminders = await listReminders(id);
  const next = reminders.find((reminder) => reminder.status === 'Pending');
  const work = queue.find((row) => row.cacheKey === assessmentCacheKey(config, job, 'llm'));
  const fallback = current && assessmentKind(config, job, current) === 'ai-fallback';
  const attempts = Math.max(work?.attempts ?? 0, fallback ? 1 : 0);
  const retryAfter = work?.retryAfter ?? null;
  return { ...await summarize(config, job, listings, assessments, queue, at),
    description: job.description, primaryUrl: job.primaryUrl, isRemote: job.isRemote, locationCountry: job.locationCountry,
    reminders, nextFollowUp: next ? { ID: next.ID, dueDate: next.dueDate } : null,
    aiRetry: fallback || work && ['Failed', 'Rejected', 'RetryPending'].includes(work.status) ? {
      attempts, maxAttempts: MAX_AI_ATTEMPTS, retryAfter, reason: work?.lastReason ?? current?.aiReason ?? null, queued: work?.status === 'RetryPending',
      canRetry: Boolean(eligibleForAiRetry(config, job) && jobActivity(listings, at) !== 'Closed' &&
        attempts < MAX_AI_ATTEMPTS && work?.status !== 'Attempting' && (!retryAfter || new Date(retryAfter) <= at)) } : null,
    listings: listings.map((row) => ({ ID: row.ID, source: row.source,
      url: row.directUrl ?? row.rawUrl ?? row.canonicalUrl, activity: listingActivity(row, at),
      activityCheckedAt: row.activityCheckedAt ?? null, validThrough: row.validThrough ?? null,
      closureReason: row.closureReason ?? null, activityEvidence: row.activityEvidence ?? null,
      firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt })),
    currentAssessment: current ? savedAssessment(config, job, current, true) : null,
    assessmentHistory: assessments.filter((row) => row.ID !== current?.ID)
      .map((row) => savedAssessment(config, job, row, validKeys.includes(row.cacheKey))) };
}

/** Sole personal-tracking write path; ingestion never owns these fields. */
export async function updateTracking(id: string, input: unknown): Promise<Tracking> {
  const patch = parseInput(trackingPatchSchema, input);
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const previous = await tx.run(SELECT.one.from(db().Jobs).where({ ID: id }));
    if (!previous) throw new ApiError(404, 'Vacancy not found');
    const nextSent = patch.cvSent ?? Boolean(previous.cvSent);
    if (nextSent && !previous.cvSent && !patch.cvSentAt) throw new ApiError(400, 'Choose the actual CV send date and time');
    if (!nextSent && patch.cvSentAt) throw new ApiError(400, 'A send date requires CV sent');
    if (nextSent && previous.cvSentAt && patch.cvSentAt === null) throw new ApiError(400, 'Clear CV sent to remove its send date');
    if (patch.cvSentAt) patch.cvSentAt = new Date(patch.cvSentAt).toISOString();
    const values = { ...patch, ...(!nextSent ? { cvSentAt: null } : {}) };
    await tx.run(UPDATE(db().Jobs).set(values).where({ ID: id }));
    if (patch.cvSent === true && !previous.cvSent) {
      await tx.run(UPDATE(db().Jobs).set({ status: 'Applied' }).where({ ID: id, status: { in: ['New', 'Interested'] } }));
    }
    if (patch.status === 'Ignored') await suppressIgnoredWork(tx, id);
    const row = await tx.run(SELECT.one.from(db().Jobs).where({ ID: id }));
    await syncCvFollowUp(tx, previous, row);
    return tracking(row);
  });
}

/** Stored status only: no lifecycle recovery, collection, ranking or delivery. */
export async function readCollectionStatus(): Promise<CollectionStatus> {
  const latestRun = await queryOne(SELECT.from(db().CollectionRuns).orderBy('startedAt desc', 'ID desc'));
  const [sources, tasks, errors] = await Promise.all([
    query(SELECT.from(db().SourceHealth).orderBy('source')),
    latestRun ? query(SELECT.from(db().CollectionTasks).where({ run_ID: latestRun.ID })) : Promise.resolve([]),
    latestRun ? query(SELECT.from(db().CollectionErrors).where({ run_ID: latestRun.ID }).orderBy('occurredAt desc')) : Promise.resolve([]),
  ]);
  const coverage = linkedinCoverage(loadConfig());
  const { taskKeys, ...coverageCounts } = coverage;
  const headRows = await query(SELECT.from(db().SearchProgress).columns('taskKey', 'headCheckedAt'));
  const cutoff = Date.now() - coverage.freshnessHours * 3_600_000;
  return { linkedinCoverage: { ...coverageCounts, checkedWithinWindow: headRows.filter((row) =>
    taskKeys.includes(row.taskKey) && row.headCheckedAt && new Date(row.headCheckedAt).getTime() >= cutoff).length },
    latestRun: latestRun ? { ID: latestRun.ID, startedAt: latestRun.startedAt,
    heartbeatAt: latestRun.heartbeatAt ?? null, finishedAt: latestRun.finishedAt ?? null,
    trigger: latestRun.trigger ?? null, batchKey: latestRun.batchKey ?? null, status: latestRun.status,
    jobsFound: latestRun.jobsFound ?? 0, jobsNew: latestRun.jobsNew ?? 0, jobsUpdated: latestRun.jobsUpdated ?? 0,
    tasks: tasks.map((row) => ({ source: row.source, status: row.status, resultCount: row.resultCount, message: row.message ?? null,
      searchRequests: row.searchRequests ?? null, detailRequests: row.detailRequests ?? null })),
    errors: errors.map((row) => ({ source: row.source ?? null, kind: row.kind, message: row.message, occurredAt: row.occurredAt ?? null })) } : null,
    sources: sources.map((row) => ({ source: row.source, consecutiveFailures: row.consecutiveFailures ?? 0,
      cooldownUntil: row.cooldownUntil ?? null, blocked: Boolean(row.blocked), lastStatus: row.lastStatus ?? null,
      lastMessage: row.lastMessage ?? null, updatedAt: row.updatedAt ?? null })) };
}
