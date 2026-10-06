import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Lowercase, strip accents, collapse whitespace. */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const COMPANY_NOISE =
  /\b(gmbh|mbh|ag|ab|a\/s|as|sa|s\.a\.|sas|sarl|srl|spa|bv|b\.v\.|nv|n\.v\.|ltd|limited|llc|inc|incorporated|plc|oy|oyj|kft|sp\.? ?z ?o\.?o\.?|s\.?r\.?o\.?|eood|ood|ad|co|company|group|holding|consulting|solutions|services|technologies|technology|it|digital|international|europe|deutschland)\b/g;

/** Collapse a company name to a comparable key: "SAP SE" and "sap" both -> "sap". */
export function normalizeCompany(value: string | null | undefined): string {
  const base = normalizeText(value).replace(/[.,&()'"`]/g, ' ');
  const stripped = base.replace(COMPANY_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return stripped || base;
}

/**
 * Canonical form of a job URL used for deduplication:
 * lowercase host, no tracking query parameters, no fragment, no trailing slash.
 * Returns the trimmed input when it is not a parseable URL.
 */
export function canonicalizeUrl(rawUrl: string | null | undefined): string {
  const value = (rawUrl ?? '').trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.protocol = 'https:';
  url.port = '';
  const keep = new URLSearchParams();
  for (const [key, val] of url.searchParams) {
    const lower = key.toLowerCase();
    if (lower.startsWith('utm_') || lower.startsWith('ref')) continue;
    if (['trk', 'trackingid', 'position', 'pagenum', 'origin', 'src', 'source', 'from', 'lipi', 'licu', 'ead'].includes(lower)) continue;
    keep.append(key, val);
  }
  const sorted = [...keep.entries()].sort(([a], [b]) => a.localeCompare(b));
  url.search = sorted.length ? new URLSearchParams(sorted).toString() : '';
  let out = url.toString();
  if (out.endsWith('/') && url.pathname !== '/') out = out.slice(0, -1);
  return out;
}

/** Tokens used for similarity comparison; stop-words and short tokens dropped. */
export function tokenize(value: string | null | undefined): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9+#./ -]/g, ' ')
    .split(/[\s/,-]+/)
    .filter((token) => token.length > 2);
}

/** Jaccard similarity over the token sets. Returns 0..1. */
export function tokenSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}
