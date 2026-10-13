"""Public recruiter pages and documented job APIs; bounded, unauthenticated reads.

Every provider keeps its own listing URL and stated location/eligibility. API
descriptions are delivered with search results and cost no separate detail slot.
"""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse, urlunparse, parse_qsl

import requests
from markdownify import markdownify
from activity import expired, http_closure, observe, page_closure
from progress import SearchProgress
from transport import request_kwargs

from sap_sources import (MAX_DETAIL_REQUESTS_PER_TASK, MAX_SEARCH_PAGES, REQUEST_TIMEOUT_SECONDS,
                         applicant_location, job_posting, job_type, location, page_soup, published_date, text)

MICHAEL_MARKETS = {
    "Poland": "https://www.michaelpage.pl",
    "Germany": "https://www.michaelpage.de",
    "Netherlands": "https://www.michaelpage.nl",
    "United Kingdom": "https://www.michaelpage.co.uk",
    "Switzerland": "https://www.michaelpage.ch",
    "France": "https://www.michaelpage.fr",
    "United Arab Emirates": "https://www.michaelpage.ae",
}
PUBLIC_SOURCES = {
    "michaelpage": (MICHAEL_MARKETS["Poland"], "Michael Page"),
    "nextventures": ("https://next-ventures.com", "Next Ventures"),
    "remotive": ("https://remotive.com", "Remotive"),
    "arbeitnow": ("https://www.arbeitnow.com", "Arbeitnow"),
    "remoteok": ("https://remoteok.com", "Remote OK"),
    "jobicy": ("https://jobicy.com", "Jobicy"),
}
API_SOURCES = {"remotive", "arbeitnow", "remoteok", "jobicy"}


def safe_public_url(source: str, href: str, base: str | None = None) -> str:
    root = PUBLIC_SOURCES[source][0]
    parsed = urlparse(urljoin(base or root, href))
    allowed = {urlparse(value).hostname for value in MICHAEL_MARKETS.values()} if source == "michaelpage" else {urlparse(root).hostname}
    if source == "arbeitnow":
        allowed |= {"www.arbeitnow.co.uk", "www.arbeitnow.ch", "www.arbeitnow.fr"}
    if parsed.scheme != "https" or parsed.hostname not in allowed or parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise ValueError(f"Unexpected {source} listing URL")
    query = urlencode([(key, value) for key, value in parse_qsl(parsed.query)
                       if not key.lower().startswith("utm_") and key.lower() not in {"tracking", "trk", "newsletter", "source"}])
    return urlunparse(parsed._replace(query=query, fragment=""))


@lru_cache(maxsize=64)
def fetch(url: str) -> str:
    response = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, **request_kwargs())
    response.raise_for_status()
    return response.text


def market_root(market: str | None) -> str:
    if market not in MICHAEL_MARKETS:
        raise ValueError(f"Unknown Michael Page market: {market}")
    return MICHAEL_MARKETS[market]


def search_url(source: str, keyword: str, market: str | None, page: int) -> str:
    if source == "michaelpage":
        return market_root(market) + "/jobs?" + urlencode({"search": keyword, "page": page - 1})
    path = "/jobs/" if page == 1 else f"/jobs/page/{page}/"
    return PUBLIC_SOURCES[source][0] + path + "?" + urlencode({"s": keyword})


def number(value: Any) -> float | None:
    try:
        candidate = float(value)
        return candidate if math.isfinite(candidate) and candidate >= 0 else None
    except (TypeError, ValueError):
        return None


def salary_text(row: dict[str, Any], value: str | None) -> None:
    """Only structured amounts with an explicit currency and pay interval."""
    match = re.search(r"(PLN|EUR|GBP|USD|CHF|€|£|\$)\s*([\d.,]+)(?:\s*[-–]\s*(?:PLN|EUR|GBP|USD|CHF|€|£|\$)?\s*([\d.,]+))?\s*(?:per|/|a|pro)?\s*(hour|hr|h\b|day|daily|month|year|annum|annuel|rocznie)", value or "", re.I)
    if not match:
        return
    def amount(raw: str) -> float | None:
        # Site display numbers: 1.405/day and 260.000/year are thousands.
        raw = re.sub(r"[.,](?=\d{3}(?:[.,]|$))", "", raw).replace(",", ".")
        return number(raw)
    minimum, maximum = amount(match[2]), amount(match[3] or match[2])
    if minimum is None or maximum is None:
        return
    unit = match[4].lower()
    interval = "hourly" if unit in {"hour", "hr", "h"} else "daily" if unit in {"day", "daily"} else "monthly" if unit == "month" else "yearly"
    row.update(min_amount=minimum, max_amount=maximum, interval=interval,
               currency={"€": "EUR", "£": "GBP", "$": "USD"}.get(match[1], match[1].upper()))


def stated_type(value: Any) -> str | None:
    values = value if isinstance(value, list) else [value]
    mapping = {"kontrakt b2b": "contract", "b2b": "contract", "interim": "contract",
               "stała": "fulltime", "festanstellung": "fulltime", "permanent": "fulltime",
               "full time": "fulltime", "full-time": "fulltime", "cdi": "fulltime"}
    return next((found for item in values if isinstance(item, str)
                 and (found := job_type(item) or mapping.get(item.strip().lower()))), None)


def parse_search(source: str, html: str, root: str) -> tuple[list[dict[str, Any]], bool]:
    soup = page_soup(html)
    if source == "michaelpage":
        # The same card markup is reused for unrelated recommendations below
        # the search results. Those are not matches for the requested keyword.
        for suggestions in soup.select(".other-users-also-applied-for-block"):
            suggestions.decompose()
    selector = ".search-job-tile" if source == "michaelpage" else "article.matador-job-listings"
    cards = soup.select(selector)
    if not cards:
        empty = soup.select_one(".view-empty, .no-results, .search-empty-result .view-job-search .view-content")
        if not empty:
            raise ValueError(f"{source} search markup is not recognized")
    rows = []
    for card in cards:
        link = card.select_one(".job-title a" if source == "michaelpage" else ".post-content > a:has(h3)")
        if not link or not link.get("href") or not text(link):
            raise ValueError(f"{source} job card is missing title or URL")
        url = safe_public_url(source, link["href"], root)
        row = {"id": urlparse(url).path.rstrip("/").split("/")[-1], "site": source,
               "job_url": url, "title": text(link), "company": PUBLIC_SOURCES[source][1],
               "description": None, "date_posted": None, "location": None,
               "job_type": None, "is_remote": None}
        if source == "michaelpage":
            row.update(location=location(text(card.select_one(".job-location"))),
                       job_type=stated_type(text(card.select_one(".job-contract-type"))))
            # Home Office / télétravail can mean hybrid; do not infer full remote.
            if (text(card.select_one(".job-nature")) or "").lower() in {"praca zdalna", "remote working", "remote"}:
                row["is_remote"] = True
            salary_text(row, text(card.select_one(".job-salary")))
        else:
            summary = text(card.select_one("p")) or ""
            meta = re.search(r"Location:\s*(.*?)\s+Type:\s*(.*?)\s+Job\s+#(\d+)", summary)
            if meta:
                row.update(location=location(meta[1]), job_type=stated_type(meta[2]), id=meta[3])
        rows.append(row)
    more = bool(soup.select_one('a[rel="next"], .pager__item--next a, .pager-next a, .pager a, .nav-links a.next'))
    if source == "nextventures":
        more = bool(soup.select_one('.wp-pagenavi a[href*="/page/"], .nav-links a[href*="/page/"]'))
    return rows, more


def apply_posting(row: dict[str, Any], posting: dict[str, Any]) -> None:
    row["date_posted"] = published_date(posting.get("datePosted")) or row.get("date_posted")
    row["job_type"] = stated_type(posting.get("employmentType")) or row.get("job_type")
    places = posting.get("jobLocation", [])
    places = places if isinstance(places, list) else [places]
    locations = []
    for place in places:
        address = place.get("address") if isinstance(place, dict) else None
        if not isinstance(address, dict):
            continue
        parts = []
        for key in ["addressLocality", "addressRegion", "addressCountry"]:
            value = address.get(key)
            value = value.get("name") if isinstance(value, dict) else value
            if isinstance(value, str) and value.strip() and value.strip().lower() not in {"- none specified -", "none specified", "unknown"} and value not in parts:
                parts.append(value)
        if parts:
            locations.append(location(", ".join(parts)))
    if locations:
        row["location"] = "; ".join(locations)
    if posting.get("jobLocationType") == "TELECOMMUTE":
        row["is_remote"] = True
    salary = posting.get("baseSalary")
    if isinstance(salary, dict) and isinstance(salary.get("value"), dict):
        value = salary["value"]
        interval = {"HOUR": "hourly", "DAY": "daily", "MONTH": "monthly", "YEAR": "yearly"}.get(str(value.get("unitText", "")).upper())
        if interval and salary.get("currency"):
            low = number(value.get("minValue", value.get("value")))
            high = number(value.get("maxValue", value.get("value")))
            if low is not None or high is not None:
                row.update(min_amount=low, max_amount=high, currency=salary["currency"], interval=interval)


def hydrate(source: str, row: dict[str, Any], html: str, description_format: str) -> dict[str, Any]:
    soup = page_soup(html)
    posting = job_posting(soup) or {}
    closure = page_closure(row, soup, posting)
    if closure:
        return closure
    updated = dict(row)
    updated["title"] = updated.get("title") or posting.get("title") or text(soup.select_one("h1"))
    employer = posting.get("hiringOrganization")
    if isinstance(employer, dict):
        updated["company"] = updated.get("company") or employer.get("name")
    apply_posting(updated, posting)
    description = posting.get("description")
    if not isinstance(description, str) or not description.strip():
        if source == "michaelpage":
            nodes = soup.select('[class^="job_advert__job-desc-"]')
            description = "\n".join(str(node) for node in nodes)
        else:
            node = soup.select_one(".job_description")
            if node:
                # Application controls and personal-data forms are not vacancy text.
                for control in node.select("form, .matador-application, script, style"):
                    control.decompose()
                description = str(node)
    if not description:
        raise ValueError(f"{source} detail page has no description")
    updated["description"] = markdownify(description).strip() if description_format == "markdown" else description
    required_location = applicant_location(posting)
    if required_location:
        updated["description"] = f"Candidate required location: {required_location}\n\n" + updated["description"]
    return observe(updated, "active", "Public listing detail contains a description", valid_through=posting.get("validThrough"))


def api_url(source: str, keyword: str, page: int) -> str:
    root = PUBLIC_SOURCES[source][0]
    if source == "remotive":
        return root + "/api/remote-jobs?" + urlencode({"search": keyword})
    if source == "arbeitnow":
        return root + "/api/job-board-api?" + urlencode({"page": page})
    if source == "jobicy":
        return root + "/api/v2/remote-jobs?" + urlencode({"count": 100, "tag": keyword})
    return root + "/api"


def parse_api(source: str, payload: Any, keyword: str, description_format: str) -> tuple[list[dict[str, Any]], bool]:
    records = payload if source == "remoteok" and isinstance(payload, list) else payload.get("data" if source == "arbeitnow" else "jobs") if isinstance(payload, dict) else None
    if not isinstance(records, list) or isinstance(payload, dict) and (payload.get("success") is False or payload.get("error")):
        raise ValueError(f"{source} API returned an invalid response")
    rows = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError(f"{source} API returned an invalid listing")
        if source == "remoteok" and "legal" in record:
            continue
        if source == "jobicy":
            title, body, company, place = (record.get(key) for key in ["jobTitle", "jobDescription", "companyName", "jobGeo"])
            posted, engagement = record.get("pubDate"), record.get("jobType")
        else:
            title = record.get("position" if source == "remoteok" else "title")
            body = record.get("description")
            company = record.get("company" if source == "remoteok" else "company_name")
            place = record.get("candidate_required_location" if source == "remotive" else "location")
            posted = record.get("publication_date" if source == "remotive" else "date" if source == "remoteok" else "created_at")
            engagement = record.get("job_type", record.get("job_types"))
        if not isinstance(title, str) or not isinstance(body, str) or not isinstance(record.get("url"), str):
            raise ValueError(f"{source} API listing is missing title, description or URL")
        plain = page_soup(body).get_text(" ", strip=True)
        tokens = re.findall(r"\w+", keyword)
        if not all(re.search(r"\b" + re.escape(token) + r"\b", title + " " + plain, re.I) for token in tokens):
            # SAPUI5 is also a valid SAP keyword match.
            if keyword.lower() != "sap" or not re.search(r"\bsapui5\b", title + " " + plain, re.I):
                continue
        if isinstance(posted, (int, float)):
            posted = datetime.fromtimestamp(posted, timezone.utc).date().isoformat()
        row = {"site": source, "id": str(record.get("id", record.get("slug")) or record["url"]),
               "job_url": safe_public_url(source, record["url"]), "title": title, "company": company,
               "location": place or None, "job_type": stated_type(engagement), "date_posted": published_date(posted),
               "is_remote": record.get("remote") if source == "arbeitnow" else True,
               "description": markdownify(body).strip() if description_format == "markdown" else body}
        # Keep API eligibility and unstructured pay visible to matching and review.
        if source == "remotive":
            row["description"] = f"Candidate required location: {place or 'not stated'}\nSalary: {record.get('salary') or 'not stated'}\n\n" + row["description"]
        if source == "jobicy" and record.get("salaryPeriod") in {"hourly", "daily", "monthly", "yearly"} and record.get("salaryCurrency"):
            row.update(min_amount=number(record.get("salaryMin")), max_amount=number(record.get("salaryMax")),
                       currency=record["salaryCurrency"], interval=record["salaryPeriod"])
        if source == "jobicy":
            row["description"] = f"Candidate required location: {place or 'not stated'}\n\n" + row["description"]
        if expired(record.get("validThrough")):
            rows.append(observe(row, "closed", f"validThrough: {record['validThrough']}", "valid_through", record['validThrough']))
        else:
            rows.append(observe(row, "active", "Public API returned the listing with a description", valid_through=record.get("validThrough")))
    more = source == "arbeitnow" and bool(payload.get("links", {}).get("next"))
    return rows, more


def scrape_public(kwargs: dict[str, Any]) -> tuple[list[dict[str, Any]], BaseException | None]:
    import json
    source = kwargs["site_name"][0]
    progress = SearchProgress(kwargs)
    wanted = max(1, int(kwargs.get("results_wanted", 25)))
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=int(kwargs.get("hours_old", 96)))).date().isoformat()
    fmt = kwargs.get("description_format", "markdown")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    detail_requests = 0
    failure: BaseException | None = None
    closures: list[dict[str, Any]] = []
    def stream(row):
        if kwargs.get("on_record"):
            kwargs["on_record"](row)
    def keep(row: dict[str, Any]) -> bool:
        if row.get("activity_status") == "closed":
            closures.append(row)
            stream(row)
            return False
        return row.get("activity_refresh") or not (row.get("date_posted") and row["date_posted"] < cutoff)
    def detail(row: dict[str, Any]) -> dict[str, Any]:
        nonlocal detail_requests
        detail_requests += 1
        url = safe_public_url(source, row["job_url"])
        try:
            return hydrate(source, row, fetch(url), fmt)
        except requests.HTTPError as exc:
            closure = http_closure(row, exc)
            if closure:
                return closure
            raise
    for row in kwargs.get("detail_jobs", [])[:min(wanted, MAX_DETAIL_REQUESTS_PER_TASK)]:
        try:
            updated = detail(row)
            seen.add(updated["job_url"])
            if keep(updated):
                rows.append(updated)
                stream(updated)
        except ValueError as exc:
            failure = failure or exc
        except Exception as exc:
            return rows + closures, exc
    if kwargs.get("enrich_only"):
        return rows + closures, failure
    keyword = kwargs.get("search_term", "SAP")
    root = market_root(kwargs.get("location")) if source == "michaelpage" else PUBLIC_SOURCES[source][0]
    backfill_count = 0
    for page in progress.pages(MAX_SEARCH_PAGES):
        try:
            if source in API_SOURCES:
                candidates, more = parse_api(source, json.loads(fetch(api_url(source, keyword, page))), keyword, fmt)
            else:
                candidates, more = parse_search(source, fetch(search_url(source, keyword, kwargs.get("location"), page)), root)
        except Exception as exc:
            return rows + closures, exc
        progress.checked_head(page)
        for row in progress.candidates(candidates, page):
            if row["job_url"] in seen:
                continue
            seen.add(row["job_url"])
            if row.get("activity_status") != "closed" and not (row.get("date_posted") and row["date_posted"] < cutoff):
                stream(row)
            if kwargs.get("fetch_description") and source not in API_SOURCES and detail_requests < MAX_DETAIL_REQUESTS_PER_TASK:
                try:
                    row = detail(row)
                except ValueError as exc:
                    failure = failure or exc
                except Exception as exc:
                    rows.append(row)
                    stream(row)
                    return rows + closures, exc
                stream(row)
            if keep(row):
                rows.append(row)
                stream(row)
                if not progress.fresh:
                    backfill_count += 1
            if not progress.fresh and backfill_count >= wanted:
                return rows + closures, failure
        progress.finish_page(page, more)
        if not more and not progress.fresh:
            break
    return rows + closures, failure
