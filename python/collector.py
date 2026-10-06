#!/usr/bin/env python3
"""SAP Job Radar collector.

Collects vacancies with python-jobspy and emits machine-readable JSON Lines on
stdout. Every diagnostic message goes to stderr so stdout stays parseable.

This process only collects. Persistence, deduplication, matching and
notification are owned by the Node.js side.

Protocol
--------
stdin  : one JSON object -> {"tasks": [...], "task_timeout_seconds": 120}
stdout : JSON Lines, one object per line:
         {"type": "meta",        "jobspy_version": "..."}
         {"type": "job",         "task_id": "...", "source": "...", "job": {...}}
         {"type": "task_result", "task_id": "...", "status": "succeeded", ...}
         {"type": "task_result", "task_id": "...", "status": "failed",
                                 "error_kind": "blocked|timeout|network|error", ...}
         {"type": "done",        "tasks": n}
exit   : 0 on protocol success (task failures are reported in-band),
         2 on an unusable request.
"""

from __future__ import annotations

import json
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
    return "error"


def build_kwargs(task: dict[str, Any]) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"site_name": [task["source"]], "verbose": 0}
    for key, value in task.items():
        if key in ALLOWED_TASK_PARAMS and value is not None:
            kwargs[key] = value
    return kwargs


def run_task(task: dict[str, Any], timeout_seconds: int) -> dict[str, Any]:
    from jobspy import scrape_jobs

    task_id = task["task_id"]
    source = task["source"]
    started = time.monotonic()
    kwargs = build_kwargs(task)
    log(f"[task {task_id}] {source} :: {kwargs.get('search_term')!r} @ {kwargs.get('location')!r}")

    # Daemon threads let us abandon a wedged scraper without blocking exit.
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"task-{task_id}")
    future = executor.submit(scrape_jobs, **kwargs)
    try:
        frame = future.result(timeout=timeout_seconds)
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
            emit(
                {
                    "type": "job",
                    "task_id": task_id,
                    "source": source,
                    "job": {key: clean_value(value) for key, value in row.items()},
                }
            )
            count += 1

    return {
        "type": "task_result",
        "task_id": task_id,
        "source": source,
        "status": "succeeded",
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

    for index, task in enumerate(tasks):
        if not isinstance(task, dict) or "task_id" not in task or "source" not in task:
            log(f"skipping malformed task at index {index}")
            continue
        if index > 0 and delay_seconds > 0:
            time.sleep(delay_seconds)
        emit(run_task(task, timeout_seconds))

    emit({"type": "done", "tasks": len(tasks)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
