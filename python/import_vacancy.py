"""One bounded public detail lookup using the collector's existing adapters."""
from __future__ import annotations
import json
import sys
from urllib.parse import urljoin

import requests
from activity import observe
from details import hydrate_board, linkedin_job_id
from public_sources import PUBLIC_SOURCES, safe_public_url, hydrate as hydrate_public
from sap_sources import SOURCES, safe_url, hydrate as hydrate_agency
from transport import LinkedInTransport, request_kwargs, safe_message, use_transport

MAX_BYTES = 2_000_000
MAX_REQUESTS = 3

def lookup(source, url):
    def validate(value):
        if source == "linkedin":
            linkedin_job_id(value)
            return value
        if source in SOURCES:
            return safe_url(source, value)
        return safe_public_url(source, value)

    used = 0
    def bounded_get(target, **_kwargs):
        nonlocal used
        target = validate(target)
        if used >= MAX_REQUESTS:
            raise ValueError("Public detail redirect limit reached")
        used += 1
        response = requests.get(target, timeout=10, allow_redirects=False, stream=True, **request_kwargs())
        try:
            chunks = []
            size = 0
            for chunk in response.iter_content(16_384):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("Public detail page is too large")
                chunks.append(chunk)
            response._content = b"".join(chunks)
            response._content_consumed = True
            return response
        finally:
            response.close()

    url = validate(url)
    row = {"job_url": url}
    if source == "linkedin":
        row["id"] = linkedin_job_id(url)
        with use_transport(LinkedInTransport(detail_limit=MAX_REQUESTS)):
            return hydrate_board(source, row, "markdown", bounded_get)
    while True:
        response = bounded_get(url)
        if response.status_code in {404, 410}:
            return observe(row, "closed", f"HTTP {response.status_code} for listing detail", f"http_{response.status_code}")
        response.raise_for_status()
        if not response.is_redirect:
            break
        url = validate(urljoin(url, response.headers.get("Location", "")))
    row["job_url"] = url
    hydrate = hydrate_agency if source in SOURCES else hydrate_public
    return hydrate(source, row, response.text, "markdown")

def main():
    try:
        payload = json.loads(sys.stdin.read(4096))
        source = payload["source"]
        if source not in {"linkedin", *SOURCES, *PUBLIC_SOURCES}:
            raise ValueError("This source has no supported public detail adapter")
        row = lookup(source, payload["url"])
        status = row.pop("activity_status", None)
        reason = row.pop("activity_reason", None)
        evidence = row.pop("activity_evidence", None)
        checked = row.pop("activity_checked_at", None)
        deadline = row.pop("valid_through", None)
        activity = {"source": source, "source_job_id": row.get("id"), "job_url": row["job_url"],
            "status": status, "evidence": evidence, "checked_at": checked, "valid_through": deadline,
            **({"reason": reason} if reason else {})} if status else None
        print(json.dumps({"job": row, "activity": activity, "message": "Public listing checked"}))
    except Exception as exc:
        print(json.dumps({"job": None, "activity": None, "message": safe_message(exc)[:1000]}))

if __name__ == "__main__":
    main()
