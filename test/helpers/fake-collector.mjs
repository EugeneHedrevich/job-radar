#!/usr/bin/env node
/**
 * Test double for python/collector.py.
 *
 * Emits a deliberately messy stream: a valid job, a line that is not JSON, a
 * line that is JSON but violates the schema, and a task result. Used to prove
 * that malformed collector output never corrupts the database.
 */
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const [task] = request.tasks;

  const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

  process.stderr.write('diagnostic line that must never be parsed as a result\n');
  emit({ type: 'meta', jobspy_version: 'test-double', tasks: request.tasks.length });
  emit({ type: 'listing_activity', task_id: task.task_id, activity: {
    source: task.source, source_job_id: 'closed-1', job_url: 'https://example.com/jobs/closed-1',
    status: 'closed', reason: 'http_410', evidence: 'HTTP 410 for listing detail', checked_at: '2026-10-10T12:00:00.000Z',
  } });

  emit({
    type: 'job',
    task_id: task.task_id,
    source: task.source,
    job: {
      id: task.search_term === 'hang' ? String(process.pid) : 'ok-1',
      site: task.source,
      title: 'SAP BTP Developer',
      company: 'Fixture Corp',
      job_url: 'https://example.com/jobs/ok-1',
      description: null,
      date_posted: null,
    },
  });

  if (task.search_term === 'hang') {
    emit({ type: 'task_started', task_id: task.task_id });
    emit({ type: 'request_stats', task_id: task.task_id, search_requests: 2, detail_requests: 1 });
    emit({ type: 'search_progress', task_id: task.task_id, cursor: { offset: 10 } });
    setInterval(() => {}, 1000);
    return;
  }

  process.stdout.write('this line is not JSON at all\n');
  emit({ type: 'job', task_id: task.task_id });          // missing required fields
  emit({ type: 'not_a_known_type', hello: 'world' });     // unknown discriminator
  process.stdout.write('\n');                             // blank line

  emit({
    type: 'task_result',
    task_id: task.task_id,
    source: task.source,
    status: 'succeeded',
    count: 1,
    duration_ms: 12,
  });
  emit({ type: 'done', tasks: request.tasks.length });
});
