import type { AssessmentResult } from '../matching/types.js';

export const APPLICATION_STATUSES = ['New', 'Interested', 'Applied', 'Ignored', 'Interview', 'Rejected'] as const;
export type ApplicationStatus = typeof APPLICATION_STATUSES[number];
export type Activity = 'Active' | 'Unknown' | 'Closed';
export type AssessmentKind = 'ai' | 'rules' | 'ai-fallback';
export type AssessmentState = AssessmentKind | 'outdated' | 'unassessed';
export type JobSort = 'firstSeenAt' | 'lastSeenAt' | 'datePosted' | 'fitScore' | 'title' | 'company';

export interface Tracking {
  status: ApplicationStatus;
  personalNotes: string;
  applicationDate: string | null;
  cvSent: boolean;
  cvSentAt: string | null;
  sentCvLabel: string | null;
}

export interface JobSummary extends Tracking {
  ID: string;
  title: string;
  company: string | null;
  location: string | null;
  isRemote: boolean | null;
  manuallyImportedAt: string | null;
  nextFollowUp: { ID: string; dueDate: string } | null;
  jobType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryInterval: string | null;
  sources: string[];
  activity: Activity;
  datePosted: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  fitScore: number | null;
  recommendation: AssessmentResult['recommendation'] | null;
  assessmentState: AssessmentState;
  assessedAt: string | null;
  aiPending: boolean;
  aiQueuedAt: string | null;
  isDemo: boolean;
}

export interface SavedAssessment extends Omit<AssessmentResult, 'fitScore'> {
  ID: string;
  fitScore: number | null;
  createdAt: string | null;
  kind: AssessmentKind;
  current: boolean;
}

export interface Listing {
  ID: string;
  source: string;
  url: string;
  activity: Activity;
  activityCheckedAt: string | null;
  validThrough: string | null;
  closureReason: string | null;
  activityEvidence: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface JobDetail extends JobSummary {
  description: string | null;
  primaryUrl: string;
  isRemote: boolean | null;
  locationCountry: string | null;
  listings: Listing[];
  currentAssessment: SavedAssessment | null;
  assessmentHistory: SavedAssessment[];
  reminders: FollowUpReminder[];
}

export interface FollowUpReminder {
  ID: string;
  jobId: string;
  title: string;
  company: string | null;
  sentAt: string;
  dueDate: string;
  status: 'Pending' | 'Completed' | 'Cancelled';
  completedAt: string | null;
}

export interface CollectionOperation {
  ID: string;
  run_ID: string | null;
  stage: 'Preparing' | 'Collecting' | 'Saving' | 'Assessing' | 'Finished' | 'Error';
  outcome: 'Running' | 'Completed' | 'Empty' | 'Partial' | 'Failed' | 'NoSources';
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  tasksTotal: number;
  tasksDone: number;
  tasksSucceeded: number;
  tasksFailed: number;
  tasksSkipped: number;
  jobsFound: number;
  jobsNew: number;
  jobsUpdated: number;
  jobsAssessed: number;
  aiCalls: number;
  aiBacklog: number;
  aiBudgetExhausted: boolean;
  message: string | null;
}

export interface ImportResult {
  result: 'Added' | 'Already tracked' | 'Needs details';
  availability: 'Active' | 'Closed' | 'Could not verify';
  job: JobDetail | null;
  message: string;
  detailsToken?: string;
}

export interface JobList {
  items: JobSummary[];
  total: number;
  storedTotal: number;
  page: number;
  pageSize: number;
  sources: string[];
}

export interface CollectionStatus {
  latestRun: {
    ID: string;
    startedAt: string;
    heartbeatAt: string | null;
    finishedAt: string | null;
    trigger: string | null;
    batchKey: string | null;
    status: string;
    jobsFound: number;
    jobsNew: number;
    jobsUpdated: number;
    tasks: { source: string; status: string; resultCount: number; message: string | null;
      searchRequests: number | null; detailRequests: number | null }[];
    errors: { source: string | null; kind: string; message: string; occurredAt: string | null }[];
  } | null;
  sources: {
    source: string;
    consecutiveFailures: number;
    cooldownUntil: string | null;
    blocked: boolean;
    lastStatus: string | null;
    lastMessage: string | null;
    updatedAt: string | null;
  }[];
}
