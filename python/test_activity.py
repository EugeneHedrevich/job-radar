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
    def test_future_deadlines_survive_detail_hydration_and_wire_transport(self):
        posting = {"@type": "JobPosting", "description": "SAP CAP details", "validThrough": "2099-10-11"}
        html = '<script type="application/ld+json">' + json.dumps(posting) + '</script>'
        for source in ["whitehall", "nextventures", "linkedin"]:
            with self.subTest(source=source), patch("details.requests.get", return_value=Mock(status_code=200, is_redirect=False, text=html)):
                active = details.hydrate_board(source, row(), "markdown") if source == "linkedin" else (
                    sap_sources if source == "whitehall" else public_sources).hydrate(source, row(source), html, "markdown")
            self.assertEqual(active["activity_status"], "active")
            self.assertEqual(active["valid_through"], "2099-10-12T00:00:00+00:00")
        output = io.StringIO()
        with patch("collector.scrape_with_failures", return_value=(pd.DataFrame([active]), None)), contextlib.redirect_stdout(output):
            collector.run_task({"task_id": "activity", "source": "linkedin", "search_term": "SAP"}, 5)
        observation = json.loads(output.getvalue().splitlines()[0])["activity"]
        self.assertEqual(observation["valid_through"], "2099-10-12T00:00:00+00:00")

    def test_refresh_checks_full_old_descriptions_and_shares_the_detail_limit(self):
        stored = [{**row(key=str(key)), "description": "Stored details", "date_posted": "2000-01-01",
                   "activity_refresh": True} for key in [12345, 54321]]
        active = activity.observe(stored[0], "active", "Public page is still available")
        with patch("details.hydrate_board", return_value=active) as request, patch("details.time.sleep"):
            result, failure = details.enrich_board("linkedin", [], {"detail_jobs": stored, "results_wanted": 1})
        self.assertIsNone(failure)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(result[0]["activity_status"], "active")

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
        self.assertNotIn("valid_through", records[1]["activity"])
        self.assertEqual(result["count"], 1)
        self.assertNotIn("activity_status", records[-1]["job"])


class DetailBacklogTest(unittest.TestCase):
    def test_hydration_preserves_pinned_linkedin_salary_parser(self):
        response = Mock(status_code=200, is_redirect=False, text='''
            <div class="show-more-less-html__markup">SAP CAP contract, fully remote.</div>
            <div class="compensation__salary">€60.00/hr - €75.00/hr</div>''')
        with patch("details.requests.get", return_value=response):
            hydrated = details.hydrate_board("linkedin", row(key="12345"), "markdown")
        self.assertEqual(hydrated["currency"], "EUR")
        self.assertEqual(hydrated["min_amount"], 60)
        self.assertEqual(hydrated["max_amount"], 75)
        self.assertEqual(hydrated["interval"], "hourly")

    def test_follows_only_same_identity_public_redirects(self):
        for target in ["/jobs/view/sap-cap-developer-12345/?trk=newsletter",
                       "https://pl.linkedin.com/jobs/view/sap-cap-developer-12345"]:
            with self.subTest(target=target):
                redirect = Mock(status_code=302, is_redirect=True, headers={"Location": target})
                final = Mock(status_code=200, is_redirect=False,
                             text='<div class="show-more-less-html__markup">SAP CAP remote contract.</div>')
                with patch("details.requests.get", side_effect=[redirect, final]) as get:
                    hydrated = details.hydrate_board("linkedin", row(key="12345"), "markdown")
                self.assertIn("SAP CAP", hydrated["description"])
                self.assertEqual(get.call_count, 2)

    def test_rejects_changed_identity_or_host_without_requesting_redirect_target(self):
        for target in ["https://example.com/jobs/view/12345", "/jobs/view/99999", "https://www.linkedin.com:444/jobs/view/12345"]:
            with self.subTest(target=target), patch("details.requests.get", return_value=Mock(
                    status_code=302, is_redirect=True, headers={"Location": target})) as get:
                with self.assertRaises(ValueError):
                    details.hydrate_board("linkedin", row(key="12345"), "markdown")
                self.assertEqual(get.call_count, 1)

    def test_login_redirect_is_reported_as_blocked_and_stops_requests(self):
        with patch("details.requests.get", return_value=Mock(status_code=302, is_redirect=True,
                  headers={"Location": "/authwall"})) as get:
            with self.assertRaisesRegex(RuntimeError, "blocked"):
                details.hydrate_board("linkedin", row(key="12345"), "markdown")
        self.assertEqual(get.call_count, 1)

    def test_bad_detail_markup_does_not_starve_later_stored_jobs(self):
        with patch("details.hydrate_board", side_effect=[ValueError("missing description"),
                   {**row(key="12346"), "description": "SAP CAP details"}]), patch("details.time.sleep"):
            rows, failure = details.enrich_board("linkedin", [], {"results_wanted": 2,
                "detail_jobs": [row(key="12345"), row(key="12346")]})
        self.assertIsInstance(failure, ValueError)
        self.assertEqual([row["id"] for row in rows], ["12346"])

    def test_backlog_is_independent_of_search_keyword_and_shares_original_detail_limit(self):
        stored = row(key="stored-cap")
        fresh = [row(key="new-joule-1"), row(key="new-joule-2")]
        with patch("details.hydrate_board", side_effect=lambda _source, row, _format: {**row, "description": "Full SAP description"}) as hydrate, \
                patch("details.time.sleep"):
            rows, failure = details.enrich_board("linkedin", fresh, {"results_wanted": 2, "search_term": "SAP Joule", "detail_jobs": [stored]})
        self.assertIsNone(failure)
        self.assertEqual(hydrate.call_count, 2)
        self.assertEqual(hydrate.call_args_list[0].args[1]["id"], "stored-cap")
        self.assertEqual(next(row for row in rows if row["id"] == "stored-cap")["description"], "Full SAP description")
        self.assertIsNone(next(row for row in rows if row["id"] == "new-joule-2")["description"])

    def test_known_urls_are_requested_only_once_and_upstream_failure_stops_enrichment(self):
        listing = row(key="same")
        with patch("details.hydrate_board", side_effect=requests.HTTPError("429 Too Many Requests")) as hydrate:
            rows, failure = details.enrich_board("linkedin", [listing], {"results_wanted": 5, "detail_jobs": [listing, row(key="other")]})
        self.assertEqual(len(rows), 1)
        self.assertEqual(hydrate.call_count, 1)
        self.assertIn("429", str(failure))

    def test_rejects_unexpected_hosts_before_requesting(self):
        with patch("details.requests.get") as get:
            with self.assertRaises(ValueError):
                details.hydrate_board("linkedin", {**row(key="bad"), "job_url": "https://example.com/private"}, "markdown")
        get.assert_not_called()
