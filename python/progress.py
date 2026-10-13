"""Bounded page and within-page cursors for the existing public adapters."""
from __future__ import annotations


class SearchProgress:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.cursor = dict(kwargs.get("search_cursor") or {"page": 1, "index": 0})
        self.start_page = max(1, int(self.cursor.get("page", 1)))
        self.start_index = max(0, int(self.cursor.get("index", 0)))
        self.fresh = False

    def pages(self, limit):
        # A first-page check uses one of the original page slots. It never
        # replaces the saved backfill position, even if that check is empty.
        if self.start_page > 1 or self.start_index > 0:
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
                continue
            # Consuming a candidate advances even if its details fail.
            self.save(page, index + 1)
            yield row

    def finish_page(self, page, more):
        self.save(page + 1 if more and page < 100 else 1)
