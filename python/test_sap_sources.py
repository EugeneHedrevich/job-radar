"""Offline regressions for public SAP agency adapters. All HTTP is mocked."""

import contextlib
import io
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import requests

import collector
import sap_sources


RED_CARD = '''<div class="c-jobs"><div class="c-card-job">
<a class="c-card-job__title" href="/jobs/job/sap-btp/abc123">SAP BTP Consultant</a>
<li class="c-list-specifications__item--location">Paris, France, Western Europe</li>
<p class="c-card-job__date">8 Oct 2026</p><p>Truncated description...</p>
</div></div>'''

EURSAP_CARD = '''<a class="looking__card" href="https://eursap.eu/jobs/sap-cpi-123">
<div class="looking__name">SAP JOB VACANCY: SAP CPI Consultant</div>
<span class="looking__info"><strong>Job ID:</strong></span><span class="looking__info">123</span>
<span class="looking__info"><strong>Location:</strong></span><span class="looking__info">Remote Work</span>
<span class="looking__info"><strong>Work Type:</strong></span><span class="looking__info">Contract</span>
<span class="looking__info"><strong>Start Date:</strong></span><span class="looking__info">Nov 02, 2026</span>
</a>'''

WHITEHALL_CARD = '''<div class="wh-search-results"><div class="job-item">
<div class="job-ref">Job ID: BBBH123_456</div><div class="job-type">Contract</div>
<h3><a href="https://www.whitehallresources.com/job/sap-ui5-123/">SAP UI5 Developer</a></h3>
<div class="job-location">England</div>
</div></div>'''


def posting(**overrides):
    return '<script type="application/ld+json">' + json.dumps({
        "@context": "https://schema.org", "@type": "JobPosting",
        "datePosted": "2026-10-07", "employmentType": "Contract",
        "description": "<p>Must have:</p><ul><li>CAP</li><li>Node.js</li></ul><p>Nice to have: SAPUI5.</p>",
        **overrides,
    }) + '</script>'


class AgencyAdaptersTest(unittest.TestCase):
    def tearDown(self):
        sap_sources.search_html.cache_clear()
        sap_sources.detail_html.cache_clear()

    def test_red_preserves_identity_date_and_country_without_fabricating_description(self):
        rows, more = sap_sources.parse_search("redglobal", RED_CARD)
        self.assertFalse(more)
        self.assertEqual(rows[0]["id"], "abc123")
        self.assertEqual(rows[0]["location"], "Paris, France")
        self.assertEqual(rows[0]["date_posted"], "2026-10-08")
        self.assertIsNone(rows[0]["description"])
        self.assertIsNone(rows[0]["is_remote"])

    def test_eursap_start_date_is_not_a_publication_date(self):
        row = sap_sources.parse_search("eursap", EURSAP_CARD)[0][0]
        self.assertEqual(row["id"], "123")
        self.assertEqual(row["title"], "SAP CPI Consultant")
        self.assertEqual(row["job_type"], "contract")
        self.assertTrue(row["is_remote"])
        self.assertIsNone(row["date_posted"])

    def test_whitehall_preserves_recruiter_identity_and_contract_type(self):
        row = sap_sources.parse_search("whitehall", WHITEHALL_CARD)[0][0]
        self.assertEqual(row["id"], "BBBH123_456")
        self.assertEqual(row["company"], "Whitehall Resources")
        self.assertEqual(row["location"], "England, United Kingdom")
        self.assertEqual(row["job_type"], "contract")

    def test_eursap_uses_public_post_search_and_caches_identical_requests(self):
        response = Mock()
        response.json.return_value = {"error": [], "res": [{"key": "#filter-result", "value": EURSAP_CARD}]}
        with patch("sap_sources.requests.post", return_value=response) as request:
            self.assertEqual(sap_sources.search_html("eursap", "CPI", 1), EURSAP_CARD)
            self.assertEqual(sap_sources.search_html("eursap", "CPI", 1), EURSAP_CARD)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[0], "https://eursap.eu/jobs/search")
        self.assertEqual(request.call_args.kwargs["data"]["keywords"], "CPI")

    def test_invalid_search_response_is_not_a_successful_empty_result(self):
        response = Mock()
        response.json.return_value = {"res": [{"key": "#other", "value": ""}]}
        with patch("sap_sources.requests.post", return_value=response):
            with self.assertRaisesRegex(ValueError, "no results fragment"):
                sap_sources.search_html("eursap", "CPI", 1)
        for source in sap_sources.SOURCES:
            with self.subTest(source=source), self.assertRaises(ValueError):
                sap_sources.parse_search(source, "<html>Unexpected page</html>")
        with self.assertRaisesRegex(RuntimeError, "blocked"):
            sap_sources.parse_search("redglobal", "<title>Just a moment...</title>")

    def test_empty_searches_remain_valid(self):
        for source, html in [("redglobal", '<div class="c-jobs"></div>'),
                             ("redglobal", '<div class="c-notification">We\'re sorry, your search did not return any results. Please adjust your search criteria.</div>'),
                             ("whitehall", '<div class="wh-search-results">No jobs found</div>'),
                             ("eursap", '<h2 class="job-results-title">Results not found</h2>')]:
            with self.subTest(source=source):
                self.assertEqual(sap_sources.parse_search(source, html), ([], False))

    def test_an_unrelated_notification_does_not_hide_a_layout_failure(self):
        with self.assertRaises(ValueError):
            sap_sources.parse_search("redglobal", '<div class="c-notification">Please sign in</div>')

    def test_explicit_eursap_contract_overrides_fulltime_schema_and_retains_list_boundaries(self):
        row = sap_sources.parse_search("eursap", EURSAP_CARD)[0][0]
        html = '<div class="hero__list-name">Work Type:</div><div class="hero__list-info">Contract</div>'
        result = sap_sources.hydrate("eursap", row, html + posting(employmentType="FULL_TIME"), "markdown")
        self.assertEqual(result["job_type"], "contract")
        self.assertEqual(result["date_posted"], "2026-10-07")
        self.assertIn("Must have:", result["description"])
        self.assertIn("* CAP", result["description"])
        self.assertIn("Nice to have", result["description"])

    def test_rate_without_interval_stays_unknown(self):
        row = sap_sources.parse_search("redglobal", RED_CARD)[0][0]
        result = sap_sources.hydrate("redglobal", row, posting(baseSalary={"currency": "EUR", "minValue": "780", "maxValue": "780"}), "markdown")
        self.assertNotIn("min_amount", result)
        self.assertNotIn("interval", result)

    def test_explicit_hourly_rate_is_preserved(self):
        row = sap_sources.parse_search("whitehall", WHITEHALL_CARD)[0][0]
        salary = {"currency": "EUR", "value": {"minValue": "60", "maxValue": "75", "unitText": "HOUR"}}
        result = sap_sources.hydrate("whitehall", row, posting(baseSalary=salary), "markdown")
        self.assertEqual((result["min_amount"], result["max_amount"], result["interval"]), (60, 75, "hourly"))

    def test_detail_requests_require_the_existing_budget_flag(self):
        with patch("sap_sources.search_html", return_value=WHITEHALL_CARD), patch("sap_sources.detail_html") as request:
            rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "search_term": "UI5",
                                                       "results_wanted": 1, "fetch_description": False})
        request.assert_not_called()
        self.assertIsNone(failure)
        self.assertEqual(rows[0]["id"], "BBBH123_456")
        self.assertIsNone(rows[0]["description"])

    def test_bounded_pagination_and_partial_records_after_a_search_failure(self):
        row = sap_sources.parse_search("whitehall", WHITEHALL_CARD)[0][0]
        with patch("sap_sources.search_html", return_value="html") as request, \
             patch("sap_sources.parse_search", return_value=([row], True)):
            rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "results_wanted": 5})
        self.assertEqual(request.call_count, sap_sources.MAX_SEARCH_PAGES)
        self.assertEqual(len(rows), 1)
        self.assertIsNone(failure)
        with patch("sap_sources.search_html", side_effect=[WHITEHALL_CARD, requests.ConnectionError("connection reset")]), \
             patch("sap_sources.parse_search", return_value=([row], True)):
            rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "results_wanted": 5})
        self.assertEqual(len(rows), 1)
        self.assertIsInstance(failure, requests.ConnectionError)

    def test_detail_429_retains_listing_and_reports_failure_without_calling_jobspy(self):
        current_card = RED_CARD.replace("8 Oct 2026", datetime.now(timezone.utc).strftime("%d %b %Y"))
        output = io.StringIO()
        with patch("sap_sources.search_html", return_value=current_card), \
             patch("sap_sources.detail_html", side_effect=requests.HTTPError("429 Too Many Requests")), \
             patch("jobspy.scrape_jobs") as jobspy, contextlib.redirect_stdout(output):
            result = collector.run_task({"task_id": "red-1", "source": "redglobal", "search_term": "BTP",
                                         "results_wanted": 1, "fetch_description": True}, 5)
        jobspy.assert_not_called()
        self.assertEqual((result["status"], result["error_kind"], result["count"]), ("failed", "rate_limit", 1))
        self.assertEqual(json.loads(output.getvalue())["source"], "redglobal")

    def test_job_urls_cannot_request_another_host(self):
        with self.assertRaises(ValueError):
            sap_sources.safe_url("redglobal", "https://other.example/jobs/123")

    def test_refills_after_first_five_details_reveal_old_or_expired_jobs(self):
        today = datetime.now(timezone.utc).date()
        stale = (today - timedelta(days=30)).isoformat()
        fresh = today.isoformat()
        candidates = [{"job_url": f"https://www.whitehallresources.com/job/{i}",
                       "id": str(i), "title": "SAP CAP", "date_posted": None} for i in range(6)]
        details = [posting(datePosted=stale) for _ in range(3)] + \
                  [posting(datePosted=fresh, validThrough=stale) for _ in range(2)] + \
                  [posting(datePosted=fresh)]
        with patch("sap_sources.search_html", return_value="html"), \
             patch("sap_sources.parse_search", return_value=(candidates, False)), \
             patch("sap_sources.detail_html", side_effect=details) as request:
            rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "results_wanted": 5,
                                                       "fetch_description": True})
        self.assertIsNone(failure)
        self.assertEqual([row["id"] for row in rows], ["5"])
        self.assertEqual(request.call_count, 6)

    def test_refills_across_pages_but_never_exceeds_detail_request_limit(self):
        stale = (datetime.now(timezone.utc).date() - timedelta(days=30)).isoformat()
        candidates = [{"job_url": f"https://www.whitehallresources.com/job/{i}",
                       "id": str(i), "title": "SAP CAP", "date_posted": None}
                      for i in range(sap_sources.MAX_DETAIL_REQUESTS_PER_TASK + 5)]
        with patch("sap_sources.search_html", return_value="html") as search, \
             patch("sap_sources.parse_search", side_effect=[(candidates[:5], True), (candidates[5:], True)]), \
             patch("sap_sources.detail_html", return_value=posting(datePosted=stale)) as detail:
            rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "results_wanted": 5,
                                                       "fetch_description": True})
        self.assertEqual(rows, [])
        self.assertIsNone(failure)
        self.assertEqual(search.call_count, 2)
        self.assertEqual(detail.call_count, sap_sources.MAX_DETAIL_REQUESTS_PER_TASK)

    def test_listing_dates_and_duplicate_urls_do_not_spend_detail_budget(self):
        today = datetime.now(timezone.utc).date()
        row = {"job_url": "https://www.whitehallresources.com/job/1", "id": "1", "title": "SAP CAP"}
        old = {**row, "job_url": "https://www.whitehallresources.com/job/old",
               "date_posted": (today - timedelta(days=30)).isoformat()}
        with patch("sap_sources.search_html", return_value="html"), \
             patch("sap_sources.parse_search", return_value=([old, row, row], False)), \
             patch("sap_sources.detail_html", return_value=posting(datePosted=today.isoformat())) as request:
            rows, failure = sap_sources.scrape_agency({"site_name": ["whitehall"], "results_wanted": 5,
                                                       "fetch_description": True})
        self.assertIsNone(failure)
        self.assertEqual(len(rows), 1)
        request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
