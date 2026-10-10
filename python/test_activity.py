"""Offline activity observations and wire-contract regressions. Never live HTTP."""
import contextlib
import io
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import pandas as pd
import requests
from bs4 import BeautifulSoup

import activity
import collector
import details
import public_sources
import sap_sources


def row(source="linkedin", key="12345"):
    roots = {"linkedin": "https://www.linkedin.com/jobs/view/", "whitehall": "https://www.whitehallresources.com/job/",
             "nextventures": "https://next-ventures.com/jobs/"}
    return {"id": key, "job_url": roots[source] + key, "title": "SAP CAP Developer", "description": None}


def http_error(code):
    response = requests.Response()
    response.status_code = code
    return requests.HTTPError(f"HTTP {code}", response=response)


class ConfirmedActivityTest(unittest.TestCase):
    def test_valid_through_uses_the_explicit_expiry_not_the_posting_date(self):
        now = datetime.now(timezone.utc)
        self.assertTrue(activity.expired((now - timedelta(seconds=60)).isoformat()))
        self.assertFalse(activity.expired((now + timedelta(days=1)).isoformat()))
        self.assertFalse(activity.expired(now.date().isoformat()))
        self.assertFalse(activity.expired("unknown"))
        self.assertFalse(activity.expired("2026-10-10T12:00:00"))
        soup = BeautifulSoup('<h1>SAP vacancy</h1>', "html.parser")
        self.assertIsNone(activity.page_closure(row(), soup, {"datePosted": "2000-01-01"}))

    def test_recognizes_expiry_and_closed_notices_before_requiring_description_markup(self):
        expired = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        html = '<script type="application/ld+json">' + json.dumps({"@type": "JobPosting", "validThrough": expired}) + '</script>'
        for provider, record in [("whitehall", row("whitehall")), ("nextventures", row("nextventures"))]:
            adapter = sap_sources if provider == "whitehall" else public_sources
            result = adapter.hydrate(provider, record, html, "markdown")
            self.assertEqual(result["activity_reason"], "valid_through")
        for message in ['<h1>This job is no longer available</h1>', '<span class="topcard__flavor--closed">No longer accepting applications</span>']:
            response = Mock(status_code=200, is_redirect=False, text=message)
            with patch("details.requests.get", return_value=response):
                result = details.hydrate_board("linkedin", row(), "markdown")
            self.assertEqual(result["activity_reason"], "closed_message")
            self.assertEqual(result["activity_status"], "closed")
        with patch("details.requests.get", return_value=Mock(status_code=200, is_redirect=False, text='<h1>Unknown page</h1>')):
            with self.assertRaises(ValueError):
                details.hydrate_board("linkedin", row(), "markdown")

    def test_404_and_410_produce_observations_without_losing_listing_identity(self):
        for code in [404, 410]:
            with patch("details.requests.get", return_value=Mock(status_code=code)):
                closed = details.hydrate_board("linkedin", row(), "markdown")
            self.assertEqual(closed["id"], "12345")
            self.assertEqual(closed["activity_reason"], f"http_{code}")
            with patch("sap_sources.detail_html", side_effect=http_error(code)):
                rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "enrich_only": True,
                    "fetch_description": True, "detail_jobs": [row("whitehall")]})
            self.assertIsNone(failure)
            self.assertEqual(rows[0]["activity_reason"], f"http_{code}")
            with patch("public_sources.fetch", side_effect=http_error(code)):
                rows, failure = public_sources.scrape_public({"site_name": ["nextventures"], "enrich_only": True,
                    "fetch_description": True, "detail_jobs": [row("nextventures")]})
            self.assertIsNone(failure)
            self.assertEqual(rows[0]["activity_reason"], f"http_{code}")

    def test_blocks_transport_failures_parse_errors_and_search_absence_are_not_closure(self):
        for code in [403, 429, 500]:
            with patch("sap_sources.detail_html", side_effect=http_error(code)):
                rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "enrich_only": True,
                    "fetch_description": True, "detail_jobs": [row("whitehall")]})
            self.assertEqual(rows, [])
            self.assertIsNotNone(failure)
        with patch("sap_sources.search_html", return_value="empty"), patch("sap_sources.parse_search", return_value=([], False)):
            self.assertEqual(sap_sources.scrape_agency({"site_name": ["whitehall"]}), ([], None))
        for exc in [requests.Timeout("timeout"), ValueError("missing description")]:
            self.assertIsNone(activity.http_closure(row(), exc))

    def test_retains_confirmed_closed_backlog_rows_and_filters_old_open_postings_without_closing_them(self):
        closed = activity.observe(row(), "closed", "HTTP 410", "http_410")
        old = {**row(key="54321"), "date_posted": "2000-01-01", "description": "Full description"}
        with patch("details.hydrate_board", side_effect=[closed, old]), patch("details.time.sleep"):
            rows, failure = details.enrich_board("linkedin", [], {"detail_jobs": [row(), row(key="54321")], "results_wanted": 2})
        self.assertIsNone(failure)
        self.assertEqual([item["id"] for item in rows], ["12345"])
        self.assertEqual(rows[0]["activity_status"], "closed")

    def test_wire_emits_closure_without_requiring_a_job_title_and_counts_only_open_jobs(self):
        closed = activity.observe({"id": "12345", "job_url": row()["job_url"]}, "closed", "HTTP 404", "http_404")
        active = activity.observe({**row(key="54321"), "description": "SAP CAP details"}, "active", "Public detail is available")
        output = io.StringIO()
        with patch("collector.scrape_with_failures", return_value=(pd.DataFrame([closed, active]), None)), contextlib.redirect_stdout(output):
            result = collector.run_task({"task_id": "activity", "source": "linkedin", "search_term": "SAP"}, 5)
        records = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([record["type"] for record in records], ["listing_activity", "listing_activity", "job"])
        self.assertEqual(records[0]["activity"]["reason"], "http_404")
        self.assertEqual(result["count"], 1)
        self.assertNotIn("activity_status", records[-1]["job"])
