namespace sap.jobradar;

using { cuid } from '@sap/cds/common';

/**
 * A de-duplicated vacancy. One Job can be backed by several SourceListings
 * (e.g. the same role found on LinkedIn and on Indeed).
 *
 * Nullable columns mean "unknown". They are never back-filled with guesses.
 */
entity Jobs : cuid {
  fingerprint       : String(64) not null;   // canonical cross-source dedupe key
  title             : String(500) not null;
  company           : String(500);
  companyNormalized : String(500);
  location          : String(500);
  locationCountry   : String(100);
  isRemote          : Boolean;               // null = not stated by the source
  jobType           : String(50);            // fulltime | contract | ... | null
  salaryMin         : Decimal(15, 2);
  salaryMax         : Decimal(15, 2);
  salaryInterval    : String(20);            // hourly | daily | monthly | yearly
  salaryCurrency    : String(10);
  description       : LargeString;           // null = description not retrieved
  descriptionHash   : String(64);
  primaryUrl        : String(1000) not null;
  datePosted        : Date;                  // publication date; null = unknown
  firstSeenAt       : Timestamp not null;    // never used as a publication date
  lastSeenAt        : Timestamp not null;
  status            : String(20) default 'New';  // New | Interested | Applied | Ignored
  isDemo            : Boolean default false;   // fixture data is never delivered live

  listings          : Composition of many SourceListings on listings.job = $self;
  assessments       : Composition of many Assessments    on assessments.job = $self;
  notifications     : Composition of many Notifications  on notifications.job = $self;
}

/** One listing of a Job on one source. Unique by (source, sourceJobId). */
entity SourceListings : cuid {
  job             : Association to Jobs;
  source          : String(50) not null;     // linkedin | indeed | glassdoor | ...
  sourceJobId     : String(200);
  canonicalUrl    : String(1000) not null;   // normalised, tracking params stripped
  rawUrl          : String(1000);
  directUrl       : String(1000);
  hasDescription  : Boolean default false;
  // Not named `raw`: cds.ql's UPDATE.set() treats an object with a `raw`
  // property as a tagged template literal.
  rawRecord       : LargeString;             // untouched collector record (JSON)
  firstSeenAt     : Timestamp not null;
  lastSeenAt      : Timestamp not null;
  run             : Association to CollectionRuns;
}

/** One invocation of the collector (manual or scheduled). */
entity CollectionRuns : cuid {
  startedAt    : Timestamp not null;
  finishedAt   : Timestamp;
  trigger      : String(50);                 // manual | scheduled
  batchKey     : String(200);                // which rotating batch was used
  status       : String(20);                 // Running | Completed | Failed
  jobsFound    : Integer default 0;
  jobsNew      : Integer default 0;
  jobsUpdated  : Integer default 0;

  tasks        : Composition of many CollectionTasks  on tasks.run = $self;
  errors       : Composition of many CollectionErrors on errors.run = $self;
}

/** One (source x keyword x location) search inside a run. */
entity CollectionTasks : cuid {
  run           : Association to CollectionRuns;
  taskKey       : String(200);
  source        : String(50);
  searchTerm    : String(200);
  location      : String(200);
  countryIndeed : String(100);
  status        : String(20);                // Succeeded | Failed | Skipped
  resultCount   : Integer default 0;
  durationMs    : Integer;
  message       : String(2000);
}

entity CollectionErrors : cuid {
  run        : Association to CollectionRuns;
  source     : String(50);
  kind       : String(50);                   // timeout | blocked | rate_limit | parse | unknown
  message    : String(2000);
  occurredAt : Timestamp;
}

/** Per-source circuit breaker state, survives restarts. */
entity SourceHealth {
  key source          : String(50);
  consecutiveFailures : Integer default 0;
  cooldownUntil       : Timestamp;
  blocked             : Boolean default false;
  lastStatus          : String(50);
  lastMessage         : String(2000);
  updatedAt           : Timestamp;
}

/** Result of rule-based or LLM matching. Cached by cacheKey. */
entity Assessments : cuid {
  job                : Association to Jobs;
  cacheKey           : String(128) not null; // hash(job content + profile version + engine)
  engine             : String(20);           // rules | llm
  model              : String(100);
  profileVersion     : String(50);
  fitScore           : Integer;              // 0-100 fit score, NOT a hiring probability
  recommendation     : String(20);           // Apply | Review | Skip
  technicalFit       : Integer;
  commercialFit      : Integer;
  locationFit        : Integer;
  strongMatches      : LargeString;          // JSON string array
  mandatoryGaps      : LargeString;          // JSON string array
  preferredGaps      : LargeString;          // JSON string array
  missingInformation : LargeString;          // JSON string array
  explanation        : LargeString;
  suggestedCvVariant : String(50);
  hardReject         : Boolean default false;
  hardRejectReason   : String(500);
  createdAt          : Timestamp;
}

entity Notifications : cuid {
  job               : Association to Jobs;
  assessment        : Association to Assessments;
  channel           : String(20);            // telegram
  status            : String(20);            // Pending | Sending | Sent | Failed | Skipped | Superseded
  claimToken        : String(36);            // owner of the current delivery attempt
  claimUntil        : Timestamp;             // lease expiry for recovery after a crash
  attempts          : Integer default 0;
  lastError         : String(2000);
  telegramMessageId : Integer;
  chatId            : String(100);
  payload           : LargeString;
  createdAt         : Timestamp;
  sentAt            : Timestamp;
}
