import { loadConfig } from '../config/index.js';
import { db, SELECT, UPDATE, query, queryOne, cds } from '../db/index.js';
import { readOperation } from '../collector/lease.js';
import { analyzeVacancy } from '../matching/analysis.js';
import { normalizeJob } from '../normalize/index.js';
import { readJob } from './store.js';
import { ApiError } from './errors.js';
import { jobText } from '../matching/signals.js';
import { codeRevision, readWeeklyState, reviewConfiguration, weeklyProgress } from '../pipeline/weekly.js';

export async function patchRunDiagnostics(runId: string, patch: Record<string, unknown>) {
  await cds.tx(async (tx: any) => {
    await tx.run('UPDATE sap_jobradar_Jobs SET ID = ID WHERE 0 = 1');
    const row = await tx.run(SELECT.one.from(db().CollectionRuns).columns('diagnostics').where({ ID: runId }));
    await tx.run(UPDATE(db().CollectionRuns).set({ diagnostics: JSON.stringify({
      ...JSON.parse(row?.diagnostics ?? '{}'), ...patch }) }).where({ ID: runId }));
  });
}

/** Defense in depth for source text/errors as well as allowlisted configuration. */
export function redactDiagnostics(value: unknown): unknown {
  const secrets = Object.entries(process.env).filter(([key, val]) => val &&
    /(?:API_KEY|TOKEN|PASSWORD|SECRET|JOB_RADAR_PROXY|TELEGRAM_CHAT_ID)$/i.test(key)).map(([, val]) => val!);
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      let safe = item;
      for (const secret of secrets) if (secret.length >= 4) safe = safe.replaceAll(secret, '[redacted]');
      return safe.replace(/(https?|socks5):\/\/[^\s/@]+@/gi, '$1://[redacted]@')
        .replace(/([?&](?:token|api_key|access_token|key|signature|password|x-amz-(?:signature|credential|security-token))=)[^&#\s"']+/gi, '$1[redacted]')
        .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_=.-]+/gi, '$1 [redacted]');
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !/^(?:secrets?|password|apiKey|openaiApiKey|telegramBotToken|telegramChatId|authorization|cookie|proxy|importToken|claimToken)$/i.test(key))
      .map(([key, val]) => [key, walk(val)]));
    return item;
  };
  return walk(value);
}

/** Local persisted reads only. No ranking, lease reset, requests or notification work. */
export async function exportCollectionDiagnostics(operationId: string) {
  const operation = await readOperation(operationId);
  if (!operation) throw new ApiError(404, 'Collection operation not found');
  const weekly = await readWeeklyState(operationId);
  const config = loadConfig({ reload: true });
  const rows = await query<any>(SELECT.from(db().CollectionRuns).where({ operationId }).orderBy('startedAt asc'));
  // Compatibility for operations created before per-run diagnostics existed.
  if (!rows.length && operation.run_ID) {
    const older = await queryOne<any>(SELECT.from(db().CollectionRuns).where({ ID: operation.run_ID }));
    if (older) rows.push(older);
  }
  const ids = new Set<string>();
  const runs: Array<{ diagnostics: Record<string, any>; [key: string]: any }> = [];
  for (const row of rows) {
    const { diagnostics: raw, ...run } = row;
    const diagnostics = JSON.parse(raw ?? '{}');
    const decisions = new Map<string, any>((diagnostics.ingest?.decisions ?? []).map((decision: any) => [decision.key, decision]));
    diagnostics.candidates = diagnostics.candidates?.map((candidate: any) => {
      const job = candidate.normalized;
      const decision = job ? decisions.get(`${job.listing.source}|${job.listing.sourceJobId ?? job.listing.canonicalUrl}`) : undefined;
      return { ...candidate, decision: candidate.exclusion ? { action: 'excluded', reason: candidate.exclusion } : decision ?? null,
        analysis: job ? analyzeVacancy(config, { ...job, ID: decision?.jobId ?? 'filtered-candidate' }) : null };
    });
    for (const id of diagnostics.ingest?.jobIds ?? []) ids.add(id);
    const listings = await query<any>(SELECT.from(db().SourceListings).columns('job_ID').where({ run_ID: row.ID }));
    for (const listing of listings) ids.add(listing.job_ID);
    runs.push({ ...run, diagnostics,
      tasks: await query(SELECT.from(db().CollectionTasks).where({ run_ID: row.ID })),
      errors: await query(SELECT.from(db().CollectionErrors).where({ run_ID: row.ID })) });
  }
  const vacancies = [];
  for (const id of ids) {
    const stored = await queryOne<any>(SELECT.from(db().Jobs).where({ ID: id }));
    if (!stored) continue;
    const detail = await readJob(id); // Same cache validity and labels as the dashboard.
    const facts = await query<any>(SELECT.from(db().SourceListings).where({ job_ID: id }));
    vacancies.push({ ID: id, title: stored.title, company: stored.company, description: stored.description,
      datePosted: stored.datePosted, publicationDateKnown: Boolean(stored.datePosted),
      status: stored.status, analysis: analyzeVacancy(config, stored),
      assessmentState: detail.assessmentState, currentAssessment: detail.currentAssessment,
      assessmentHistory: detail.assessmentHistory, aiPending: detail.aiPending,
      materialSourceConflicts: detail.listings.filter((listing) => listing.conflicts?.length)
        .map((listing) => ({ source: listing.source, conflicts: listing.conflicts })),
      aiWork: await query(SELECT.from(db().AiAssessmentQueue).where({ job_ID: id })),
      sourceFacts: facts.map((listing) => ({ ...detail.listings.find((l) => l.ID === listing.ID),
        facts: normalizeJob(JSON.parse(listing.rawRecord), listing.source) })) });
  }
  const health = await query<any>(SELECT.from(db().SourceHealth));
  const attempts = runs.flatMap((run) => run.diagnostics.attempts ?? []);
  const sum = (values: any[], key: string) => values.reduce((count, row) => count + (Number(row[key]) || 0), 0);
  const sources = [...new Set<string>([...(weekly?.searches.map((search) => search.task.source) ?? []),
    ...attempts.map((row: any) => row.source)])].map((source) => {
    const rows = attempts.filter((row: any) => row.source === source);
    const searches = weekly?.searches.filter((search) => search.task.source === source);
    return { source, attempts: rows.length, successfulChecks: rows.filter((row: any) => row.status === 'Succeeded').length,
      exhaustive: rows.filter((row: any) => row.coverage === 'exhausted' && row.status === 'Succeeded').length,
      measuredSearchRequests: sum(rows, 'searchRequests'), measuredDetailRequests: sum(rows, 'detailRequests'),
      unknownUsageTasks: rows.filter((row: any) => row.searchRequests == null || row.detailRequests == null).length,
      rateLimits: rows.filter((row: any) => row.httpStatus === 429 || row.errorKind === 'rate_limit').length,
      coverage: searches ? { total: searches.length, checked: searches.filter((s) => s.checked).length,
        exhaustive: searches.filter((s) => s.state === 'exhausted').length,
        deferred: searches.filter((s) => ['pending', 'failed', 'cooldown'].includes(s.state)).length,
        failed: searches.filter((s) => s.state === 'failed').length, cooldown: searches.filter((s) => s.state === 'cooldown').length,
        capped: searches.filter((s) => ['limited', 'capped'].includes(s.state)).length } : null,
      durationMs: runs.reduce((total, run) => total + (run.diagnostics.sourceDurationsMs?.[source] ?? 0), 0) };
  });
  const stageDurations: Record<string, number> = {};
  for (const run of runs) {
    for (const [stage, ms] of Object.entries(run.diagnostics.stagesMs ?? {})) stageDurations[stage] = (stageDurations[stage] ?? 0) + Number(ms);
    stageDurations.assessing = (stageDurations.assessing ?? 0) + (run.diagnostics.assessingMs ?? 0);
  }
  const countStages = ['received', 'normalized', 'withinInterval', 'unusable', 'outsideInterval', 'unknownDates', 'boundaryDates', 'described'];
  const counts: Record<string, number> = Object.fromEntries(countStages.map((key) => [key, sum(runs.map((r) => r.diagnostics.counts ?? {}), key)]));
  for (const key of ['created', 'updated', 'uniqueListings', 'mergedAcrossSources', 'filtered', 'deferred', 'pendingEnrichment'])
    counts[key] = sum(runs.map((r) => r.diagnostics.ingest ?? {}), key);
  counts.distinctSavedVacancies = vacancies.length;
  counts.pendingAi = vacancies.filter((v) => v.aiPending).length;
  counts.pendingDescriptions = vacancies.filter((v) => !jobText(v).hasDescription && v.analysis.relevance.state !== 'irrelevant').length;
  counts.pendingCapacityReplay = sum(rows, 'jobsDeferred');
  counts.quarantinedCandidates = runs.reduce((sum, run) => sum + (run.diagnostics.quarantinedCandidates?.length ?? 0), 0);
  const exclusionReasons: Record<string, number> = {};
  for (const run of runs) for (const [reason, count] of Object.entries(run.diagnostics.ingest?.exclusionReasons ?? {}))
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + Number(count);
  if (counts.outsideInterval) exclusionReasons['Outside requested interval'] = counts.outsideInterval;
  if (counts.unusable) exclusionReasons['Normalization failed'] = counts.unusable;
  return redactDiagnostics({ formatVersion: 1, exportedAt: new Date().toISOString(), operationId,
    runId: operation.run_ID, codeRevision: weekly?.revision ?? runs[0]?.diagnostics.revision ?? null,
    exportRevision: codeRevision(), requestedInterval: weekly ? { start: weekly.start, end: weekly.end } : null,
    configurationAtStart: weekly?.configuration ?? runs[0]?.diagnostics.configuration ?? null,
    currentConfiguration: reviewConfiguration(config), operation,
    coverage: weekly ? { ...weeklyProgress(weekly), searches: weekly.searches } : null,
    notes: [
      'Successful requests/checks do not establish exhaustive coverage. Task counts are not request counts.',
      'Unknown request usage is null, never zero. Conservative budget settlement may exceed measured usage.',
      'Source dates can be date-only. Boundary-day records and unknown publication dates are identified separately.',
      'Relative date filters are widened on continuation; records after the frozen end are excluded locally.',
      'Offset pagination can move as source results change; completeness cannot be guaranteed by these adapters.',
      'Memory samples cover the Node process; collector subprocess memory is not measured.',
      'Stage counts sum observations across cycles; distinctSavedVacancies is deduplicated across the operation.',
      'Collection counts start at records emitted by adapters. Unemitted upstream cards and their exclusion reasons are unavailable.',
      'Export reflects current saved facts/cache state; each run retains its observed candidates and effective configuration.',
    ],
    durations: { elapsedMs: Date.parse(operation.finishedAt ?? new Date().toISOString()) - Date.parse(operation.startedAt),
      activeMs: runs.reduce((sum, run) => sum + (run.diagnostics.totalMs ?? 0), 0), stagesMs: stageDurations },
    counts, exclusionReasons, sources, assessmentTotals: Object.fromEntries(['assessed', 'cachedAssessments', 'rulesAssessments', 'aiCalls', 'aiSucceeded', 'aiFailures']
      .map((key) => [key, sum(runs.map((r) => r.diagnostics.assessment ?? {}), key)])),
    sourceHealth: health.map(({ importToken: _token, ...row }) => row), runs, vacancies });
}
