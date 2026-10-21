import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { MAX_PERIOD_HOURS, type CollectionOperation } from '../../src/dashboard/types';
import { FOLLOW_UP_TIMEZONE } from '../../src/util/calendar';
import { request } from './api';

export function useCollection(onFinished: () => void) {
  const [operation, setOperation] = useState<CollectionOperation | null>(null);
  const [weeklyOperation, setWeeklyOperation] = useState<CollectionOperation | null>(null);
  const [starting, setStarting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const previous = useRef<CollectionOperation | null>(null);
  const refresh = useRef(onFinished);
  refresh.current = onFinished;
  const accept = useCallback((next: CollectionOperation | null) => {
    if (previous.current && (!next || next.updatedAt < previous.current.updatedAt)) return;
    if (previous.current && next && (next.ID === previous.current.ID && next.updatedAt < previous.current.updatedAt ||
      previous.current.outcome === 'Running' && next.ID !== previous.current.ID && next.updatedAt <= previous.current.updatedAt)) return;
    if (previous.current?.outcome === 'Running' && next && (next.outcome !== 'Running' ||
      next.stage === 'Waiting' && previous.current.stage !== 'Waiting')) refresh.current();
    previous.current = next;
    setOperation(next);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await request<{ operation: CollectionOperation | null; weeklyOperation: CollectionOperation | null }>('/api/collection', { signal: controller.signal });
        if (!controller.signal.aborted) { accept(result.operation); setWeeklyOperation(result.weeklyOperation); setLoaded(true); setError(null); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to read progress');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, previous.current?.outcome === 'Running' ? 1500 : 15_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accept, pollRevision]);
  async function start(mode: 'rotation' | 'weekly' = 'rotation', continueId?: string, lookbackHours?: number, automatic?: boolean) {
    setStarting(true); setError(null);
    try {
      const result = await request<{ operationId: string; operation: CollectionOperation }>('/api/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, continueId, lookbackHours, automatic }) });
      accept(result.operation);
      setPollRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to start collection'); }
    finally { setStarting(false); }
  }
  async function pause(id: string) {
    setStarting(true); setError(null);
    try {
      const result = await request<{ operation: CollectionOperation }>(`/api/collection/${encodeURIComponent(id)}/pause`, { method: 'POST' });
      accept(result.operation); setWeeklyOperation(result.operation); setPollRevision(value => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to pause search'); }
    finally { setStarting(false); }
  }
  return { operation, weeklyOperation, starting, loading: !loaded, error, start, pause,
    periodActive: weeklyOperation?.outcome === 'Running' || Boolean(operation?.weekly && operation.outcome === 'Running'),
    running: operation?.outcome === 'Running' && operation.stage !== 'Waiting' };
}

export function PeriodSearch({ disabled, onStart }: {
  disabled: boolean; onStart: (hours: number, automatic: boolean) => void;
}) {
  const [length, setLength] = useState('7');
  const [unit, setUnit] = useState('days');
  const [automatic, setAutomatic] = useState(false);
  const id = useId();
  const factor = unit === 'weeks' ? 168 : unit === 'days' ? 24 : 1;
  const maximum = Math.floor(MAX_PERIOD_HOURS / factor);
  const valid = /^\d+$/.test(length) && Number(length) >= 1 && Number(length) <= maximum;
  return <form className="period-search" aria-label="Search vacancies by period" onSubmit={(event) => {
    event.preventDefault(); if (valid && !disabled) onStart(Number(length) * factor, automatic);
  }}>
    <div className="period-search-controls">
      <label htmlFor={id}>Last</label>
      <div className={`period-value${valid ? '' : ' invalid'}`}>
        <input id={id} type="number" min="1" max={maximum} step="1" required inputMode="numeric" aria-invalid={!valid}
          aria-label="Period length" aria-describedby={!valid ? `${id}-hint` : undefined}
          value={length} onChange={(event) => setLength(event.target.value)} />
        <select aria-label="Period unit" value={unit} onChange={(event) => setUnit(event.target.value)}>
          <option value="hours">hours</option><option value="days">days</option><option value="weeks">weeks</option>
        </select>
      </div>
      <button className="primary" disabled={disabled || !valid}>Collect vacancies</button>
    </div>
    <label className="period-auto"><input type="checkbox" checked={automatic} disabled={disabled}
      onChange={event => setAutomatic(event.target.checked)} />Continue automatically in the background</label>
    {!valid && <p id={`${id}-hint`} className="error small period-hint">Use a whole number from 1 to {maximum}.</p>}
  </form>;
}

export function CollectionToolbar({ operation, loading, busy, onStart, onPause }: {
  operation: CollectionOperation | null; loading: boolean; busy: boolean;
  onStart: (hours: number, automatic: boolean) => void; onPause: (id: string) => void;
}) {
  const active = operation?.outcome === 'Running' && operation.weekly;
  return <section className="collection-toolbar" aria-label="Collection controls">
    {loading ? <span className="muted small">Reading saved search status…</span> : active ? <>
      <div className="active-search"><strong>Period search · {periodDuration(active.start, active.end)}</strong>
        <span className="muted small">{operation.pauseRequestedAt ? 'Pause requested. The current batch will save before stopping.' :
          active.automatic ? 'Automatic continuation is on. It runs in the background until paused or completed.' : 'One batch is running. Further batches require Continue search.'}</span></div>
      <button disabled={busy || Boolean(operation.pauseRequestedAt)} onClick={() => onPause(operation.ID)}>
        {operation.pauseRequestedAt ? 'Pausing…' : operation.stage === 'Waiting' ? 'Pause search' : 'Pause after this batch'}</button>
    </> : <PeriodSearch disabled={busy} onStart={onStart} />}
  </section>;
}

const collectionTime = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone: FOLLOW_UP_TIMEZONE,
});
function periodDuration(start: string, end: string): string {
  const minutes = Math.floor((Date.parse(end) - Date.parse(start)) / 60_000);
  if (minutes < 1) return 'under 1 min';
  return [Math.floor(minutes / 1440) && `${Math.floor(minutes / 1440)}d`,
    Math.floor(minutes % 1440 / 60) && `${Math.floor(minutes % 1440 / 60)}h`, minutes % 60 && `${minutes % 60} min`].filter(Boolean).join(' ');
}

export function CollectionProgress({ operation, error, children, onContinue, starting }: {
  operation: CollectionOperation | null; error: string | null; children?: ReactNode;
  onContinue?: () => void; starting?: boolean;
}) {
  if (!operation && !error) return <details className="collection-idle"><summary>Collection diagnostics</summary>{children}</details>;
  const waiting = operation?.stage === 'Waiting';
  const running = operation?.outcome === 'Running' && !waiting;
  const title = operation ? operation.stage === 'Paused' ? 'Search paused' : operation.pauseRequestedAt && running ? 'Pausing after this batch' : waiting ? 'Waiting to resume' : running ? operation.stage : {
    Completed: 'Collection finished', Empty: 'Searches returned no vacancies', Partial: 'Partial coverage / results saved',
    Failed: 'Collection failed', NoSources: 'No sources available', Running: 'Collecting',
  }[operation.outcome] : 'Collection unavailable';
  const weekly = operation?.weekly;
  const partial = weekly && (weekly.deferred > 0 || weekly.limited > 0 || (weekly.unsupported ?? 0) > 0);
  const range = weekly && <div className="weekly-progress">
    <div className="period-heading"><strong>{Date.parse(weekly.end) - Date.parse(weekly.start) === 168 * 3_600_000 ? 'Last 7 days' : 'Period search'}</strong>
      <span className="muted small">{periodDuration(weekly.start, weekly.end)}</span>
      {partial && <span className="coverage-label">Partial coverage</span>}</div>
    <p className="small period-dates">
      <time dateTime={weekly.start}>{collectionTime.format(new Date(weekly.start))}</time> → <time dateTime={weekly.end}>{collectionTime.format(new Date(weekly.end))}</time>
      {' '}<span className="muted">({FOLLOW_UP_TIMEZONE})</span></p>
    <p className="small period-summary"><span><strong>{weekly.checked}/{weekly.total}</strong> combinations checked</span>
      <span><strong>{weekly.totals?.created ?? 0}</strong> new</span>
      <span><strong>{weekly.relevantVacancies ?? 0}</strong> relevant</span>
      <span><strong>{weekly.pendingDescriptions ?? 0}</strong> descriptions pending</span></p>
    {waiting && operation?.resumeAt && <p className="muted small">Next eligible resume: <time dateTime={operation.resumeAt}>{collectionTime.format(new Date(operation.resumeAt))} ({FOLLOW_UP_TIMEZONE})</time></p>}
    {operation?.stage === 'Paused' && <p className="muted small">Progress is saved. Refreshing the page will not resume this search.</p>}
    {!running && (!weekly.automatic || operation?.outcome !== 'Running') && weekly.canContinue && onContinue && <button disabled={starting} onClick={onContinue}>
      {operation?.stage === 'Paused' ? 'Resume saved search' : 'Continue search'}</button>}
  </div>;
  const download = operation && <a className="small" href={`/api/collection/${encodeURIComponent(operation.ID)}/diagnostics`} download>
    Export diagnostics JSON{running ? ' (in progress)' : ''}</a>;
  const counts = operation && <>
    {weekly && <>
      <p className="muted small">The requested interval is frozen. Every continuation searches the same dates; the resume time schedules the next batch.</p>
      <p className="small"><strong>Overall coverage:</strong> {weekly.exhaustive} exhaustive ·
        {' '}{weekly.deferred - (weekly.failed ?? 0) - (weekly.cooldown ?? 0)} pending · {weekly.limited} capped · {weekly.failed ?? 0} failed · {weekly.cooldown ?? 0} on cooldown
        {weekly.cycles ? ` · ${weekly.cycles} saved cycles` : ''}
        {weekly.deferredCandidates ? ` · ${weekly.deferredCandidates} deferred for capacity` : ''}
        {weekly.unsupported ? ` · ${weekly.unsupported} unsupported scopes` : ''}</p>
      {weekly.totals && <p className="small">Overall: {weekly.totals.received ?? 0} received · {weekly.totals.updated ?? 0} updated ·
        {' '}{weekly.totals.assessed ?? 0} assessment checks · {operation.aiCallsReserved ?? 0}/{operation.aiCallLimit ?? 5} AI allowance used</p>}
      {partial && <p className="warning small">Coverage is partial. Successful checks do not establish exhaustive coverage.</p>}
    </>}
    {operation.jobsAccepted != null && <p className="small">{operation.jobsFound} received · {operation.jobsAccepted} accepted · {operation.jobsFiltered ?? 0} filtered
      {' '}{operation.jobsDeferred ?? 0} deferred for enrichment
      {operation.jobsFound - operation.jobsAccepted - (operation.jobsFiltered ?? 0) - (operation.jobsDeferred ?? 0) > 0 ? ` · ${operation.jobsFound - operation.jobsAccepted - (operation.jobsFiltered ?? 0) - (operation.jobsDeferred ?? 0)} ${weekly ? 'outside interval / unusable' : 'unusable'}` : ''}</p>}
    {Object.entries(operation.exclusionReasons ?? {}).map(([reason, count]) => <p className="muted small" key={reason}>{count} filtered: {reason}</p>)}
    <p className="small progress-counts">{operation.tasksDone}/{operation.tasksTotal} tasks reported · {operation.jobsFound} records found · {operation.jobsNew} new jobs · {operation.jobsUpdated} updated jobs</p>
    {operation.cachedAssessments !== null && operation.cachedAssessments !== undefined ? <p className="small">
      {operation.cachedAssessments} cached assessments · {operation.rulesAssessments ?? 0} new rules assessments ·
      {' '}{operation.aiSucceeded ?? 0} successful AI assessments · {operation.aiFailures ?? 0} failed AI attempts ({operation.aiCalls} calls)</p>
      : <p className="muted small">{operation.jobsAssessed} records processed. Assessment breakdown was not recorded for this older run.</p>}
    {operation.tasksFailed > 0 && <p className="warning small">{operation.tasksFailed} failed source tasks · {operation.tasksSucceeded} succeeded · {operation.tasksSkipped} skipped</p>}
    {operation.message && <p className="muted small">{operation.message}</p>}
    {weekly?.limitations.map((reason) => <p className="muted small" key={reason}>{reason}</p>)}
    {operation.aiFailureReasons.length > 0 && <ul className="failure-reasons">{operation.aiFailureReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    {!running && operation.aiBacklog > 0 && <p className="pending small">
      {operation.aiBudgetExhausted ? `AI call allowance reached (${operation.aiCalls} calls). ` : ''}
      {operation.aiBacklog} remain in the shared AI queue for a later collection.</p>}
  </>;
  const failure = error && <p className="error small" role="alert">{error}</p>;
  return <section className="progress-panel" aria-label={running ? 'Collection progress' : 'Collection result'} aria-live="polite">
    <div className="progress-heading"><strong>{title}{running && operation?.currentSource ? ` · ${operation.currentSource}` : ''}</strong>
      {running && <span className="muted small"><span className="spinner" /> Running</span>}</div>
    {range}
    {operation && (running ? <div className="cycle-progress">
      <p className="small"><strong>Current batch:</strong> {operation.tasksDone}/{operation.tasksTotal} tasks · {operation.jobsFound} found
        {operation.stage === 'Assessing' && ` · ${operation.assessmentRemaining ?? '…'} assessments remaining`}</p>
      {operation.tasksTotal > 0 && <progress value={operation.tasksDone} max={operation.tasksTotal} aria-label="Current batch search tasks" />}
    </div> : !weekly && <p className="small">{operation.jobsNew} new · {operation.jobsUpdated} updated · {operation.jobsFound} found</p>)}
    {Boolean(operation?.tasksFailed || operation?.aiFailures) && <p className="warning small">Some attempts failed; details are available below.</p>}
    <div className="collection-footer"><details className="collection-diagnostics"><summary>Coverage & diagnostics</summary>
      <div className="terminal-diagnostics">{counts}{children}</div>
    </details>{download}</div>{failure}
  </section>;
}
