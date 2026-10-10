"""Confirmed listing activity. Freshness and transport failures are not closure."""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Any


def observe(row: dict[str, Any], status: str, evidence: str, reason: str | None = None) -> dict[str, Any]:
    return {**row, "activity_status": status, "activity_reason": reason,
            "activity_evidence": evidence[:1900], "activity_checked_at": datetime.now(timezone.utc).isoformat()}


def expired(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
            return date.fromisoformat(value.strip()) < datetime.now(timezone.utc).date()
        deadline = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        # An unspecified timezone does not establish a precise expiry instant.
        return deadline.tzinfo is not None and deadline < datetime.now(timezone.utc)
    except ValueError:
        return False


def page_closure(row: dict[str, Any], soup: Any, posting: dict[str, Any]) -> dict[str, Any] | None:
    if expired(posting.get("validThrough")):
        return observe(row, "closed", f"validThrough: {posting['validThrough']}", "valid_through")
    # Inspect visible notice elements. Job descriptions or JSON-LD scripts are
    # not closure banners, and an unrecognized page is still a parse failure.
    messages = soup.select("h1, h2, .job-expired, .job-closed, .jobs-unavailable, .alert, [role=alert], .closed-job, .topcard__flavor--closed, .job-status, .job_advert__expired")
    phrases = re.compile(
        r"(?:this (?:job|position|vacancy) (?:is |has )?(?:no longer available|closed|expired|been filled)|"
        r"(?:no longer accepting|not accepting) applications|this job (?:posting|listing) has expired|"
        r"diese (?:stelle|position) ist (?:nicht mehr verf[uü]gbar|besetzt)|"
        r"cette offre (?:est |n'est )?(?:expir[eé]e|plus disponible|cl[oô]tur[eé]e)|"
        r"ta oferta (?:jest )?(?:nieaktualna|zamkni[eę]ta)|"
        r"deze vacature is (?:gesloten|verlopen))", re.I)
    for node in messages:
        message = node.get_text(" ", strip=True)
        if phrases.search(message):
            return observe(row, "closed", message, "closed_message")
    return None


def http_closure(row: dict[str, Any], exc: BaseException) -> dict[str, Any] | None:
    response = getattr(exc, "response", None)
    code = getattr(response, "status_code", None)
    return observe(row, "closed", f"HTTP {code} for listing detail", f"http_{code}") if code in {404, 410} else None
