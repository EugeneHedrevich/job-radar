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
import traceback
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import date, datetime
from typing import Any

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
}


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(record: dict[str, Any]) -> None:
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


def build_kwargs(task: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"site_name": [task["source"]], "verbose": 1}
    for key, value in task.items():
        if key in ALLOWED_TASK_PARAMS and value is not None:
            kwargs[key] = value
    if task.get("fetch_description") and task.get("detail_jobs"):
        kwargs["detail_jobs"] = task["detail_jobs"]
    return kwargs


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
        kind = classify_error(RuntimeError(message))
        if record.levelno >= logging.ERROR or kind != "error":
            self.failures.append((kind, message))

    def worst(self) -> tuple[str, str] | None:
        severity = {"blocked": 5, "rate_limit": 4, "timeout": 3, "network": 2, "error": 1}
        return max(self.failures, key=lambda failure: severity[failure[0]], default=None)


def scrape_with_failures(kwargs: dict[str, Any]) -> tuple[Any, tuple[str, str] | None]:
    from sap_sources import SOURCES, scrape_agency
    from public_sources import PUBLIC_SOURCES, scrape_public

    if kwargs["site_name"][0] in PUBLIC_SOURCES:
        import pandas as pd
        records, failure = scrape_public(kwargs)
        return pd.DataFrame(records), ((classify_error(failure), f"{type(failure).__name__}: {failure}") if failure else None)

    if kwargs["site_name"][0] in SOURCES:
        import pandas as pd

        records, failure = scrape_agency(kwargs)
        return pd.DataFrame(records), ((classify_error(failure), f"{type(failure).__name__}: {failure}") if failure else None)

    from jobspy import scrape_jobs

    if kwargs.get("enrich_only"):
        import pandas as pd
        from details import enrich_board
        records, failure = enrich_board(kwargs["site_name"][0], [], kwargs)
        return pd.DataFrame(records), ((classify_error(failure), f"{type(failure).__name__}: {failure}") if failure else None)

    capture = UpstreamFailures()
    loggers = [logging.getLogger(name) for name in list(logging.root.manager.loggerDict)
               if name.startswith("JobSpy:")]
    levels = [logger.level for logger in loggers]
    for logger in loggers:
        logger.addHandler(capture)
    try:
        # A backlog reuses this task's description request allowance rather
        # than requesting full search details plus a second set of URLs.
        backlog = kwargs.get("detail_jobs")
        search_kwargs = {key: value for key, value in kwargs.items() if key not in {"detail_jobs", "enrich_only"}}
        if backlog:
            search_kwargs["fetch_description"] = False
        frame = scrape_jobs(**search_kwargs)
        failure = capture.worst()
        if backlog and not failure:
            import pandas as pd
            from details import enrich_board

            columns = [column for column in FORWARDED_COLUMNS if column in frame.columns]
            rows = [{key: clean_value(value) for key, value in row.items()}
                    for row in frame[columns].to_dict(orient="records")]
            records, detail_failure = enrich_board(kwargs["site_name"][0], rows, kwargs)
            frame = pd.DataFrame(records)
            if detail_failure:
                failure = (classify_error(detail_failure), f"{type(detail_failure).__name__}: {detail_failure}")
        return frame, failure
    finally:
        for logger, level in zip(loggers, levels):
            logger.removeHandler(capture)
            logger.setLevel(level)
        capture.close()


def run_task(task: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    task_id = task["task_id"]
    source = task["source"]
    started = time.monotonic()
    kwargs = build_kwargs(task)
    log(f"[task {task_id}] {source} :: {kwargs.get('search_term')!r} @ {kwargs.get('location')!r}")

    # The Node parent enforces the subprocess wall-clock timeout as well.
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"task-{task_id}")
    future = executor.submit(scrape_with_failures, kwargs)
    try:
        frame, upstream_failure = future.result(timeout=timeout_seconds)
    except FutureTimeout:
        executor.shutdown(wait=False, cancel_futures=True)
        return {
            "type": "task_result",
            "task_id": task_id,
            "source": source,
            "status": "failed",
            "error_kind": "timeout",
            "message": f"task exceeded {timeout_seconds}s",
            "count": 0,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 - reported in-band, never fatal
        executor.shutdown(wait=False)
        log(f"[task {task_id}] failed: {traceback.format_exc()}")
        return {
            "type": "task_result",
            "task_id": task_id,
            "source": source,
            "status": "failed",
            "error_kind": classify_error(exc),
            "message": f"{type(exc).__name__}: {exc}"[:1900],
            "count": 0,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
    executor.shutdown(wait=False)

    count = 0
    if frame is not None and not frame.empty:
        columns = [c for c in FORWARDED_COLUMNS if c in frame.columns]
        for row in frame[columns].to_dict(orient="records"):
            row = {key: clean_value(value) for key, value in row.items()}
            status = row.pop("activity_status", None)
            reason = row.pop("activity_reason", None)
            evidence = row.pop("activity_evidence", None)
            checked_at = row.pop("activity_checked_at", None)
            if status in {"active", "closed"}:
                emit({"type": "listing_activity", "task_id": task_id, "activity": {
                    "source": source, "source_job_id": row.get("id"), "job_url": row.get("job_url"),
                    "status": status, "evidence": evidence, "checked_at": checked_at,
                    **({"reason": reason} if reason else {}),
                }})
            if status == "closed":
                continue
            emit(
                {
                    "type": "job",
                    "task_id": task_id,
                    "source": source,
                    "job": row,
                }
            )
            count += 1

    return {
        "type": "task_result",
        "task_id": task_id,
        "source": source,
        "status": "failed" if upstream_failure else "succeeded",
        **({"error_kind": upstream_failure[0], "message": upstream_failure[1][:1900]}
           if upstream_failure else {}),
        "count": count,
        "duration_ms": int((time.monotonic() - started) * 1000),
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
    for index, task in enumerate(tasks):
        if not isinstance(task, dict) or "task_id" not in task or "source" not in task:
            log(f"skipping malformed task at index {index}")
            continue
        if task["source"] in paused_sources:
            failure = paused_sources[task["source"]]
            emit({"type": "task_result", "task_id": task["task_id"], "source": task["source"],
                  "status": "failed", "error_kind": failure["error_kind"], "count": 0,
                  "duration_ms": 0, "message": f"source paused after {failure['message']}"[:1900]})
            continue
        if index > 0 and delay_seconds > 0:
            time.sleep(delay_seconds)
        result = run_task(task, timeout_seconds)
        emit(result)
        if result.get("error_kind") in {"blocked", "rate_limit", "timeout"}:
            paused_sources[task["source"]] = result

    emit({"type": "done", "tasks": len(tasks)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
