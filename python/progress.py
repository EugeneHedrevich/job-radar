"""Bounded page and within-page cursors for the existing public adapters."""
from __future__ import annotations
from contextlib import contextmanager
from contextvars import ContextVar
import re
from datetime import datetime, timezone


_measurements = ContextVar('request_measurements', default=None)
request_kind = ContextVar('request_kind', default='search')


def selected_detail(title, kwargs):
    patterns = kwargs.get('detail_title_patterns')
    return not patterns or any(re.search(pattern, title or '', re.I) for pattern in patterns)


@contextmanager
def measure_requests(report):
    counts = {'search': 0, 'detail': 0}
    token = _measurements.set((counts, report))
    try:
        yield counts
    finally:
        _measurements.reset(token)


@contextmanager
def detail_phase():
    token = request_kind.set('detail')
    try:
        yield
    finally:
        request_kind.reset(token)


def current_measurements():
    return _measurements.get()


def observed_request(call, kind, *args, _measurement=None, **kwargs):
    """Count at the existing HTTP call sites, including requests redirects.

    This does not change sessions, TLS, retries, proxies or LinkedIn transport.
    An attempt is streamed before I/O so termination preserves the measurement.
    """
    measurement = _measurement or _measurements.get()
    def count(amount):
        if measurement:
            counts, report = measurement
            counts[kind] += amount
            report(counts['search'], counts['detail'])
    count(1)
    response = call(*args, **kwargs)
    if measurement:
        measurement[0].update(http_status=getattr(response, 'status_code', None), http_status_at=datetime.now(timezone.utc).isoformat())
    redirects = getattr(response, 'history', None)
    if isinstance(redirects, (list, tuple)) and redirects:
        count(len(redirects))
    return response


class SearchProgress:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.cursor = dict(kwargs.get("search_cursor") or {"page": 1, "index": 0})
        self.start_page = max(1, int(self.cursor.get("page", 1)))
        self.start_index = max(0, int(self.cursor.get("index", 0)))
        self.fresh = False
        if not kwargs.get('enrich_only'):
            kwargs['coverage'] = 'incomplete'

    def pages(self, limit):
        # A first-page check uses one of the original page slots. It never
        # replaces the saved backfill position, even if that check is empty.
        if self.start_page > 1:
            self.fresh = True
            yield 1
            limit -= 1
        self.fresh = False
        for page in range(self.start_page, min(100, self.start_page + limit - 1) + 1):
            yield page

    def checked_head(self, page):
        if page == 1 and self.kwargs.get('on_head_checked'):
            self.kwargs['on_head_checked']()

    def save(self, page, index=0):
        if self.fresh:
            return
        self.cursor = {"page": page, "index": index}
        self.kwargs["next_cursor"] = self.cursor
        callback = self.kwargs.get("on_progress")
        if callback:
            callback(self.cursor)

    def candidates(self, rows, page):
        for index, row in enumerate(rows):
            if self.fresh and index >= max(1, int(self.kwargs.get('results_wanted', 25))):
                break
            if not self.fresh and page == self.start_page and index < self.start_index:
                # Head and within-page continuation reuse this one response.
                if page == 1 and index < max(1, int(self.kwargs.get('results_wanted', 25))):
                    self.fresh = True
                    yield row
                    self.fresh = False
                continue
            # Consuming a candidate advances even if its details fail.
            self.save(page, index + 1)
            yield row

    def finish_page(self, page, more):
        if not self.fresh:
            self.kwargs['coverage'] = 'incomplete' if more or self.kwargs.get('candidate_errors') else 'exhausted'
        self.save(page + 1 if more and page < 100 else 1)
