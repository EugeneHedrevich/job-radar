"""Bounded adapters for public SAP agency searches; no accounts or applications.

They return the same columns as JobSpy. Detail requests use the existing
fetch_description task budget. Missing metadata stays unknown.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any
from urllib.parse import urlencode, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify
from activity import http_closure, observe, page_closure
from progress import SearchProgress
from transport import request_kwargs

SOURCES = {
    "redglobal": ("https://www.redglobal.com", "RED Global"),
    "eursap": ("https://eursap.eu", "Eursap"),
    "whitehall": ("https://www.whitehallresources.com", "Whitehall Resources"),
}
MAX_SEARCH_PAGES = 3
REQUEST_TIMEOUT_SECONDS = 20
# Includes detail requests whose metadata subsequently excludes the listing.
MAX_DETAIL_REQUESTS_PER_TASK = 10


def text(node: Any) -> str | None:
    if node is None:
        return None
    return node.get_text(" ", strip=True) or None


def published_date(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    for fmt in ("%Y-%m-%d", "%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(value.strip()[:10] if fmt == "%Y-%m-%d" else value.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def applicant_location(posting: dict[str, Any]) -> str | None:
    requirements = posting.get("applicantLocationRequirements")
    requirements = requirements if isinstance(requirements, list) else [requirements]
    names = []
    for requirement in requirements:
        name = requirement.get("name") if isinstance(requirement, dict) else requirement
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return ", ".join(dict.fromkeys(names)) or None


def job_type(value: str | None) -> str | None:
    value = (value or "").strip().lower()
    return {"contract": "contract", "freelance": "contract", "permanent": "fulltime",
            "full_time": "fulltime", "full-time": "fulltime", "part_time": "parttime"}.get(value)


def remote_flag(value: str | None) -> bool | None:
    value = (value or "").strip().lower()
    if value in {"remote", "remote work", "fully remote", "telecommute"}:
        return True
    if value in {"onsite", "on-site", "office based"}:
        return False
    return None


def location(value: str | None) -> str | None:
    # Agency UI regions are not countries. Keep the explicit country last so
    # the shared normalizer can read it; never infer it from the search target.
    parts = [part.strip() for part in (value or "").split(",") if part.strip()]
    regions = {"western europe", "eastern europe", "north america", "south america", "asia"}
    parts = [part for part in parts if part.lower() not in regions]
    countries = {"Austria", "Belgium", "Bulgaria", "France", "Germany", "Ireland", "Italy",
                 "Netherlands", "Poland", "Portugal", "Romania", "Spain", "Sweden", "Switzerland",
                 "United Kingdom", "United States", "India", "Japan", "China",
                 "United Arab Emirates", "South Africa", "Egypt", "Saudi Arabia", "Qatar"}
    aliases = {"DE": "Germany", "FR": "France", "NL": "Netherlands", "GB": "United Kingdom",
               "PL": "Poland", "Polska": "Poland", "CH": "Switzerland",
               "Schweiz": "Switzerland", "Suisse": "Switzerland",
               "AE": "United Arab Emirates", "UAE": "United Arab Emirates",
               "ZA": "South Africa", "EG": "Egypt", "SA": "Saudi Arabia", "QA": "Qatar",
               "US": "United States", "Deutschland": "Germany", "United States of America": "United States"}
    parts = list(dict.fromkeys(aliases.get(part, part) for part in parts))
    explicit = [part for part in parts if part in countries]
    if len(explicit) == 1:
        parts = [part for part in parts if part != explicit[0]] + explicit
    if len(parts) == 1 and parts[0] in {"England", "Scotland", "Wales", "Northern Ireland", "UK"}:
        parts.append("United Kingdom")
    return ", ".join(parts) or None


def safe_url(source: str, href: str, base: str | None = None) -> str:
    root = SOURCES[source][0]
    url = urljoin(base or root, href).split("#", 1)[0]
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != urlparse(root).hostname:
        raise ValueError(f"Unexpected {source} job URL")
    return url


def page_soup(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "html.parser")
    title = (text(soup.title) or "").lower()
    if any(marker in title for marker in ("just a moment", "access denied", "captcha")) or soup.select_one("#challenge-form"):
        raise RuntimeError("blocked: upstream served an access challenge")
    return soup


@lru_cache(maxsize=64)
def search_html(source: str, keyword: str, page: int) -> str:
    root = SOURCES[source][0]
    if source == "eursap":
        # Eursap's public browser search is POST, and GET ?keywords= is ignored.
        response = requests.post(root + "/jobs/search", data={"keywords": keyword, "languages": "",
                                 "type": "", "locations": "", "sort": ""},
                                 headers={"X-Requested-With": "XMLHttpRequest"}, timeout=REQUEST_TIMEOUT_SECONDS, **request_kwargs())
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("error") or payload.get("error_res"):
            raise ValueError("Eursap search returned an invalid or failed response")
        fragments = [entry.get("value") for entry in payload.get("res", [])
                     if isinstance(entry, dict) and entry.get("key") == "#filter-result"]
        if len(fragments) != 1 or not isinstance(fragments[0], str):
            raise ValueError("Eursap search response has no results fragment")
        return fragments[0]
    if source == "redglobal":
        url = root + "/jobs/search?" + urlencode({"keywords": keyword, "page": page})
    else:
        path = "/sap-jobs/" if page == 1 else f"/sap-jobs/page/{page}/"
        url = root + path + "?" + urlencode({"search": keyword})
    response = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, **request_kwargs())
    response.raise_for_status()
    return response.text


@lru_cache(maxsize=128)
def detail_html(url: str) -> str:
    response = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, **request_kwargs())
    response.raise_for_status()
    return response.text


def labels(node: Any, selector: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for label in node.select(selector):
        value = label.find_next_sibling()
        if value is not None:
            values[(text(label) or "").rstrip(":").lower()] = text(value) or ""
    return values


def parse_search(source: str, html: str) -> tuple[list[dict[str, Any]], bool]:
    soup = page_soup(html)
    selectors = {"redglobal": ".c-card-job", "eursap": "a.looking__card", "whitehall": ".wh-search-results .job-item"}
    cards = soup.select(selectors[source])
    containers = {"redglobal": ".c-jobs", "eursap": ".job-results-title", "whitehall": ".wh-search-results"}
    red_empty = source == "redglobal" and any(
        "your search did not return any results" in (text(node) or "").lower()
        for node in soup.select(".c-notification")
    )
    if not cards and not red_empty and not soup.select_one(containers[source]):
        raise ValueError(f"{source} search markup is not recognized")
    rows = []
    for card in cards:
        row: dict[str, Any] = {"site": source, "company": SOURCES[source][1], "description": None,
                               "date_posted": None, "job_type": None, "is_remote": None}
        if source == "redglobal":
            link = card.select_one("a.c-card-job__title")
            row.update(title=text(link), location=location(text(card.select_one(".c-list-specifications__item--location"))),
                       date_posted=published_date(text(card.select_one(".c-card-job__date"))))
        elif source == "eursap":
            link = card
            meta = labels(card, ".looking__info:has(strong)")
            row.update(id=meta.get("job id"), title=re.sub(r"^SAP JOB VACANCY:\s*", "", text(card.select_one(".looking__name")) or ""),
                       location=location(meta.get("location")), job_type=job_type(meta.get("work type")),
                       is_remote=remote_flag(meta.get("location")))
            # Start Date is never used as a publication date.
        else:
            link = card.select_one("h3 a")
            arrangement = text(card.select_one(".job-arrangement"))
            row.update(title=text(link), location=location(text(card.select_one(".job-location"))),
                       id=re.sub(r"^Job ID:\s*", "", text(card.select_one(".job-ref")) or "") or None,
                       job_type=job_type(text(card.select_one(".job-type"))), is_remote=remote_flag(arrangement))
        if link is None or not link.get("href") or not row.get("title"):
            raise ValueError(f"{source} job card is missing title or URL")
        row["job_url"] = safe_url(source, link["href"])
        row["id"] = row.get("id") or urlparse(row["job_url"]).path.rstrip("/").split("/")[-1]
        rows.append(row)
    next_page = any((text(link) or "").lower() in {"next", "next »"} for link in soup.select("a[href]"))
    return rows, next_page


def job_posting(soup: BeautifulSoup) -> dict[str, Any] | None:
    def find(node: Any) -> dict[str, Any] | None:
        if isinstance(node, dict):
            kind = node.get("@type", [])
            if kind == "JobPosting" or isinstance(kind, list) and "JobPosting" in kind:
                return node
            return find(node.get("@graph"))
        if isinstance(node, list):
            return next((result for child in node if (result := find(child))), None)
        return None
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            # Some agency scripts contain literal newlines in description strings.
            result = find(json.loads(script.string or "", strict=False))
        except (ValueError, TypeError):
            continue
        if result:
            return result
    return None


def hydrate(source: str, row: dict[str, Any], html: str, description_format: str) -> dict[str, Any]:
    soup = page_soup(html)
    posting = job_posting(soup) or {}
    closure = page_closure(row, soup, posting)
    if closure:
        return closure
    row = dict(row)
    meta: dict[str, str] = {}
    if source == "eursap":
        meta = labels(soup, ".hero__list-name")
        row["job_type"] = job_type(meta.get("work type")) or row.get("job_type")
    elif source == "redglobal":
        for item in soup.select(".c-section-alt__head .c-list-specifications__item"):
            label = item.select_one("span")
            if label:
                key = (text(label) or "").lower()
                label.extract()
                meta[key] = text(item) or ""
        row["job_type"] = job_type(meta.get("type")) or row.get("job_type")
    else:
        meta["location"] = text(soup.select_one(".left-col .job-location")) or ""
        meta["workplace"] = text(soup.select_one(".left-col .job-arrangement")) or ""
        meta["type"] = text(soup.select_one(".left-col .job-type")) or ""
        row["job_type"] = job_type(meta.get("type")) or row.get("job_type")
    row["location"] = location(meta.get("location")) or row.get("location")
    place = posting.get("jobLocation")
    address = place.get("address") if isinstance(place, dict) else None
    country = address.get("addressCountry") if isinstance(address, dict) else address
    if isinstance(country, dict):
        country = country.get("name")
    if isinstance(country, str) and country.strip():
        country = location(country)
        if country and country.casefold() not in (row.get("location") or "").casefold():
            row["location"] = location(", ".join(filter(None, [row.get("location"), country])))
    stated_remote = remote_flag(meta.get("workplace") or meta.get("location"))
    if stated_remote is None and posting.get("jobLocationType") == "TELECOMMUTE":
        stated_remote = True
    if stated_remote is not None:
        row["is_remote"] = stated_remote
    if not row.get("job_type"):
        employment = posting.get("employmentType")
        if isinstance(employment, str):
            row["job_type"] = job_type(employment)
    row["date_posted"] = published_date(posting.get("datePosted")) or row.get("date_posted")
    description = posting.get("description")
    if not isinstance(description, str) or not description.strip():
        node = soup.select_one(".details__text" if source == "eursap" else ".left-col" if source == "whitehall" else ".c-section-alt__text")
        description = str(node) if node else None
    if not description:
        raise ValueError(f"{source} job detail has no description")
    description = markdownify(description).strip() if description_format == "markdown" else description
    prefix = "\n".join(f"{key.title()}: {value}" for key, value in meta.items() if value and key in {"language", "work type", "type", "workplace", "start date", "pay"})
    row["description"] = (prefix + "\n\n" + description).strip()
    required_location = applicant_location(posting)
    if required_location:
        row["description"] = f"Candidate required location: {required_location}\n\n" + row["description"]
    # A number without an explicit interval (e.g. RED's daily rate lacking a
    # unit in JSON-LD) must not be converted into an hourly rate.
    salary = posting.get("baseSalary")
    if isinstance(salary, dict) and isinstance(salary.get("value"), dict):
        value = salary["value"]
        interval = {"HOUR": "hourly", "DAY": "daily", "MONTH": "monthly", "YEAR": "yearly"}.get(str(value.get("unitText", "")).upper())
        if interval:
            for key, candidate in (("min_amount", value.get("minValue", value.get("value"))), ("max_amount", value.get("maxValue", value.get("value")))):
                try:
                    amount = float(candidate)
                    if math.isfinite(amount):
                        row[key] = amount
                except (TypeError, ValueError):
                    pass
            if "min_amount" in row or "max_amount" in row:
                row.update(interval=interval, currency=salary.get("currency"))
    return observe(row, "active", "Public listing detail contains a description", valid_through=posting.get("validThrough"))


def hydrate_detail(source: str, row: dict[str, Any], description_format: str) -> dict[str, Any]:
    try:
        return hydrate(source, row, detail_html(safe_url(source, row["job_url"])), description_format)
    except requests.HTTPError as exc:
        closure = http_closure(row, exc)
        if closure:
            return closure
        raise


def scrape_agency(kwargs: dict[str, Any]) -> tuple[list[dict[str, Any]], BaseException | None]:
    source = kwargs["site_name"][0]
    progress = SearchProgress(kwargs)
    def stream(row):
        if kwargs.get("on_record"):
            kwargs["on_record"](row)
    wanted = max(1, int(kwargs.get("results_wanted", 25)))
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=int(kwargs.get("hours_old", 96)))).date()
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    failure: BaseException | None = None
    fetch_description = bool(kwargs.get("fetch_description"))
    detail_requests = 0
    enriched = []
    closures = []
    if fetch_description:
        for row in kwargs.get("detail_jobs", [])[:min(wanted, MAX_DETAIL_REQUESTS_PER_TASK)]:
            detail_requests += 1
            try:
                url = safe_url(source, row["job_url"])
                updated = hydrate_detail(source, row, kwargs.get("description_format", "markdown"))
            except Exception as exc:
                return enriched + closures, exc
            seen.add(url)
            if updated.get("activity_status") == "closed":
                closures.append(updated)
                stream(updated)
                continue
            if not row.get("activity_refresh") and updated.get("date_posted") and date.fromisoformat(updated["date_posted"]) < cutoff:
                continue
            enriched.append(updated)
            stream(updated)
    if kwargs.get("enrich_only"):
        return enriched + closures, failure
    start = 1 if source == "eursap" else progress.start_page
    for page in range(start, min(100, start + (1 if source == "eursap" else MAX_SEARCH_PAGES) - 1) + 1):
        try:
            candidates, more = parse_search(source, search_html(source, kwargs.get("search_term", "SAP"), page))
        except Exception as exc:
            failure = exc
            break
        for row in progress.candidates(candidates, page):
            if row["job_url"] in seen:
                continue
            seen.add(row["job_url"])
            if row.get("date_posted") and date.fromisoformat(row["date_posted"]) < cutoff:
                continue
            # Keep the search identity if its detail request later hangs.
            stream(row)
            if fetch_description:
                if detail_requests >= MAX_DETAIL_REQUESTS_PER_TASK:
                    rows.append(row)
                    stream(row)
                    return enriched + rows + closures, failure
                detail_requests += 1
                try:
                    row = hydrate_detail(source, row, kwargs.get("description_format", "markdown"))
                except Exception as exc:
                    # Retain the identity, report the failure and stop requests.
                    rows.append(row)
                    stream(row)
                    return enriched + rows + closures, exc
                stream(row)
                if row.get("activity_status") == "closed":
                    closures.append(row)
                    stream(row)
                    continue
                if row.get("date_posted") and date.fromisoformat(row["date_posted"]) < cutoff:
                    continue
            rows.append(row)
            stream(row)
            if len(rows) >= wanted:
                break
        if len(rows) < wanted:
            progress.finish_page(page, more)
        if len(rows) >= wanted or not more or (fetch_description and detail_requests >= MAX_DETAIL_REQUESTS_PER_TASK):
            break
    return enriched + rows + closures, failure
