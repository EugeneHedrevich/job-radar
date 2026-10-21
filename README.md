# SAP Job Radar

Finds new SAP vacancies, scores them against a single candidate profile, and pushes the
relevant ones to Telegram with an **Open vacancy** button. You open the link and apply
manually — the tool never applies on your behalf and never rewrites your CV.

```
Python collectors -> JSON Lines -> Node.js / SAP CAP -> SQLite -> matching -> Telegram
   collection          stdout         normalisation          store       rules+LLM      notify
                                      deduplication
```

* **Collection**: `python-jobspy` (LinkedIn, Indeed, Glassdoor), public recruiter pages
  (RED Global, Eursap, Whitehall Resources, Michael Page, Next Ventures), and the
  Remotive, Arbeitnow, Remote OK and Jobicy public APIs, run as subprocesses.
* **Orchestration & persistence**: SAP CAP (Node.js + TypeScript) on SQLite.
* **Matching**: deterministic rules first, optional structured OpenAI evaluation second.
* **Notification**: Telegram Bot API.
* **Personal dashboard**: React + TypeScript + Vite, with a local Node API using the same SQLite database.
* **Configuration**: YAML in `config/`, secrets in `.env`.

---

## 1. Requirements

| Tool    | Version                | Notes                                        |
| ------- | ---------------------- | -------------------------------------------- |
| Node.js | 20.19+ or 22.12+ (22 tested) | needed for CAP, the CLI and Vite         |
| Python  | 3.10 or newer (3.12 tested) | required by `python-jobspy`              |
| npm     | 10 or newer            |                                               |

macOS ships Python 3.9, which **cannot** run JobSpy. Use `uv`, `pyenv` or Homebrew to get 3.12.

## 2. Setup (macOS and Linux)

```bash
git clone <this repo> sap-job-radar
cd sap-job-radar

# --- Node side -------------------------------------------------------------
npm ci                 # or: npm install

# --- Python side -----------------------------------------------------------
# Option A: uv (fastest, installs its own interpreter)
uv venv --python 3.12 .venv
uv pip install -r python/requirements.txt

# Option B: any Python >= 3.10 already on your machine
python3.12 -m venv .venv
./.venv/bin/python -m pip install -r python/requirements.txt

# --- Secrets ---------------------------------------------------------------
touch .env
# edit .env: OPENAI_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

Optional path variables in `.env` may stay empty. Missing, empty and
whitespace-only values use the configured defaults; surrounding whitespace in overrides is
trimmed. Relative paths resolve from the project root:

| Variable | Default |
| -------- | ------- |
| `JOB_RADAR_CONFIG_DIR` | `./config` |
| `JOB_RADAR_DB_DIR` | `storage.db_dir` (`./data`) |
| `JOB_RADAR_PYTHON` | `collector.python` (`./.venv/bin/python`) |
| `JOB_RADAR_COLLECTOR_SCRIPT` | `collector.script` (`./python/collector.py`) |

`JOB_RADAR_PROXY` optionally supplies one proxy for searches and enrichment. Use
`http://host:port` or `https://host:port`; a missing scheme
defaults to `http`. Authentication uses `user:password@host:port` with URL-encoded
credentials. Invalid URLs fail validation, and credentials are redacted from diagnostics.
Keep real values in `.env`, never in committed configuration.

TLS certificate verification stays enabled for every provider and proxy. If a trusted
proxy requires its own CA, set `JOB_RADAR_CA_BUNDLE` to a readable PEM bundle containing
the trusted roots (absolute path or relative to the project root). Searches and details
use the same bundle; there are no provider-specific TLS exceptions or global SSL patches.

Verify the installation without touching any live job board:

```bash
npm run cycle:demo     # offline demo fixtures in separate storage, Telegram dry run
npm test               # full test suite
npm run typecheck
```

Exact transitive Python versions are pinned in `python/requirements.lock.txt`
(`uv pip install -r python/requirements.lock.txt` for a byte-identical environment).
Node dependencies are pinned in `package.json` and `package-lock.json`.

### Telegram setup

1. Talk to [@BotFather](https://t.me/BotFather), `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot.
3. Get your numeric chat id (e.g. from [@userinfobot](https://t.me/userinfobot)) into `TELEGRAM_CHAT_ID`.

Without these two values the tool still runs: notifications are queued in SQLite and
delivered on the next run once the credentials exist.

### OpenAI setup (optional)

Set `OPENAI_API_KEY`. The model comes from `config/settings.yaml` (`llm.model`) and can be
overridden with `OPENAI_MODEL`. **Without a key the tool works fully** — matching falls back
to the deterministic rule engine.

### First live run

Fill `.env` with your existing `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`. Check `config/profile.yaml`: skills, languages, availability and work
authorisation must reflect your actual situation. The current preferences are **€45/hour
minimum, €50/hour target and at most 4 onsite days per month**; review them before running.

The starting limits are 5 new OpenAI evaluations per ranking run and 3 Telegram
notifications per notification run, with a minimum fit score of 75. Existing assessment
cache, collector budgets, source cooldowns and notification deduplication remain in use.

Run these commands manually from the project directory:

```bash
npm run status
npm run collect -- --batch btp-core --source linkedin,indeed --results 5
npm run rank
npm run notify -- --dry-run --limit 3
npm run notify -- --limit 1
```

Inspect the notification preview before the final command, which sends at most one real
Telegram notification. `--results 5` is a limit per search task, not for the whole batch.
`--dry-run` disables Telegram sending only: collection still contacts real job boards and
ranking still makes OpenAI requests when enabled. This also applies to `cycle` and `watch`
with `--dry-run`. `notify` reads stored assessments; its `--limit` limits notifications,
**not AI calls**. AI requests are bounded by `llm.max_jobs_per_run`.

The assessment cache revision is updated for corrected matching and structured gap evidence. A normal
`npm run rank` recalculates outdated assessments with the same five-request OpenAI budget;
matching current assessments still use the cache. The SQLite data, older assessments,
source cooldowns and notification history are preserved.

### Continuous monitoring

After the manual check, run **one instance** of `npm run watch`. The current schedule is
every 3 hours in `Europe/Sofia`, with an immediate cycle on startup. To keep accessible logs:

```bash
mkdir -p logs
npm run watch >> logs/job-radar.log 2>&1
```

For unattended operation, manually configure a process supervisor such as `launchd` on
macOS or `systemd` on Linux to start on boot and restart after a process crash. Set the
project working directory and make Node.js, the Python virtual environment and `.env`
available to that process. Use the log above or the supervisor's logs and arrange log
rotation. No service is installed automatically.

Keep SQLite in the same persistent directory (`./data` by default, or an absolute
`JOB_RADAR_DB_DIR`), not temporary storage. It contains the assessment cache, source
cooldowns and notification history. Do not run a second watcher against it. A sleeping or
powered-off laptop does not perform monitoring; keep the host awake or use an always-on
machine.

## 3. Commands

| Command                      | What it does                                                     |
| ---------------------------- | ---------------------------------------------------------------- |
| `npm run collect`            | Collect the current rotating batch, normalise, deduplicate, store |
| `npm run rank`               | Score stored jobs and print the top 20 with explanations          |
| `npm run top`                | Print the current top 20 without re-scoring                       |
| `npm run notify`             | Deliver queued Telegram notifications (retries failures)          |
| `npm run cycle`              | One complete monitoring cycle: collect → rank → notify            |
| `npm run dry-run`            | A complete cycle that prints notifications instead of sending     |
| `npm run watch`              | Run the cycle on the configured schedule (every 3h by default)    |
| `npm run cycle:demo`         | Complete cycle on offline demo fixtures, dry run                  |
| `npm run status`             | Database counts, source health, configuration state               |
| `npm run enrich`             | Fetch stored descriptions within the budget, without new searches |
| `npm run dev`                | Local dashboard API + Vite development server                     |
| `npm run build`              | Typecheck backend/frontend and build the dashboard                |
| `npm start`                  | Local API serving the built dashboard                             |
| `npm test`                   | Test suite                                                        |

Flags are passed after `--`:

```bash
npm run collect -- --batch btp-core --source indeed --hours 168 --results 10
npm run rank    -- --limit 30 --rules-only --force
npm run notify  -- --dry-run --min-score 70
npm run cycle   -- --demo --dry-run
npm run watch   -- --dry-run
```

Run `npx tsx src/cli.ts help` for the full flag list.

### Personal dashboard

After `npm ci`, develop with:

```bash
npm run dev
# Open http://127.0.0.1:5173
```

This starts the API on `127.0.0.1:3210` and Vite on `127.0.0.1:5173`.
Vite proxies `/api` to the backend. For separate terminals, use `npm run dev:api`
and `npm run dev:ui`. For normal use:

```bash
npm run build
npm start
# Open http://127.0.0.1:3210
```

The backend serves `dist/dashboard` and binds only to loopback. Set `JOB_RADAR_PORT`
in `.env` or the environment to change its port; Vite uses the same setting.
No Python environment, OpenAI key or Telegram credentials are required to view saved data.
Disabling LLM requests or removing the key does not invalidate a saved assessment whose
vacancy, matching configuration and model cache key still match.
Keep the Node development dependencies installed: startup uses the existing `tsx` runner.

The dashboard opens the **same persistent database** as the CLI, using
`storage.db_dir` / `storage.db_file` and `JOB_RADAR_DB_DIR`. To view an existing demo
database instead, set `JOB_RADAR_DB_DIR=./data/demo` (adjust for your storage location)
when starting it. Opening or refreshing the dashboard only reads stored vacancies.
**Collect vacancies** starts a local asynchronous collection and bounded assessment,
with a persisted operation ID. It never invokes Telegram. Progress reports the real
Preparing → Collecting → Saving → Assessing → Finished stages, task/result counts,
partial failures and the remaining AI backlog after the five-call ceiling. Reloading
the page restores progress from SQLite. A shared, renewable SQLite lease prevents
overlap with other dashboard clicks, CLI collection and scheduled cycles; expired
operations become errors after five minutes without a heartbeat.
Running operations show full stages; finished operations collapse into a compact result.
Expanded diagnostics separate unique new/updated jobs, cached assessments, new rules
assessments, successful AI assessments and failed AI attempts. The CLI and scheduler
use the same finalisation, including saved AI failure reasons.

**Last 7 days** starts a weekly review operation with an exact frozen UTC interval
(the preceding 168 hours). It walks the enabled, deduplicated query/geography
catalogue. It continues automatically through bounded cycles of at most 18 search
tasks and two description tasks, with the existing LinkedIn allowances, cooldowns
and source leases. **Five AI calls is a ceiling for the entire period operation**,
reserved durably before each attempt, including interrupted attempts. Cached AI
and local rules remain available after that allowance is spent.

The existing scheduler checks persisted continuations each minute in both the
dashboard and watch processes. It releases execution leases while waiting, records
the next eligible resume time, and recovers interrupted operations after their
lease expires. Available sources continue while LinkedIn is paused. Regular watch
cycles defer to an active period operation; automatic continuations never deliver
notifications. Keep the application running for scheduled continuation; restarting
it recovers saved work. Older manually stepped searches opt in using **Continue
weekly search automatically**. Dates, committed cursors and aggregate counters
survive continuation. Capped/unsupported scopes stop automatically; three failed
visits also cap a scope for review. A local startup error requires repair and an
explicit resume rather than repeated automatic worker starts.
Results and weekly continuation commit together, so an interrupted import can be
replayed without losing results or personal tracking. New or changed records use
the ordinary assessment cache and pending AI queue; there is no forced rescore.

Progress shows the actual interval (including shorter periods), cycle execution,
waiting reason/resume time and operation totals. It separates combinations checked, exhaustive scans, deferred combinations
and adapter-limited scans. Glassdoor has no reliable persisted continuation in the
pinned adapter, so it remains limited. Other adapters' moving offset pages and
provider retention can also prevent exhaustive historical coverage. Continuing
widens relative source filters to retain the original start, filters records after
the frozen end locally, and preserves actual publication dates. Unknown dates
remain explicitly unknown; date-only records on either boundary day have uncertain
membership in the exact interval. They are retained and identified in the report.

**Export diagnostics JSON** downloads a local report, including an in-progress or
failed operation. It contains all recorded cycles, revision/configuration snapshots,
queries, request attempts (including redirects where observable), 429s, deferred
pages, collection/filter/deduplication decisions and filtered candidate descriptions,
source facts/conflicts, shared analysis, saved assessments/cache state, AI outcomes,
stage/source timings and Node memory samples. Unknown request usage stays unknown;
task counts are never request counts. Current saved facts and assessment validity
are evaluated at export time; per-cycle observations retain what was collected.
Credentials, tokens, proxy authentication and secret configuration are redacted.
Detailed diagnostics stay collapsed in the UI. Starting the server or exporting
a report does not launch collection, paid AI requests or notifications.

LinkedIn prioritizes primary BTP, CAP, UI5/Fiori and CPI/Integration first pages
across EU and GCC scopes before overlapping variants or backfill. Each unchecked
head receives one HTTP request. Diagnostics record allowlisted parameters from
actual client calls, response statuses and timestamps; unrelated titles alone do
not establish that the provider ignored a query. Browser transport is unchanged.
Latest request status is separate from historical failures. After a rate limit,
one successful probe retains the streak and cautious one-request recovery mode;
reset requires two successful visits and a full shared window since the last 429.
Retry-After and immediate stopping on 429/403/challenges still apply.

Relevant cards without enough description evidence show **Awaiting description**
instead of a negative recommendation. SAP Integration/Integratie Consultant and
SAP-context BTP/WorkZone/Berater titles are retained; ambiguous technical SAP cards
remain in the bounded description queue. Target-family cards receive priority over
generic architecture, and unrelated Pega roles are filtered. Generic CI/CI-CD is
not an alias for SAP CPI. Generic functional PP/QM/FI/CO consultant titles no longer
occupy unresolved slots; technical SAP ambiguity remains eligible. Untracked,
automatically queued candidates expire after `pending_ttl_hours` (168 by default)
or yield to higher priority candidates, retaining saved facts and assessment history.
Manual imports and personal tracking are protected. Capacity overflow is deferred,
stored with the results/cursor in the diagnostic ledger and replayed in bounded
slices as space becomes available, without refetching search pages. It is reported
separately from relevance filtering. The shared parser handles employment/location labels,
preferred headings and negation, excluding privacy/legal/company marketing sections.
Contract testing and SAP Payroll integration are technical references, and ASAP
does not establish a zero-day deadline. AI receives the same cleaned vacancy content.

`geography_groups.gcc` configures UAE, Saudi Arabia, Qatar, Kuwait, Bahrain and Oman.
Six broad families (BTP, CAP, Integration Suite, CPI, UI5 and Fiori) search the country
group on LinkedIn/Indeed. `gulf-cities` adds one broad SAP query for Dubai, Abu Dhabi,
Riyadh, Jeddah and the Eastern Province. Equivalent existing UAE/Dubai queries are
deduplicated. Glassdoor's unsupported GCC scopes are reported without requests;
existing global agency and public catalogue searches remain available. Preferred
regions include GCC countries, preserving the Bulgaria base, remote preference,
relocation restrictions and declared work permissions. An employer office location
does not establish a candidate residency requirement or permission to work from Bulgaria.

Weekly progress separates overall coverage from current-cycle counts, including
failed, cooldown, pending, capped and exhausted work. Continuing an existing weekly
operation adds newly configured scopes while preserving its interval and cursors.
Invalid Arbeitnow URLs are validated separately from pagination, retained in
diagnostics for review, and do not discard the rest of a valid page. Pages with
quarantined candidates never establish exhaustive coverage. Whole-page parse
failures retain their cursor and wait before retrying while other work can continue.

Preparation diagnostics include database-lock wait, cursor/rotation reads, planning,
description-candidate reads and analysis timings. Preparation examines only the
selected sources and a bounded priority slice; unchanged analysis is reused under
an input/profile/scoring key. Repeated cards remain separate from measured HTTP
request counts. Changed analysis uses cache revision 23 and preserves prior assessments.
`refreshSavedVacancies()` performs an idempotent local rules refresh and can recover
relevant candidates from saved filtered observations, with no source or AI requests.

The compact list opens with newest saved, unviewed vacancies and no score cutoff. Search covers
title, company, location and personal notes. **My applications** includes personal
tracking regardless of score, assessment age or listing closure. **Added manually**
keeps imports easy to find while assessment is pending. More filters and collection
diagnostics are collapsed, along with detailed dates, source evidence and assessment history.
**Mark viewed** in a row or vacancy details moves the vacancy from **Vacancies** to
**Viewed**. The marker is saved in SQLite, survives collection and restarts, and is
independent of application status. Opening a vacancy alone does not mark it viewed.
**Mark unviewed** restores it to the main list, subject to its filters. Viewed
applications and manual imports remain in their respective views; notes and reminders
are preserved. Viewed vacancies have no minimum-score cutoff.
The searchable Sources picker accepts multiple sources: jobs from any selected source
are included once, and clearing the selection includes all sources. Filter by minimum
current fit score, application status and listing activity; sort and paginate with the
controls above and below the list. Unknown scores use `—`,
and a minimum-score filter excludes unknown scores even when the minimum is zero,
except manually imported vacancies still awaiting current assessment. Applications
and manual-import views do not apply score cutoffs.
Publication, first fetched and last seen dates stay separate.
PLN salaries show an approximate EUR equivalent in parentheses, using the latest available
[NBP average EUR rate](https://api.nbp.pl/en.html), shared across the list and vacancy details
and cached for an hour. Hover over the conversion to see the rate and publication date.
The source salary and pay period stay visible. If the rate cannot be loaded, PLN is shown
with an unavailable conversion label.

Open a vacancy to view saved assessment details and history. Current scores use the
same content/configuration cache validation as CLI/Telegram. YAML changes are read
on the next dashboard request; changes to process environment/secrets require a restart.
AI, deterministic rules and AI-request fallbacks have separate labels. A fallback
retains its actual rules score. Outdated assessments appear only in history, with no
current score. AI pending reflects the saved queue for current inputs; stale queue
entries, Ignored jobs and closed jobs do not appear as pending.

Personal tracking includes `New`, `Interested`, `Applied`, `Ignored`, `Interview` and
`Rejected`, notes, application date, a separate CV-sent checkbox and an optional actual
CV filename/version. **Suggested CV variant** comes from the read-only assessment;
**CV actually sent** is your saved label. Marking a CV as sent moves `New` or `Interested`
to `Applied`; `Interview`, `Rejected` and `Ignored` retain their explicit status.
Saved CV-sent vacancies are highlighted in blue in the list. Setting `Applied` alone
does not mark a CV as sent. Save confirmation follows the SQLite update; collection, enrichment
and ranking only update their own fields. The additive migration adds tracking columns
without replacing stored vacancies, statuses, assessments or application notes.
`Active` / `Unknown` / `Closed` is derived separately from stored listing observations
and explicit expiry using the existing activity logic. Closed vacancies retain all
personal tracking and saved assessments.

**Add vacancy** accepts a public HTTPS URL, checks canonical URLs across all stored
source listings, and reuses supported public detail adapters. The lookup is bounded
to three requests/redirects, 2 MB per response and 35 seconds overall. Source cooldowns
and disabled sources are respected. Lookups are serialized per source through SQLite;
their structured 429/403 failures and Retry-After update the same circuit breaker as
collection. A still-running earlier collection cannot clear a newer import block.
Unsupported or failed lookups ask for a title and
description; blocks, timeouts and parse failures report **Could not verify**. Only
explicit closure evidence reports **Closed**. Duplicate URLs return **Already tracked**
with existing personal notes intact. Import reuses normalization, deduplication and
rules caching; eligible AI work joins the durable queue for a subsequent collection,
without granting extra paid calls. Imports do not send Telegram messages.

When first marking a CV as sent, confirm the actual date and time (default: today in
Europe/Sofia). This is saved separately from the application date, with a follow-up
seven Sofia calendar days later, including across daylight-saving changes. Legacy
CV-sent records retain an unknown send date until you supply it. Unchanged CV-sent
saves can edit notes/status without requiring that legacy date or changing the status
automatically. Newly marking a CV as sent requires its actual send date and time.
Unchanged CV-sent saves and note edits do not reset reminders. An empty reminder
panel becomes a small indicator. The compact panel emphasises due/overdue
follow-ups and lets you complete, postpone by seven days or change the due date.
Clearing CV-sent or marking a job Ignored/Rejected cancels pending follow-ups while
preserving completed history. SQLite retains overdue reminders across restart.
These are in-app reminders; the stopped local application sends no reminder notifications.
`Ignored` excludes a job from new paid AI requests and Telegram candidates. Saving it
supersedes pending AI work and skips queued delivery, while keeping assessment, notification
and personal history. Delivery rechecks the status before sending; an already in-flight
send can still complete and retains its delivery history.

The collection card reports the last stored run's start/finish/heartbeat, batch, counts,
task failures, recorded errors and source cooldowns. It does not recover stale runs
or explain low counts. Expand it for source details.

The thin JSON API is local and intentionally limited:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/jobs` | Stored jobs with `view=vacancies\|viewed\|applications\|imports`, search, filters, sort and pagination |
| `GET /api/jobs/:id` | Vacancy facts, listings, current assessment and saved history |
| `PATCH /api/jobs/:id/tracking` | Only `status`, `viewed`, `personalNotes`, `applicationDate`, `cvSent`, `cvSentAt`, `sentCvLabel` |
| `POST /api/jobs/:id/assessment/retry` | Requeue a failed AI attempt; performs no provider request |
| `GET /api/status` | Last stored collection and source health |
| `POST /api/collection` | Start collection; return operation ID or the already active operation |
| `GET /api/collection` / `GET /api/collection/:id` | Latest or selected durable operation progress |
| `POST /api/import` | Import URL; return Added, Already tracked or Needs details and separate availability |
| `GET /api/reminders` | Pending follow-ups, ordered by Sofia due date |
| `PATCH /api/reminders/:id` | Complete, postpone or reschedule a pending follow-up |

Tracking updates accept JSON, reject unknown/read-only fields, validate statuses and
dates (`YYYY-MM-DD` or `null`; `cvSentAt` is an ISO timestamp with an offset) and return saved tracking values. Page size is capped
at 100. `viewed: true` saves a server timestamp once; `viewed: false` clears the marker.
The returned `viewedAt` is read-only; unrelated tracking saves leave it unchanged.
Supply several sources with repeated parameters (`source=indeed&source=linkedin`)
or a comma-separated value; the original single-source parameter still works.
Allowed sort fields are `firstSeenAt`, `lastSeenAt`, `datePosted`, `fitScore`,
`title` and `company`; direction is `asc` or `desc`. Unknown scores/dates sort last in
either direction. For this small single-user dataset, the API reads stored rows in bulk
and filters/paginates valid scores in memory, without a second database or service layer.

### SAP specialist sources

The `sap-specialists` batch adds public searches from
[RED Global](https://www.redglobal.com/jobs), [Eursap](https://eursap.eu/jobs) and
[Whitehall Resources](https://www.whitehallresources.com/sap-jobs/). It searches BTP, CAP,
CPI, UI5 and Fiori without requiring the title to contain "Developer". The batch is part
of the regular rotation; its 15 tasks fit inside the existing limit of 18 per run.

```bash
npm run collect -- --batch sap-specialists --source redglobal,eursap,whitehall --results 5
npm run rank
npm run notify -- --dry-run --limit 3
```

Searches include all advertised locations. The matcher applies your profile preferences;
"remote" never implies permission to work from Bulgaria. The advertiser is stored as the
agency when the client company is undisclosed. Published dates and rate intervals are
used only when explicitly supplied. A start date is not a publication date, and a rate
without an interval stays unknown. Known expired listings and known dates outside the
freshness window are excluded when that metadata is available.

The existing description budget still applies: by default two search tasks per run can
fetch full descriptions. Other results remain incomplete. To dedicate that budget to a
particular agency, use e.g.
`npm run collect -- --batch sap-specialists --source whitehall --results 5`.
Description slots rotate between available sources and keyword/location tasks. The per-batch
cursors are stored in SQLite and survive restarts, including manual repeats of the same batch.
Disabled sources, cooldowns and `--source` exclusions consume no slots and retain their cursors.
Demo collection does not advance the live cursors. Description reservations commit before I/O;
vacancies, activity observations, query rotation and search progress commit together after I/O.
A failed import rolls back its progress so replay is idempotent. No transaction spans HTTP work.
RED Global and Whitehall read at most three search pages per task; Eursap uses one filtered
response from its public browser search. Page and within-page cursors resume capped results
on subsequent runs instead of repeating the first results. Cursor expiry measures inactivity
and allows at least two complete rotation periods; successful head visits retain pagination.
A failed search with no collected records preserves its previous cursor, while a successful
empty search can finish the sweep. HTTP failures and access challenges
are reported to the existing cooldown mechanism; they are not successful empty searches.
Agency searches check the next candidates after details reveal an expired or old listing,
until the requested count is reached, pages end, or **10 detail requests per task** are spent.
The 20-second HTTP timeout and source/process timeouts still apply. A detail request failure
retains the listing identity, reports failure and stops further requests for that task.

### Priority coverage and initial backfill

Priority `rotation.batches` contain small, interleaved searches for the original six sources:

| Direction | Batches |
| --------- | ------- |
| CAP / CAPM | `cap-broad`, `cap-roles`, `cap-contracts` |
| SAPUI5 / Fiori | `ui5-broad`, `ui5-fiori`, `ui5-roles`, `ui5-contracts` |
| Joule | `joule-broad`, `joule-roles`, `joule-contracts` |
| BTP AI | `btp-ai-broad`, `btp-ai-hub`, `btp-ai-roles`, `btp-ai-contracts` |

Broad searches include SAP CAP, SAP CAPM, SAP Cloud Application Programming Model,
SAPUI5, SAP UI5, SAP Fiori, Fiori Elements, SAP Joule, Joule Studio, SAP Business AI,
SAP AI Core, SAP Generative AI Hub and SAP BTP AI. Other batches add Developer,
Consultant, Architect and separate freelance / contract / B2B queries. Broad queries
remain in use; engagement is still evaluated after collection.

Each configured batch fits the global 18-search-task ceiling. `cap-markets`, `joule-markets`
and `btp-markets` separately search supported non-LinkedIn markets outside the Netherlands,
including Germany, Switzerland, the UK, Poland, Austria and Ireland. LinkedIn allows
**two search tasks per cycle** by default; postponed keyword/location combinations rotate
through a persisted catalogue cursor on subsequent available cycles, using spare task
capacity instead of waiting for their original batch to return. Broad “SAP CAP” and “SAPUI5”
queries retain their skill wording; explicit Developer queries run separately. Identical
effective queries, geographies and filters share a task. The configured sequence allows at most
**80 LinkedIn search slots per 129 hours** before cooldowns/shared allowances, so some
combinations wait beyond one sequence. Catalogue rotation avoids duplicate queries and repeats
until the sweep wraps; diagnostics report observed first-page coverage rather than promising
complete coverage. The LinkedIn freshness window is 168 hours
to accommodate its slower sweep; other source windows are unchanged. Larger custom batches
also rotate their postponed tail. Collection outcomes distinguish successful empty searches,
partial results, all executed tasks failing (even with skipped tasks), and no available sources.
The explicit **43-cycle / 129-hour** sequence repeats the broad priority and public catalogue
batches within **57 hours**, inside the 120-hour freshness window. Rate limits and small caps
can delay individual combinations and pages; complete vacancy coverage is not guaranteed.
A global, persisted source cursor gives
each of the five eligible description sources a slot within three priority cycles
(up to nine hours), when all are available. Keyword/location progress remains separate
for each batch. Disabled sources, cooldowns and `--source` restrictions consume no slots.

Selected public detail tasks also reserve a small share of their existing request
allowance for stored jobs without descriptions and stale listing activity, independently of the search term.
Reservations persist before collection and rotate unsuccessful URLs to the queue tail.
Public detail pages may be unavailable or blocked; those failures are reported through
the normal circuit breaker. Confirmed SAP jobs remain visible when incomplete; unresolved
technical cards (for example “CAP Developer” and “Senior Full Stack Developer”) wait in the
same persisted store, hidden from the main list until their description confirms relevance.
`description_budget.max_pending_candidates` caps this unresolved queue at 40. Clear internships
and unrelated finance/sales roles are still filtered; manual imports and personal tracking remain
accessible. Confirmed closures release pending capacity without deleting history. Backlog and fresh search
details share the same allowance: **five LinkedIn detail HTTP requests per cycle**, including
redirects, divided across selected description tasks; agencies retain ten per task.
`searches.yaml` configures `linkedin_limits.max_search_tasks_per_run`,
`max_detail_requests_per_run` and `max_search_requests_per_task` (initially 2 / 5 / 3).
Search task counts are not request counts: pagination consumes additional HTTP requests.
Observed LinkedIn search/detail request counts appear in CLI output, collection history and
the dashboard, including failed requests. No third description task is added. Agency searches still refill after
old/expired detail pages, within their three-page and ten-detail-request bounds.
Every JobSpy search uses `fetch_description=False`. Selected LinkedIn tasks pass fresh
results and stored candidates to bounded `enrich_board()`. Glassdoor details also use
bounded enrichment, retaining JobSpy's search-session cookies; its stored URLs are not
replayed separately. Indeed already includes descriptions in search results.

LinkedIn search, hydration and manual detail imports use the same `curl_cffi` client
implementation. One session is reused within its worker process, with the pinned library's
native `chrome120` fingerprint and matching browser headers. JobSpy still parses search
results; its conflicting User-Agent/authority overrides are filtered. The configured proxy,
trusted CA bundle, certificate verification, request budgets and timeouts still apply.
A 429/403 or access challenge latches the client closed to further I/O; it never switches
clients, fingerprints or proxies to retry. Persistent source cooldowns remain in force.
Browser impersonation is an experiment and does not establish that an IP rate limit is resolved.
Any live smoke check must be separate and spend at most one search HTTP request, with no
detail enrichment.

For the first manual backfill, use a **7–14 day window** (`--hours 168` or `--hours 336`)
and a small `--results` value. For example, run these separately and inspect their counters:

```bash
npm run collect -- --batch cap-broad --hours 336 --results 5
npm run collect -- --batch ui5-broad --hours 336 --results 5
npm run collect -- --batch ui5-fiori --hours 336 --results 5
npm run collect -- --batch joule-broad --hours 336 --results 5
npm run collect -- --batch btp-ai-broad --hours 336 --results 5
npm run collect -- --batch btp-ai-hub --hours 336 --results 5
npm run rank
npm run notify -- --dry-run --limit 3
```

Use the other batch keys above for role and engagement variants. Repeating a batch advances
its description rotation; other batches advance the shared source cursor too.
Each invocation still allows at most **18 search tasks, two tasks
with descriptions, five OpenAI requests and three Telegram notifications**. Several invocations
multiply those budgets; `rank --limit` controls printed items, not OpenAI requests.
`--hours` only changes that manual collection: regular `watch` keeps the **120-hour** window.
The commands contact live sources/OpenAI; the final dry run only prevents Telegram delivery.

`collect`, `rank`, `notify` and `status` print a compact table for CAP/CAPM, UI5/Fiori, Joule
and BTP AI: collected unique jobs, descriptions available, prescreen passes, valid current
LLM assessments, and jobs eligible for notification. `collect` scopes the table to that run;
the others show all stored live jobs. LLM counts include cached assessments and are not a
request counter. Sent jobs, active delivery claims and exhausted retries are excluded from
notification-ready counts; the per-run Telegram cap still applies. A vacancy may count in
several directions. Missing descriptions are visible before ranking rather than counted
as a failed LLM request. SAP Joule titles retain relevance, while generic AI/Joule titles
without SAP context fail prescreen.

### EMEA and Dubai / UAE searches

Regional batches are included in the regular rotation:

| Batch | Coverage | Tasks |
| ----- | -------- | ----: |
| `emea-frontend` | SAPUI5, SAP UI5 and Fiori on LinkedIn across EMEA, Europe, the Middle East, Africa, UAE and Dubai | 18 |
| `emea-core` | BTP, CAP and CPI on LinkedIn across EMEA, the Middle East and Africa; Indeed in UAE, South Africa and Egypt | 18 |
| `uae-frontend` | Developer queries on LinkedIn and Indeed in UAE/Dubai | 12 |

```bash
npm run collect -- --batch emea-frontend --hours 720 --results 25
npm run collect -- --batch emea-core --hours 720 --results 25
npm run collect -- --batch uae-frontend --hours 720 --results 25
npm run rank -- --rules-only
```

The public SAP batch also searches Michael Page UAE with the broad `SAP` keyword.
Narrow UAE developer routes returned 404 and are excluded from the scheduled batch.
Glassdoor has no supported UAE country endpoint. Bulgaria uses LinkedIn because the
tested Indeed Bulgaria endpoint returned HTTP 400. Search coverage does not establish
work authorisation or acceptance of relocation: the existing profile still controls ranking.
Regional searches supplement country searches; provider result caps, cooldowns and
description budgets mean a scan cannot guarantee every advertised EMEA vacancy.

## 4. Configuration

| File                      | Contents                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| `config/profile.yaml`     | Candidate profile, education, skills, availability, authorisation, rate |
| `config/searches.yaml`    | Keywords, per-source geography, rotation, budgets, resilience     |
| `config/scoring.yaml`     | Weights, thresholds, hard rejects, signal phrases                 |
| `config/cv-variants.yaml` | CV variants that may be recommended                               |
| `config/settings.yaml`    | Database path, LLM model, Telegram threshold, schedule            |

Key behaviours driven by configuration:

* **Rotation** — `searches.rotation` defines small batches. One batch runs per cycle, so a
  3-hourly schedule walks the whole rotation instead of running every keyword against every
  country every time. The freshness window (`defaults.hours_old`, 120h) deliberately overlaps
  several cycles so a failed run loses nothing.
* **Per-source geography** — LinkedIn only understands free-text `location`; Indeed and
  Glassdoor need `country_indeed` with JobSpy's exact spelling, and Glassdoor supports fewer
  countries. There is no single "Europe" location that works everywhere.
* **Source queries** — `sources.<source>.queries` configures role phrase overrides, exact
  phrases, exclusions and optional geography subsets. LinkedIn uses its documented
  [quoted phrases and NOT](https://www.linkedin.com/help/linkedin/answer/a524335);
  Indeed uses [quoted phrases and dash exclusions](https://support.indeed.com/hc/en-us/articles/204488950-Improving-Your-Job-Searches-Tips-and-Help).
  Public adapters and Glassdoor keep plain phrases. The installed JobSpy LinkedIn/Indeed
  adapters support optional `employment` and `remote_only` query filters; these are unset
  by default. Query settings affect collection, independently of saved-job UI filters.
* **Relevance before persistence** — `scoring.relevance.target_role_families` selects specific
  SAP CAP/CAPM, UI5/Fiori, BTP, Joule/Business AI and Integration Suite/CPI roles.
  `hard_title_exclusions` cannot be rescued by technical words. Internship/student roles
  and unrelated finance/admin titles are rejected before a new automatic job is inserted.
  Finance process descriptions do not exclude SAP developers. Plausible SAP technical
  titles without descriptions remain available for bounded enrichment. “CAP Developer”
  is accepted when the description establishes SAP context; unrelated CAP meanings
  remain excluded. Duplicate checks
  precede this filter so existing listings, notes, applications and reminders can be updated.
  Manual additions remain allowed with a relevance warning. Runs record received,
  accepted and filtered records, with exclusion reasons; duplicate records are counted as
  received/accepted records while new/updated counts refer to distinct jobs.
* **Shared LinkedIn allowance** — SQLite records six search and five detail requests in a
  rolling three-hour window, configurable downwards in `linkedin_limits`. Collection,
  CLI/enrichment and manual imports reserve the same allowance and source lease. Repeated
  runs do not reset it. Actual usage releases unused reservations; interrupted/unknown
  requests remain charged conservatively. Structured 429/403 failures and Retry-After
  persist in source health. After cooldown, a recovery task uses one HTTP request total:
  a search for collection or a detail for enrichment/imports. Another 429 pauses LinkedIn while other
  sources continue. Diagnostics show the pause, last failure and shared request counts.
  Proxy secrets remain in the environment. Public access is not guaranteed.
  Collection and manual lookups share the existing source lease for every provider,
  including retries. Query rotation advances only through tasks that actually execute;
  skipped combinations remain eligible for the next run.
* **Description budget** — `description_budget.max_tasks_per_run` caps how many searches may
  fetch full descriptions (one extra HTTP request per job, and the fastest way to get
  blocked). A job without a description stays incomplete: it is shown and can be reviewed,
  but it is never given an invented assessment and can never be recommended `Apply`.
  A persistent global source cursor and per-batch keyword/location cursors distribute
  those slots. Existing incomplete listings share the selected slots for enrichment.
* **Scoring** — `weights` must sum to 1.0. Bumping `profile.version` or `scoring.version`
  invalidates every cached assessment.
  Matching revision 20 shares one vacancy analysis and final policy between rules and
  AI validation. Confirmed mandatory mismatches override keyword bonuses; unverified
  requirements remain unknown and cannot become confirmed matches. Compound requirements
  such as “SAP CAP / Kafka” and “SAP CAP + Kafka” are checked separately, while an
  explicit “CAP or Kafka” choice is satisfied only when one complete alternative is
  evidenced. If every alternative is explicitly contradicted, the requirement is a
  blocker; otherwise it remains uncertain. Known skills do not hide other requirements
  in the same fragment or establish a separately required certification.
  Parentheses preserve independent AND conditions: “(CAP or Node.js) and RAP ownership”
  still requires RAP. “(CAP and Node.js) or RAP ownership” can use the complete CAP/Node.js
  branch. Malformed or ambiguous grouping requires review instead of assuming a match.
  Local optional or “not required” capabilities do not block a mandatory branch or
  become confirmed profile matches. Unresolved optional-marker scope requires review.
  The AI prompt includes the exact verified gap evidence; undocumented capabilities
  remain uncertainty, and unsupported model gaps still produce an explicit rules fallback.
  Experience wording such as “Must have 5 years of React experience” retains React as a
  separate required capability. An undocumented skill requires review, never confirmed absence.
  An explicitly comparable upper rate bound below `minimum_hourly_rate` forces Skip for
  rules and AI. Missing/unknown currencies, missing upper bounds and overlapping ranges do
  not establish a below-minimum blocker.
  Technical B2B/EDI integrations are separate from employment offers;
  explicit permanent employment wins over unrelated technical wording, while genuine
  alternatives require review. Source remote flags do not prove fully remote work.
  Optional hybrid attendance does not override fully remote work. “Not fully remote”
  earns no remote bonus and leaves attendance unresolved until a schedule is stated. Negated permanent
  employment is not an offer. A Homeoffice/mobile-working cap (including “max. 2 Tage pro
  Woche”) leaves monthly attendance unknown unless the working schedule is stated;
  it never assumes a five-day week. Requirements under “Das bringst du mit” include combined German
  and English language requirements and use the actual profile language policy.
  `requirement_capabilities` lists technology aliases whose individual requirements need
  checking, including Commerce Cloud, Salesforce and EDI. Undocumented experience is
  unknown; it is not a confirmed missing skill. Unknown mandatory requirements cap the
  overall score below Apply, including unknown employment/work conditions when the
  profile restricts them, while preferred uncertainty remains separate. Independently
  verified blockers force Skip even if the model omits or misformats evidence.

The dashboard refreshes obsolete deterministic assessments at startup without provider
or Telegram calls, including tracked closed records. Assessment history is retained;
later eligible AI work uses the existing five-call allowance. The default view hides
irrelevant untracked records without deleting them; applications and deliberate imports
stay accessible. Suitability and main blockers lead the list, with technical fit in details.

The profile declares Chemical Engineering education. Qualification level and institution
remain unknown until supplied. This information is passed to OpenAI; it does not imply a
Computer Science degree or a particular diploma level.

### Changing the notification threshold

`config/settings.yaml` → `telegram.min_fit_score` (default `75`) is the single delivery
threshold. Recommendation wording is controlled independently by `scoring.thresholds.apply`
and `scoring.thresholds.review`.

`npm run top` only reads current saved assessments. After a content/configuration or cache
revision change, run `npm run rank` to produce current results; old assessments remain in
history. Successful AI output is Completed; transient provider failures are Failed, and
invalid/unsupported model output is Rejected. Failures retain a rules fallback, provenance
and reason. A normal collection does not automatically retry them. **Queue AI retry** in
vacancy details requeues one failed input key for a later collection, sharing its existing
five-call allowance; repeated clicks do not duplicate work. Each unchanged input key has
at most three paid attempts (initial plus two explicit retries), including `rank --force`.
Provider Retry-After is respected. When retrying, earlier fallback rows remain in assessment
history. Legacy fallback caches are recognised without invalidating successful caches.

### Expanded public SAP coverage

The `sap-public` batch searches six additional providers with a broad `SAP` query.
It recurs within 57 hours in the rotation and uses 12 of the 18 allowed tasks.

| Provider | Coverage | Descriptions |
| -------- | -------- | ------------ |
| [Michael Page](https://www.michaelpage.pl/jobs/sap) | Poland, Germany, Netherlands, UK, Switzerland, France and UAE | Budgeted public detail pages |
| [Next Ventures](https://next-ventures.com/jobs/?s=SAP) | Public international SAP recruiter vacancies | Budgeted public detail pages |
| [Remotive](https://remotive.com/api/remote-jobs?search=SAP) | Remote jobs, retaining candidate location restrictions | Included in API results |
| [Arbeitnow](https://www.arbeitnow.com/blog/job-board-api) | Employer listings, including regional Arbeitnow URLs | Included in API results |
| [Remote OK](https://remoteok.com/api) | Latest public remote job feed | Included in API results |
| [Jobicy](https://jobicy.com/jobs-rss-feed) | Public remote SAP keyword search | Included in API results |

```bash
npm run collect -- --batch sap-public --results 10
npm run collect -- --batch sap-public --source michaelpage --results 10
npm run enrich -- --source linkedin,redglobal,whitehall,michaelpage,nextventures --results 5 --hours 336
npm run rank -- --rules-only
```

Michael Page and Next Ventures use a 90-day source freshness window because open
recruiter adverts often remain active for weeks. The original posting date is retained;
explicit expiries are respected. `--hours` overrides the window for every selected source.
Broad collection preserves functional as well as technical SAP roles; the existing profile
still determines ranking and Telegram eligibility. API sources retain their platform URLs
and source attribution. Searches are bounded to three pages; feed/API availability does
not guarantee exhaustive vacancy coverage. Public adapters save page/index progress;
LinkedIn saves bounded offsets below 1,000 and Indeed below 300 with at most three
HTTP searches per task. Indeed's offset still refetches earlier API pages; Glassdoor's
pinned offset implementation cannot reliably resume a later page. Its capped scans are
explicitly marked incomplete instead of claiming coverage beyond the first results.
Resumed LinkedIn searches reserve a head check within their actual HTTP allowance.
Indeed uses one JobSpy invocation to check the head and walk to the saved backfill,
so it does not request the first page twice within a task. Public page
adapters likewise reserve one of their three page slots for the head; a head and backfill
within page one reuse its response. Head observations
do not overwrite backfill cursors; failed empty lookups retain progress. A one-request
LinkedIn allowance alternates head/backfill visits. Sweeps restart at exhaustion or after
at least two rotation periods without verified activity. Changed queries reset their saved progress.
`coverage.catch_up_hours` extends the next visit after a missed head check by at most 72 hours;
every sixth successful visit can scan up to 720 hours (`older_scan_every` / `older_scan_hours`).
These visits use the same request/task allowance and preserve actual publication dates and
explicit closure evidence. Source diagnostics separate successful checks, incomplete scans and
pending descriptions; a successful check is not a claim of exhaustive coverage.
Regional location never proves cross-border
eligibility, and PLN rates are never treated as EUR.
Successful LinkedIn details are cached by canonical job ID across the run's tasks;
reusing them consumes no HTTP allowance. Explicit activity refreshes still fetch again.

The first saved source listing remains authoritative for canonical vacancy facts; secondary
sources fill missing fields and retain their latest conflicting observations in listing details.
Conflicting compensation values/units are kept together rather than constructing a comparable
rate from unrelated source amounts and currencies.
Equivalent whitespace/case and tracking-URL changes do not replace established facts or
invalidate the assessment cache. Alternating sources cannot repeatedly replace descriptions,
rates or employment conditions; real changes from the authoritative source still refresh them.

`enrich` spends at most two description tasks on relevant stored listings and issues no
new searches. It supports LinkedIn, all five recruiter adapters and public API providers'
listing pages. Full descriptions are refreshed for activity after 24 hours, even when the
listing no longer appears in search or has an old publication date. Persisted attempts
delay retries for 24 hours and rotate failed pages behind other work. Indeed already
includes descriptions; Glassdoor requires its search session and has no separate URL replay.
Bad detail markup rotates to the queue tail; rate limits, blocks and transport errors stop
requests. LinkedIn canonical redirects must preserve the same numeric listing ID within
validated public LinkedIn domains; login/access-challenge redirects trigger cooldown.
Unknown `--source` values fail with the available names, and sources absent from a batch
report which batch to use.

Freelancermap, Global Enterprise Partners, Linksap and SAP Careers returned HTTP 403
during public access checks on 2026-10-09 and remain unintegrated. Access challenges are
not bypassed. Additional sources belong in bounded batches with a tested adapter.

## 5. How matching works

**Stage 1 — cheap rules.** Keyword prescreen plus a weighted score across three dimensions:

| Dimension  | Weight | Driven by                                                      |
| ---------- | ------ | -------------------------------------------------------------- |
| technical  | 0.55   | profile skills found in the title (weighted higher) and body    |
| commercial | 0.20   | contract vs permanent signals, implied hourly rate vs target    |
| location   | 0.25   | remote/hybrid/on-site signals, country vs preferred region      |

**Stage 2 — optional LLM.** Jobs that pass the prescreen, clear
`thresholds.llm_screen_gate` and actually have a description are sent to OpenAI with a strict
JSON schema. Vacancy text is treated as untrusted input: it is truncated, delimited, and the
model is instructed never to follow instructions inside it.

Both engines return the same structured assessment: fit score 0–100, recommendation
(`Apply` / `Review` / `Skip`), strong matches, mandatory and preferred gaps, technical,
commercial and location fit, missing information, a short explanation and a suggested CV
variant.

AI mandatory gaps also include compact evidence: requirement, a short vacancy quotation,
and the exact known profile fact (`profilePath` / `profileValue`) proving incompatibility.
Quotes are checked against the original vacancy. Unlisted skills, unstated education,
unknown diploma levels and uncertain equivalency belong in `missingInformation`, not in
proven gaps. A stated experience floor such as 7+ years is not proof of less than 10 years.
Malformed or unsupported model conclusions fall back to rules with explicit uncertainty,
without another OpenAI request. Deterministic mandatory gaps, hard rejects and travel
uncertainty remain authoritative. Assessment cache revision 14 and an additive SQLite
migration preserve old assessments, jobs, notification history and unique indexes.

Every monitoring cycle ranks both collected jobs and stored candidates awaiting their
current AI cache key. `AiAssessmentQueue` retains the rules score and original waiting
time across restarts. Priority is rules score plus one point per three waiting hours,
with waiting time and job ID as stable tie breakers. All candidates share the same
five-request ceiling; valid answers complete work, while failed or rejected attempts stay
held until explicitly requeued. Input changes create a new key; `rank --force` explicitly
requests reassessment under the same attempt limit. Normal cycles never force
reassessment. `status` reports pending AI work and closed listings.

Listing activity is separate from the user's `New`, `Interested`, `Applied` or `Ignored`
status. Confirmed detail-page HTTP 404/410, expired `validThrough` and recognized closure
notices become collector observations stored on `SourceListings`, with observation history.
Future expiry dates are retained and close the listing when due without HTTP. Date-only
deadlines expire at the end of that UTC day; timestamps require an explicit timezone.
Old publication dates, missing search results, blocks and parse/transport failures do
not establish closure. A job is closed only when all its listings are confirmed closed;
an active or unknown secondary listing keeps it eligible. Closed listings are excluded
from enrichment, and closed jobs from AI work and notification delivery. Pending
notifications recheck stored activity immediately before sending and choose a remaining
available source URL. This check uses persisted observations and adds no network requests.
Activity refresh shares the existing two description slots and each provider's detail
request allowance. Transport and markup failures retain the last observation and cooldowns.

Language requirements use the actual profile language list and local mandatory/preferred
context, including multilingual requirement headings. An optional language elsewhere
cannot cancel another mandatory language. Declared professional proficiency satisfies a
professional/business requirement; fluent/native and CEFR requirements stay separate.
Country abbreviations retain case and require geographic context, so the pronoun `us`
does not restrict residence. Explicit exclusions precede EU/Europe/worldwide permissions
and retain the vacancy quotation and profile fact for a confirmed contradiction.
Basic ABAP understanding, reading and debugging remain distinct from independent ABAP
development / ABAP OO and RAP ownership; unconfirmed basic capability requires review.
The profile's availability is passed to the AI and explicit start/workload requirements
are checked against stated notice, earliest start and weekly capacity. Remote format,
office location and mandatory candidate residence are evaluated separately. Unknown
authorization, schedules, timezone compatibility and eligibility remain visible as
missing information; EU contractor permission never establishes local employment rights.

Rules that always apply:

* **Focused frontend roles use frontend skills.** Full SAPUI5/Fiori adverts with at least
  three matched role skills, including declared SAPUI5, also use the weights in
  `technical.role_profiles.ui5`. A remote UI5/JavaScript/TypeScript/OData contract can qualify
  without CAP, Node.js or BTP. Title-only and incidental UI5 mentions do not gain these
  points, and mandatory ABAP or other incompatibilities still force `Skip`.
  UI5 broad searches include Germany, the Netherlands and Poland explicitly, and
  the frontend batch searches `SAPUI5 Developer`, `SAP UI5 Developer` and `SAP Fiori Developer`.
  Use `npm run top -- --search UI5 --limit 50` or `--search Fiori` to inspect matching titles.
  If a capability explicitly absent from the profile is mentioned with an unclear obligation,
  both matching engines cap the score below `Apply` pending review. A confirmed mandatory
  requirement remains a hard rejection; an explicitly optional requirement does not block a match.
  Undocumented mandatory capabilities, such as SAP MDK, also require review. They are
  reported as missing profile evidence, rather than treated as proven incompatibilities.
* **Mandatory incompatibility overrides a high score.** Permanent-only, ABAP-centric,
  predominantly functional, heavily on-site and unheld-mandatory-language roles are capped at
  `hard_rejects.score_cap` and forced to `Skip` — the LLM cannot override this.
  An explicitly unclaimed capability that is mandatory also forces `Skip`, including
  ABAP requirements in mixed BTP/Fiori roles; positive keyword matches cannot compensate.
  Confirmed AI proficiency/qualification gaps cap the score below the `Apply` threshold.
* **Requirement boundaries are preserved.** List items and mandatory/preferred sections are
  evaluated separately, and markers are attached to their skill. Known mandatory gaps remain
  mandatory in model results and prevent `Apply`. Short names can be configured in
  `profile.not_claimed_aliases` (for example, `ABAP OO` for `ABAP OO development`).
  A shared marker also covers comma-separated lists without a colon (`Must have CAP,
  Node.js, ABAP OO development`); an explicit preferred marker changes the list context.
  Recruiter requirement sections are configurable in `signals.mandatory_sections`,
  `preferred_sections` and `non_requirement_sections`. Polish, German, French and Dutch
  profile headings are recognized, including Polish `Bardzo dobra znajomość` lists.
  Evidence includes the governing heading when a skill appears as a bare list item.
* **Travel limits are enforced for required attendance.** Explicitly mandatory onsite days
  per week/month/year are compared with
  `travel.max_onsite_days_per_month` before accepting a role. Weekly attendance is converted
  using `compensation.working_days_per_month / 5`; three required days every week exceeds the
  current four-day monthly limit. Optional or negated attendance causes no travel hard reject.
  These markers apply within the attendance requirement, including connected comma-separated
  fragments (`Onsite attendance is required, at least three days per week`, at least
  12 days/month with the current working-day setting). Independent skills or
  conditions reset that context. The `onsite_heavy` work-mode and remote-prohibition checks
  use the same local obligation markers; an optional skill elsewhere cannot disable them.
  Numeric schedules use the configured travel limit rather than a separate five-day regex.
  A frequency without a clear obligation
  is reported in `missingInformation`, including in model results; an unstated or ambiguous
  frequency is also reported there without inventing a monthly value.
* **Mixed roles are judged on the description**, not the title. A "SAP BTP Developer with
  ABAP background" that only wants ABAP for reading is not rejected.
* **Unknown is not a verdict.** An unstated rate, contract type, work mode or country lands in
  `missingInformation` and moves the dimension towards neutral — never an automatic accept or
  reject. Work authorisation is never inferred from the base location.
* **Scores are fit scores**, not hiring probabilities, and are labelled as such everywhere.
* **CV variants are only ever recommended from `config/cv-variants.yaml`.** No CV content is
  generated, and no tailored PDF is produced in this phase.

Assessments are cached by job content + profile version + scoring version + engine, so
re-running costs nothing and changing the profile forces a clean re-evaluation.
The cache also includes the effective profile, scoring and CV configuration, so changes
invalidate assessments even if a version was not bumped. Notifications use the latest
assessment matching the current vacancy and configuration; queued retries are checked again
before delivery. Failed LLM calls consume the request budget and disable further calls for
that run, with rules used for the remaining jobs.

## 6. Data model

`db/schema.cds` (CAP CDS, deployed to SQLite on first run):

* `Jobs` — deduplicated vacancies with `status` of `New` / `Interested` / `Applied` / `Ignored` /
  `Interview` / `Rejected`, personal notes, application date, CV-sent state and actual CV label.
* `SourceListings` — one row per (source, listing), linked to a job.
* `CollectionRuns`, `CollectionTasks`, `CollectionErrors` — what ran, what failed, why.
* `SourceHealth` — per-source circuit breaker that survives restarts.
* `DescriptionRotation` — per-batch description cursors that survive restarts.
* `SearchProgress` — durable bounded pagination state.
* `CollectionOperations`, `CollectionLease` — progress and shared collection ownership.
* `FollowUpReminders` — pending, completed and cancelled CV follow-ups, with Sofia due dates.
* `Assessments` — cached match results.
* `Notifications` — pending / sending / sent / failed state, attempt counter, delivery claim
  and Telegram message id.

Deduplication:

1. Exact match on `(source, sourceJobId)`.
2. Exact match on `(source, canonicalUrl)` — tracking parameters, scheme, `www.` and
   fragments are normalised away.
3. Cross-source: same normalised company **plus** either similar descriptions or
   near-identical titles with the same known city/location. A shared country, generic remote
   location or missing location is insufficient when descriptions are missing. Different
   listing identities from the same board stay separate.
   Conflicting countries, cities or explicitly stated client/project details prevent merging,
   even when recruiter descriptions share the same boilerplate.

Repeated observations of an existing listing refresh stated details, including descriptions,
rates and remote terms, while preserving known values when a new observation omits them.
Changes invalidate previous assessments. A newly merged cross-source listing fills missing
fields without replacing existing known information.

Unique indexes on `Jobs.fingerprint`, `SourceListings(source, sourceJobId)`,
`SourceListings(source, canonicalUrl)` and `Assessments.cacheKey` enforce this at the database
level, so repeated runs and restarts cannot create duplicates.

`firstSeenAt` is never used as a publication date. `datePosted` stays `null` when the source
does not state one.

The database lives in `storage.db_dir` (`./data` by default, git-ignored). Override with
`JOB_RADAR_DB_DIR`.
Demo and `--fixture` commands use a `demo/` subdirectory of that database directory and
automatically enable rules-only matching and Telegram previews. Fixture records are also
marked as demo data and cannot be delivered by a live notification run. Existing databases
are migrated without dropping data, and bundled demo listings left by older versions are
marked to prevent live delivery.

## 7. Resilience

* Each source runs in its **own subprocess**. Task and process deadlines terminate it with
  SIGKILL; the parent waits for exit before retrying. Already streamed records, request
  counts and search progress survive. Unstarted tasks are recorded as skipped.
* Collection runs heartbeat every 30 seconds. Runs with five-minute stale heartbeats are
  recovered as failed by collection/status; legacy runs receive the full process/retry
  allowance for their recorded batch. Unexpected pipeline errors also close the run as failed.
* Timeouts, rate limits, blocks and network errors are classified separately. Other sources'
  transient failures get one retry when global search/description slots remain. LinkedIn
  never adds retry tasks beyond its cycle allowance. **Rate limits and blocks are never retried** — the
  source goes on cooldown (`resilience.cooldown_minutes`) and is reported in `npm run status`.
  Rate-limit cooldowns grow 120 → 240 → 480 minutes, up to the configured 2,880-minute cap;
  a longer `Retry-After` takes precedence. A successful recovery cycle resets the streak.
* No account login, cookie harvesting, CAPTCHA solving or proxy rotation is implemented. If a
  board blocks you, the tool reports it and backs off.
* Collector output is schema-validated line by line; malformed lines are counted and discarded
  rather than corrupting the database. Tasks the collector never reports on are recorded as
  failed, not silently dropped.
* Task-local JobSpy session guards stop HTTP requests at the first 429/403 or access challenge,
  preserve partial records and retain `Retry-After`; its failure logs are captured too.
  This applies across LinkedIn, Indeed and Glassdoor. Public adapters stop at the first failed
  request and pass its retry delay through the same circuit breaker. Other sources continue.
  Ordinary empty searches and exhausted request allowances remain successful.
* Concurrent notification runs insert each job's notification once and atomically claim it
  before sending. SQLite transactions are short and never span delivery; one connection per
  process and a busy timeout prevent overlapping writes from immediately failing. Claims
  expire after five minutes for recovery after a crash, and attempts are bounded. Delivery
  followed by a crash before recording success can still be retried; Telegram delivery and
  SQLite persistence cannot be committed as one transaction. Existing duplicate queue rows
  remain as `Superseded` history, with a sent copy taking precedence.
* Existing-database migrations run in one CAP transaction. A SQLite writer lock is acquired
  before checking columns, and held through schema changes, duplicate-history reconciliation
  and index creation. Parallel processes recheck the committed schema after acquiring the
  lock. Migration failures roll back and propagate to the caller.

## 8. Tests

```bash
npm test
npm run typecheck
```

Covers deduplication (including repeated runs, cross-source merges and false-merge
prevention), missing-field handling, mandatory-gap filtering and hard rejects, uncertainty
handling, malformed collector output, source failure isolation and cooldown, batch planning
budgets, notification retry/permanent-failure behaviour, and a full offline cycle proving that
running the same collection twice creates no duplicate jobs and sends no extra notifications.
Regression coverage includes current-assessment notification selection and queued retries,
authoritative vacancy updates, conservative vacancy identity, demo isolation and legacy data
migration, negative contract statements, mandatory gaps, and LLM request budgets. The tests
use offline fixtures; no live job boards or Telegram messages are needed.
The collector fixture uses the configured Python environment and exercises pinned JobSpy
parsing plus `curl_cffi` responses with all HTTP mocked. Run it independently with
`./.venv/bin/python -B test/helpers/freshness-regression.py`.
Concurrency tests hold one sender open while another independent process completes,
checking that only the claimed notification is delivered.
Suites group matching, AI evidence, queue/cache, collection, identity, listing activity,
notifications and migrations. Shared offline fixtures and parameterized cases retain the
regressions without repeating provider, retry or matching setup.
Additional regressions cover blank path overrides, comma-separated requirement markers,
optional and unclear attendance, and concurrent migration of a database missing claim columns.
Compact dashboard regressions reuse the review fixture and temporary SQLite helper to cover
all-job visibility, score validity/labels, stored queue/activity/status reads, strict personal
updates, tracking persistence through ingestion/ranking/restart, and additive tracking migrations.

`fixtures/demo-jobs.jsonl` is **demo data** — hand-written, fictional companies, in the exact
format the Python collector emits.

## 9. Security and privacy

* `.env`, `data/`, `*.sqlite` and `cv/` are git-ignored. Never commit secrets, the database or
  personal CV files.
* The Python collector is spawned with an argument array and a JSON payload on stdin — no
  shell interpolation of configuration values.
* Vacancy text is untrusted input to the LLM: truncated, delimited and explicitly flagged as
  data the model must not obey.
* Configured regular expressions come from your own YAML, never from scraped text.

## 10. Later extension points (not implemented)

Deliberately out of scope for this MVP, with the hooks that would be used:

* **Gmail / LinkedIn email alerts** — add a new collector that emits the same JSON Lines
  contract as `python/collector.py`; nothing else changes.
* **More SAP agencies** — follow the public adapters in `python/sap_sources.py`, emit the
  same collector contract and register a source and batch in `config/searches.yaml`.
* **Additional authenticated APIs** (Adzuna, Jooble) — same collector contract;
  Arbeitnow and three public remote-job APIs are already integrated.
* **CV tailoring** — `config/cv-variants.yaml` already carries variant metadata; a generator
  would consume `Assessments.suggestedCvVariant` plus the gap lists.
* **Richer Telegram actions** (Interested / Applied / Ignore buttons) — `Jobs.status` and
  `Notifications.telegramMessageId` are already persisted for callback handling.
* **PostgreSQL / HANA** — swap `cds.requires.db` in `src/db/index.ts`; the CDS model is
  unchanged.
