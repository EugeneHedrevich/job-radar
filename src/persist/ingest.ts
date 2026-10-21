import { randomUUID } from 'node:crypto';
import { cds, db, SELECT, INSERT, UPDATE } from '../db/index.js';
import type { NormalizedJob } from '../normalize/index.js';
import { canonicalizeUrl, normalizeText, tokenSimilarity } from '../util/text.js';
import { log } from '../util/log.js';
import { loadConfig } from '../config/index.js';
import { hasPersonalTracking, vacancyRelevance } from '../matching/relevance.js';
import { closedJobIds } from './activity.js';

export interface IngestResult {
  decisions: Array<{ key: string; action: 'created' | 'updated' | 'unchanged' | 'merged' | 'filtered'; jobId?: string; reason?: string }>;
  uniqueListings: number;
  created: number;
  updated: number;
  mergedAcrossSources: number;
  unusable: number;
  jobIds: string[];
  newJobIds: string[];
  updatedJobIds: string[];
  accepted: number;
  filtered: number;
  pendingEnrichment: number;
  exclusionReasons: Record<string, number>;
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
  context: { runId: string | null; seenAt?: Date; demo?: boolean; connection?: any; automatic?: boolean },
): Promise<IngestResult> {
  if (context.connection) return ingestWithin(normalized, context, context.connection);
  return cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    return ingestWithin(normalized, context, tx);
  });
}

async function ingestWithin(normalized: NormalizedJob[],
  context: { runId: string | null; seenAt?: Date; demo?: boolean; automatic?: boolean }, connection: any): Promise<IngestResult> {
  const seenAt = (context.seenAt ?? new Date()).toISOString();
  const result: IngestResult = {
    decisions: [], uniqueListings: 0,
    created: 0,
    updated: 0,
    mergedAcrossSources: 0,
    unusable: 0,
    jobIds: [],
    newJobIds: [],
    updatedJobIds: [],
    accepted: normalized.length,
    filtered: 0,
    pendingEnrichment: 0,
    exclusionReasons: {},
  };
  const config = loadConfig();
  const closed = context.automatic ? await closedJobIds(connection) : new Set<string>();
  const pending = new Set<string>(context.automatic ? (await connection.run(SELECT.from(db().Jobs))).filter((job: any) =>
    !closed.has(job.ID) && !job.isDemo && !job.manuallyImportedAt && !hasPersonalTracking(job) &&
    vacancyRelevance(config, job).state === 'unresolved').map((job: any) => job.ID) : []);
  const refreshPending = async (jobId: string) => {
    if (!pending.has(jobId)) return;
    const saved = await connection.run(SELECT.one.from(db().Jobs).where({ ID: jobId }));
    if (vacancyRelevance(config, saved).state !== 'unresolved') pending.delete(jobId);
  };

  // Guard against the same listing appearing twice inside one collection run
  // (e.g. two keywords returning the same vacancy).
  const combined = new Map<string, NormalizedJob>();
  const occurrences = new Map<string, number>();
  for (const job of normalized) {
    const key = `${job.listing.source}|${job.listing.sourceJobId ?? job.listing.canonicalUrl}`;
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
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

  result.uniqueListings = combined.size;
  for (const [key, job] of combined) {

    const existingListing = await findListing(job, connection);
    if (existingListing) {
      await touchListing(existingListing.ID, job, seenAt, context.runId, connection);
      const enriched = await enrichJob(existingListing.job_ID, job, seenAt, context.demo, connection);
      if (enriched) await refreshPending(existingListing.job_ID!);
      if (enriched) { result.updated += 1; result.updatedJobIds.push(existingListing.job_ID); }
      if (existingListing.job_ID) result.jobIds.push(existingListing.job_ID);
      result.decisions.push({ key, action: enriched ? 'updated' : 'unchanged', jobId: existingListing.job_ID });
      continue;
    }

    const duplicate = await findCrossSourceDuplicate(job, Boolean(context.demo), connection);
    if (duplicate) {
      await insertListing(duplicate.ID, job, seenAt, context.runId, connection);
      await enrichJob(duplicate.ID, job, seenAt, context.demo, connection);
      await refreshPending(duplicate.ID);
      result.mergedAcrossSources += 1;
      result.updatedJobIds.push(duplicate.ID);
      result.jobIds.push(duplicate.ID);
      result.decisions.push({ key, action: 'merged', jobId: duplicate.ID });
      continue;
    }

    // Existing listings and cross-source matches were handled first, preserving their history.
    const relevance = context.automatic ? vacancyRelevance(config, job) : null;
    const waiting = relevance?.state === 'unresolved';
    if (relevance?.state === 'irrelevant' || waiting && pending.size >= config.searches.description_budget.max_pending_candidates) {
      const count = occurrences.get(key)!;
      result.filtered += count;
      result.accepted -= count;
      const reason = waiting ? 'Pending enrichment capacity reached' : relevance!.reason!;
      result.exclusionReasons[reason] = (result.exclusionReasons[reason] ?? 0) + count;
      result.decisions.push({ key, action: 'filtered', reason });
      continue;
    }
    const jobId = randomUUID();
    if (waiting) { pending.add(jobId); result.pendingEnrichment += 1; }
    await connection.run(
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
    await insertListing(jobId, job, seenAt, context.runId, connection);
    result.created += 1;
    result.jobIds.push(jobId);
    result.newJobIds.push(jobId);
    result.decisions.push({ key, action: 'created', jobId });
  }

  result.jobIds = [...new Set(result.jobIds)];
  result.updatedJobIds = [...new Set(result.updatedJobIds)].filter((id) => !result.newJobIds.includes(id));
  return result;
}

async function findListing(job: NormalizedJob, connection: any): Promise<{ ID: string; job_ID: string } | undefined> {
  const { SourceListings } = db();
  if (job.listing.sourceJobId) {
    const bySourceId = await connection.run(
      SELECT.one.from(SourceListings)
        .columns('ID', 'job_ID')
        .where({ source: job.listing.source, sourceJobId: job.listing.sourceJobId }),
    );
    if (bySourceId) return bySourceId;
  }
  return connection.run(
    SELECT.one.from(SourceListings)
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
export async function findCrossSourceDuplicate(job: NormalizedJob, demo = false, connection: any = cds): Promise<JobRow | undefined> {
  if (!job.companyNormalized) return undefined;
  const candidates: JobRow[] = await connection.run(
    SELECT.from(db().Jobs).where({ companyNormalized: job.companyNormalized, isDemo: demo }),
  );
  for (const candidate of candidates) {
    // A different identity on the same board is a separate vacancy, even when
    // a recruiter reuses titles or descriptions across clients.
    const sameSource = await connection.run(
      SELECT.one.from(db().SourceListings).columns('ID')
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
  connection: any,
): Promise<void> {
  await connection.run(
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
  connection: any,
): Promise<void> {
  const previous = await connection.run(SELECT.one.from(db().SourceListings)
    .columns('rawRecord', 'hasDescription').where({ ID: listingId }));
  const raw = previous ? JSON.parse(previous.rawRecord) : {};
  for (const [key, value] of Object.entries(JSON.parse(job.listing.raw))) {
    if (value !== null && value !== undefined && value !== '') raw[key] = value;
  }
  await connection.run(
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
 * The originating listing remains authoritative. Secondary observations only
 * fill missing values, including on later visits. Their raw facts stay on the
 * source listing for review. Unknown values never erase known ones,
 * and firstSeenAt is immutable.
 * Returns true when something other than lastSeenAt changed.
 */
async function enrichJob(
  jobId: string | null, job: NormalizedJob, seenAt: string,
  demo = false, connection: any = cds,
): Promise<boolean> {
  if (!jobId) return false;
  const current: JobRow | undefined = await connection.run(SELECT.one.from(db().Jobs).where({ ID: jobId }));
  if (!current) {
    log.warn('Listing points at a missing job', { jobId });
    return false;
  }
  const authoritative = current.fingerprint === job.fingerprint || canonicalizeUrl(current.primaryUrl) === job.listing.canonicalUrl;

  const patch: Record<string, unknown> = { lastSeenAt: seenAt };
  const fill = <K extends keyof JobRow>(key: K, value: JobRow[K] | null) => {
    const previous = current[key];
    // CAP returns Decimal columns as strings; compare their numeric values.
    const unchanged = (key === 'salaryMin' || key === 'salaryMax') && previous !== null && value !== null
      ? Number(previous) === Number(value)
      : typeof value === 'string' && typeof previous === 'string' ? normalizeText(value) === normalizeText(previous) : value === previous;
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
  const payFields = ['salaryMin', 'salaryMax', 'salaryInterval', 'salaryCurrency'] as const;
  // Never construct a comparable rate from conflicting amounts/units on
  // different sources. A secondary quote must agree with established pay.
  const compatiblePay = authoritative || (Boolean(job.salaryCurrency && job.salaryInterval) ||
    current.salaryCurrency === null && current.salaryInterval === null) && payFields.every((field) =>
    current[field] === null || job[field] === null || (field === 'salaryMin' || field === 'salaryMax'
      ? Number(current[field]) === Number(job[field]) : normalizeText(current[field]) === normalizeText(job[field])));
  if (compatiblePay) for (const field of payFields) fill(field, job[field]);
  fill('datePosted', job.datePosted);

  if (job.description && job.descriptionHash !== current.descriptionHash && (authoritative || !current.description)) {
    patch.description = job.description;
    patch.descriptionHash = job.descriptionHash;
  }
  if (demo && !current.isDemo) patch.isDemo = true;
  if (authoritative && canonicalizeUrl(current.primaryUrl) !== canonicalizeUrl(job.primaryUrl)) patch.primaryUrl = job.primaryUrl;

  await connection.run(UPDATE(db().Jobs).set(patch).where({ ID: jobId }));
  return Object.keys(patch).length > 1;
}

/** Latest conflicting source observations are retained in rawRecord, outside
 * the assessment cache key. Show them in details rather than changing facts. */
export function conflictingFacts(current: JobRow, observed: NormalizedJob): Array<{ field: string; value: string }> {
  return (['description', 'jobType', 'isRemote', 'location', 'salaryMin', 'salaryMax', 'salaryInterval', 'salaryCurrency', 'datePosted'] as const)
    .filter((field) => current[field] !== null && observed[field] !== null &&
      (field === 'salaryMin' || field === 'salaryMax' ? Number(current[field]) !== Number(observed[field]) :
        normalizeText(String(current[field])) !== normalizeText(String(observed[field]))))
    .map((field) => ({ field, value: String(observed[field]) }));
}
