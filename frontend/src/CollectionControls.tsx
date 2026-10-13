import { useCallback, useEffect, useRef, useState } from 'react';
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
export function CollectionProgress({ operation, error }: { operation: CollectionOperation | null; error: string | null }) {
  if (!operation && !error) return null;
  const index = operation ? stages.indexOf(operation.stage) : -1;
  return <section className="progress-panel" aria-label="Collection progress" aria-live="polite">
    {operation && <>
      <div className="progress-heading"><strong>{operation.outcome === 'Running' ? operation.stage :
        { Completed: 'Collection finished', Empty: 'No vacancies found', Partial: 'Finished with partial failures',
          Failed: 'Collection failed', NoSources: 'No sources available' }[operation.outcome]}</strong>
        <span className="muted small">{operation.outcome === 'Running' ? <><span className="spinner" /> Running</> : operation.outcome}</span></div>
      <ol className="stages" aria-label="Collection stages">{stages.map((stage, position) =>
        <li key={stage} className={position === index ? 'current' : position < index ? 'done' : ''}
          aria-current={position === index ? 'step' : undefined}>{stage}</li>)}</ol>
      <p className="small progress-counts">{operation.tasksDone}/{operation.tasksTotal} tasks reported · {operation.jobsFound} found · {operation.jobsNew} new · {operation.jobsUpdated} updated · {operation.jobsAssessed} assessed · {operation.aiCalls} AI calls</p>
      {operation.tasksFailed > 0 && <p className="warning small">{operation.tasksFailed} failed tasks · {operation.tasksSucceeded} succeeded · {operation.tasksSkipped} skipped</p>}
      {operation.message && <p className={operation.outcome === 'Failed' || operation.outcome === 'Partial' ? 'warning small' : 'muted small'}>{operation.message}</p>}
      {operation.outcome !== 'Running' && operation.aiBacklog > 0 && <p className="pending small">
        {operation.aiBudgetExhausted ? `AI call budget reached (${operation.aiCalls} calls). ` : ''}
        {operation.aiBacklog} vacancies remain in the AI backlog for a later collection.</p>}
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
