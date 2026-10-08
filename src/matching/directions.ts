import type { MatchableJob } from './types.js';
import { jobText } from './signals.js';

export const PRIORITY_DIRECTIONS = ['CAP/CAPM', 'UI5/Fiori', 'Joule', 'BTP AI'] as const;
export type PriorityDirection = typeof PRIORITY_DIRECTIONS[number];

/** Direction counts may overlap. Generic AI without SAP context is excluded. */
export function priorityDirections(job: MatchableJob): PriorityDirection[] {
  const text = jobText(job).all;
  if (!/\b(?:sap|sapui5|btp|fiori|ui5)\b/.test(text)) return [];
  const result: PriorityDirection[] = [];
  if (/\b(?:cap|capm|cloud application programming model)\b/.test(text)) result.push('CAP/CAPM');
  if (/\b(?:sapui5|ui5|fiori)\b/.test(text)) result.push('UI5/Fiori');
  if (/\bjoule\b/.test(text)) result.push('Joule');
  if (/\b(?:business ai|ai core|generative ai hub|genai hub|btp ai|sap ai)\b/.test(text)) result.push('BTP AI');
  return result;
}
