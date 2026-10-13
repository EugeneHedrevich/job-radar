import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config/index.js';
import { readHealth } from './collector/health.js';
import { recoverInterruptedRuns } from './collector/lifecycle.js';
import { connectDb, db, disconnectDb, SELECT, query } from './db/index.js';
import { loadFixture } from './fixtures/load.js';
import { collect } from './pipeline/collect.js';
import { withCollectionOperation } from './pipeline/collection-operation.js';
import { claimCollection, CollectionBusyError, readOperation,
  type CollectionClaim } from './collector/lease.js';
import { notify } from './pipeline/notify.js';
import { rank, readTop, emptyRankProgress, type RankOptions } from './pipeline/rank.js';
import { PENDING_AI_STATUSES } from './pipeline/ai-queue.js';
import { directionCounters } from './pipeline/coverage.js';
import { startScheduler } from './scheduler.js';
import { log, out } from './util/log.js';

interface Args {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function num(flags: Args['flags'], key: string): number | undefined {
  const value = str(flags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

function list(flags: Args['flags'], key: string): string[] | undefined {
  const value = str(flags, key);
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
}

const HELP = `SAP Job Radar

Usage: npm run <command> -- [flags]   (or: npx tsx src/cli.ts <command> [flags])

Commands
  collect     Collect the current rotating batch and store deduplicated jobs
  enrich      Fetch descriptions for stored jobs without repeating searches
  rank        Score stored jobs against the profile and print the top results
  top         Print the current top results without re-scoring
  notify      Send queued Telegram notifications (supports --dry-run)
  cycle       One complete monitoring cycle: collect -> rank -> notify
  watch       Run the cycle on the configured schedule
  status      Show database counts, source health and configuration state
  help        Show this text

Common flags
  --batch <key>        Force a rotation batch instead of the time-based one
  --source <a,b>       Restrict collection to these sources
  --hours <n>          Override the freshness window (hours)
  --results <n>        Override results wanted per task
  --fixture <file>     Use offline demo data instead of live sources
  --demo               Shorthand for --fixture fixtures/demo-jobs.jsonl
  --limit <n>          Limit printed/sent items (default 20 for rank/top)
  --search <text>      Filter top results by title (for example UI5 or Fiori)
  --rules-only         Skip the LLM stage even when OPENAI_API_KEY is set
  --force              Ignore cached assessments
  --min-score <n>      Override the notification threshold
  --dry-run            Print notifications instead of sending them
`;

function fixtureFile(flags: Args['flags']): string | undefined {
  if (flags.get('demo')) return path.join(PROJECT_ROOT, 'fixtures', 'demo-jobs.jsonl');
  const file = str(flags, 'fixture');
  return file ? path.resolve(PROJECT_ROOT, file) : undefined;
}

async function runCollect(flags: Args['flags'], claim?: CollectionClaim) {
  const file = fixtureFile(flags);
  const summary = await collect({
    claim,
    enrichOnly: Boolean(flags.get('enrich-only')),
    ...(str(flags, 'batch') ? { batchKey: str(flags, 'batch')! } : {}),
    ...(list(flags, 'source') ? { onlySources: list(flags, 'source')! } : {}),
    ...(num(flags, 'hours') !== undefined ? { hoursOld: num(flags, 'hours')! } : {}),
    ...(num(flags, 'results') !== undefined ? { resultsWanted: num(flags, 'results')! } : {}),
    ...(file ? { fixture: loadFixture(file) } : {}),
    trigger: 'manual',
  });

  out('');
  out(`Collection run ${summary.runId}`);
  out(`  outcome            : ${summary.outcome}`);
  out(`  batch              : ${summary.batchKey}${file ? ' (offline demo fixture)' : ''}`);
  out(`  listings collected : ${summary.jobsFound}`);
  out(`  records accepted   : ${summary.ingest.accepted}`);
  out(`  records filtered   : ${summary.ingest.filtered}`);
  for (const [reason, count] of Object.entries(summary.ingest.exclusionReasons)) out(`    ${count}: ${reason}`);
  out(`  new jobs           : ${summary.ingest.created}`);
  out(`  updated jobs       : ${summary.ingest.updatedJobIds.length}`);
  out(`  merged cross-source: ${summary.ingest.mergedAcrossSources}`);
  out(`  unusable records   : ${summary.ingest.unusable}`);
  out(`  malformed lines    : ${summary.malformedLines}`);
  if (summary.outcomes.length) {
    out('  tasks:');
    for (const outcome of summary.outcomes) {
      const detail = outcome.status === 'Succeeded' ? `${outcome.resultCount} listings`
        : `${outcome.resultCount} listings; ${outcome.errorKind ? outcome.errorKind + ': ' : ''}${outcome.message ?? ''}`;
      const requests = outcome.searchRequests !== undefined ? `; HTTP requests: search=${outcome.searchRequests}, detail=${outcome.detailRequests ?? 0}` : '';
      out(`    [${outcome.status}] ${outcome.source} "${outcome.searchTerm}" @ ${outcome.location ?? outcome.countryIndeed ?? '-'} - ${detail}${requests}`);
    }
  }
  for (const skipped of summary.skipped) out(`  skipped source ${skipped.source}: ${skipped.reason}`);
  await printDirectionCounters(summary.runId);
  return summary;
}

function printTable(rows: Awaited<ReturnType<typeof rank>>): void {
  out('');
  if (!rows.length) {
    out('No current ranked results. Collect jobs and run `npm run rank` to evaluate them.');
    return;
  }
  out('  #  Score  Rec     Source-ready title                                   Company                        Location                  Posted');
  out('  -  -----  ------  --------------------------------------------------  -----------------------------  ------------------------  ----------');
  rows.forEach((row, index) => {
    out(
      [
        String(index + 1).padStart(3),
        String(row.assessment.fitScore).padStart(5),
        row.assessment.recommendation.padEnd(6),
        truncatePad(row.job.title, 50),
        truncatePad(row.job.company ?? 'unknown', 29),
        truncatePad(row.job.location ?? 'unknown', 24),
        row.job.datePosted ?? 'unknown',
      ].join('  '),
    );
  });
  out('');
  out('Scores are fit scores (profile match), not hiring probabilities.');
}

function truncatePad(value: string, width: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return (clean.length > width ? `${clean.slice(0, width - 1)}\u2026` : clean).padEnd(width);
}

async function runRank(flags: Args['flags'], jobIds?: string[], includePendingAi = false, report?: RankOptions['onProgress']) {
  let progress = emptyRankProgress();
  const ranked = await rank({
    jobIds,
    includePendingAi,
    limit: num(flags, 'limit') ?? 20,
    rulesOnly: Boolean(flags.get('rules-only')),
    force: Boolean(flags.get('force')),
    onProgress: async (next) => { progress = next; await report?.(next); },
  });
  printTable(ranked);
  out(`Assessments: ${progress.cachedAssessments} cached, ${progress.rulesAssessments} new rules, ${progress.aiSucceeded} successful AI, ${progress.aiFailures} failed AI attempts (${progress.aiCalls} calls).`);
  for (const reason of progress.failureReasons) out(`  AI diagnostic: ${reason}`);
  for (const row of ranked.slice(0, 5)) {
    out('');
    out(`${row.assessment.fitScore}/100  ${row.job.title}`);
    out(`  engine   : ${row.assessment.engine}${row.assessment.model ? ` (${row.assessment.model})` : ''}${row.cached ? ' [cached]' : ''}`);
    out(`  cv       : ${row.assessment.suggestedCvVariant ?? 'none'}`);
    out(`  why      : ${row.assessment.explanation}`);
    if (row.assessment.mandatoryGaps.length) out(`  gaps     : ${row.assessment.mandatoryGaps.join('; ')}`);
    for (const gap of row.assessment.mandatoryGapEvidence) {
      out(`  evidence : ${gap.requirement}; "${gap.vacancyQuote}"; profile ${gap.profilePath} = ${gap.profileValue}`);
    }
    if (row.assessment.missingInformation.length) out(`  unknown  : ${row.assessment.missingInformation.join('; ')}`);
    out(`  url      : ${row.job.primaryUrl}`);
  }
  await printDirectionCounters();
  return ranked;
}

async function runNotify(flags: Args['flags']) {
  const summary = await notify({
    dryRun: Boolean(flags.get('dry-run')),
    ...(num(flags, 'min-score') !== undefined ? { minFitScore: num(flags, 'min-score')! } : {}),
    ...(num(flags, 'limit') !== undefined ? { limit: num(flags, 'limit')! } : {}),
  });
  out('');
  out(`Notifications: queued ${summary.queued}, sent ${summary.sent}, failed ${summary.failed}, retried ${summary.retried}, skipped ${summary.skipped}${summary.dryRun ? ' (dry run)' : ''}`);
  await printDirectionCounters();
  return summary;
}

async function runCycle(flags: Args['flags']) {
  const reservation = await claimCollection('cli-cycle');
  if (!reservation.acquired) throw new CollectionBusyError(reservation.operationId);
  const claim = reservation.claim;
  await withCollectionOperation(claim, () => runCollect(flags, claim),
    (collected, report) => runRank(flags, collected.ingest.jobIds, !fixtureFile(flags), report), Boolean(flags.get('rules-only')));
  const operation = await readOperation(claim.operationId);
  out(`Cycle outcome: ${operation?.outcome}. ${operation?.message ?? ''}`);
  await runNotify(flags);
}

async function runStatus() {
  const config = loadConfig();
  await recoverInterruptedRuns(config);
  const { Jobs, SourceListings, CollectionRuns, Assessments, Notifications, AiAssessmentQueue } = db();
  const count = async (entity: any, where?: Record<string, unknown>) => {
    const statement = where ? SELECT.from(entity).where(where) : SELECT.from(entity);
    return (await query(statement)).length;
  };

  out('');
  out('SAP Job Radar status');
  out(`  database            : ${config.dbPath}`);
  out(`  profile version     : ${config.profile.version}`);
  out(`  scoring version     : ${config.scoring.version}`);
  out(`  LLM                 : ${config.llmAvailable ? `enabled (${config.settings.llm.model})` : 'not configured - deterministic matching only'}`);
  out(`  Telegram            : ${config.telegramAvailable ? 'configured' : 'not configured - notifications are queued only'}`);
  out(`  notify threshold    : ${config.settings.telegram.min_fit_score}/100`);
  out('');
  out(`  jobs                : ${await count(Jobs)}`);
  out(`  source listings     : ${await count(SourceListings)}`);
  out(`  collection runs     : ${await count(CollectionRuns)}`);
  out(`  assessments         : ${await count(Assessments)}`);
  out(`  AI queue pending    : ${await count(AiAssessmentQueue, { status: { in: PENDING_AI_STATUSES } })}`);
  out(`  listings closed     : ${await count(SourceListings, { activityState: 'Closed' })}`);
  out(`  notifications sent  : ${await count(Notifications, { status: 'Sent' })}`);
  out(`  notifications open  : ${await count(Notifications, { status: { in: ['Pending', 'Failed', 'Sending'] } })}`);

  const health = await readHealth();
  out('');
  out('  source health:');
  if (!health.length) out('    (no runs recorded yet)');
  for (const row of health) {
    const cooldown = row.cooldownUntil && new Date(row.cooldownUntil) > new Date() ? ` cooldown until ${row.cooldownUntil}` : '';
    out(`    ${row.source.padEnd(12)} ${row.lastStatus ?? 'unknown'} failures=${row.consecutiveFailures} rate-limit streak=${row.rateLimitStreak ?? 0}${cooldown}`);
    if (row.lastMessage) out(`      last: ${row.lastMessage.slice(0, 160)}`);
  }
  await printDirectionCounters();
}

async function printDirectionCounters(runId?: string): Promise<void> {
  out('');
  out(`Directions (${runId ? 'unique jobs seen in this collection' : 'all stored live jobs'}; current assessments, cached LLM included):`);
  out('  Direction     Collected  Description  Prescreen  LLM  Notify-ready');
  for (const row of await directionCounters(runId)) {
    out(`  ${row.direction.padEnd(12)} ${String(row.collected).padStart(9)} ${String(row.described).padStart(12)} ${String(row.prescreened).padStart(10)} ${String(row.llm).padStart(4)} ${String(row.notify).padStart(13)}`);
  }
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || flags.get('help')) {
    out(HELP);
    return 0;
  }

  const config = loadConfig();
  const offline = Boolean(fixtureFile(flags));
  // An override to the live database directory still keeps fixtures isolated.
  if (offline) config.dbPath = path.join(path.dirname(config.dbPath), 'demo', path.basename(config.dbPath));
  await connectDb();
  if (offline) {
    flags.set('dry-run', true);
    flags.set('rules-only', true);
  }

  switch (command) {
    case 'collect':
      await runCollect(flags);
      break;
    case 'enrich':
      flags.set('enrich-only', true);
      await runCollect(flags);
      break;
    case 'rank':
      await runRank(flags);
      break;
    case 'top': {
      const ranked = await readTop(num(flags, 'limit') ?? 20, str(flags, 'search'));
      printTable(ranked);
      if (!ranked.length) out('No current assessments. Run npm run rank to evaluate stored jobs.');
      break;
    }
    case 'notify':
      await runNotify(flags);
      break;
    case 'cycle':
      await runCycle(flags);
      break;
    case 'watch':
      await startScheduler({
        demo: Boolean(flags.get('demo')),
        dryRun: Boolean(flags.get('dry-run')),
      });
      return -1; // long running: do not disconnect
    case 'status':
      await runStatus();
      break;
    default:
      out(`Unknown command "${command}".`);
      out(HELP);
      return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    if (code === -1) return; // scheduler keeps the process alive
    await disconnectDb();
    process.exit(code);
  })
  .catch(async (error) => {
    log.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) log.debug(error.stack);
    await disconnectDb().catch(() => undefined);
    process.exit(1);
  });
