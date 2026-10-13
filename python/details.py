"""Bounded description enrichment of stored public listing URLs.

Searches still run through pinned JobSpy. Enrichment uses only public pages,
does not log in, and reports transport/markup failures to the circuit breaker.
"""

from __future__ import annotations

import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from transport import active_transport, LinkedInTransport, RequestBudgetExhausted, request_kwargs
from markdownify import markdownify
from activity import observe, page_closure

from sap_sources import REQUEST_TIMEOUT_SECONDS, applicant_location, job_posting, page_soup, published_date


def linkedin_job_id(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    public_host = host in {"www.linkedin.com", "linkedin.com"} or bool(re.fullmatch(r"[a-z]{2}\.linkedin\.com", host))
    if parsed.scheme != "https" or not public_host or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise ValueError("Unexpected linkedin detail URL")
    match = re.fullmatch(r"/jobs/view/(?:[^/]*-)?(\d+)/?", parsed.path)
    if not match:
        raise ValueError("Unexpected linkedin detail URL")
    return match.group(1)


def hydrate_board(source: str, row: dict[str, Any], description_format: str) -> dict[str, Any]:
    url = str(row.get("job_url") or "")
    if source != "linkedin":
        raise ValueError(f"Unexpected {source} detail URL")
    identity = linkedin_job_id(url)
    transport = active_transport.get() or LinkedInTransport()
    for hop in range(4):
        transport.before("detail")
        response = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, allow_redirects=False, **request_kwargs())
        transport.check(response)
        if response.status_code in {404, 410}:
            return observe(row, "closed", f"HTTP {response.status_code} for listing detail", f"http_{response.status_code}")
        response.raise_for_status()
        if not response.is_redirect:
            break
        target = urljoin(url, response.headers.get("Location", ""))
        if "/authwall" in target or "/login" in target or "/checkpoint" in target:
            raise RuntimeError("blocked: linkedin redirected the public listing to an access challenge")
        if linkedin_job_id(target) != identity:
            raise ValueError("linkedin redirect changed the listing identity")
        if target == url or hop == 3:
            raise ValueError("linkedin detail page exceeded the redirect limit")
        url = target
    soup = page_soup(response.text)
    posting = job_posting(soup) or {}
    closure = page_closure(row, soup, posting)
    if closure:
        return closure
    description = posting.get("description")
    if not isinstance(description, str) or not description.strip():
        node = soup.select_one(".show-more-less-html__markup")
        description = str(node) if node else None
    if not description:
        raise ValueError(f"{source} public detail page has no description")
    updated = dict(row)
    updated["description"] = markdownify(description).strip() if description_format == "markdown" else description
    required_location = applicant_location(posting)
    if required_location:
        updated["description"] = f"Candidate required location: {required_location}\n\n" + updated["description"]
    # Reuse pinned JobSpy's parsers so a backlog slot keeps the structured
    # employment, seniority and pay fields normally supplied by its details.
    from jobspy.linkedin import LinkedIn
    from jobspy.linkedin.util import parse_company_industry, parse_job_level, parse_job_type
    from jobspy.model import SalarySource

    employment = parse_job_type(soup)
    if employment:
        updated["job_type"] = ", ".join(kind.value[0] for kind in employment)
    for key, value in (("job_level", parse_job_level(soup)), ("company_industry", parse_company_industry(soup))):
        if value:
            updated[key] = value
    salary = soup.select_one(".compensation__salary")
    compensation = LinkedIn._parse_salary(salary.get_text()) if salary else None
    if compensation:
        updated.update(min_amount=compensation.min_amount, max_amount=compensation.max_amount,
                       interval=compensation.interval.value if compensation.interval else None,
                       currency=compensation.currency, salary_source=SalarySource.DIRECT_DATA.value)
    updated["date_posted"] = published_date(posting.get("datePosted")) or updated.get("date_posted")
    return observe(updated, "active", "Public listing detail contains a description", valid_through=posting.get("validThrough"))


def enrich_board(source: str, rows: list[dict[str, Any]], kwargs: dict[str, Any]) -> tuple[list[dict[str, Any]], BaseException | None]:
    # Existing jobs get a share of the selected task's original request budget.
    # New search results remain visible even when that budget is exhausted.
    limit = max(0, min(int(kwargs.get("detail_request_limit", 5)), int(kwargs.get("results_wanted", 25))))
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=int(kwargs.get("hours_old", 96)))).date()
    result = [dict(row) for row in rows]
    positions = {row.get("job_url"): index for index, row in enumerate(result)}
    candidates = [*kwargs.get("detail_jobs", []), *rows]
    seen: set[str] = set()
    requests_used = 0
    failure: BaseException | None = None
    for row in candidates:
        url = row.get("job_url")
        if not url or url in seen or row.get("description") and not row.get("activity_refresh"):
            continue
        seen.add(url)
        if requests_used >= limit:
            break
        if requests_used:
            time.sleep(3)
        requests_used += 1
        try:
            hydrate = kwargs.get("hydrate_row", hydrate_board)
            updated = hydrate(source, row, kwargs.get("description_format", "markdown"))
        except RequestBudgetExhausted:
            break
        except Exception as exc:
            if isinstance(exc, ValueError):
                failure = failure or exc
                continue
            return [item for item in result if item is not None], exc
        if kwargs.get("on_record"):
            kwargs["on_record"](updated)
        if not row.get("activity_refresh") and updated.get("activity_status") != "closed" and (updated.get("date_posted") and date.fromisoformat(str(updated["date_posted"])[:10]) < cutoff):
            # Old datePosted only filters freshness; it never closes a listing.
            if url in positions:
                result[positions[url]] = None
            continue
        if url in positions:
            result[positions[url]] = updated
        else:
            positions[url] = len(result)
            result.append(updated)
    return [row for row in result if row is not None], failure
