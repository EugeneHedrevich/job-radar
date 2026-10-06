import type { CollectorJob } from '../collector/types.js';
import { canonicalizeUrl, normalizeCompany, normalizeText, sha256 } from '../util/text.js';

export interface NormalizedListing {
  source: string;
  sourceJobId: string | null;
  canonicalUrl: string;
  rawUrl: string | null;
  directUrl: string | null;
  hasDescription: boolean;
  raw: string;
}

export interface NormalizedJob {
  /** Stable identity of the originating listing; used for idempotent re-runs. */
  fingerprint: string;
  title: string;
  company: string | null;
  companyNormalized: string | null;
  location: string | null;
  locationCountry: string | null;
  /** null means the source did not state it - not "false". */
  isRemote: boolean | null;
  jobType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryInterval: string | null;
  salaryCurrency: string | null;
  description: string | null;
  descriptionHash: string | null;
  primaryUrl: string;
  /** Publication date as reported by the source. Never the collection time. */
  datePosted: string | null;
  listing: NormalizedListing;
}

const COUNTRY_CODES: Record<string, string> = {
  at: 'Austria', be: 'Belgium', bg: 'Bulgaria', ch: 'Switzerland', cz: 'Czech Republic',
  de: 'Germany', dk: 'Denmark', ee: 'Estonia', es: 'Spain', fi: 'Finland', fr: 'France',
  gb: 'United Kingdom', gr: 'Greece', hr: 'Croatia', hu: 'Hungary', ie: 'Ireland',
  it: 'Italy', lt: 'Lithuania', lu: 'Luxembourg', lv: 'Latvia', nl: 'Netherlands',
  no: 'Norway', pl: 'Poland', pt: 'Portugal', ro: 'Romania', se: 'Sweden',
  si: 'Slovenia', sk: 'Slovakia', uk: 'United Kingdom', us: 'United States',
};

const COUNTRY_NAMES = new Set(Object.values(COUNTRY_CODES).map((name) => name.toLowerCase()));

/** Derive the country from a free-text location. Returns null when unclear. */
export function extractCountry(location: string | null | undefined): string | null {
  if (!location) return null;
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  const last = parts.at(-1);
  if (!last) return null;
  const lower = last.toLowerCase();
  if (lower.length === 2 && COUNTRY_CODES[lower]) return COUNTRY_CODES[lower];
  if (COUNTRY_NAMES.has(lower)) {
    return Object.values(COUNTRY_CODES).find((name) => name.toLowerCase() === lower) ?? null;
  }
  // "Remote", "Europe" and similar are locations but not countries.
  return null;
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toBoolean(value: boolean | string | null | undefined): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const lower = value.toLowerCase();
  if (['true', '1', 'yes'].includes(lower)) return true;
  if (['false', '0', 'no'].includes(lower)) return false;
  return null;
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Convert one collector record into the canonical shape. Returns null when the
 * record lacks the minimum identity (title + URL) needed to store it.
 */
export function normalizeJob(record: CollectorJob, source: string): NormalizedJob | null {
  const title = clean(record.title);
  const rawUrl = clean(record.job_url);
  const directUrl = clean(record.job_url_direct);
  const canonicalUrl = canonicalizeUrl(rawUrl ?? directUrl);
  if (!title || !canonicalUrl) return null;

  const sourceJobId = clean(record.id);
  const company = clean(record.company);
  const location = clean(record.location);
  const description = clean(record.description);

  return {
    fingerprint: sha256(`${source}|${sourceJobId ?? canonicalUrl}`),
    title,
    company,
    companyNormalized: company ? normalizeCompany(company) : null,
    location,
    locationCountry: extractCountry(location),
    isRemote: toBoolean(record.is_remote),
    jobType: clean(record.job_type),
    salaryMin: toNumber(record.min_amount),
    salaryMax: toNumber(record.max_amount),
    salaryInterval: clean(record.interval),
    salaryCurrency: clean(record.currency),
    description,
    descriptionHash: description ? sha256(normalizeText(description)) : null,
    primaryUrl: rawUrl ?? canonicalUrl,
    datePosted: toIsoDate(record.date_posted),
    listing: {
      source,
      sourceJobId,
      canonicalUrl,
      rawUrl,
      directUrl,
      hasDescription: Boolean(description),
      raw: JSON.stringify(record),
    },
  };
}
