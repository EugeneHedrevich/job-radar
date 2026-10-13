import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, PROJECT_ROOT } from '../config/index.js';
import { collectorJobSchema, listingActivitySchema, type CollectorJob, type ListingActivity } from '../collector/types.js';
import { activeCooldowns } from '../collector/health.js';
import { cds, db, SELECT, UPDATE } from '../db/index.js';
import { canonicalizeUrl } from '../util/text.js';
import { normalizeJob } from '../normalize/index.js';
import { ingestJobs } from '../persist/ingest.js';
import { applyListingActivity } from '../persist/activity.js';
import { rank } from '../pipeline/rank.js';
import { readJob } from './store.js';
import { ApiError } from './errors.js';
import type { ImportResult } from './types.js';

const inputSchema = z.object({ url: z.string().url().max(1000), title: z.string().trim().max(500).optional(),
  description: z.string().trim().max(60_000).optional(), company: z.string().trim().max(500).optional(),
  location: z.string().trim().max(500).optional(), detailsToken: z.string().uuid().optional() }).strict();
const metadataSchema = z.object({ job: collectorJobSchema.nullable(), activity: listingActivitySchema.nullable(), message: z.string().max(2000) });
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

async function fetchMetadata(source: string, url: string): Promise<ImportMetadata> {
  const unverified = (message: string): ImportMetadata => ({ job: null, activity: null, message });
  if (['manual', 'indeed', 'glassdoor'].includes(source)) return unverified('This URL has no supported public detail adapter. Enter the title and description.');
  if ((await activeCooldowns()).has(source)) return unverified('This source is on cooldown. Enter the title and description or try later.');
  const config = loadConfig();
  if (!config.searches.sources[source]?.enabled) return unverified('This source is disabled. Enter the title and description.');
  return new Promise((resolve) => {
    const child = spawn(config.pythonPath, [path.join(PROJECT_ROOT, 'python/import_vacancy.py')],
      { cwd: PROJECT_ROOT, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', finished = false;
    const done = (value: ImportMetadata) => { if (!finished) { finished = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 35_000);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ source, url }));
    child.stdout.on('data', (chunk) => { output += String(chunk); if (output.length > 256_000) child.kill('SIGKILL'); });
    child.stderr.resume();
    child.on('error', () => done(unverified('The local metadata adapter could not start. Enter the title and description.')));
    child.on('close', () => {
      try { const parsed = metadataSchema.safeParse(JSON.parse(output));
        done(parsed.success ? parsed.data : unverified('Metadata could not be parsed. Enter the title and description.')); }
      catch { done(unverified('The lookup timed out or could not verify the listing. Enter the title and description.')); }
    });
  });
}

async function canonicalMatch(urls: string[], connection: any = cds): Promise<string | undefined> {
  const wanted = new Set(urls.filter(Boolean).map(canonicalizeUrl));
  const rows = await connection.run(SELECT.from(db().SourceListings).columns('job_ID', 'canonicalUrl', 'rawUrl', 'directUrl'));
  return rows.find((row: any) => [row.canonicalUrl, row.rawUrl, row.directUrl]
    .some((url) => url && wanted.has(canonicalizeUrl(url))))?.job_ID;
}

/** Network lookup precedes a short atomic duplicate check and ingestion. */
export async function importVacancy(input: unknown,
  lookup: (source: string, url: string) => Promise<ImportMetadata> = fetchMetadata): Promise<ImportResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'Provide a valid URL and bounded vacancy details');
  const fields = parsed.data;
  const target = importUrl(fields.url);
  const duplicate = await canonicalMatch([fields.url, target.url]);
  if (duplicate) return alreadyTracked(duplicate);
  // Explicit fallback submission makes no second network request.
  const previous = fields.detailsToken ? pendingDetails.get(fields.detailsToken) : undefined;
  const metadata = previous && previous.expiresAt > Date.now() && previous.url === target.url ? previous.metadata
    : fields.title && fields.description ? { job: null, activity: null, message: 'Added with the details you supplied; availability could not be verified.' }
      : await lookup(target.source, target.url);
  const availability = metadata.activity?.status === 'closed' ? 'Closed'
    : metadata.activity?.status === 'active' ? 'Active' : 'Could not verify';
  const record: CollectorJob = { ...metadata.job, job_url: metadata.job?.job_url ?? target.url,
    title: metadata.job?.title || fields.title, description: metadata.job?.description || fields.description,
    company: metadata.job?.company || fields.company, location: metadata.job?.location || fields.location };
  if (!record.title?.trim() || !record.description?.trim()) {
    for (const [key, draft] of pendingDetails) if (draft.expiresAt <= Date.now()) pendingDetails.delete(key);
    if (pendingDetails.size >= 100) pendingDetails.delete(pendingDetails.keys().next().value!);
    const detailsToken = randomUUID();
    pendingDetails.set(detailsToken, { url: target.url, metadata, expiresAt: Date.now() + 10 * 60_000 });
    return { result: 'Needs details', availability, detailsToken,
      job: null, message: `${metadata.message}. Enter a title and description to save this vacancy.` };
  }
  const normalized = normalizeJob(record, target.source);
  if (!normalized) throw new ApiError(400, 'A title and vacancy URL are required');
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
  if (metadata.activity) await applyListingActivity([metadata.activity as ListingActivity]);
  if (fields.detailsToken) pendingDetails.delete(fields.detailsToken);
  // Deterministic caching and durable eligibility queue; paid work uses the next
  // collection's shared five-call allowance, never a per-import extra allowance.
  await rank({ jobIds: [saved.id], rulesOnly: true });
  return { result: saved.added ? 'Added' : 'Already tracked', availability,
    job: await readJob(saved.id), message: saved.added ? metadata.message : 'This vacancy is already in your radar.' };
}

async function alreadyTracked(id: string): Promise<ImportResult> {
  const job = await readJob(id);
  return { result: 'Already tracked', job, availability: job.activity === 'Unknown' ? 'Could not verify' : job.activity,
    message: 'This vacancy is already in your radar.' };
}
