#!/usr/bin/env node
/** Test double that reports a per-task failure instead of crashing the run. */
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
  emit({ type: 'meta', jobspy_version: 'test-double', tasks: request.tasks.length });
  const [first, ...rest] = request.tasks;
  emit({
    type: 'task_result',
    task_id: first.task_id,
    source: first.source,
    status: 'failed',
    error_kind: 'blocked',
    message: 'simulated 403 from the job board',
    count: 0,
    duration_ms: 5,
  });
  // The remaining tasks are reported by nobody on purpose: the Node side must
  // record them as failed rather than losing them.
  void rest;
  emit({ type: 'done', tasks: request.tasks.length });
});
