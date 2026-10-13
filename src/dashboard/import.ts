import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, PROJECT_ROOT } from '../config/index.js';
import { collectorJobSchema, listingActivitySchema, type CollectorJob, type ListingActivity } from '../collector/types.js';
import { claimImportSource, recordOutcomes, settleSourceRequests } from '../collector/health.js';
import { cds, db, SELECT, UPDATE } from '../db/index.js';
import { canonicalizeUrl } from '../util/text.js';
import { normalizeJob } from '../normalize/index.js';
import { ingestJobs } from '../persist/ingest.js';
import { applyListingActivity } from '../persist/activity.js';
import { rank } from '../pipeline/rank.js';
import { readJob } from './store.js';
import { ApiError } from './errors.js';
import type { ImportResult } from './types.js';
import { vacancyRelevance } from '../matching/relevance.js';

const inputSchema = z.object({ url: z.string().url().max(1000), title: z.string().trim().max(500).optional(),
  description: z.string().trim().max(60_000).optional(), company: z.string().trim().max(500).optional(),
  location: z.string().trim().max(500).optional(), detailsToken: z.string().uuid().optional() }).strict();
const metadataSchema = z.object({ job: collectorJobSchema.nullable(), activity: listingActivitySchema.nullable(), message: z.string().max(2000),
  requests: z.number().int().min(0).max(3).nullable().optional(),
  failure: z.object({ kind: z.enum(['rate_limit', 'blocked', 'timeout', 'network', 'error', 'parse']),
    message: z.string().max(2000), httpStatus: z.number().int().optional(), retryAfterSeconds: z.number().nonnegative().optional() }).nullable().optional() });
export type ImportMetadata = z.infer<typeof metadataSchema>;
const pendingDetails = new Map<string, { url: string; metadata: ImportMetadata; expiresAt: number }>();

const hosts: Record<string, string> = {
  'redglobal.com': 'redglobal', 'eursap.eu': 'eursap', 'whitehallresources.com': 'whitehall',
  'next-ventures.com': 'nextventures', 'remotive.com': 'remotive', 'arbeitnow.com': 'arbeitnow',
  'arbeitnow.co.uk': 'arbeitnow', 'arbeitnow.ch': 'arbeitnow', 'arbeitnow.fr': 'arbeitnow',
  'remoteok.com': 'remoteok', 'jobicy.com': 'jobicy',
  'indeed.com': 'indeed', 'indeed.de': 'indeed', 'indeed.nl': 'indeed', 'indeed.co.uk': 'indeed',
  'glassdoor.com': 'glassdoor', 'glassdoor.de': 'glassdoor', 'glassdoor.co.uk': 'glassdoor',
};

function importUrl(value: string): { url: string; source: string } {
  const url = new URL(value);
  const host = url.hostname.replace(/^www\./, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
    !host.includes('.') || host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') ||
    /\.(?:local|localhost|internal|test|invalid)$/.test(host)) throw new ApiError(400, 'Use a public HTTPS vacancy URL');
  let source = hosts[host] ?? 'manual';
  if (/^(?:[a-z]{2}\.)?linkedin\.com$/.test(host)) source = 'linkedin';
  if (/^michaelpage\.(?:pl|de|nl|co\.uk|ch|fr|ae)$/.test(host)) source = 'michaelpage';
  // Use each adapter's configured public hostname; validation is repeated in Python.
  if (['redglobal', 'whitehall', 'arbeitnow', 'michaelpage'].includes(source)) url.hostname = `www.${host}`;
  url.hash = '';
  return { url: url.href, source };
}

async function fetchMetadata(source: string, url: string, requestLimit = 3): Promise<ImportMetadata> {
  const unverified = (message: string): ImportMetadata => ({ job: null, activity: null, message });
  if (['manual', 'indeed', 'glassdoor'].includes(source)) return unverified('This URL has no supported public detail adapter. Enter the title and description.');
  const config = loadConfig();
  if (!config.searches.sources[source]?.enabled) return unverified('This source is disabled. Enter the title and description.');
  return new Promise((resolve) => {
    const child = spawn(config.pythonPath, [path.join(PROJECT_ROOT, 'python/import_vacancy.py')],
      { cwd: PROJECT_ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const done = (value: ImportMetadata) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 35_000);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ source, url, request_limit: requestLimit }));
    child.stdout.on('data', (chunk) => { output += String(chunk); if (output.length > 256_000) child.kill('SIGKILL'); });
    child.stderr.resume();
    child.on('error', () => done(unverified('The local metadata adapter could not start. Enter the title and description.')));
    child.on('close', () => {
      try { const parsed = metadataSchema.safeParse(JSON.parse(output));
        done(parsed.success ? parsed.data : { ...unverified('Metadata could not be parsed.'),
          failure: { kind: 'parse', message: 'Metadata could not be parsed.' } }); }
      catch { const message = timedOut ? 'Metadata lookup timed out' : 'Metadata lookup failed';
        done({ ...unverified(message), requests: null, failure: { kind: timedOut ? 'timeout' : 'error', message } }); }
    });
  });
}

async function lookupWithHealth(source: string, url: string, lookup: (source: string, url: string, requestLimit: number) => Promise<ImportMetadata>): Promise<ImportMetadata> {
  const config = loadConfig();
  if (['manual', 'indeed', 'glassdoor'].includes(source) || !config.searches.sources[source]?.enabled)
    return { job: null, activity: null, message: 'No enabled public detail adapter. Enter the title and description.' };
  const claim = await claimImportSource(source);
  if (!claim.token) return { job: null, activity: null, message: claim.reason!, requests: 0 };
  const startedAt = new Date();
  let used: number | undefined;
  try {
    let metadata: ImportMetadata;
    try { metadata = metadataSchema.parse(await lookup(source, url, claim.detailLimit)); }
    catch (error) { metadata = { job: null, activity: null, message: String(error).slice(0, 1000),
      failure: { kind: 'error', message: String(error).slice(0, 1000) } }; }
    used = metadata.requests ?? undefined;
    if (metadata.failure || metadata.activity) {
      await recordOutcomes(config, [{ taskId: `import:${claim.token}`, source, searchTerm: '', location: undefined,
        countryIndeed: undefined, status: metadata.failure ? 'Failed' : 'Succeeded', resultCount: metadata.job ? 1 : 0,
        durationMs: Date.now() - startedAt.getTime(), errorKind: metadata.failure?.kind,
        message: metadata.failure?.message, retryAfterSeconds: metadata.failure?.retryAfterSeconds,
        httpStatus: metadata.failure?.httpStatus,
        detailRequests: metadata.requests ?? undefined }], new Date(), startedAt);
    }
    return metadata;
  } finally { await settleSourceRequests(source, claim.token, 0, used); }
}

async function canonicalMatch(urls: string[], connection: any = cds): Promise<string | undefined> {
  const wanted = new Set(urls.filter(Boolean).map(canonicalizeUrl));
  const rows = await connection.run(SELECT.from(db().SourceListings).columns('job_ID', 'canonicalUrl', 'rawUrl', 'directUrl'));
  return rows.find((row: any) => [row.canonicalUrl, row.rawUrl, row.directUrl]
    .some((url) => url && wanted.has(canonicalizeUrl(url))))?.job_ID;
}

/** Network lookup precedes a short atomic duplicate check and ingestion. */
export async function importVacancy(input: unknown,
  lookup: (source: string, url: string, requestLimit: number) => Promise<ImportMetadata> = fetchMetadata): Promise<ImportResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'Provide a valid URL and bounded vacancy details');
  const fields = parsed.data;
  const target = importUrl(fields.url);
  const duplicate = await canonicalMatch([fields.url, target.url]);
  if (duplicate) return alreadyTracked(duplicate);
  // Explicit fallback submission makes no second network request.
  const previous = fields.detailsToken ? pendingDetails.get(fields.detailsToken) : undefined;
  const metadata: ImportMetadata = previous && previous.expiresAt > Date.now() && previous.url === target.url ? previous.metadata
    : fields.title && fields.description ? { job: null, activity: null, message: 'Added with the details you supplied; availability could not be verified.' }
      : await lookupWithHealth(target.source, target.url, lookup);
  const availability = metadata.failure ? 'Could not verify' : metadata.activity?.status === 'closed' ? 'Closed'
    : metadata.activity?.status === 'active' ? 'Active' : 'Could not verify';
  const record: CollectorJob = { ...metadata.job, job_url: metadata.job?.job_url ?? target.url,
    title: metadata.job?.title || fields.title, description: metadata.job?.description || fields.description,
    company: metadata.job?.company || fields.company, location: metadata.job?.location || fields.location };
  if (!record.title?.trim() || !record.description?.trim()) {
    for (const [key, draft] of pendingDetails) if (draft.expiresAt <= Date.now()) pendingDetails.delete(key);
    if (pendingDetails.size >= 100) pendingDetails.delete(pendingDetails.keys().next().value!);
    const detailsToken = randomUUID();
    pendingDetails.set(detailsToken, { url: target.url, metadata, expiresAt: Date.now() + 10 * 60_000 });
    return { result: 'Needs details', availability, detailsToken, failure: metadata.failure,
      job: null, message: `${metadata.message}. Enter a title and description to save this vacancy.` };
  }
  const normalized = normalizeJob(record, target.source);
  if (!normalized) throw new ApiError(400, 'A title and vacancy URL are required');
  const relevance = vacancyRelevance(loadConfig(), normalized);
  const saved = await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const existing = await canonicalMatch([fields.url, target.url, normalized.listing.canonicalUrl], tx);
    if (existing) return { id: existing, added: false, touched: false };
    const result = await ingestJobs([normalized], { runId: null, connection: tx });
    const id = result.jobIds[0]!;
    await tx.run(UPDATE(db().Jobs).set({ manuallyImportedAt: new Date().toISOString() }).where({ ID: id }));
    return { id, added: result.created > 0, touched: true };
  });
  if (!saved.touched) return alreadyTracked(saved.id);
  if (metadata.activity && !metadata.failure) await applyListingActivity([metadata.activity as ListingActivity]);
  if (fields.detailsToken) pendingDetails.delete(fields.detailsToken);
  // Deterministic caching and durable eligibility queue; paid work uses the next
  // collection's shared five-call allowance, never a per-import extra allowance.
  await rank({ jobIds: [saved.id], rulesOnly: true });
  return { result: saved.added ? 'Added' : 'Already tracked', availability, failure: metadata.failure,
    job: await readJob(saved.id), message: `${saved.added ? metadata.message : 'This vacancy is already in your radar.'}${
      !relevance.accepted ? ` Relevance warning: ${relevance.reason}. Saved because you added it manually.` : ''}` };
}

async function alreadyTracked(id: string): Promise<ImportResult> {
  let job = await readJob(id);
  if (!job.manuallyImportedAt) {
    await cds.run(UPDATE(db().Jobs).set({ manuallyImportedAt: new Date().toISOString() }).where({ ID: id, manuallyImportedAt: null }));
    job = await readJob(id);
  }
  const relevance = vacancyRelevance(loadConfig(), job);
  return { result: 'Already tracked', job, availability: job.activity === 'Unknown' ? 'Could not verify' : job.activity,
    message: `This vacancy is already in your radar.${!relevance.accepted ? ` Relevance warning: ${relevance.reason}. Kept accessible because you selected it manually.` : ''}` };
}
