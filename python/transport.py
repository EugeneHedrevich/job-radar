"""Task-local HTTP accounting and shared, verified proxy configuration."""
from __future__ import annotations

import os
import re
import math
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


@lru_cache(maxsize=1)
def network_config() -> tuple[str | None, str | bool]:
    raw = os.environ.get("JOB_RADAR_PROXY", "").strip()
    proxy = None
    if raw:
        try:
            parsed = urlsplit(raw if "://" in raw else "http://" + raw)
            if (parsed.scheme not in {"http", "https", "socks5"} or not parsed.hostname or
                    not parsed.port or parsed.path not in {"", "/"} or parsed.query or parsed.fragment or
                    re.search(r"\s", raw) or bool(parsed.username) != (parsed.password is not None)):
                raise ValueError()
            proxy = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        except ValueError:
            raise ValueError("Invalid JOB_RADAR_PROXY; use [http|https|socks5]://[user:password@]host:port") from None
    ca = os.environ.get("JOB_RADAR_CA_BUNDLE", "").strip()
    if ca and (not Path(ca).is_file() or not os.access(ca, os.R_OK)):
        raise ValueError("JOB_RADAR_CA_BUNDLE must name a readable trusted PEM certificate bundle")
    return proxy, ca or True


def request_kwargs() -> dict:
    proxy, verify = network_config()
    return {"proxies": {"http": proxy, "https": proxy} if proxy else None, "verify": verify}


def safe_message(value: object) -> str:
    text = str(value)
    raw = os.environ.get("JOB_RADAR_PROXY", "").strip()
    if raw:
        text = text.replace(raw, "[proxy]")
    return re.sub(r"(?i)(https?|socks5)://[^\s/@]+:[^\s/@]+@", r"\1://[redacted]@", text)


def retry_after(response) -> float | None:
    value = (getattr(response, "headers", None) or {}).get("Retry-After")
    if not isinstance(value, str):
        return None
    try:
        seconds = float(value)
        return max(0, seconds) if math.isfinite(seconds) else None
    except ValueError:
        try:
            at = parsedate_to_datetime(value)
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)
            return max(0, (at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError):
            return None


class RequestBudgetExhausted(Exception):
    pass


class SourceStopped(RuntimeError):
    def __init__(self, message: str, response=None):
        super().__init__(message)
        self.retry_after_seconds = retry_after(response) if response is not None else None


class LinkedInTransport:
    def __init__(self, detail_limit: int = 5, search_limit: int = 3, report=None):
        self.detail_limit = detail_limit
        self.search_limit = search_limit
        self.search_requests = 0
        self.detail_requests = 0
        self.failure = None
        self.report = report

    def before(self, kind: str) -> None:
        if self.failure:
            raise self.failure
        used = self.detail_requests if kind == "detail" else self.search_requests
        limit = self.detail_limit if kind == "detail" else self.search_limit
        if used >= limit:
            raise RequestBudgetExhausted("LinkedIn request allowance exhausted")
        if kind == "detail":
            self.detail_requests += 1
        else:
            self.search_requests += 1
        if self.report:
            self.report(self.search_requests, self.detail_requests)

    def check(self, response) -> None:
        status = response.status_code
        headers = getattr(response, "headers", None) or {}
        target = str(headers.get("Location", "")) + " " + str(getattr(response, "url", ""))
        body = str(getattr(response, "text", ""))
        challenge = (re.search(r"/(authwall|login|checkpoint|signup)(?:[/?]|$)", target, re.I) or
                     re.search(r"<title[^>]*>[^<]*(captcha|access denied|just a moment|security verification|log[ -]?in|sign[ -]?in|verify (?:your identity|you are human))", body, re.I) or
                     re.search(r'id=[\"\'](?:challenge-form|captcha)', body, re.I))
        if status in {429, 403} or challenge:
            self.failure = SourceStopped(f"HTTP {status}" if status in {429, 403} else
                "blocked: LinkedIn served an access challenge", response)
            raise self.failure


active_transport: ContextVar[LinkedInTransport | None] = ContextVar("linkedin_transport", default=None)


@contextmanager
def use_transport(transport):
    token = active_transport.set(transport)
    try:
        yield
    finally:
        active_transport.reset(token)
