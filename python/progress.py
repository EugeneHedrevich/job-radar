"""Bounded page and within-page cursors for the existing public adapters."""
from __future__ import annotations


class SearchProgress:
    def __init__(self, kwargs):
        self.kwargs = kwargs
        self.cursor = dict(kwargs.get("search_cursor") or {"page": 1, "index": 0})
        self.start_page = max(1, int(self.cursor.get("page", 1)))
        self.start_index = max(0, int(self.cursor.get("index", 0)))

    def save(self, page, index=0):
        self.cursor = {"page": page, "index": index}
        self.kwargs["next_cursor"] = self.cursor
        callback = self.kwargs.get("on_progress")
        if callback:
            callback(self.cursor)

    def candidates(self, rows, page):
        for index, row in enumerate(rows):
            if page == self.start_page and index < self.start_index:
                continue
            # Consuming a candidate advances even if its details fail.
            self.save(page, index + 1)
            yield row

    def finish_page(self, page, more):
        self.save(page + 1 if more and page < 100 else 1)
