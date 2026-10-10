"""Confirmed listing activity. Freshness and transport failures are not closure."""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any


def expiry_instant(value: Any) -> str | None:
    """Keep explicit, comparable deadlines, including future expiry dates."""
    if not isinstance(value, str):
        return None
    try:
        deadline = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
            deadline = (deadline + timedelta(days=1)).replace(tzinfo=timezone.utc)
        if deadline.tzinfo is not None:
            return deadline.astimezone(timezone.utc).isoformat()
    except (ValueError, OverflowError):
        pass
    return None


def observe(row: dict[str, Any], status: str, evidence: str, reason: str | None = None,
            valid_through: Any = None) -> dict[str, Any]:
    return {**row, "activity_status": status, "activity_reason": reason,
            "activity_evidence": evidence[:1900], "activity_checked_at": datetime.now(timezone.utc).isoformat(),
            "valid_through": expiry_instant(valid_through)}


def expired(value: Any) -> bool:
    deadline = expiry_instant(value)
    return deadline is not None and datetime.fromisoformat(deadline) <= datetime.now(timezone.utc)


def page_closure(row: dict[str, Any], soup: Any, posting: dict[str, Any]) -> dict[str, Any] | None:
    if expired(posting.get("validThrough")):
        return observe(row, "closed", f"validThrough: {posting['validThrough']}", "valid_through", posting['validThrough'])
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
