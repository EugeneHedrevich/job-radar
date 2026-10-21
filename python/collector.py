#!/usr/bin/env python3
"""SAP Job Radar collector.

Collects vacancies with python-jobspy and public SAP agency adapters, emitting JSON Lines on
stdout. Every diagnostic message goes to stderr so stdout stays parseable.

This process only collects. Persistence, deduplication, matching and
notification are owned by the Node.js side.

Protocol
--------
stdin  : one JSON object -> {"tasks": [...], "task_timeout_seconds": 120}
stdout : JSON Lines, one object per line:
         {"type": "meta",        "jobspy_version": "..."}
         {"type": "job",         "task_id": "...", "source": "...", "job": {...}}
         {"type": "listing_activity", "task_id": "...", "activity": {...}}
         {"type": "task_result", "task_id": "...", "status": "succeeded", ...}
         {"type": "task_result", "task_id": "...", "status": "failed",
                                 "error_kind": "blocked|timeout|network|error", ...}
         {"type": "done",        "tasks": n}
exit   : 0 on protocol success (task failures are reported in-band),
         2 on an unusable request.
"""

from __future__ import annotations

import json
import logging
import math
import sys
import time
from threading import Lock
from contextlib import contextmanager
from unittest.mock import patch
from datetime import date, datetime, timezone
from typing import Any
from types import SimpleNamespace
from transport import LinkedInTransport, RequestBudgetExhausted, linkedin_client, network_config, retry_after, safe_message, use_transport
from progress import observed_request, request_kind, detail_phase, measure_requests, current_measurements

EMIT_LOCK = Lock()

# Columns we forward to Node. Anything else from JobSpy is dropped on purpose:
# Node must not depend on board-specific extras.
FORWARDED_COLUMNS = [
    "id",
    "site",
    "job_url",
    "job_url_direct",
    "title",
    "company",
    "location",
    "date_posted",
    "job_type",
    "salary_source",
    "interval",
    "min_amount",
    "max_amount",
    "currency",
    "is_remote",
    "job_level",
    "job_function",
    "description",
    "company_industry",
    "company_url",
    "activity_status", "activity_reason", "activity_evidence", "activity_checked_at",
    "valid_through",
]

# JobSpy kwargs a task is allowed to set. Guards against passing arbitrary
# keys into the library from a config file.
ALLOWED_TASK_PARAMS = {
    "search_term",
    "google_search_term",
    "location",
    "distance",
    "is_remote",
    "job_type",
    "results_wanted",
    "country_indeed",
    "description_format",
    "offset",
    "hours_old",
    "fetch_description",
    "enforce_annual_salary",
    "enrich_only",
    "head_only",
    "detail_request_limit", "search_request_limit", "search_cursor",
    "requested_start", "requested_end",
    "detail_title_patterns",
}


def log(message: str) -> None:
    print(safe_message(message), file=sys.stderr, flush=True)


def emit(record: dict[str, Any]) -> None:
    # Glassdoor parses cards in parallel. print() writes text and its newline
    # separately, so serialize complete protocol records from all threads.
    with EMIT_LOCK:
        print(json.dumps(record, ensure_ascii=False, default=str), flush=True)


def clean_value(value: Any) -> Any:
    """Convert pandas/numpy values into JSON-safe values.

    Missing values of every flavour (NaN, NaT, pd.NA, None) become null so the
    Node side can treat them as 'unknown' rather than as a real value.
    """
    if value is None:
        return None
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()

    # Lazily touch pandas only for the types it owns.
    import pandas as pd

    try:
        if value is pd.NaT or pd.isna(value):
            return None
    except (TypeError, ValueError):
        # pd.isna raises for array-likes; those are handled below.
        pass

    if isinstance(value, (list, tuple)):
        return [clean_value(item) for item in value]
    if hasattr(value, "item"):  # numpy scalar
        return clean_value(value.item())
    text = str(value).strip()
    return text or None


def classify_error(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if "429" in text or "too many requests" in text or "rate limit" in text:
        return "rate_limit"
    if "403" in text or "blocked" in text or "captcha" in text or "forbidden" in text:
        return "blocked"
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if "connection" in text or "ssl" in text or "dns" in text or "proxy" in text:
        return "network"
    if isinstance(exc, ValueError):
        return "parse"
    return "error"


def build_kwargs(task: dict[str, Any], timeout_seconds: int = 0) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"site_name": [task["source"]], "verbose": 1}
    for key, value in task.items():
        if key in ALLOWED_TASK_PARAMS and value is not None:
            kwargs[key] = value
    if task.get("fetch_description") and task.get("detail_jobs"):
        kwargs["detail_jobs"] = task["detail_jobs"]
    if task.get('requested_start'):
        start = datetime.fromisoformat(task['requested_start'].replace('Z', '+00:00'))
        # Include the task's full deadline so a later pagination request cannot
        # move the relative lower bound beyond the frozen start.
        kwargs['hours_old'] = max(1, math.ceil((datetime.now(timezone.utc) - start).total_seconds() / 3600)) + math.ceil(timeout_seconds / 3600)
    return kwargs


def failure_info(exc):
    if not exc:
        return None
    delay = getattr(exc, 'retry_after_seconds', None)
    return (classify_error(exc), safe_message(f"{type(exc).__name__}: {exc}"),
            delay if delay is not None else retry_after(getattr(exc, 'response', None)))


@contextmanager
def jobspy_search(source, transport, kwargs):
    """Scope guards to this board's sessions, never to global requests/SSL.

    1.2.0 catches request errors; the latch still prevents any subsequent I/O.
    Stream each parsed card so killing a later page preserves earlier records.
    """
    from importlib import import_module
    module = import_module(f"jobspy.{source}")
    scraper_class = getattr(module, {"linkedin": "LinkedIn", "indeed": "Indeed", "glassdoor": "Glassdoor"}[source])
    create_session = module.create_session
    original_process = scraper_class._process_job
    scrapers = {}
    measurement = current_measurements()  # JobSpy invokes the source in another thread.

    def session_factory(**session_options):
        client = linkedin_client() if source == 'linkedin' else None
        session = SimpleNamespace(headers={}) if client else create_session(**session_options)
        request = client.request if client else session.request
        def guarded(method, url, **options):
            if client:
                client.ensure_allowed(transport)
            if transport.failure:
                raise transport.failure
            if source in {"linkedin", "indeed"}:
                if transport.search_requests >= kwargs.get('_request_stop_at', transport.search_limit):
                    kwargs['_budget_exhausted'] = True
                    raise RequestBudgetExhausted('LinkedIn request allowance exhausted')
                transport.before("search")
            options["allow_redirects"] = False
            if client:
                options['headers'] = {**session.headers, **(options.get('headers') or {})}
                options['transport'] = transport
            response = request(method, url, **options) if client else observed_request(request, request_kind.get(), method, url, _measurement=measurement, **options)
            transport.check(response)
            if response.status_code >= 400:
                response.raise_for_status()
            return response
        session.request = guarded
        if client:
            session.get = lambda url, **options: guarded('GET', url, **options)
        return session

    def process(scraper, *args, **options):
        job = original_process(scraper, *args, **options)
        if job:
            scrapers[job.job_url] = scraper
            row = job.model_dump()
            row.update(company=row.get("company_name"), site=source,
                       job_type=", ".join(kind.value[0] for kind in job.job_type) if job.job_type else None,
                       location=job.location.display_location() if job.location else None)
            if job.compensation:
                pay = job.compensation
                row.update(min_amount=pay.min_amount, max_amount=pay.max_amount,
                           interval=pay.interval.value if pay.interval else None,
                           currency=pay.currency, salary_source="direct_data")
            if kwargs.get("on_record"):
                kwargs["on_record"](row)
            if source in {"indeed", "glassdoor"} and kwargs.get("on_head_checked"):
                kwargs["on_head_checked"]()  # Keep a verified head even if a later page fails.
            if source == "linkedin" and kwargs.get("on_progress"):
                offset = int(kwargs.get("offset", 0)) // 10 * 10
                kwargs["next_cursor"] = {"offset": min(990, offset + len(scrapers) // 10 * 10)}
                kwargs["on_progress"](kwargs["next_cursor"])
        return job

    def glassdoor_detail(_source, row, _format):
        scraper = scrapers.get(row["job_url"])
        if scraper is None:
            raise ValueError("Glassdoor details require the current search session")
        from urllib.parse import parse_qs, urlparse
        identity = int(parse_qs(urlparse(row["job_url"]).query)["jl"][0])
        with detail_phase():
            description = scraper._fetch_job_description(identity)
        if not description:
            raise ValueError("Glassdoor search-session detail has no description")
        return {**row, "description": description}
    if source == "glassdoor":
        kwargs["hydrate_row"] = glassdoor_detail
        kwargs["detail_request_limit"] = min(10, int(kwargs.get("results_wanted", 25)))
    with patch.object(module, "create_session", session_factory), patch.object(scraper_class, "_process_job", process):
        yield


class UpstreamFailures(logging.Handler):
    """JobSpy sometimes logs a failed request and returns an empty/partial frame.

    Its loggers do not propagate to the root logger, so attach directly. Known
    transport/block warnings matter too (e.g. description requests), while
    ordinary warnings such as unsupported filters are not task failures.
    """

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.failures: list[tuple[str, str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        if "request allowance exhausted" in message:
            return
        kind = classify_error(RuntimeError(message))
        if record.levelno >= logging.ERROR or kind != "error":
            self.failures.append((kind, message))

    def worst(self) -> tuple[str, str] | None:
        severity = {"blocked": 5, "rate_limit": 4, "timeout": 3, "network": 2, "error": 1}
        return max(self.failures, key=lambda failure: severity[failure[0]], default=None)


class RedactProxy(logging.Filter):
    def filter(self, record):
        record.msg = safe_message(record.getMessage())
        record.args = ()
        return True


def scrape_with_failures(kwargs: dict[str, Any]) -> tuple[Any, tuple[str, str, float | None] | None]:
    from sap_sources import SOURCES, scrape_agency
    from public_sources import PUBLIC_SOURCES, scrape_public

    if kwargs["site_name"][0] in PUBLIC_SOURCES:
        import pandas as pd
        records, failure = scrape_public(kwargs)
        return pd.DataFrame(records), failure_info(failure)

    if kwargs["site_name"][0] in SOURCES:
        import pandas as pd

        records, failure = scrape_agency(kwargs)
        return pd.DataFrame(records), failure_info(failure)

    from jobspy import scrape_jobs

    if kwargs.get("enrich_only"):
        import pandas as pd
        from details import enrich_board
        records, failure = enrich_board(kwargs["site_name"][0], [], kwargs)
        return pd.DataFrame(records), failure_info(failure)

    capture = UpstreamFailures()
    redaction = RedactProxy()
    loggers = [logging.getLogger(name) for name in list(logging.root.manager.loggerDict)
               if name.startswith("JobSpy:")]
    levels = [logger.level for logger in loggers]
    for logger in loggers:
        logger.addFilter(redaction)
        logger.addHandler(capture)
    try:
        # A backlog reuses this task's description request allowance rather
        # than requesting full search details plus a second set of URLs.
        search_kwargs = {key: value for key, value in kwargs.items() if key in ALLOWED_TASK_PARAMS or key in {"site_name", "verbose"}}
        for key in {"enrich_only", "detail_request_limit", "search_request_limit", "search_cursor", "head_only", "requested_start", "requested_end", "detail_title_patterns"}:
            search_kwargs.pop(key, None)
        # All JobSpy searches disable its silently failing internal enrichment.
        search_kwargs["fetch_description"] = False
        proxy, verify = network_config()
        if proxy:
            search_kwargs["proxies"] = [proxy]
        if isinstance(verify, str):
            search_kwargs["ca_cert"] = verify
        source = kwargs["site_name"][0]
        if source == 'glassdoor':
            kwargs['coverage_reason'] = 'Glassdoor is capped at the first results; pinned JobSpy has no reliable persisted cursor continuation.'
        transport = kwargs.get("transport") or LinkedInTransport()
        import pandas as pd
        offset = int(kwargs.get('offset', 0))
        # Indeed's offset only slices client-side results: one invocation must
        # walk from the head to the backfill, using the same server cursors.
        phases = [True]
        if source == 'linkedin' and offset > 0:
            phases = [False, True] if transport.search_limit > 1 else [not kwargs.get('head_only', True)]
        frames = []
        failure = None
        for backfill in phases:
            phase = kwargs if backfill else {**kwargs, 'offset': 0, 'on_progress': None}
            phase['_request_stop_at'] = transport.search_limit if backfill else min(transport.search_limit, transport.search_requests + 1)
            search_kwargs['offset'] = 0 if source == 'indeed' else int(phase.get('offset', 0))
            if source == 'indeed':
                search_kwargs['results_wanted'] = min(300, offset + int(kwargs.get('results_wanted', 25)))
            with jobspy_search(source, transport, phase):
                frame = scrape_jobs(**search_kwargs)
                frames.append(frame)
                failure = failure_info(transport.failure) or capture.worst()
                if not failure and transport.search_requests and search_kwargs['offset'] == 0 and kwargs.get('on_head_checked'):
                    kwargs['on_head_checked']()
                if backfill and source in {'linkedin', 'indeed'} and (len(frame) or not failure):
                    count = len(frame)
                    next_offset = offset + max(10, (count // 10) * 10) if source == 'linkedin' else count
                    cap = 1000 if source == 'linkedin' else 300
                    if source == 'indeed':
                        if failure or phase.get('_budget_exhausted'):
                            next_offset = max(offset, count)  # The saved backfill may not have been reached.
                        elif count < search_kwargs['results_wanted']:
                            next_offset = 0  # The server cursor was exhausted before the requested window.
                    kwargs['next_cursor'] = {'offset': next_offset if count and next_offset < cap else 0}
                    if kwargs.get('on_progress'):
                        kwargs['on_progress'](kwargs['next_cursor'])
                    if not failure and not phase.get('_budget_exhausted') and count < search_kwargs['results_wanted']:
                        kwargs['coverage'] = 'exhausted' if count else 'unknown'
                combined = pd.concat(frames, ignore_index=True)
                if 'job_url' in combined.columns:
                    combined = combined.drop_duplicates(subset=['job_url'], keep='last')
                if (backfill or len(phases) == 1) and source in {'linkedin', 'glassdoor'} and kwargs.get('fetch_description') and not failure:
                    from details import enrich_board
                    columns = [column for column in FORWARDED_COLUMNS if column in combined.columns]
                    rows = [{key: clean_value(value) for key, value in row.items()}
                            for row in combined[columns].to_dict(orient='records')]
                    records, detail_failure = enrich_board(source, rows, kwargs)
                    combined = pd.DataFrame(records)
                    failure = failure_info(detail_failure)
            if failure:
                break
        if failure and len(failure) == 2:
            failure = (*failure, None)
        frame = combined
        return frame, failure
    finally:
        for logger, level in zip(loggers, levels):
            logger.removeHandler(capture)
            logger.removeFilter(redaction)
            logger.setLevel(level)
        capture.close()


def run_task(task: dict[str, Any], timeout_seconds: int, detail_cache=None) -> dict[str, Any]:
    task_id = task["task_id"]
    source = task["source"]
    started = time.monotonic()
    kwargs = build_kwargs(task, timeout_seconds)
    kwargs['coverage'] = 'unknown' if task.get('enrich_only') else 'incomplete'
    kwargs['detail_cache'] = detail_cache if detail_cache is not None else {}
    log(f"[task {task_id}] {source} :: {kwargs.get('search_term')!r} @ {kwargs.get('location')!r}")

    collected_urls = set()
    emitted = set()
    def stream(row):
        row = {key: value for key, value in row.items() if key in FORWARDED_COLUMNS}
        row = {key: clean_value(value) for key, value in row.items()}
        signature = json.dumps(row, sort_keys=True, default=str)
        if signature in emitted:
            return
        emitted.add(signature)
        status = row.pop("activity_status", None)
        reason = row.pop("activity_reason", None)
        evidence = row.pop("activity_evidence", None)
        checked_at = row.pop("activity_checked_at", None)
        valid_through = row.pop("valid_through", None)
        if status in {"active", "closed"}:
            emit({"type": "listing_activity", "task_id": task_id, "activity": {
                "source": source, "source_job_id": row.get("id"), "job_url": row.get("job_url"),
                "status": status, "evidence": evidence, "checked_at": checked_at,
                **({"valid_through": valid_through} if valid_through else {}),
                **({"reason": reason} if reason else {}),
            }})
        if status == "closed":
            return
        emit(
            {
                "type": "job",
                "task_id": task_id,
                "source": source,
                "job": row,
            }
        )
        collected_urls.add(row.get("job_url") or row.get("id"))

    def stats(search, detail):
        emit({"type": "request_stats", "task_id": task_id, "search_requests": search, "detail_requests": detail})
    kwargs["on_record"] = stream
    kwargs["on_progress"] = lambda cursor: emit({"type": "search_progress", "task_id": task_id, "cursor": cursor})
    def checked_head():
        if kwargs.get('head_checked'):
            return
        kwargs['head_checked'] = True
        emit({'type': 'search_head_checked', 'task_id': task_id})
    kwargs['on_head_checked'] = checked_head
    def candidate_error(row, reason):
        emit({'type': 'candidate_rejected', 'task_id': task_id, 'source': source,
              'job': {key: clean_value(value) for key, value in row.items() if key in FORWARDED_COLUMNS},
              'reason': safe_message(reason)[:1000]})
    kwargs['on_candidate_error'] = candidate_error
    transport = LinkedInTransport(int(kwargs.get("detail_request_limit", 5)), int(kwargs.get("search_request_limit", 3)), stats if source == 'linkedin' else None)
    kwargs["transport"] = transport
    # Synchronous source work: the Node parent kills this entire process at
    # the task deadline and waits for close before starting any retry.
    emit({"type": "task_started", "task_id": task_id})
    with measure_requests(stats if source != 'linkedin' else lambda *_: None) as measured:
        try:
            with use_transport(transport if source == "linkedin" else None):
                frame, upstream_failure = scrape_with_failures(kwargs)
            if frame is not None and not frame.empty:
                for row in frame.to_dict(orient="records"):
                    stream(row)
        except Exception as exc:
            upstream_failure = failure_info(exc)
    if kwargs.get("next_cursor"):
        kwargs["on_progress"](kwargs["next_cursor"])

    return {
        "type": "task_result",
        "task_id": task_id,
        "source": source,
        "status": "failed" if upstream_failure else "succeeded",
        **({"error_kind": upstream_failure[0], "message": upstream_failure[1][:1900],
            **({"retry_after_seconds": upstream_failure[2]} if len(upstream_failure) > 2 and upstream_failure[2] is not None else {})}
           if upstream_failure else {}),
        "count": len(collected_urls),
        "head_checked": bool(kwargs.get('head_checked')),
        "coverage": kwargs['coverage'],
        "candidate_errors": kwargs.get('candidate_errors', 0),
        **({'coverage_reason': kwargs['coverage_reason']} if kwargs.get('coverage_reason') else {}),
        "duration_ms": int((time.monotonic() - started) * 1000),
        "search_requests": transport.search_requests if source == "linkedin" else measured['search'],
        "detail_requests": transport.detail_requests if source == "linkedin" else measured['detail'],
    }


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        log("fatal: empty request on stdin")
        return 2
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        log(f"fatal: request is not valid JSON: {exc}")
        return 2

    tasks = request.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        log("fatal: request.tasks must be a non-empty array")
        return 2

    timeout_seconds = int(request.get("task_timeout_seconds") or 120)
    delay_seconds = float(request.get("delay_between_tasks_seconds") or 0)

    try:
        import jobspy  # noqa: F401
        from importlib.metadata import PackageNotFoundError, version as package_version

        try:
            version = package_version("python-jobspy")
        except PackageNotFoundError:
            version = "unknown"
    except Exception as exc:  # noqa: BLE001
        log(f"fatal: cannot import jobspy: {exc}")
        return 2

    emit({"type": "meta", "jobspy_version": version, "tasks": len(tasks)})

    paused_sources: dict[str, dict[str, Any]] = {}
    detail_cache = {}
    for index, task in enumerate(tasks):
        if not isinstance(task, dict) or "task_id" not in task or "source" not in task:
            log(f"skipping malformed task at index {index}")
            continue
        if task["source"] in paused_sources:
            failure = paused_sources[task["source"]]
            emit({"type": "task_result", "task_id": task["task_id"], "source": task["source"],
                  "status": "skipped", "count": 0,
                  "duration_ms": 0, "search_requests": 0, "detail_requests": 0,
                  "message": f"source paused after {failure['message']}"[:1900]})
            continue
        if index > 0 and delay_seconds > 0:
            time.sleep(delay_seconds)
        result = run_task(task, timeout_seconds, detail_cache)
        emit(result)
        if result.get("error_kind") in {"blocked", "rate_limit", "timeout"}:
            paused_sources[task["source"]] = result

    emit({"type": "done", "tasks": len(tasks)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
