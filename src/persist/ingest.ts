import { randomUUID } from 'node:crypto';
import { cds, db, SELECT, INSERT, UPDATE, query, queryOne } from '../db/index.js';
import type { NormalizedJob } from '../normalize/index.js';
import { tokenSimilarity } from '../util/text.js';
import { log } from '../util/log.js';

export interface IngestResult {
  created: number;
  updated: number;
  mergedAcrossSources: number;
  unusable: number;
  jobIds: string[];
  newJobIds: string[];
}

export interface JobRow {
  ID: string;
  fingerprint: string;
  title: string;
  company: string | null;
  companyNormalized: string | null;
  location: string | null;
  locationCountry: string | null;
  isRemote: boolean | null;
  jobType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryInterval: string | null;
  salaryCurrency: string | null;
  description: string | null;
  descriptionHash: string | null;
  primaryUrl: string;
  datePosted: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  status: string;
}

/** Thresholds for cross-source duplicate detection. */
export const DEDUPE = {
  minTitleSimilarity: 0.6,
  minDescriptionSimilarity: 0.7,
  /** Used only when descriptions are unavailable on one of the two sides. */
  titleOnlySimilarity: 0.85,
};

export async function ingestJobs(
  normalized: NormalizedJob[],
  context: { runId: string | null; seenAt?: Date },
): Promise<IngestResult> {
  const seenAt = (context.seenAt ?? new Date()).toISOString();
  const result: IngestResult = {
    created: 0,
    updated: 0,
    mergedAcrossSources: 0,
    unusable: 0,
    jobIds: [],
    newJobIds: [],
  };

  // Guard against the same listing appearing twice inside one collection run
  // (e.g. two keywords returning the same vacancy).
  const seenInBatch = new Set<string>();

  for (const job of normalized) {
    const batchKey = `${job.listing.source}|${job.listing.sourceJobId ?? job.listing.canonicalUrl}`;
    if (seenInBatch.has(batchKey)) continue;
    seenInBatch.add(batchKey);

    const existingListing = await findListing(job);
    if (existingListing) {
      await touchListing(existingListing.ID, job, seenAt, context.runId);
      const enriched = await enrichJob(existingListing.job_ID, job, seenAt);
      if (enriched) result.updated += 1;
      if (existingListing.job_ID) result.jobIds.push(existingListing.job_ID);
      continue;
    }

    const duplicate = await findCrossSourceDuplicate(job);
    if (duplicate) {
      await insertListing(duplicate.ID, job, seenAt, context.runId);
      await enrichJob(duplicate.ID, job, seenAt);
      result.mergedAcrossSources += 1;
      result.jobIds.push(duplicate.ID);
      continue;
    }

    const jobId = randomUUID();
    await cds.run(
      INSERT.into(db().Jobs).entries({
        ID: jobId,
        fingerprint: job.fingerprint,
        title: job.title,
        company: job.company,
        companyNormalized: job.companyNormalized,
        location: job.location,
        locationCountry: job.locationCountry,
        isRemote: job.isRemote,
        jobType: job.jobType,
        salaryMin: job.salaryMin,
        salaryMax: job.salaryMax,
        salaryInterval: job.salaryInterval,
        salaryCurrency: job.salaryCurrency,
        description: job.description,
        descriptionHash: job.descriptionHash,
        primaryUrl: job.primaryUrl,
        datePosted: job.datePosted,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
        status: 'New',
      }),
    );
    await insertListing(jobId, job, seenAt, context.runId);
    result.created += 1;
    result.jobIds.push(jobId);
    result.newJobIds.push(jobId);
  }

  return result;
}

async function findListing(job: NormalizedJob): Promise<{ ID: string; job_ID: string } | undefined> {
  const { SourceListings } = db();
  if (job.listing.sourceJobId) {
    const bySourceId = await queryOne<{ ID: string; job_ID: string }>(
      SELECT.from(SourceListings)
        .columns('ID', 'job_ID')
        .where({ source: job.listing.source, sourceJobId: job.listing.sourceJobId }),
    );
    if (bySourceId) return bySourceId;
  }
  return queryOne<{ ID: string; job_ID: string }>(
    SELECT.from(SourceListings)
      .columns('ID', 'job_ID')
      .where({ source: job.listing.source, canonicalUrl: job.listing.canonicalUrl }),
  );
}

/**
 * Cross-source duplicate detection.
 *
 * A match requires the same company. Titles alone are never enough: either the
 * descriptions must be similar, or the titles must be near-identical AND the
 * locations compatible.
 */
export async function findCrossSourceDuplicate(job: NormalizedJob): Promise<JobRow | undefined> {
  if (!job.companyNormalized) return undefined;
  const candidates = await query<JobRow>(
    SELECT.from(db().Jobs).where({ companyNormalized: job.companyNormalized }),
  );
  for (const candidate of candidates) {
    if (isDuplicate(candidate, job)) return candidate;
  }
  return undefined;
}

export function isDuplicate(candidate: JobRow, job: NormalizedJob): boolean {
  if (!candidate.companyNormalized || candidate.companyNormalized !== job.companyNormalized) return false;

  const titleSimilarity = tokenSimilarity(candidate.title, job.title);
  if (titleSimilarity < DEDUPE.minTitleSimilarity) return false;

  if (candidate.description && job.description) {
    if (candidate.descriptionHash && candidate.descriptionHash === job.descriptionHash) return true;
    return tokenSimilarity(candidate.description, job.description) >= DEDUPE.minDescriptionSimilarity;
  }

  // Without descriptions we need near-identical titles and compatible locations.
  if (titleSimilarity < DEDUPE.titleOnlySimilarity) return false;
  const countriesKnown = candidate.locationCountry && job.locationCountry;
  if (countriesKnown && candidate.locationCountry !== job.locationCountry) return false;
  return true;
}

async function insertListing(
  jobId: string,
  job: NormalizedJob,
  seenAt: string,
  runId: string | null,
): Promise<void> {
  await cds.run(
    INSERT.into(db().SourceListings).entries({
      ID: randomUUID(),
      job_ID: jobId,
      source: job.listing.source,
      sourceJobId: job.listing.sourceJobId,
      canonicalUrl: job.listing.canonicalUrl,
      rawUrl: job.listing.rawUrl,
      directUrl: job.listing.directUrl,
      hasDescription: job.listing.hasDescription,
      rawRecord: job.listing.raw,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      run_ID: runId,
    }),
  );
}

async function touchListing(
  listingId: string,
  job: NormalizedJob,
  seenAt: string,
  runId: string | null,
): Promise<void> {
  await cds.run(
    UPDATE(db().SourceListings)
      .set({
        lastSeenAt: seenAt,
        run_ID: runId,
        rawRecord: job.listing.raw,
        hasDescription: job.listing.hasDescription,
      })
      .where({ ID: listingId }),
  );
}

/**
 * Refresh a job from a newly seen listing. Known values are never replaced by
 * unknown ones, and firstSeenAt is immutable.
 * Returns true when something other than lastSeenAt changed.
 */
async function enrichJob(jobId: string | null, job: NormalizedJob, seenAt: string): Promise<boolean> {
  if (!jobId) return false;
  const current = await queryOne<JobRow>(SELECT.from(db().Jobs).where({ ID: jobId }));
  if (!current) {
    log.warn('Listing points at a missing job', { jobId });
    return false;
  }

  const patch: Record<string, unknown> = { lastSeenAt: seenAt };
  const fill = <K extends keyof JobRow>(key: K, value: JobRow[K] | null) => {
    if (value !== null && value !== undefined && (current[key] === null || current[key] === undefined)) {
      patch[key as string] = value;
    }
  };
  fill('company', job.company);
  fill('companyNormalized', job.companyNormalized);
  fill('location', job.location);
  fill('locationCountry', job.locationCountry);
  fill('isRemote', job.isRemote);
  fill('jobType', job.jobType);
  fill('salaryMin', job.salaryMin);
  fill('salaryMax', job.salaryMax);
  fill('salaryInterval', job.salaryInterval);
  fill('salaryCurrency', job.salaryCurrency);
  fill('datePosted', job.datePosted);

  // A description that arrives later (e.g. from a description-budget run) is a
  // genuine upgrade and replaces the empty one.
  if (job.description && !current.description) {
    patch.description = job.description;
    patch.descriptionHash = job.descriptionHash;
  }

  await cds.run(UPDATE(db().Jobs).set(patch).where({ ID: jobId }));
  return Object.keys(patch).length > 1;
}
