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
from transport import LinkedInTransport, SourceStopped, linkedin_client, request_kwargs, safe_message, use_transport
from collector import failure_info

MAX_BYTES = 2_000_000
MAX_REQUESTS = 3

def lookup(source, url, counts, request_limit=MAX_REQUESTS):
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
        if used >= request_limit:
            raise ValueError("Public detail redirect limit reached")
        used += 1
        counts['requests'] = used
        fetch = linkedin_client().get if source == 'linkedin' else requests.get
        response = fetch(target, timeout=10, allow_redirects=False, stream=True, **request_kwargs())
        try:
            if response.status_code in {429, 403}:
                raise SourceStopped(f'HTTP {response.status_code}', response)
            chunks = []
            size = 0
            for chunk in response.iter_content(None if source == 'linkedin' else 16_384):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("Public detail page is too large")
                chunks.append(chunk)
            if source == 'linkedin':
                response.content = b"".join(chunks)
                linkedin_client().check(response)
            else:
                response._content = b"".join(chunks)
                response._content_consumed = True
            return response
        finally:
            response.close()

    url = validate(url)
    row = {"job_url": url}
    if source == "linkedin":
        row["id"] = linkedin_job_id(url)
        with use_transport(LinkedInTransport(detail_limit=request_limit)):
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
    counts = {'requests': 0}
    try:
        payload = json.loads(sys.stdin.read(4096))
        source = payload["source"]
        if source not in {"linkedin", *SOURCES, *PUBLIC_SOURCES}:
            raise ValueError("This source has no supported public detail adapter")
        request_limit = max(0, min(MAX_REQUESTS, int(payload.get('request_limit', MAX_REQUESTS))))
        row = lookup(source, payload["url"], counts, request_limit)
        status = row.pop("activity_status", None)
        reason = row.pop("activity_reason", None)
        evidence = row.pop("activity_evidence", None)
        checked = row.pop("activity_checked_at", None)
        deadline = row.pop("valid_through", None)
        activity = {"source": source, "source_job_id": row.get("id"), "job_url": row["job_url"],
            "status": status, "evidence": evidence, "checked_at": checked, "valid_through": deadline,
            **({"reason": reason} if reason else {})} if status else None
        print(json.dumps({"job": row, "activity": activity, "failure": None, **counts, "message": "Public listing checked"}))
    except Exception as exc:
        kind, message, delay = failure_info(exc)
        response = getattr(exc, 'response', None)
        # SourceStopped carries the status in its message; do not expose response bodies.
        status = getattr(response, 'status_code', None)
        if status is None and str(exc) in {'HTTP 429', 'HTTP 403'}:
            status = int(str(exc).split()[-1])
        failure = {'kind': kind, 'message': safe_message(message)[:1000],
            **({'httpStatus': status} if status else {}),
            **({'retryAfterSeconds': delay} if delay is not None else {})}
        print(json.dumps({"job": None, "activity": None, "failure": failure, **counts, "message": failure['message']}))

if __name__ == "__main__":
    main()
