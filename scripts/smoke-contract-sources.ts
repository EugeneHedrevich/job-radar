/** Explicit bounded live check. Uses normal ingestion/health; no AI or delivery. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connectDb, disconnectDb, db, queryOne, SELECT } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';
import { collect } from '../src/pipeline/collect.js';
import { createWeeklyState } from '../src/pipeline/weekly.js';
import { rank } from '../src/pipeline/rank.js';

const sources = ['freelancermap', 'jobserve', 'freelancede', 'hays', 'justjoin', 'nofluffjobs'];
const config = loadConfig();
const base = createWeeklyState(config, new Date(), 168);
base.automatic = false;
const report: { interval: { start: string; end: string }; sources: Record<string, unknown>[] } = {
  interval: { start: base.start, end: base.end }, sources: [],
};
await connectDb();
try {
  for (const source of sources) {
    const search = base.searches.find(search => search.task.source === source &&
      search.task.search_term === (source === 'nofluffjobs' ? 'SAP' : 'SAP BTP'))!;
    search.task.search_page_limit = 2;
    search.task.detail_request_limit = 1;
    const summary = await collect({ weekly: { ...base, searches: [search] }, onlySources: [source] });
    const row = await queryOne<any>(SELECT.from(db().CollectionRuns).columns('diagnostics').where({ ID: summary.runId }));
    const diagnostics = JSON.parse(row.diagnostics);
    const decisions = summary.ingest.decisions.filter(decision => decision.key.startsWith(source + '|'));
    // Use the same cached shared analysis/final policy; never force reassessment.
    await rank({ jobIds: summary.ingest.jobIds, rulesOnly: true });
    const result = { source, runId: summary.runId, outcome: summary.outcome,
      searchRequests: summary.outcomes.reduce((sum, outcome) => sum + (outcome.searchRequests ?? 0), 0),
      detailRequests: summary.outcomes.reduce((sum, outcome) => sum + (outcome.detailRequests ?? 0), 0),
      parsed: summary.outcomes.reduce((sum, outcome) => sum + (outcome.parsedCandidates ?? outcome.resultCount), 0),
      received: summary.jobsFound, outsideInterval: diagnostics.counts?.outsideInterval ?? 0,
      filtered: summary.ingest.filtered, exclusionReasons: summary.ingest.exclusionReasons,
      duplicates: decisions.filter(decision => ['unchanged', 'updated', 'merged'].includes(decision.action)).length +
        summary.outcomes.reduce((sum, outcome) => sum + (outcome.duplicateCandidates ?? 0), 0),
      created: decisions.filter(decision => decision.action === 'created').length,
      deferred: summary.ingest.deferred,
      replayedSavedCandidates: diagnostics.replayedCandidates?.created ?? 0,
      skipped: summary.skipped,
      stopReason: summary.outcomes.map(outcome => outcome.status === 'Failed' ? outcome.message : outcome.coverageReason).filter(Boolean).join('; '),
      tasks: summary.outcomes, aiCalls: 0, notifications: 0 };
    report.sources.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const target = path.join(path.dirname(config.dbPath), 'contract-source-smoke.json');
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log(`Saved non-secret smoke report: ${target}`);
  await disconnectDb();
}
