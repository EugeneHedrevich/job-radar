import { randomUUID } from 'node:crypto';
import { cds, db, SELECT, INSERT, UPDATE, query, queryOne } from '../db/index.js';
import type { NormalizedJob } from '../normalize/index.js';
import { normalizeText, tokenSimilarity } from '../util/text.js';
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
  isDemo: boolean;
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
  context: { runId: string | null; seenAt?: Date; demo?: boolean },
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
  const combined = new Map<string, NormalizedJob>();
  for (const job of normalized) {
    const key = `${job.listing.source}|${job.listing.sourceJobId ?? job.listing.canonicalUrl}`;
    const previous = combined.get(key);
    if (!previous) { combined.set(key, job); continue; }
    // A later search or retry may have retrieved the description. Missing
    // fields from another search must never erase that enrichment.
    const raw = { ...JSON.parse(previous.listing.raw) };
    for (const [field, value] of Object.entries(JSON.parse(job.listing.raw))) {
      if (value !== null && value !== undefined && value !== '') raw[field] = value;
    }
    const merged = { ...previous };
    for (const field of Object.keys(job) as Array<keyof NormalizedJob>) {
      if (field !== 'listing' && job[field] !== null && job[field] !== undefined) {
        Object.assign(merged, { [field]: job[field] });
      }
    }
    merged.listing = { ...previous.listing, ...job.listing,
      hasDescription: Boolean(merged.description), raw: JSON.stringify(raw) };
    combined.set(key, merged);
  }

  for (const job of combined.values()) {

    const existingListing = await findListing(job);
    if (existingListing) {
      await touchListing(existingListing.ID, job, seenAt, context.runId);
      const enriched = await enrichJob(existingListing.job_ID, job, seenAt, true, context.demo);
      if (enriched) result.updated += 1;
      if (existingListing.job_ID) result.jobIds.push(existingListing.job_ID);
      continue;
    }

    const duplicate = await findCrossSourceDuplicate(job, Boolean(context.demo));
    if (duplicate) {
      await insertListing(duplicate.ID, job, seenAt, context.runId);
      await enrichJob(duplicate.ID, job, seenAt, false, context.demo);
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
        isDemo: Boolean(context.demo),
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
 * same specific location must be known. Different same-board identities never
 * participate in this heuristic.
 */
export async function findCrossSourceDuplicate(job: NormalizedJob, demo = false): Promise<JobRow | undefined> {
  if (!job.companyNormalized) return undefined;
  const candidates = await query<JobRow>(
    SELECT.from(db().Jobs).where({ companyNormalized: job.companyNormalized, isDemo: demo }),
  );
  for (const candidate of candidates) {
    // A different identity on the same board is a separate vacancy, even when
    // a recruiter reuses titles or descriptions across clients.
    const sameSource = await queryOne(
      SELECT.from(db().SourceListings).columns('ID')
        .where({ job_ID: candidate.ID, source: job.listing.source }),
    );
    if (sameSource) continue;
    if (isDuplicate(candidate, job)) return candidate;
  }
  return undefined;
}

export function isDuplicate(candidate: JobRow, job: NormalizedJob): boolean {
  if (!candidate.companyNormalized || candidate.companyNormalized !== job.companyNormalized) return false;
  // Recruiter boilerplate is not evidence that conflicting client projects
  // are the same vacancy. Check these facts before description similarity.
  if (candidate.locationCountry && job.locationCountry &&
    normalizeText(candidate.locationCountry) !== normalizeText(job.locationCountry)) return false;
  const candidateCity = specificLocation(candidate.location, candidate.locationCountry);
  const incomingCity = specificLocation(job.location, job.locationCountry);
  if (candidateCity && incomingCity && candidateCity !== incomingCity) return false;
  if (conflictingProjectDetails(candidate.description, job.description)) return false;

  const titleSimilarity = tokenSimilarity(candidate.title, job.title);
  if (titleSimilarity < DEDUPE.minTitleSimilarity) return false;

  if (candidate.description && job.description) {
    if (candidate.descriptionHash && candidate.descriptionHash === job.descriptionHash) return true;
    return tokenSimilarity(candidate.description, job.description) >= DEDUPE.minDescriptionSimilarity;
  }

  // Without descriptions require an exact, specific location. A shared country
  // or an unknown location is insufficient evidence of vacancy identity.
  if (titleSimilarity < DEDUPE.titleOnlySimilarity) return false;
  const location = normalizeText(candidate.location ?? '');
  const incomingLocation = normalizeText(job.location ?? '');
  if (!location || location !== incomingLocation) return false;
  return Boolean(candidateCity);
}

function specificLocation(location: string | null, country: string | null): string {
  const generic = new Set(['remote', 'europe', 'european union', 'eu', 'worldwide', normalizeText(country)]);
  return normalizeText(location).split(',').map((part) => part.trim())
    .filter((part) => part && !generic.has(part) && !/^[a-z]{2}$/.test(part)).join(', ');
}

function projectDetails(description: string | null): Map<string, string> {
  const fields = new Map<string, string>();
  const labels = /\b(end[- ]?client|client(?: (?:country|location))?|project(?: (?:id|code|reference|name|country|location))?|(?:job |requisition )?reference(?: (?:id|number))?|requisition id|start date|duration)\s*:\s*([^\n;.!?]+)/gi;
  for (const match of (description ?? '').matchAll(labels)) {
    const label = normalizeText(match[1]).replace(/^end[- ]?client$/, 'client');
    const value = normalizeText(match[2]);
    if (value && !['unknown', 'not stated', 'confidential', 'tbd'].includes(value)) fields.set(label, value);
  }
  return fields;
}

function conflictingProjectDetails(first: string | null, second: string | null): boolean {
  const a = projectDetails(first);
  const b = projectDetails(second);
  for (const [field, value] of a) {
    if (b.has(field) && b.get(field) !== value) return true;
  }
  return false;
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
  const previous = await queryOne<{ rawRecord: string; hasDescription: boolean }>(SELECT.from(db().SourceListings)
    .columns('rawRecord', 'hasDescription').where({ ID: listingId }));
  const raw = previous ? JSON.parse(previous.rawRecord) : {};
  for (const [key, value] of Object.entries(JSON.parse(job.listing.raw))) {
    if (value !== null && value !== undefined && value !== '') raw[key] = value;
  }
  await cds.run(
    UPDATE(db().SourceListings)
      .set({
        lastSeenAt: seenAt,
        run_ID: runId,
        rawRecord: JSON.stringify(raw),
        hasDescription: job.listing.hasDescription || Boolean(previous?.hasDescription),
      })
      .where({ ID: listingId }),
  );
}

/**
 * Refresh stated values from an existing source listing; new cross-source
 * listings fill missing values only. Unknown values never erase known ones,
 * and firstSeenAt is immutable.
 * Returns true when something other than lastSeenAt changed.
 */
async function enrichJob(
  jobId: string | null, job: NormalizedJob, seenAt: string,
  authoritative: boolean, demo = false,
): Promise<boolean> {
  if (!jobId) return false;
  const current = await queryOne<JobRow>(SELECT.from(db().Jobs).where({ ID: jobId }));
  if (!current) {
    log.warn('Listing points at a missing job', { jobId });
    return false;
  }

  const patch: Record<string, unknown> = { lastSeenAt: seenAt };
  const fill = <K extends keyof JobRow>(key: K, value: JobRow[K] | null) => {
    const previous = current[key];
    // CAP returns Decimal columns as strings; compare their numeric values.
    const unchanged = (key === 'salaryMin' || key === 'salaryMax') && previous !== null && value !== null
      ? Number(previous) === Number(value)
      : value === previous;
    if (value !== null && value !== undefined && !unchanged &&
      (authoritative || previous === null || previous === undefined)) {
      patch[key as string] = value;
    }
  };
  if (authoritative) fill('title', job.title);
  fill('company', job.company);
  fill('companyNormalized', job.companyNormalized);
  fill('location', job.location);
  fill('locationCountry', job.locationCountry);
  if (patch.location && authoritative) patch.locationCountry = job.locationCountry;
  fill('isRemote', job.isRemote);
  fill('jobType', job.jobType);
  fill('salaryMin', job.salaryMin);
  fill('salaryMax', job.salaryMax);
  fill('salaryInterval', job.salaryInterval);
  fill('salaryCurrency', job.salaryCurrency);
  fill('datePosted', job.datePosted);

  if (job.description && job.description !== current.description && (authoritative || !current.description)) {
    patch.description = job.description;
    patch.descriptionHash = job.descriptionHash;
  }
  if (demo && !current.isDemo) patch.isDemo = true;
  if (authoritative && current.primaryUrl !== job.primaryUrl) patch.primaryUrl = job.primaryUrl;

  await cds.run(UPDATE(db().Jobs).set(patch).where({ ID: jobId }));
  return Object.keys(patch).length > 1;
}
