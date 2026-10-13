import type { AppConfig } from '../config/index.js';
import { jobText, matchesAny } from './signals.js';

export interface Relevance { accepted: boolean; reason: string | null; family: string | null }

/** Title exclusions are unconditional; descriptions cannot rescue internships. */
export function vacancyRelevance(config: AppConfig, job: { title: string; description?: string | null }): Relevance {
  const text = jobText({ ...job, description: job.description ?? null });
  const settings = config.scoring.relevance;
  const excluded = Object.entries(settings.hard_title_exclusions).find(([, patterns]) => matchesAny(text.title, patterns));
  if (excluded) return { accepted: false, reason: excluded[0], family: null };
  // A target title can be enriched later, without treating generic CAP/AI/cloud as SAP evidence.
  for (const [family, patterns] of Object.entries(settings.target_role_families)) {
    if (matchesAny(text.title, patterns)) return { accepted: true, reason: null, family };
  }
  // General SAP technical titles need specific target technology in the description.
  if (/\bsap\b/.test(text.all) && /\b(?:develop\w*|architect\w*|technical|technisch\w*|integration|engineer\w*)\b/.test(text.title)) {
    if (!text.hasDescription) return { accepted: true, reason: null, family: 'needs-description' };
    for (const [family, patterns] of Object.entries(settings.target_role_families))
      if (matchesAny(text.body, patterns)) return { accepted: true, reason: null, family };
  }
  return { accepted: false, reason: 'Outside configured SAP target role families', family: null };
}

/** Personal records stay accessible even when their vacancy is outside the target. */
export function hasPersonalTracking(job: any): boolean {
  return Boolean(job.cvSent || job.cvSentAt || job.applicationDate || job.sentCvLabel || job.personalNotes?.trim() || job.status && job.status !== 'New');
}
