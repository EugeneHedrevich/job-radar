import { useEffect, useRef, useState, type FormEvent } from 'react';
import { APPLICATION_STATUSES, type AssessmentState, type CollectionStatus, type JobDetail,
  type JobList, type JobSummary, type SavedAssessment, type Tracking } from '../../src/dashboard/types';
import { request, useResource } from './api';
import SourceFilter, { sourceLabel } from './SourceFilter';

const assessmentLabels: Record<AssessmentState, string> = {
  ai: 'AI assessment', rules: 'Deterministic rules', 'ai-fallback': 'AI-request fallback (rules)',
  outdated: 'Outdated assessment', unassessed: 'Not assessed',
};

const compactAssessmentLabels: Record<AssessmentState, string> = {
  ai: 'AI', rules: 'Rules', 'ai-fallback': 'AI fallback · Rules', outdated: 'Outdated', unassessed: 'Unassessed',
};

function date(value: string | null | undefined, time = false): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  // Date-only publication/application values must not shift with local timezone.
  return parsed.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric',
    ...(time ? { hour: '2-digit', minute: '2-digit' } : { timeZone: 'UTC' }) });
}

function salary(job: JobSummary): string {
  if (job.salaryMin === null && job.salaryMax === null) return 'Salary not stated';
  const range = job.salaryMin !== null && job.salaryMax !== null ?
    job.salaryMin === job.salaryMax ? String(job.salaryMin) : `${job.salaryMin}–${job.salaryMax}` :
    job.salaryMin !== null ? `From ${job.salaryMin}` : `Up to ${job.salaryMax}`;
  return `${range} ${job.salaryCurrency ?? ''} / ${job.salaryInterval ?? 'period not stated'}`;
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
    <strong className={job.fitScore === null ? 'score unknown' : `score score-${job.recommendation?.toLowerCase()}`}>{job.fitScore ?? '—'}
      {job.fitScore !== null && <small>/100</small>}</strong>
    {job.recommendation && <Badge value={job.recommendation} />}
    <span className="muted small" title={assessmentLabels[job.assessmentState]}>{compactAssessmentLabels[job.assessmentState]}</span>
    {job.aiPending && <span className="pending small">AI pending</span>}
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
          {tasks.filter((task) => task.status !== 'Succeeded' && task.message).map((task, index) => <span className="warning small" key={index}>{task.status}: {task.message}</span>)}
        </div>;
      })}</div>}
      {data?.sources.length ? <div className="source-grid">{data.sources.map((source) => <div className="source-item" key={source.source}>
        <strong>{sourceLabel(source.source)}</strong><span>{source.lastStatus ?? 'Unknown'} · {source.consecutiveFailures} consecutive failures{source.blocked ? ' · Blocked' : ''}</span>
        {source.cooldownUntil && <span className="small">Cooldown {new Date(source.cooldownUntil).getTime() > Date.now() ? 'until' : 'ended'} {date(source.cooldownUntil, true)}</span>}
        {source.lastMessage && <span className="muted small">{source.lastMessage}</span>}
      </div>)}</div> : <p className="muted small">No stored source health yet.</p>}
      {run?.errors.map((error, index) => <p className="warning small" key={index}>{error.source ?? 'Collection'} · {error.kind}: {error.message}</p>)}
      </div>
    </details>
  </section>;
}

function AssessmentView({ assessment }: { assessment: SavedAssessment }) {
  return <div className="assessment-view">
    <div className="assessment-heading"><strong>{assessment.fitScore ?? '—'}{assessment.fitScore !== null ? '/100 fit score' : ' Score missing'}</strong>
      {assessment.recommendation && <Badge value={assessment.recommendation} />}</div>
    <p className="muted small">{assessmentLabels[assessment.kind]} · {date(assessment.createdAt, true)}
      {assessment.model ? ` · ${assessment.model}` : ''} · Profile {assessment.profileVersion ?? 'Unknown'}</p>
    <p className="explanation">{assessment.explanation || 'No explanation saved.'}</p>
    {assessment.hardReject && <p className="warning">Hard rejection: {assessment.hardRejectReason ?? 'See mandatory gaps.'}</p>}
    <dl className="facts"><div><dt>Suggested CV variant</dt><dd>{assessment.suggestedCvVariant ?? 'Not suggested'}</dd></div></dl>
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
  </div>;
}

function extractTracking(job: Tracking): Tracking {
  return { status: job.status, personalNotes: job.personalNotes, applicationDate: job.applicationDate,
    cvSent: job.cvSent, sentCvLabel: job.sentCvLabel };
}

function TrackingForm({ job, onSaved, onDirty, onBusy }: {
  job: JobDetail; onSaved: (tracking: Tracking) => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void;
}) {
  const [form, setForm] = useState(() => extractTracking(job));
  const [baseline, setBaseline] = useState(() => JSON.stringify(extractTracking(job)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(form) !== baseline;
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  function change(patch: Partial<Tracking>) { setForm((previous) => ({ ...previous, ...patch })); setSaved(false); }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); onBusy(true); setError(null); setSaved(false);
    try {
      const result = await request<Tracking>(`/api/jobs/${encodeURIComponent(job.ID)}/tracking`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      setForm(result); setBaseline(JSON.stringify(result)); setSaved(true); onSaved(result);
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
      <label>CV actually sent <span className="muted">(optional filename or version)</span><input maxLength={500}
        placeholder="e.g. BTP-CV-v3.pdf" value={form.sentCvLabel ?? ''} onChange={(event) => change({ sentCvLabel: event.target.value || null })} /></label>
      <label>Personal notes<textarea rows={5} maxLength={20_000} placeholder="Contacts, next steps, interview notes…"
        value={form.personalNotes} onChange={(event) => change({ personalNotes: event.target.value })} /></label>
      <p className="muted small">CV sent is tracked separately from application status.</p>
    </fieldset>
    <div className="save-row"><button className="primary" type="submit" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save tracking'}</button>
      <span className={saved ? 'success small' : 'muted small'} role="status">{saved ? 'Saved.' : dirty ? 'Unsaved changes' : ''}</span></div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

function VacancyDetail({ job, onSaved, onDirty, onBusy }: {
  job: JobDetail; onSaved: (tracking: Tracking) => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void;
}) {
  return <>
    <div className="detail-intro"><span className="eyebrow">Vacancy details{job.isDemo ? ' · Demo data' : ''}</span>
      <h2 id="detail-title">{job.title}</h2><p>{job.company ?? 'Company not stated'} · {job.location ?? 'Location not stated'}</p>
      <div className="detail-badges"><Badge value={job.activity} /><Badge value={job.status} /></div>
      {safeUrl(job.primaryUrl) && <a className="external-link" href={safeUrl(job.primaryUrl)} target="_blank" rel="noreferrer">Open original vacancy ↗</a>}
    </div>
    <section className="detail-section"><h3>Personal tracking</h3>
      <TrackingForm key={job.ID} job={job} onSaved={onSaved} onDirty={onDirty} onBusy={onBusy} />
    </section>
    <section className="detail-section"><h3>Current assessment</h3>
      {job.aiPending && <p className="pending small">AI work pending · Queued {date(job.aiQueuedAt, true)}</p>}
      {job.currentAssessment ? <AssessmentView assessment={job.currentAssessment} /> : <p className="muted">
        {job.assessmentState === 'outdated' ? 'The saved assessment is outdated for the current vacancy or matching configuration. No current score is available.' : 'No saved current assessment yet.'}</p>}
      {!job.aiPending && <p className="muted small">No current AI work pending in the stored queue.</p>}
      {job.assessmentHistory.length > 0 && <details className="history"><summary>Assessment history ({job.assessmentHistory.length})</summary>
        {job.assessmentHistory.map((assessment) => <div className="historical" key={assessment.ID}>
          <span className="eyebrow">{assessment.current ? 'Earlier saved assessment · Inputs still valid' : 'Outdated · Historical score only'}</span>
          <AssessmentView assessment={assessment} />
        </div>)}
      </details>}
    </section>
    <section className="detail-section"><h3>Vacancy facts</h3><dl className="facts">
      <div><dt>Contract type</dt><dd>{job.jobType ?? 'Not stated'}</dd></div><div><dt>Salary</dt><dd>{salary(job)}</dd></div>
      <div><dt>Work format</dt><dd>{job.isRemote === null ? 'Not stated' : job.isRemote ? 'Remote' : 'Not remote'}</dd></div>
      <div><dt>Published</dt><dd>{date(job.datePosted)}</dd></div><div><dt>First fetched</dt><dd>{date(job.firstSeenAt, true)}</dd></div>
      <div><dt>Last seen</dt><dd>{date(job.lastSeenAt, true)}</dd></div>
    </dl></section>
    <section className="detail-section"><h3>Sources & listing activity</h3>
      {job.listings.map((listing) => <div className="listing" key={listing.ID}><div className="listing-heading"><strong>{sourceLabel(listing.source)}</strong><Badge value={listing.activity} /></div>
        {safeUrl(listing.url) && <a href={safeUrl(listing.url)} target="_blank" rel="noreferrer">Open source listing ↗</a>}
        <p className="muted small">First fetched {date(listing.firstSeenAt, true)} · Last seen {date(listing.lastSeenAt, true)}<br />
          Activity checked {date(listing.activityCheckedAt, true)}{listing.validThrough ? ` · Valid through ${date(listing.validThrough, true)}` : ''}</p>
        {listing.closureReason && <p className="small">Reason recorded: {listing.closureReason}</p>}
        {listing.activityEvidence && <p className="muted small">{listing.activityEvidence}</p>}
      </div>)}
      {!job.listings.length && <p className="muted">No source listings saved.</p>}
    </section>
    <section className="detail-section"><h3>Description</h3><div className="description">{job.description ?? 'Description not retrieved.'}</div></section>
  </>;
}

const defaultFilters = { q: '', sources: [] as string[], minScore: '', status: '', activity: '', sort: 'firstSeenAt', direction: 'desc', pageSize: '20' };

export default function App() {
  const [filters, setFilters] = useState(defaultFilters);
  const [search, setSearch] = useState('');
  const [scoreInput, setScoreInput] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [listRevision, setListRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const params = new URLSearchParams({ page: String(page) });
  for (const [key, value] of Object.entries(filters)) if (key !== 'sources' && typeof value === 'string' && value !== '') params.set(key, value);
  for (const source of filters.sources) params.append('source', source);
  const list = useResource<JobList>(`/api/jobs?${params}`, revision + listRevision, true);
  const collection = useResource<CollectionStatus>('/api/status', revision, true);
  const detail = useResource<JobDetail>(selected ? `/api/jobs/${encodeURIComponent(selected)}` : null, revision + detailRevision);
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
  function refresh() { if (guard()) { setDirty(false); setRevision((value) => value + 1); } }
  function select(id: string | null) { if (guard()) { setDirty(false); setSelected(id); } }
  function filter(key: Exclude<keyof typeof defaultFilters, 'sources'>, value: string) { setFilters((previous) => ({ ...previous, [key]: value })); setPage(1); }
  function setSources(sources: string[]) { setFilters((previous) => ({ ...previous, sources })); setPage(1); }
  function resetFilters() {
    setSearch(''); setScoreInput('');
    setFilters((previous) => ({ ...previous, q: '', sources: [], minScore: '', status: '', activity: '' })); setPage(1);
  }
  function saved(tracking: Tracking) {
    detail.setData((previous) => previous ? { ...previous, ...tracking } : previous);
    setListRevision((value) => value + 1);
  }
  const data = list.data;
  const updating = list.loading || search !== filters.q || validScore && scoreInput !== filters.minScore;
  const hasFilters = Boolean(search || scoreInput || filters.sources.length || filters.status || filters.activity);
  return <div className="app">
    <header className="app-header"><div className="brand"><div className="radar-mark"><RadarMark /></div>
      <strong>Job Radar</strong></div><span className="workspace-label">Personal workspace</span></header>
    <main>
      <div className="page-heading"><div><h1 id="vacancies-heading">Vacancies <span className="count">{data?.storedTotal ?? '—'}</span></h1>
        <p className="muted">All saved roles. Your notes and next steps.</p></div>
        <button className="refresh-button" onClick={refresh} disabled={saving || list.loading} title="Reload stored data">↻ Refresh</button>
      </div>
      <CollectionArea data={collection.data} loading={collection.loading} error={collection.error} retry={refresh} />
      <section className="vacancies" aria-labelledby="vacancies-heading">
        <div className="filters" role="search" aria-label="Filter vacancies">
          <label className="search-label"><span className="sr-only">Search title, company, location or notes</span>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" /><path d="m13 13 4 4" stroke="currentColor" strokeWidth="1.5" /></svg>
            <input type="search" placeholder="Search vacancies…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <SourceFilter options={data?.sources ?? []} value={filters.sources} onChange={setSources} />
          <label><span className="sr-only">Application status</span><select aria-label="Application status" className={filters.status ? 'has-selection' : ''} value={filters.status} onChange={(event) => filter('status', event.target.value)}><option value="">All statuses</option>{APPLICATION_STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label>
          <label><span className="sr-only">Listing activity</span><select aria-label="Listing activity" className={filters.activity ? 'has-selection' : ''} value={filters.activity} onChange={(event) => filter('activity', event.target.value)}><option value="">All activity</option>{['Active', 'Unknown', 'Closed'].map((state) => <option key={state}>{state}</option>)}</select></label>
          <label className="score-filter"><span className="sr-only">Minimum fit score</span><input type="number" aria-label="Minimum fit score" min="0" max="100" step="1" placeholder="Min. fit" value={scoreInput}
            aria-invalid={!validScore} aria-describedby={!validScore ? 'score-error' : undefined} onChange={(event) => setScoreInput(event.target.value)} />
            {!validScore && <span id="score-error" className="filter-error" role="alert">Use a whole number from 0 to 100.</span>}</label>
        </div>
        <div className="list-toolbar"><div className="results-info"><span className="muted small" role="status">{updating ? <><span className="spinner" /> Updating…</> : data ? `${data.total} ${data.total === 1 ? 'result' : 'results'}` : 'Vacancies'}</span>
          {hasFilters && <button className="text-button" onClick={resetFilters}>Clear filters</button>}</div>
          <div className="sort-controls"><label className="inline-label"><span className="sr-only">Sort by</span><select aria-label="Sort by" value={filters.sort} onChange={(event) => filter('sort', event.target.value)}>
            <option value="firstSeenAt">First fetched</option><option value="lastSeenAt">Last seen</option><option value="datePosted">Publication date</option>
            <option value="fitScore">Fit score</option><option value="title">Title</option><option value="company">Company</option></select></label>
            <button className="sort-direction" onClick={() => filter('direction', filters.direction === 'desc' ? 'asc' : 'desc')}
              aria-label={`Sort ${filters.direction === 'desc' ? 'descending' : 'ascending'}; switch to ${filters.direction === 'desc' ? 'ascending' : 'descending'}`}
              title={filters.direction === 'desc' ? 'Descending — click for ascending' : 'Ascending — click for descending'}>{filters.direction === 'desc' ? '↓' : '↑'}</button></div>
        </div>
        {(filters.sources.length > 0 || filters.minScore || filters.status || filters.activity) && <div className="filter-chips" aria-label="Active filters">
          {filters.sources.map((source) => <button key={source} onClick={() => setSources(filters.sources.filter((item) => item !== source))} aria-label={`Remove ${sourceLabel(source)} source filter`}>{sourceLabel(source)} <span aria-hidden="true">×</span></button>)}
          {filters.minScore && <button onClick={() => { setScoreInput(''); filter('minScore', ''); }} aria-label="Remove minimum fit score filter">Fit ≥ {filters.minScore} <span aria-hidden="true">×</span></button>}
          {filters.status && <button onClick={() => filter('status', '')} aria-label="Remove application status filter">{filters.status} <span aria-hidden="true">×</span></button>}
          {filters.activity && <button onClick={() => filter('activity', '')} aria-label="Remove listing activity filter">Listing: {filters.activity} <span aria-hidden="true">×</span></button>}
        </div>}
        {list.loading && !data && <div className="load-state" role="status"><span className="spinner" />Loading vacancies…</div>}
        {list.error && <div className={data ? 'error-banner' : 'empty-state error'} role="alert"><div>{!data && <h3>Couldn’t load vacancies</h3>}<p>{list.error}</p>{data && <p className="small">Showing the previous results.</p>}</div><button onClick={refresh}>Try again</button></div>}
        {data && !data.total && <div className="empty-state"><div className="empty-radar"><RadarMark /></div><h3>{data.storedTotal ? 'No vacancies match these filters' : 'Your radar is ready'}</h3>
          <p className="muted">{data.storedTotal ? 'Try another search or include more statuses and scores.' : 'Stored vacancies will appear here after a CLI collection. Refreshing only reads saved data.'}</p>
          {data.storedTotal > 0 && <button onClick={resetFilters}>Clear filters</button>}</div>}
        {data && data.total > 0 && <>
          <div className={`table-scroll ${updating ? 'is-updating' : ''}`} aria-busy={updating}><table><caption className="sr-only">Saved deduplicated vacancies</caption>
            <thead><tr><th>Vacancy</th><th>Sources</th><th title="Current saved fit score">Fit</th><th>Activity</th><th>Application</th><th>Published</th><th>First fetched</th><th>Last seen</th></tr></thead>
            <tbody>{data.items.map((job) => <tr key={job.ID} className={job.activity === 'Closed' ? 'closed-row' : ''}>
              <td className="vacancy-cell"><button className="job-title" onClick={() => select(job.ID)}>{job.title}</button>
                <div className="company">{job.company ?? 'Company not stated'}{job.isDemo && <span className="demo">Demo</span>}<span className="muted"> · {job.location ?? 'Location not stated'}</span></div>
                <div className="vacancy-meta">{job.jobType ?? 'Contract type unknown'}{(job.salaryMin !== null || job.salaryMax !== null) && <> · {salary(job)}</>}</div></td>
              <td><div className="source-tags">{job.sources.length ? job.sources.map((source) => <span key={source}>{sourceLabel(source)}</span>) : <span>Unknown</span>}</div></td>
              <td><Fit job={job} /></td><td><Badge value={job.activity} /></td>
              <td><Badge value={job.status} /><div className="muted small tracking-indicator">{job.cvSent ? '✓ CV sent' : 'CV not sent'}</div></td>
              <td className="date-cell" title={date(job.datePosted)}>{job.datePosted ? date(job.datePosted) : '—'}</td><td className="date-cell" title={date(job.firstSeenAt, true)}>{date(job.firstSeenAt)}</td>
              <td className="date-cell" title={date(job.lastSeenAt, true)}>{date(job.lastSeenAt)}</td>
            </tr>)}</tbody></table></div>
          <div className="pagination"><span className="muted small">{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span>
            <div><label className="inline-label">Rows <select value={filters.pageSize} onChange={(event) => filter('pageSize', event.target.value)}>{[10, 20, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
              <button disabled={updating || data.page <= 1} onClick={() => setPage(data.page - 1)}>← Previous</button><span className="small">Page {data.page} of {Math.ceil(data.total / data.pageSize)}</span>
              <button disabled={updating || data.page * data.pageSize >= data.total} onClick={() => setPage(data.page + 1)}>Next →</button></div></div>
        </>}
      </section>
      <footer>Fit scores measure profile match, not hiring probability.</footer>
    </main>
    <dialog className="detail-panel" ref={dialog} aria-labelledby={detail.data ? 'detail-title' : 'loading-detail-title'} onCancel={(event) => { event.preventDefault(); select(null); }}>
      <div className="panel-toolbar"><span className="muted small">Vacancy details</span><button onClick={() => select(null)} disabled={saving} aria-label="Close vacancy details">✕</button></div>
      {detail.loading && <div className="load-state" role="status"><h2 id="loading-detail-title" className="sr-only">Vacancy details</h2><span className="spinner" />Loading vacancy…</div>}
      {detail.error && <div className="empty-state error" role="alert"><h2 id="loading-detail-title">Couldn’t load vacancy</h2><p>{detail.error}</p><button onClick={() => setDetailRevision((value) => value + 1)}>Try again</button></div>}
      {detail.data && <VacancyDetail job={detail.data} onSaved={saved} onDirty={setDirty} onBusy={setSaving} />}
    </dialog>
  </div>;
}
