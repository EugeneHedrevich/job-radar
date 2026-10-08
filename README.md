# SAP Job Radar

Finds new SAP vacancies, scores them against a single candidate profile, and pushes the
relevant ones to Telegram with an **Open vacancy** button. You open the link and apply
manually — the tool never applies on your behalf and never rewrites your CV.

```
JobSpy (Python)  ->  JSON Lines  ->  Node.js / SAP CAP  ->  SQLite  ->  matching  ->  Telegram
   collection          stdout         normalisation          store       rules+LLM      notify
                                      deduplication
```

* **Collection**: `python-jobspy` (LinkedIn, Indeed, Glassdoor), run as a subprocess.
* **Orchestration & persistence**: SAP CAP (Node.js + TypeScript) on SQLite.
* **Matching**: deterministic rules first, optional structured OpenAI evaluation second.
* **Notification**: Telegram Bot API.
* **Configuration**: YAML in `config/`, secrets in `.env`.

---

## 1. Requirements

| Tool    | Version                | Notes                                        |
| ------- | ---------------------- | -------------------------------------------- |
| Node.js | 20 or newer (22 tested) | needed for the CAP runtime and the CLI        |
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

Verify the installation without touching any live job board:

```bash
npm run cycle:demo     # offline demo fixtures in separate storage, Telegram dry run
npm test               # full test suite
npm run test:collector  # pinned JobSpy regressions with mocked HTTP (requires .venv)
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

The assessment cache revision is updated for the corrected onsite rules. A normal
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
| `npm test`                   | Test suite                                                        |
| `npm run test:collector`    | Python collector regressions against pinned JobSpy, mocked HTTP  |

Flags are passed after `--`:

```bash
npm run collect -- --batch btp-core --source indeed --hours 168 --results 10
npm run rank    -- --limit 30 --rules-only --force
npm run notify  -- --dry-run --min-score 70
npm run cycle   -- --demo --dry-run
npm run watch   -- --dry-run
```

Run `npx tsx src/cli.ts help` for the full flag list.

## 4. Configuration

| File                      | Contents                                                         |
| ------------------------- | ---------------------------------------------------------------- |
| `config/profile.yaml`     | Candidate profile, skills, availability, work authorisation, rate |
| `config/searches.yaml`    | Keywords, per-source geography, rotation, budgets, resilience     |
| `config/scoring.yaml`     | Weights, thresholds, hard rejects, signal phrases                 |
| `config/cv-variants.yaml` | CV variants that may be recommended                               |
| `config/settings.yaml`    | Database path, LLM model, Telegram threshold, schedule            |

Key behaviours driven by configuration:

* **Rotation** — `searches.rotation` defines small batches. One batch runs per cycle, so a
  3-hourly schedule walks the whole rotation instead of running every keyword against every
  country every time. The freshness window (`defaults.hours_old`, 96h) deliberately overlaps
  several cycles so a failed run loses nothing.
* **Per-source geography** — LinkedIn only understands free-text `location`; Indeed and
  Glassdoor need `country_indeed` with JobSpy's exact spelling, and Glassdoor supports fewer
  countries. There is no single "Europe" location that works everywhere.
* **Description budget** — `description_budget.max_tasks_per_run` caps how many searches may
  fetch full descriptions (one extra HTTP request per job, and the fastest way to get
  blocked). A job without a description stays incomplete: it is shown and can be reviewed,
  but it is never given an invented assessment and can never be recommended `Apply`.
* **Scoring** — `weights` must sum to 1.0. Bumping `profile.version` or `scoring.version`
  invalidates every cached assessment.

### Changing the notification threshold

`config/settings.yaml` → `telegram.min_fit_score` (default `75`). Mirror it in
`scoring.thresholds.notify` if you also want the recommendation wording to change.

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

Rules that always apply:

* **Mandatory incompatibility overrides a high score.** Permanent-only, ABAP-centric,
  predominantly functional, heavily on-site and unheld-mandatory-language roles are capped at
  `hard_rejects.score_cap` and forced to `Skip` — the LLM cannot override this.
* **Requirement boundaries are preserved.** List items and mandatory/preferred sections are
  evaluated separately, and markers are attached to their skill. Known mandatory gaps remain
  mandatory in model results and prevent `Apply`. Short names can be configured in
  `profile.not_claimed_aliases` (for example, `ABAP OO` for `ABAP OO development`).
  A shared marker also covers comma-separated lists without a colon (`Must have CAP,
  Node.js, ABAP OO development`); an explicit preferred marker changes the list context.
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

* `Jobs` — deduplicated vacancies with `status` of `New` / `Interested` / `Applied` / `Ignored`.
* `SourceListings` — one row per (source, listing), linked to a job.
* `CollectionRuns`, `CollectionTasks`, `CollectionErrors` — what ran, what failed, why.
* `SourceHealth` — per-source circuit breaker that survives restarts.
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

* Each source runs in its **own subprocess**, so a hanging or blocked board cannot affect the
  others.
* Timeouts, rate limits, blocks and network errors are classified separately. Timeouts and
  network errors get one bounded retry; **rate limits and blocks are never retried** — the
  source goes on cooldown (`resilience.cooldown_minutes`) and is reported in `npm run status`.
* No account login, cookie harvesting, CAPTCHA solving or proxy rotation is implemented. If a
  board blocks you, the tool reports it and backs off.
* Collector output is schema-validated line by line; malformed lines are counted and discarded
  rather than corrupting the database. Tasks the collector never reports on are recorded as
  failed, not silently dropped.
* JobSpy request failures reported only through its loggers are captured as task failures,
  including empty or partial results returned after a 429 or block. A block/rate limit stops
  the remaining tasks for that source immediately; ordinary empty searches remain successful.
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
npm run test:collector
npm run typecheck
```

Covers deduplication (including repeated runs, cross-source merges and false-merge
prevention), missing-field handling, mandatory-gap filtering and hard rejects, uncertainty
handling, malformed collector output, source failure isolation and cooldown, batch planning
budgets, notification retry/permanent-failure behaviour, and a full offline cycle proving that
running the same collection twice creates no duplicate jobs and sends no extra notifications.
Regression coverage includes current-assessment notification selection and queued retries,
authoritative vacancy updates, conservative vacancy identity, demo isolation and legacy data
migration, negative contract statements, mandatory gaps, and LLM request budgets. Python
tests exercise the installed JobSpy implementation with mocked HTTP responses; no live job
boards or Telegram messages are needed.
Concurrency tests hold one sender open while another independent process completes,
checking that only the claimed notification is delivered.
Additional regressions cover blank path overrides, comma-separated requirement markers,
optional and unclear attendance, and concurrent migration of a database missing claim columns.

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
* **SAP agencies (RED Global, Eursap, Whitehall, Abeo, …)** — same collector contract, one
  module per agency feed, registered as a new `source` in `config/searches.yaml`.
* **Additional APIs** (Adzuna, Jooble, Arbeitnow) — same collector contract.
* **CV tailoring** — `config/cv-variants.yaml` already carries variant metadata; a generator
  would consume `Assessments.suggestedCvVariant` plus the gap lists.
* **Dashboard** — the CAP model is already there; add a `srv/` service and expose
  `Jobs`/`Assessments` over OData, then a UI5 or React front end.
* **Richer Telegram actions** (Interested / Applied / Ignore buttons) — `Jobs.status` and
  `Notifications.telegramMessageId` are already persisted for callback handling.
* **PostgreSQL / HANA** — swap `cds.requires.db` in `src/db/index.ts`; the CDS model is
  unchanged.
