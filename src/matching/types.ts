export type Recommendation = 'Apply' | 'Review' | 'Skip';

export interface MandatoryGapEvidence {
  requirement: string;
  vacancyQuote: string;
  profilePath: string;
  profileValue: string;
}

export interface AssessmentResult {
  engine: 'rules' | 'llm';
  model: string | null;
  profileVersion: string;
  fitScore: number;
  recommendation: Recommendation;
  technicalFit: number;
  commercialFit: number;
  locationFit: number;
  strongMatches: string[];
  mandatoryGaps: string[];
  mandatoryGapEvidence: MandatoryGapEvidence[];
  preferredGaps: string[];
  missingInformation: string[];
  explanation: string;
  suggestedCvVariant: string | null;
  hardReject: boolean;
  hardRejectReason: string | null;
}

export interface MatchableJob {
  ID: string;
  isDemo?: boolean;
  title: string;
  company: string | null;
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
}
