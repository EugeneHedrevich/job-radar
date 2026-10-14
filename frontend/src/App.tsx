import { useEffect, useRef, useState, type FormEvent } from 'react';
import { APPLICATION_STATUSES, type AssessmentState, type CollectionStatus, type JobDetail,
  type FollowUpReminder, type ImportResult, type JobList, type JobSummary, type SavedAssessment, type Tracking } from '../../src/dashboard/types';
import { request, useResource } from './api';
import SourceFilter, { sourceLabel } from './SourceFilter';
import { useEuroRate, type EuroConversion } from './currency';
import { sofiaDate, sofiaDateTime, sofiaInstant } from '../../src/util/calendar';
import { CollectionProgress, useCollection } from './CollectionControls';
import AddVacancy from './AddVacancy';
import Reminders from './Reminders';

const assessmentLabels: Record<AssessmentState, string> = {
  ai: 'AI assessment', rules: 'Deterministic rules', 'ai-fallback': 'AI-request fallback (rules)',
  outdated: 'Outdated assessment', unassessed: 'Not assessed',
};

const compactAssessmentLabels: Record<AssessmentState, string> = {
  ai: 'AI', rules: 'Rules', 'ai-fallback': 'Rules · AI unavailable', outdated: 'Needs refresh', unassessed: 'Awaiting assessment',
};

const sourceFactLabels: Record<string, string> = { description: 'Description', jobType: 'Employment type',
  isRemote: 'Source remote flag', location: 'Location', salaryMin: 'Minimum salary', salaryMax: 'Maximum salary',
  salaryInterval: 'Pay interval', salaryCurrency: 'Currency', datePosted: 'Publication date' };

function date(value: string | null | undefined, time = false): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  // Date-only publication/application values must not shift with local timezone.
  return parsed.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric',
    ...(time ? { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Sofia' } : { timeZone: 'UTC' }) });
}

function Salary({ job, conversion }: { job: JobSummary; conversion: EuroConversion }) {
  if (job.salaryMin === null && job.salaryMax === null) return 'Salary not stated';
  const range = (format: (amount: number) => string = String) => job.salaryMin !== null && job.salaryMax !== null ?
    job.salaryMin === job.salaryMax ? format(job.salaryMin) : `${format(job.salaryMin)}–${format(job.salaryMax)}` :
    job.salaryMin !== null ? `From ${format(job.salaryMin)}` : `Up to ${format(job.salaryMax!)}`;
  const rate = conversion.rate;
  const euros = rate ? range((amount) => (amount / rate.plnPerEuro).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : null;
  return <span>{range()} {job.salaryCurrency ?? ''}
    {job.salaryCurrency?.toUpperCase() === 'PLN' && <span className="salary-euros"
      title={rate ? `Approximate EUR equivalent · NBP ${rate.effectiveDate} · 1 EUR = ${rate.plnPerEuro} PLN${conversion.unavailable ? ' · Last available rate' : ''}` : undefined}>
      {euros ? ` (≈ ${euros} EUR)` : conversion.unavailable ? ' (EUR unavailable)' : ' (EUR loading…)'}
    </span>} / {job.salaryInterval ?? 'period not stated'}</span>;
}

function safeUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}

function RadarMark() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
    <circle cx="20" cy="20" r="16" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="20" cy="20" r="9" stroke="currentColor" strokeWidth="1.5" opacity=".65" />
    <path d="M20 4v16l11-11M4 20h32M20 20v16" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="26" cy="25" r="3" fill="currentColor" />
  </svg>;
}

function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value.toLowerCase()}`}>{value}</span>;
}

function Fit({ job }: { job: JobSummary }) {
  return <div className="fit-cell">
    <div className="fit-heading">
      <strong className={job.fitScore === null ? 'score unknown' : `score score-${job.recommendation?.toLowerCase()}`}>{job.fitScore ?? '—'}
        {job.fitScore !== null && <small>/100</small>}</strong>
      {job.recommendation && <Badge value={job.recommendation} />}
    </div>
    <span className="muted small" title={assessmentLabels[job.assessmentState]}>{job.aiPending ? 'Rules · AI queued' : compactAssessmentLabels[job.assessmentState]}</span>
    {Boolean(job.mainBlockers?.length) && <div className="fit-blockers">
      {job.mainBlockers.slice(0, 2).map((reason) => <span className="warning small" key={reason}>{reason}</span>)}
    </div>}
  </div>;
}

function CollectionArea({ data, loading, error, retry }: {
  data: CollectionStatus | null; loading: boolean; error: string | null; retry: () => void;
}) {
  if (loading && !data) return <section className="collection-card collection-placeholder" aria-live="polite">Loading collection status…</section>;
  if (error && !data) return <section className="collection-card collection-placeholder error" role="alert">{error} <button onClick={retry}>Retry</button></section>;
  const run = data?.latestRun;
  const failures = run?.tasks.filter((task) => task.status === 'Failed').length ?? 0;
  const cooldowns = data?.sources.filter((source) => source.cooldownUntil && new Date(source.cooldownUntil).getTime() > Date.now()).length ?? 0;
  return <section className="collection-card" aria-label="Collection status" aria-busy={loading}>
    {error && <div className="collection-placeholder error" role="alert">Couldn’t refresh collection status: {error} <button onClick={retry}>Retry</button></div>}
    <details className="source-details">
      <summary className="collection-summary">
        <span className="collection-time"><strong>Last collection</strong><span>{run ? date(run.startedAt, true) : 'None yet'}</span></span>
        {run && <span className="collection-run muted">{run.batchKey ?? 'Batch not recorded'} · {run.status}</span>}
        {run && <span className="collection-counts"><span><strong>{run.jobsFound}</strong> found</span><span><strong>{run.jobsNew}</strong> new</span><span><strong>{run.jobsUpdated}</strong> updated</span></span>}
        <span className="health-summary"><span className={failures ? 'warning' : 'muted'}>{failures} failed tasks</span>
          <span className={cooldowns ? 'warning' : 'muted'}>{cooldowns} cooldowns</span></span>
        <svg className="collection-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" /></svg>
        <span className="sr-only">Expand source health and collection details</span>
      </summary>
      <div className="collection-body">
      {run && <p className="muted small">Finished: {date(run.finishedAt, true)} · Last heartbeat: {date(run.heartbeatAt, true)} · Trigger: {run.trigger ?? 'Unknown'}</p>}
      {run && run.tasks.length > 0 && <div className="source-grid">{[...new Set(run.tasks.map((task) => task.source))].sort().map((source) => {
        const tasks = run.tasks.filter((task) => task.source === source);
        return <div className="source-item" key={source}><strong>{sourceLabel(source)}</strong>
          <span>{tasks.reduce((sum, task) => sum + task.resultCount, 0)} results · {tasks.filter((task) => task.status === 'Succeeded').length} succeeded · {tasks.filter((task) => task.status === 'Failed').length} failed · {tasks.filter((task) => task.status === 'Skipped').length} skipped</span>
          {tasks.some((task) => task.searchRequests !== null) && <span className="small">HTTP requests: {tasks.reduce((sum, task) => sum + (task.searchRequests ?? 0), 0)} search · {tasks.reduce((sum, task) => sum + (task.detailRequests ?? 0), 0)} detail</span>}
          {tasks.some((task) => task.coverageReason) && <span className="muted small">{[...new Set(tasks.map((task) => task.coverageReason).filter(Boolean))].join(' ')}</span>}
          {tasks.filter((task) => task.status !== 'Succeeded' && task.message).map((task, index) => <span className="warning small" key={index}>{task.status}: {task.message}</span>)}
        </div>;
      })}</div>}
      {data?.sources.length ? <div className="source-grid">{data.sources.map((source) => <div className="source-item" key={source.source}>
        <strong>{sourceLabel(source.source)}</strong><span>{source.lastStatus ?? 'Unknown'} · {source.consecutiveFailures} consecutive failures{source.blocked ? ' · Blocked' : ''}</span>
        <span className="small">{source.successfulChecks} verified checks within freshness · {source.incompleteScans} incomplete scans in last run · {source.pendingEnrichment} awaiting description</span>
        {source.lastSuccessfulCheck && <span className="muted small">Last verified check {date(source.lastSuccessfulCheck, true)}</span>}
        {source.cooldownUntil && <span className="small">Cooldown {new Date(source.cooldownUntil).getTime() > Date.now() ? 'until' : 'ended'} {date(source.cooldownUntil, true)}</span>}
        {source.lastMessage && <span className="muted small">{source.lastMessage}</span>}
        {source.source === 'linkedin' && <span className="small">Shared window: {source.searchRequests} search / {source.detailRequests} detail requests
          {source.reservedSearch + source.reservedDetail > 0 ? ` · ${source.reservedSearch + source.reservedDetail} reserved` : ''}
          {source.lastHttpStatus ? ` · Last HTTP ${source.lastHttpStatus}` : ''}
          {source.lastRetryAfterSeconds != null ? ` · Retry-After ${source.lastRetryAfterSeconds}s` : ''}</span>}
      </div>)}</div> : <p className="muted small">No stored source health yet.</p>}
      {run?.errors.map((error, index) => <p className="warning small" key={index}>{error.source ?? 'Collection'} · {error.kind}: {error.message}</p>)}
      {data?.linkedinCoverage && <p className="muted small">LinkedIn: {data.linkedinCoverage.combinations} configured combinations ·
        up to {data.linkedinCoverage.slotsPerSequence} slots per {data.linkedinCoverage.sequenceHours} hours before cooldowns ·
        {data.linkedinCoverage.checkedWithinWindow}/{data.linkedinCoverage.combinations} had first-page checks in the last {data.linkedinCoverage.freshnessHours} hours.
        {data.linkedinCoverage.combinations > data.linkedinCoverage.slotsPerSequence ? ' A single sequence cannot cover every combination.' : ' Shared limits and cooldowns can reduce these slots.'}</p>}
      </div>
    </details>
  </section>;
}

function AssessmentView({ assessment }: { assessment: SavedAssessment }) {
  return <div className="assessment-view">
    <div className="assessment-heading"><strong>{assessment.fitScore ?? '—'}{assessment.fitScore !== null ? '/100 suitability' : ' Score missing'}</strong>
      {assessment.recommendation && <Badge value={assessment.recommendation} />}</div>
    <p className="explanation">{assessment.explanation || 'No explanation saved.'}</p>
    {assessment.kind === 'ai-fallback' && <p className="warning small">
      {assessment.aiOutcome === 'RejectedOutput' ? 'AI output was rejected by validation.' : 'The AI provider did not return a usable assessment.'}
      {' '}{assessment.aiReason ?? 'The original fallback reason is preserved below.'}</p>}
    {assessment.hardReject && <p className="warning">Hard rejection: {assessment.hardRejectReason ?? 'See mandatory gaps.'}</p>}
    <dl className="facts"><div><dt>Suggested CV variant</dt><dd>{assessment.suggestedCvVariant ?? 'Not suggested'}</dd></div></dl>
    <details><summary>Assessment details & evidence</summary>
    <p className="small">Technical fit: {assessment.technicalFit}/100 · Employment: {assessment.commercialFit}/100 · Location/work mode: {assessment.locationFit}/100</p>
    <p className="muted small">{assessmentLabels[assessment.kind]} · {date(assessment.createdAt, true)}
      {assessment.model ? ` · ${assessment.model}` : ''} · Profile {assessment.profileVersion ?? 'Unknown'}</p>
    {([
      ['Strong matches', assessment.strongMatches], ['Mandatory gaps', assessment.mandatoryGaps],
      ['Preferred gaps', assessment.preferredGaps], ['Missing information', assessment.missingInformation],
    ] as const).map(([label, values]) => <div className="assessment-list" key={label}><h4>{label}</h4>
      {values.length ? <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : <p className="muted small">None recorded.</p>}
    </div>)}
    {assessment.mandatoryGapEvidence.length > 0 && <details><summary>Mandatory-gap evidence</summary>
      {assessment.mandatoryGapEvidence.map((item, index) => <blockquote key={index}><strong>{item.requirement}</strong>
        <p>{item.vacancyQuote}</p><span className="muted small">{item.profilePath}: {item.profileValue}</span></blockquote>)}
    </details>}
    </details>
  </div>;
}

type ApplicationTracking = Omit<Tracking, 'viewedAt'>;

function extractTracking(job: Tracking): ApplicationTracking {
  return { status: job.status, personalNotes: job.personalNotes, applicationDate: job.applicationDate,
    cvSent: job.cvSent, cvSentAt: job.cvSentAt, sentCvLabel: job.sentCvLabel };
}

export function TrackingForm({ job, onSaved, onDirty, onBusy }: {
  job: JobDetail; onSaved: (tracking: Tracking) => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void;
}) {
  const [form, setForm] = useState(() => extractTracking(job));
  const [baseline, setBaseline] = useState(() => JSON.stringify(extractTracking(job)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(form) !== baseline;
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  function change(patch: Partial<ApplicationTracking>) {
    setForm((previous) => {
      const next = { ...previous, ...patch };
      if (patch.cvSent === true && ['New', 'Interested'].includes(next.status)) next.status = 'Applied';
      if (patch.cvSent === true && !previous.cvSent) next.cvSentAt = sofiaInstant(sofiaDateTime());
      if (patch.cvSent === false) next.cvSentAt = null;
      return next;
    });
    setSaved(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); onBusy(true); setError(null); setSaved(false);
    try {
      const result = await request<Tracking>(`/api/jobs/${encodeURIComponent(job.ID)}/tracking`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      const savedForm = extractTracking(result);
      setForm(savedForm); setBaseline(JSON.stringify(savedForm)); setSaved(true); onSaved(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save tracking'); }
    finally { setSaving(false); onBusy(false); }
  }
  return <form onSubmit={save} className="tracking-form">
    <fieldset disabled={saving}><legend className="sr-only">Personal tracking</legend>
      <div className="form-grid"><label>Application status<select value={form.status} onChange={(event) => change({ status: event.target.value as Tracking['status'] })}>
        {APPLICATION_STATUSES.map((status) => <option key={status}>{status}</option>)}
      </select></label><label>Application date<input type="date" value={form.applicationDate ?? ''}
        onChange={(event) => change({ applicationDate: event.target.value || null })} /></label></div>
      <label className="checkbox"><input type="checkbox" checked={form.cvSent} onChange={(event) => change({ cvSent: event.target.checked })} />I actually sent a CV</label>
      {form.cvSent && <><label>Actual CV send date and time · Europe/Sofia<input type="datetime-local" required={!job.cvSent}
        value={form.cvSentAt ? sofiaDateTime(new Date(form.cvSentAt)) : ''} onChange={(event) => {
          try { change({ cvSentAt: event.target.value ? sofiaInstant(event.target.value) : null }); setError(null); }
          catch (failure) { setError(String(failure)); }
        }} /></label>
        {!job.cvSentAt && job.cvSent && <p className="muted small">Send date unknown. You can edit notes and status now; enter the actual date when known to create a follow-up.</p>}
        <p className="muted small">A follow-up is due seven calendar days after sending. The application date is separate.</p></>}
      <label>CV actually sent <span className="muted">(optional filename or version)</span><input maxLength={500}
        placeholder="e.g. BTP-CV-v3.pdf" value={form.sentCvLabel ?? ''} onChange={(event) => change({ sentCvLabel: event.target.value || null })} /></label>
      <label>Personal notes<textarea rows={5} maxLength={20_000} placeholder="Contacts, next steps, interview notes…"
        value={form.personalNotes} onChange={(event) => change({ personalNotes: event.target.value })} /></label>
      <p className="muted small">Marking a CV as sent moves New or Interested to Applied.</p>
    </fieldset>
    <div className="save-row"><button className="primary" type="submit" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save tracking'}</button>
      <span className={saved ? 'success small' : 'muted small'} role="status">{saved ? 'Saved.' : dirty ? 'Unsaved changes' : ''}</span></div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

function RetryAssessment({ job, onQueued }: { job: JobDetail; onQueued: () => void }) {
  const [queued, setQueued] = useState(Boolean(job.aiRetry?.queued));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!job.aiRetry) return null;
  async function retry() {
    setBusy(true); setError(null);
    try { await request(`/api/jobs/${encodeURIComponent(job.ID)}/assessment/retry`, { method: 'POST' }); setQueued(true); onQueued(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to queue retry'); }
    finally { setBusy(false); }
  }
  return <div className="retry-assessment"><button disabled={busy || queued || !job.aiRetry.canRetry} onClick={retry}>
    {queued ? 'AI retry queued' : busy ? 'Queuing…' : 'Queue AI retry'}</button>
    <p className="muted small">{job.aiRetry.attempts}/{job.aiRetry.maxAttempts} attempts used for these inputs.
      {job.aiRetry.retryAfter ? ` Provider cooldown: ${date(job.aiRetry.retryAfter, true)}.` : ''}
      {' '}Retries share a later collection’s five-call allowance.</p>
    {job.aiRetry.reason && job.currentAssessment?.kind !== 'ai-fallback' && <details><summary>Last AI attempt</summary><p className="small">{job.aiRetry.reason}</p></details>}
    {error && <p className="error small" role="alert">{error}</p>}</div>;
}

function ViewedMarker({ job, onChanged, disabled = false }: {
  job: Pick<JobSummary, 'ID' | 'title' | 'viewedAt'>; onChanged: (id: string, tracking: Tracking) => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = job.viewedAt ? 'Mark unviewed' : 'Mark viewed';
  async function toggle() {
    setBusy(true); setError(null);
    try {
      const result = await request<Tracking>(`/api/jobs/${encodeURIComponent(job.ID)}/tracking`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewed: !job.viewedAt }),
      });
      onChanged(job.ID, result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save viewed marker'); }
    finally { setBusy(false); }
  }
  return <div className="viewed-marker"><button className="text-button" onClick={toggle} disabled={busy || disabled}
    aria-label={`${label}: ${job.title}`} title={job.viewedAt ? 'Show in Vacancies again' : 'Move to the Viewed tab'}>
    {busy ? 'Saving…' : label}</button>
    {error && <p className="error small" role="alert">{error}</p>}</div>;
}

function VacancyDetail({ job, conversion, onSaved, onViewed, onDirty, onBusy, onAssessmentQueued, saving }: {
  job: JobDetail; conversion: EuroConversion; onSaved: (tracking: Tracking) => void; onViewed: (id: string, tracking: Tracking) => void;
  onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onAssessmentQueued: () => void; saving: boolean;
}) {
  return <>
    <div className="detail-intro"><span className="eyebrow">Vacancy details{job.isDemo ? ' · Demo data' : ''}</span>
      <h2 id="detail-title">{job.title}</h2><p>{job.company ?? 'Company not stated'} · {job.location ?? 'Location not stated'}</p>
      <div className="detail-badges"><Badge value={job.activity} /><Badge value={job.status} />{job.viewedAt && <Badge value="Viewed" />}</div>
      <ViewedMarker job={job} onChanged={onViewed} disabled={saving} />
      {safeUrl(job.primaryUrl) && <a className="external-link" href={safeUrl(job.primaryUrl)} target="_blank" rel="noreferrer">Open original vacancy ↗</a>}
    </div>
    <section className="detail-section"><h3>Personal tracking</h3>
      <TrackingForm key={job.ID} job={job} onSaved={onSaved} onDirty={onDirty} onBusy={onBusy} />
    </section>
    {job.reminders.length > 0 && <details className="detail-section"><summary>Follow-up history ({job.reminders.length})</summary>
      {job.reminders.map((reminder) => <p className="small" key={reminder.ID}>{reminder.status} · Due {reminder.dueDate} · CV sent {date(reminder.sentAt, true)}</p>)}
    </details>}
    <section className="detail-section"><h3>Current assessment</h3>
      {job.aiPending && <p className="pending small">AI work pending · Queued {date(job.aiQueuedAt, true)}</p>}
      {job.currentAssessment ? <AssessmentView assessment={job.currentAssessment} /> : <p className="muted">
        {job.assessmentState === 'outdated' ? 'The saved assessment is outdated for the current vacancy or matching configuration. No current score is available.' : 'No saved current assessment yet.'}</p>}
      {!job.aiPending && <p className="muted small">No current AI work pending in the stored queue.</p>}
      <RetryAssessment key={job.ID} job={job} onQueued={onAssessmentQueued} />
      {job.assessmentHistory.length > 0 && <details className="history"><summary>Assessment history ({job.assessmentHistory.length})</summary>
        {job.assessmentHistory.map((assessment) => <div className="historical" key={assessment.ID}>
          <span className="eyebrow">{assessment.current ? 'Earlier saved assessment · Inputs still valid' : 'Outdated · Historical score only'}</span>
          <AssessmentView assessment={assessment} />
        </div>)}
      </details>}
    </section>
    <details className="detail-section"><summary>Vacancy facts & dates</summary><dl className="facts">
      <div><dt>Contract type</dt><dd>{job.jobType ?? 'Not stated'}</dd></div><div><dt>Salary</dt><dd><Salary job={job} conversion={conversion} /></dd></div>
      <div><dt>Work format</dt><dd>{{ fully_remote: 'Fully remote', hybrid: 'Hybrid / limited remote work', onsite: 'Onsite', unknown: 'Could not establish from the description' }[job.workMode]}</dd></div>
      <div><dt>Published</dt><dd>{date(job.datePosted)}</dd></div><div><dt>First fetched</dt><dd>{date(job.firstSeenAt, true)}</dd></div>
      <div><dt>Last seen</dt><dd>{date(job.lastSeenAt, true)}</dd></div>
      <div><dt>Marked viewed</dt><dd>{job.viewedAt ? date(job.viewedAt, true) : 'Not marked'}</dd></div>
    </dl></details>
    <details className="detail-section"><summary>Sources & listing diagnostics</summary>
      {job.listings.map((listing) => <div className="listing" key={listing.ID}><div className="listing-heading"><strong>{sourceLabel(listing.source)}</strong><Badge value={listing.activity} /></div>
        {safeUrl(listing.url) && <a href={safeUrl(listing.url)} target="_blank" rel="noreferrer">Open source listing ↗</a>}
        <p className="muted small">First fetched {date(listing.firstSeenAt, true)} · Last seen {date(listing.lastSeenAt, true)}<br />
          Activity checked {date(listing.activityCheckedAt, true)}{listing.validThrough ? ` · Valid through ${date(listing.validThrough, true)}` : ''}</p>
        {listing.closureReason && <p className="small">Reason recorded: {listing.closureReason}</p>}
        {listing.activityEvidence && <p className="muted small">{listing.activityEvidence}</p>}
        {Boolean(listing.conflicts?.length) && <details><summary>Conflicting source facts — review</summary>
          {listing.conflicts!.map((fact) => <p className="small" key={fact.field}><strong>{sourceFactLabels[fact.field] ?? fact.field}</strong>: {fact.value}</p>)}
        </details>}
      </div>)}
      {!job.listings.length && <p className="muted">No source listings saved.</p>}
    </details>
    <details className="detail-section"><summary>Description</summary><div className="description">{job.description ?? 'Description not retrieved.'}</div></details>
  </>;
}

const defaultFilters = { q: '', sources: [] as string[], minScore: '', status: '', activity: '', sort: 'firstSeenAt', direction: 'desc', pageSize: '20' };

function nextAction(job: JobSummary): string | null {
  if (job.nextFollowUp && job.nextFollowUp.dueDate <= sofiaDate()) return `Follow up · ${job.nextFollowUp.dueDate}`;
  if (job.cvSent && !job.cvSentAt) return 'Set CV send date';
  if (job.status === 'Interview') return 'Prepare for interview';
  if (['Ignored', 'Rejected', 'Applied'].includes(job.status) || job.cvSent || job.aiPending || job.activity === 'Closed') return null;
  return job.recommendation === 'Apply' ? 'Consider applying' : null;
}

export default function App() {
  const [view, setView] = useState('vacancies');
  const [filters, setFilters] = useState(defaultFilters);
  const [search, setSearch] = useState('');
  const [scoreInput, setScoreInput] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const params = new URLSearchParams({ page: String(page), view });
  for (const [key, value] of Object.entries(filters)) if (key !== 'sources' && value !== '' && typeof value === 'string') params.set(key, value);
  for (const source of filters.sources) params.append('source', source);
  const list = useResource<JobList>(`/api/jobs?${params}`, revision + listRevision, true);
  const diagnostics = useResource<CollectionStatus>('/api/status', revision, true);
  const reminders = useResource<FollowUpReminder[]>('/api/reminders', revision, true);
  const detail = useResource<JobDetail>(selected ? `/api/jobs/${encodeURIComponent(selected)}` : null, detailRevision);
  const collection = useCollection(() => { setRevision((value) => value + 1); if (!dirty) setDetailRevision((value) => value + 1); });
  const conversion = useEuroRate(Boolean(list.data?.items.some((job) => job.salaryCurrency?.toUpperCase() === 'PLN') ||
    detail.data?.salaryCurrency?.toUpperCase() === 'PLN'), revision);
  const validScore = scoreInput === '' || /^\d+$/.test(scoreInput) && Number(scoreInput) <= 100;

  useEffect(() => {
    const timeout = setTimeout(() => { setFilters((previous) => ({ ...previous, q: search })); setPage(1); }, 250);
    return () => clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    if (!validScore) return;
    const timeout = setTimeout(() => { setFilters((previous) => ({ ...previous, minScore: scoreInput })); setPage(1); }, 250);
    return () => clearTimeout(timeout);
  }, [scoreInput, validScore]);
  useEffect(() => {
    if (selected) { if (!dialog.current?.open) dialog.current?.showModal(); if (dialog.current) dialog.current.scrollTop = 0; }
    else dialog.current?.close();
  }, [selected]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirty || saving) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, saving]);

  function guard() { return !saving && (!dirty || window.confirm('Discard unsaved tracking changes?')); }
  function refresh() { setRevision((value) => value + 1); if (!dirty) setDetailRevision((value) => value + 1); }
  function select(id: string | null) { if (guard()) { setDirty(false); setSelected(id); } }
  function filter(key: Exclude<keyof typeof defaultFilters, 'sources'>, value: string) { setFilters((previous) => ({ ...previous, [key]: value })); setPage(1); }
  function setSources(sources: string[]) { setFilters((previous) => ({ ...previous, sources })); setPage(1); }
  function resetFilters() { setSearch(''); setScoreInput(''); setFilters(defaultFilters); setPage(1); }
  function switchView(next: string) { setView(next); resetFilters(); }
  function saved(tracking: Tracking) {
    detail.setData((previous) => previous ? { ...previous, ...tracking } : previous);
    setListRevision((value) => value + 1); setRevision((value) => value + 1);
    setDetailRevision((value) => value + 1);
  }
  function viewed(id: string, tracking: Tracking) {
    // Keep unsaved application edits intact when only the viewed marker changes.
    detail.setData((previous) => previous?.ID === id ? { ...previous, viewedAt: tracking.viewedAt } : previous);
    list.setData((previous) => previous ? { ...previous, items: previous.items.map((job) =>
      job.ID === id ? { ...job, viewedAt: tracking.viewedAt } : job) } : previous);
    setListRevision((value) => value + 1);
  }
  function imported(result: ImportResult) {
    setAddOpen(false); setNotice(`${result.result} · Availability: ${result.availability}`);
    switchView(result.result === 'Added' ? 'imports' : 'vacancies'); refresh();
    if (result.job) select(result.job.ID);
  }
  const data = list.data;
  const updating = list.loading || search !== filters.q || validScore && scoreInput !== filters.minScore;
  const hasFilters = Boolean(search || scoreInput || filters.sources.length || filters.status || filters.activity);
  const linkedin = diagnostics.data?.sources.find((source) => source.source === 'linkedin');
  return <div className="app">
    <header className="app-header"><div className="brand"><div className="radar-mark"><RadarMark /></div><strong>Job Radar</strong></div>
      <span className="workspace-label">Personal · Local</span></header>
    <main>
      <div className="page-heading"><div><h1 id="vacancies-heading">Job Radar <span className="count">{data?.storedTotal ?? '—'}</span></h1>
        <p className="muted">Vacancies, applications and your next steps.</p></div>
        <div className="primary-actions"><button className="primary" onClick={collection.start} disabled={collection.starting || collection.running}>
          {collection.running ? 'Collecting…' : collection.starting ? 'Starting…' : 'Collect vacancies'}</button>
          <button onClick={() => { if (guard()) setAddOpen(true); }} disabled={saving}>Add vacancy</button></div>
      </div>
      {notice && <div className="notice" role="status">{notice}<button className="text-button" onClick={() => setNotice(null)} aria-label="Dismiss import result">×</button></div>}
      {linkedin?.cooldownUntil && new Date(linkedin.cooldownUntil).getTime() > Date.now() && <p className="warning small">
        LinkedIn paused until {date(linkedin.cooldownUntil, true)} · {linkedin.lastMessage ?? linkedin.lastStatus}
        {' '}· {linkedin.searchRequests} search / {linkedin.detailRequests} detail requests in the shared window.</p>}
      <CollectionProgress operation={collection.operation} error={collection.error}>
        <CollectionArea data={diagnostics.data} loading={diagnostics.loading} error={diagnostics.error} retry={refresh} />
        <button className="text-button" onClick={refresh}>Refresh saved data</button>
      </CollectionProgress>
      {reminders.error ? <p className="error" role="alert">Follow-ups: {reminders.error} <button onClick={refresh}>Retry</button></p>
        : reminders.data && <Reminders items={reminders.data} select={select} changed={refresh} />}
      <nav className="view-tabs" aria-label="Vacancy views">{[['vacancies', 'Vacancies'], ['viewed', 'Viewed'], ['applications', 'My applications'], ['imports', 'Added manually']].map(([key, label]) =>
        <button key={key} className={view === key ? 'selected' : ''} aria-pressed={view === key} onClick={() => switchView(key!)}>{label}</button>)}</nav>
      {view === 'viewed' && <p className="muted small view-note">Vacancies you marked as viewed. Mark one unviewed to show it in Vacancies again.</p>}
      {view === 'applications' && <p className="muted small view-note">All tracked applications, including closed listings and outdated or low assessments.</p>}
      {view === 'imports' && <p className="muted small view-note">Manually added vacancies stay here while assessment is pending.</p>}
      <section className="vacancies" aria-labelledby="vacancies-heading">
        <div className="filters" role="search" aria-label="Filter vacancies">
          <label className="search-label"><span className="sr-only">Search title, company, location or notes</span><input type="search" placeholder="Search vacancies…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <select aria-label="Application status" value={filters.status} onChange={(event) => filter('status', event.target.value)}><option value="">All statuses</option>{APPLICATION_STATUSES.map((status) => <option key={status}>{status}</option>)}</select>
          <details className="more-filters"><summary>More filters</summary><div className="extra-filters">
            <SourceFilter options={data?.sources ?? []} value={filters.sources} onChange={setSources} />
            {view !== 'applications' && <select aria-label="Listing availability" value={filters.activity} onChange={(event) => filter('activity', event.target.value)}><option value="">All availability</option>{['Active', 'Unknown', 'Closed'].map((state) => <option key={state} value={state}>{state === 'Unknown' ? 'Could not verify' : state}</option>)}</select>}
            {view === 'vacancies' && <label>Minimum fit<input type="number" min="0" max="100" value={scoreInput} onChange={(event) => setScoreInput(event.target.value)} aria-invalid={!validScore} />{!validScore && <span className="error small">Use a whole number from 0 to 100.</span>}</label>}
            <label>Sort<select value={filters.sort} onChange={(event) => filter('sort', event.target.value)}><option value="firstSeenAt">Newest saved</option><option value="fitScore">Fit score</option><option value="title">Title</option><option value="company">Company</option></select></label>
            <select aria-label="Sort direction" value={filters.direction} onChange={(event) => filter('direction', event.target.value)}><option value="desc">Descending</option><option value="asc">Ascending</option></select>
          </div></details>
        </div>
        {hasFilters && <div className="filter-chips" aria-label="Active filters">
          {search && <button onClick={() => { setSearch(''); filter('q', ''); }}>Search: {search} ×</button>}
          {filters.sources.map((source) => <button key={source} onClick={() => setSources(filters.sources.filter((value) => value !== source))}>{sourceLabel(source)} ×</button>)}
          {filters.minScore && <button onClick={() => { setScoreInput(''); filter('minScore', ''); }}>Fit ≥ {filters.minScore} ×</button>}
          {filters.status && <button onClick={() => filter('status', '')}>{filters.status} ×</button>}
          {filters.activity && <button onClick={() => filter('activity', '')}>{filters.activity === 'Unknown' ? 'Could not verify' : filters.activity} ×</button>}
        </div>}
        <div className="list-toolbar"><span className="muted small" role="status">{updating ? 'Updating…' : `${data?.items.length ?? 0} shown / ${data?.total ?? 0} matches`}</span>
          {hasFilters && <button className="text-button" onClick={resetFilters}>Clear filters</button>}</div>
        {list.loading && !data && <div className="load-state" role="status"><span className="spinner" />Loading vacancies…</div>}
        {list.error && <div className="error-banner" role="alert"><p>{list.error}</p><button onClick={refresh}>Try again</button></div>}
        {data && !data.total && <div className="empty-state"><h3>{data.storedTotal ? 'No vacancies in this view' : 'Your radar is ready'}</h3><p className="muted">{data.storedTotal ? 'Try clearing filters or choose another view.' : 'Collect vacancies or add one by URL to get started.'}</p></div>}
        {data && data.total > 0 && <>
          <div className={`table-scroll ${updating ? 'is-updating' : ''}`} aria-busy={updating}><table className="compact-jobs"><caption className="sr-only">Saved deduplicated vacancies</caption>
            <colgroup><col className="vacancy-column" /><col className="assessment-column" /><col className="application-column" /></colgroup>
            <thead><tr><th>Vacancy / company</th><th>Assessment</th><th>Application / next step</th></tr></thead>
            <tbody>{data.items.map((job) => <tr key={job.ID} className={job.activity === 'Closed' ? 'closed-row' : job.cvSent ? 'cv-sent-row' : ''}>
              <td className="vacancy-cell"><button className="job-title" onClick={() => select(job.ID)}>{job.title}</button>
                <div className="company">{job.company ?? 'Company not stated'}{job.isDemo && <span className="demo">Demo</span>}</div>
                <div className="vacancy-meta">{job.workMode === 'fully_remote' ? 'Fully remote · ' : job.workMode === 'hybrid' ? 'Hybrid · ' : ''}{job.location ?? 'Location not stated'}
                  {(job.salaryMin !== null || job.salaryMax !== null) && <> · <Salary job={job} conversion={conversion} /></>}
                  {job.activity === 'Closed' && ' · Closed'}{job.manuallyImportedAt && ' · Added manually'}</div></td>
              <td><Fit job={job} /></td><td><Badge value={job.status} />{job.cvSent && <div className="muted small tracking-indicator">✓ CV sent</div>}
                {job.viewedAt && <div className="muted small tracking-indicator">✓ Viewed</div>}
                {nextAction(job) && <div><button className="next-action" onClick={() => select(job.ID)}>{nextAction(job)}</button></div>}
                <ViewedMarker job={job} onChanged={viewed} disabled={saving || updating} /></td>
            </tr>)}</tbody></table></div>
          <div className="pagination"><span className="muted small">{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span>
            <div><button disabled={updating || data.page <= 1} onClick={() => setPage(data.page - 1)}>← Previous</button><span className="small">Page {data.page} of {Math.ceil(data.total / data.pageSize)}</span><button disabled={updating || data.page * data.pageSize >= data.total} onClick={() => setPage(data.page + 1)}>Next →</button></div></div>
        </>}
      </section>
      <footer>Fit scores measure profile match, not hiring probability.</footer>
    </main>
    {addOpen && <AddVacancy onClose={() => setAddOpen(false)} onAdded={imported} />}
    <dialog className="detail-panel" ref={dialog} aria-labelledby={detail.data ? 'detail-title' : 'loading-detail-title'} onCancel={(event) => { event.preventDefault(); select(null); }}>
      <div className="panel-toolbar"><span className="muted small">Vacancy details</span><button onClick={() => select(null)} disabled={saving} aria-label="Close vacancy details">✕</button></div>
      {detail.loading && <div className="load-state" role="status"><h2 id="loading-detail-title" className="sr-only">Vacancy details</h2><span className="spinner" />Loading vacancy…</div>}
      {detail.error && <div className="empty-state error" role="alert"><h2 id="loading-detail-title">Couldn’t load vacancy</h2><p>{detail.error}</p><button onClick={() => setDetailRevision((value) => value + 1)}>Try again</button></div>}
      {detail.data && <VacancyDetail job={detail.data} conversion={conversion} onSaved={saved} onViewed={viewed} onDirty={setDirty} onBusy={setSaving} onAssessmentQueued={refresh} saving={saving} />}
    </dialog>
  </div>;
}
