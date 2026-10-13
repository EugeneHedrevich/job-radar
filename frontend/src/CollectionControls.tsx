import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CollectionOperation } from '../../src/dashboard/types';
import { request } from './api';

export function useCollection(onFinished: () => void) {
  const [operation, setOperation] = useState<CollectionOperation | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const previous = useRef<CollectionOperation | null>(null);
  const refresh = useRef(onFinished);
  refresh.current = onFinished;
  const accept = useCallback((next: CollectionOperation | null) => {
    if (previous.current && (!next || next.startedAt < previous.current.startedAt)) return;
    if (previous.current && next && (next.ID === previous.current.ID && next.updatedAt < previous.current.updatedAt ||
      previous.current.outcome === 'Running' && next.ID !== previous.current.ID && next.startedAt <= previous.current.startedAt)) return;
    if (previous.current?.outcome === 'Running' && next && next.outcome !== 'Running') refresh.current();
    previous.current = next;
    setOperation(next);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await request<{ operation: CollectionOperation | null }>('/api/collection', { signal: controller.signal });
        if (!controller.signal.aborted) { accept(result.operation); setError(null); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to read progress');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, previous.current?.outcome === 'Running' ? 1500 : 15_000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [accept, pollRevision]);
  async function start() {
    setStarting(true); setError(null);
    try {
      const result = await request<{ operationId: string; operation: CollectionOperation }>('/api/collection', { method: 'POST' });
      accept(result.operation);
      setPollRevision((value) => value + 1);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to start collection'); }
    finally { setStarting(false); }
  }
  return { operation, starting, error, start, running: operation?.outcome === 'Running' };
}

const stages = ['Preparing', 'Collecting', 'Saving', 'Assessing', 'Finished'];
export function CollectionProgress({ operation, error, children }: {
  operation: CollectionOperation | null; error: string | null; children?: ReactNode;
}) {
  if (!operation && !error) return <details className="collection-idle"><summary>Collection diagnostics</summary>{children}</details>;
  const running = operation?.outcome === 'Running';
  const title = operation ? running ? operation.stage : {
    Completed: 'Collection finished', Empty: 'Searches returned no vacancies', Partial: 'Finished with some failures',
    Failed: 'Collection failed', NoSources: 'No sources available', Running: 'Collecting',
  }[operation.outcome] : 'Collection unavailable';
  const counts = operation && <>
    {operation.jobsAccepted != null && <p className="small">{operation.jobsFound} received · {operation.jobsAccepted} accepted · {operation.jobsFiltered ?? 0} filtered
      {operation.jobsFound - operation.jobsAccepted - (operation.jobsFiltered ?? 0) > 0 ? ` · ${operation.jobsFound - operation.jobsAccepted - (operation.jobsFiltered ?? 0)} unusable` : ''}</p>}
    {Object.entries(operation.exclusionReasons ?? {}).map(([reason, count]) => <p className="muted small" key={reason}>{count} filtered: {reason}</p>)}
    <p className="small progress-counts">{operation.tasksDone}/{operation.tasksTotal} tasks reported · {operation.jobsFound} records found · {operation.jobsNew} new jobs · {operation.jobsUpdated} updated jobs</p>
    {operation.cachedAssessments !== null && operation.cachedAssessments !== undefined ? <p className="small">
      {operation.cachedAssessments} cached assessments · {operation.rulesAssessments ?? 0} new rules assessments ·
      {' '}{operation.aiSucceeded ?? 0} successful AI assessments · {operation.aiFailures ?? 0} failed AI attempts ({operation.aiCalls} calls)</p>
      : <p className="muted small">{operation.jobsAssessed} records processed. Assessment breakdown was not recorded for this older run.</p>}
    {operation.tasksFailed > 0 && <p className="warning small">{operation.tasksFailed} failed source tasks · {operation.tasksSucceeded} succeeded · {operation.tasksSkipped} skipped</p>}
    {operation.message && <p className="muted small">{operation.message}</p>}
    {operation.aiFailureReasons.length > 0 && <ul className="failure-reasons">{operation.aiFailureReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    {!running && operation.aiBacklog > 0 && <p className="pending small">
      {operation.aiBudgetExhausted ? `AI call allowance reached (${operation.aiCalls} calls). ` : ''}
      {operation.aiBacklog} remain queued for a later collection.</p>}
  </>;
  const failure = error && <p className="error small" role="alert">{error}</p>;
  if (!running) return <section aria-label="Collection result" aria-live="polite">
    <details className="progress-panel terminal-result" key={operation?.ID}>
      <summary><strong>{title}</strong>{operation && <span className="muted small"> · {operation.jobsNew} new / {operation.jobsUpdated} updated
        {operation.jobsFiltered ? ` · ${operation.jobsFiltered} filtered` : ''}
        {operation.aiFailures ? ` · ${operation.aiFailures} AI failures` : ''}
        {operation.aiBacklog ? ` · ${operation.aiBacklog} AI queued` : ''}</span>}</summary>
      <div className="terminal-diagnostics">{counts}{children}</div>
    </details>{failure}</section>;
  const index = stages.indexOf(operation!.stage);
  return <section className="progress-panel" aria-label="Collection progress" aria-live="polite">
    <div className="progress-heading"><strong>{title}</strong><span className="muted small"><span className="spinner" /> Running</span></div>
    <ol className="stages">{stages.map((stage, position) => <li key={stage}
      className={position === index ? 'current' : position < index ? 'done' : ''}
      aria-current={position === index ? 'step' : undefined}>{stage}</li>)}</ol>
    <p className="small">{operation!.tasksDone}/{operation!.tasksTotal} tasks reported · {operation!.jobsFound} found ·
      {' '}{operation!.jobsNew} new jobs · {operation!.jobsUpdated} updated · {operation!.aiSucceeded ?? 0} successful AI · {operation!.aiCalls} AI calls</p>
    {Boolean(operation!.tasksFailed || operation!.aiFailures) && <p className="warning small">Some attempts failed; details are available below.</p>}
    <details><summary>Diagnostics</summary>{counts}{children}</details>{failure}
  </section>;
}
