import type { AppConfig } from '../config/index.js';
import { jobText, matchesAny } from './signals.js';

export interface Relevance { accepted: boolean; state: 'confirmed' | 'unresolved' | 'irrelevant'; reason: string | null; family: string | null }

/** Title exclusions are unconditional; descriptions cannot rescue internships. */
export function vacancyRelevance(config: AppConfig, job: { title: string; description?: string | null }): Relevance {
  const text = jobText({ ...job, description: job.description ?? null });
  const settings = config.scoring.relevance;
  const excluded = Object.entries(settings.hard_title_exclusions).find(([, patterns]) => matchesAny(text.title, patterns));
  if (excluded) return { accepted: false, state: 'irrelevant', reason: excluded[0], family: null };
  const capTitle = /\bcapm?\s+(?:developer|engineer|architect|development)\b/.test(text.title);
  if (capTitle && /\b(?:common agricultural policy|community action program|college of american pathologists|capital allocation|corrective action (?:plan|process))\b/.test(text.all)) {
    return { accepted: false, state: 'irrelevant', reason: 'Unrelated CAP meaning', family: null };
  }
  // A target title can be enriched later, without treating generic CAP/AI/cloud as SAP evidence.
  for (const [family, patterns] of Object.entries(settings.target_role_families)) {
    if (matchesAny(text.title, patterns)) return { accepted: true, state: 'confirmed', reason: null, family };
  }
  const sap = /\b(?:sap|sapui5|s\/4hana)\b/.test(text.title);
  const technical = /\b(?:develop\w*|engineer\w*|architect\w*|technical|technisch\w*|entwickl\w*|berater\w*|consultant\w*|integrat\w*)\b/.test(text.title);
  if (sap && technical) {
    const alias = /\b(btp|capm?|cpi|hci|work\s?zone|integratie|integration\w*)\b/.exec(text.title)?.[1];
    if (alias) return { accepted: true, state: 'confirmed', reason: null,
      family: /integr|cpi|hci/.test(alias) ? 'integration' : /cap/.test(alias) ? 'cap' : 'btp' };
  }
  if (!sap && /\b(?:pega|salesforce|servicenow)\b/.test(text.title))
    return { accepted: false, state: 'irrelevant', reason: 'Unrelated technology role', family: null };

  // CAP alone is ambiguous. A technical CAP title plus independently stated
  // SAP context establishes the intended role, unless it names another CAP.
  if (capTitle && /\b(?:sap|sapui5|s\/4hana)\b/.test(text.body)) {
    return { accepted: true, state: 'confirmed', reason: null, family: 'cap' };
  }
  // General SAP technical titles need specific target technology in the description.
  if (/\bsap\b/.test(text.all) && technical) {
    for (const [family, patterns] of Object.entries(settings.target_role_families))
      if (matchesAny(text.body, patterns)) return { accepted: true, state: 'confirmed', reason: null, family };
  }
  if (!text.hasDescription && (sap && technical || /\b(?:develop\w*|engineer\w*|architect\w*|full[- ]?stack|technical|technisch\w*)\b/.test(text.title))) {
    return { accepted: false, state: 'unresolved', reason: 'SAP context needs a description', family: null };
  }
  return { accepted: false, state: 'irrelevant', reason: 'Outside configured SAP target role families', family: null };
}

/** Lower ranks reserve scarce details for target SAP families before generic roles. */
export function descriptionPriority(config: AppConfig, job: { title: string; description?: string | null }): number {
  const relevance = vacancyRelevance(config, job);
  return relevance.state === 'irrelevant' ? 9 : relevance.accepted ? 0 : /\bsap\b/i.test(job.title) ? 1 : 2;
}

/** Personal records stay accessible even when their vacancy is outside the target. */
export function hasPersonalTracking(job: any): boolean {
  return Boolean(job.cvSent || job.cvSentAt || job.applicationDate || job.sentCvLabel || job.personalNotes?.trim() || job.status && job.status !== 'New');
}
