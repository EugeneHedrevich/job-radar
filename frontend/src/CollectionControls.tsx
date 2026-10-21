import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CollectionOperation } from '../../src/dashboard/types';
import { request } from './api';

export function useCollection(onFinished: () => void) {
  const [operation, setOperation] = useState<CollectionOperation | null>(null);
  const [weeklyOperation, setWeeklyOperation] = useState<CollectionOperation | null>(null);
  const [starting, setStarting] = useState(false);
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
        if (!controller.signal.aborted) { accept(result.operation); setWeeklyOperation(result.weeklyOperation); setError(null); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to read progress');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, previous.current?.outcome === 'Running' ? 1500 : 15_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accept, pollRevision]);
  async function start(mode: 'rotation' | 'weekly' = 'rotation', continueId?: string) {
    setStarting(true); setError(null);
    try {
      const result = await request<{ operationId: string; operation: CollectionOperation }>('/api/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, continueId }) });
      accept(result.operation);
      setPollRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to start collection'); }
    finally { setStarting(false); }
  }
  return { operation, weeklyOperation, starting, error, start,
    periodActive: weeklyOperation?.outcome === 'Running' || Boolean(operation?.weekly && operation.outcome === 'Running'),
    running: operation?.outcome === 'Running' && operation.stage !== 'Waiting' };
}

const stages = ['Preparing', 'Collecting', 'Saving', 'Assessing', 'Finished'];
export function CollectionProgress({ operation, error, children, onContinue, starting }: {
  operation: CollectionOperation | null; error: string | null; children?: ReactNode;
  onContinue?: () => void; starting?: boolean;
}) {
  if (!operation && !error) return <details className="collection-idle"><summary>Collection diagnostics</summary>{children}</details>;
  const waiting = operation?.stage === 'Waiting';
  const running = operation?.outcome === 'Running' && !waiting;
  const title = operation ? waiting ? 'Waiting to resume' : running ? operation.stage : {
    Completed: 'Collection finished', Empty: 'Searches returned no vacancies', Partial: 'Partial coverage / results saved',
    Failed: 'Collection failed', NoSources: 'No sources available', Running: 'Collecting',
  }[operation.outcome] : 'Collection unavailable';
  const weekly = operation?.weekly;
  const range = weekly && <div className="weekly-progress">
    <p className="small"><strong>{Date.parse(weekly.end) - Date.parse(weekly.start) === 168 * 3_600_000 ? 'Last 7 days' : 'Period search'} · frozen requested interval</strong><br />
      <time dateTime={weekly.start}>{weekly.start}</time> → <time dateTime={weekly.end}>{weekly.end}</time> (UTC)</p>
    <p className="small"><strong>Overall coverage:</strong> {weekly.checked}/{weekly.total} combinations checked · {weekly.exhaustive} exhaustive ·
      {' '}{weekly.deferred - (weekly.failed ?? 0) - (weekly.cooldown ?? 0)} pending · {weekly.limited} capped · {weekly.failed ?? 0} failed · {weekly.cooldown ?? 0} on cooldown
      {weekly.cycles ? ` · ${weekly.cycles} saved cycles` : ''}</p>
    <p className="small">{weekly.relevantVacancies ?? 0} relevant saved vacancies · {weekly.pendingDescriptions ?? 0} awaiting descriptions
      {weekly.deferredCandidates ? ` · ${weekly.deferredCandidates} candidates deferred for capacity` : ''}
      {weekly.unsupported ? ` · ${weekly.unsupported} unsupported source/geography scopes` : ''}</p>
    {weekly.totals && <p className="small">Overall: {weekly.totals.received ?? 0} received · {weekly.totals.created ?? 0} new ·
      {' '}{weekly.totals.updated ?? 0} updated · {weekly.totals.assessed ?? 0} assessed · {operation?.aiCallsReserved ?? 0}/{operation?.aiCallLimit ?? 5} AI allowance used</p>}
    {(weekly.deferred > 0 || weekly.limited > 0) && <p className="warning small">Coverage is partial. Successful checks do not establish exhaustive coverage.</p>}
    {waiting && <p className="small"><strong>Cycle finished; waiting to resume.</strong> {operation?.resumeAt && <>Next eligible resume: <time dateTime={operation.resumeAt}>{new Date(operation.resumeAt).toLocaleString(undefined, { timeZone: 'Europe/Sofia' })} (Europe/Sofia)</time>.</>} {operation?.message}</p>}
    {!running && (!weekly.automatic || operation?.outcome !== 'Running') && weekly.canContinue && onContinue && <button disabled={starting} onClick={onContinue}>
      {weekly.automatic ? 'Resume period search' : 'Continue weekly search automatically'}</button>}
  </div>;
  const download = operation && <a className="small" href={`/api/collection/${encodeURIComponent(operation.ID)}/diagnostics`} download>
    Export diagnostics JSON{running ? ' (in progress)' : ''}</a>;
  const counts = operation && <>
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
  if (!running) return <section aria-label="Collection result" aria-live="polite">
    {range}{download}
    <details className="progress-panel terminal-result" key={operation?.ID}>
      <summary><strong>{title}</strong>{operation && <span className="muted small"> · {operation.jobsNew} new / {operation.jobsUpdated} updated
        {operation.jobsFiltered ? ` · ${operation.jobsFiltered} filtered` : ''}
        {operation.aiFailures ? ` · ${operation.aiFailures} AI failures` : ''}
        {operation.aiBacklog ? ` · ${operation.aiBacklog} AI queued` : ''}</span>}</summary>
      <div className="terminal-diagnostics">{counts}{children}</div>
    </details>{failure}</section>;
  const index = stages.indexOf(operation!.stage);
  return <section className="progress-panel" aria-label="Collection progress" aria-live="polite">
    <div className="progress-heading"><strong>{title}{operation?.currentSource ? ` · ${operation.currentSource}` : ''}</strong><span className="muted small"><span className="spinner" /> Running</span></div>
    {range}
    <ol className="stages">{stages.map((stage, position) => <li key={stage}
      className={position === index ? 'current' : position < index ? 'done' : ''}
      aria-current={position === index ? 'step' : undefined}>{stage}</li>)}</ol>
    <p className="small"><strong>Current cycle:</strong> {operation!.tasksDone}/{operation!.tasksTotal} tasks reported · {operation!.jobsFound} found ·
      {' '}{operation!.jobsNew} new jobs · {operation!.jobsUpdated} updated · {operation!.aiSucceeded ?? 0} successful AI · {operation!.aiCalls} AI calls</p>
    {operation!.stage === 'Assessing' && <p className="small">{operation!.assessmentRemaining ?? '…'} assessments remaining in this cycle</p>}
    {Boolean(operation!.tasksFailed || operation!.aiFailures) && <p className="warning small">Some attempts failed; details are available below.</p>}
    <details><summary>Diagnostics</summary>{download}{counts}{children}</details>{failure}
  </section>;
}
