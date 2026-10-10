"""Offline backlog regressions. No source requests are made by these tests."""

import unittest
from unittest.mock import patch
from unittest.mock import Mock

import requests
import details


def record(key, source="linkedin"):
    return {"id": key, "title": "SAP CAP Developer", "job_url": f"https://www.{source}.com/jobs/view/{key}", "description": None}


class DetailBacklogTest(unittest.TestCase):
    def test_hydration_preserves_pinned_linkedin_salary_parser_and_gone_pages(self):
        response = Mock(status_code=200, is_redirect=False, text='''
            <div class="show-more-less-html__markup">SAP CAP contract, fully remote.</div>
            <div class="compensation__salary">€60.00/hr - €75.00/hr</div>''')
        with patch("details.requests.get", return_value=response):
            hydrated = details.hydrate_board("linkedin", record("12345"), "markdown")
        self.assertEqual(hydrated["currency"], "EUR")
        self.assertEqual(hydrated["min_amount"], 60)
        self.assertEqual(hydrated["max_amount"], 75)
        self.assertEqual(hydrated["interval"], "hourly")
        with patch("details.requests.get", return_value=Mock(status_code=404)):
            self.assertTrue(details.hydrate_board("linkedin", record("54321"), "markdown")["_expired"])

    def test_follows_canonical_redirect_only_for_the_same_public_job(self):
        redirect = Mock(status_code=302, is_redirect=True,
                        headers={"Location": "/jobs/view/sap-cap-developer-12345/?trk=newsletter"})
        final = Mock(status_code=200, is_redirect=False,
                     text='<div class="show-more-less-html__markup">SAP CAP remote contract.</div>')
        with patch("details.requests.get", side_effect=[redirect, final]) as get:
            row = details.hydrate_board("linkedin", record("12345"), "markdown")
        self.assertIn("SAP CAP", row["description"])
        self.assertEqual(get.call_count, 2)
        self.assertFalse(get.call_args.kwargs["allow_redirects"])

    def test_follows_linkedin_regional_canonical_redirect_for_the_same_listing(self):
        redirect = Mock(status_code=301, is_redirect=True,
                        headers={"Location": "https://pl.linkedin.com/jobs/view/sap-cap-developer-12345"})
        final = Mock(status_code=200, is_redirect=False,
                     text='<div class="show-more-less-html__markup">SAP CAP contract.</div>')
        with patch("details.requests.get", side_effect=[redirect, final]) as get:
            row = details.hydrate_board("linkedin", record("12345"), "markdown")
        self.assertIn("SAP CAP", row["description"])
        self.assertTrue(get.call_args.args[0].startswith("https://pl.linkedin.com/"))

    def test_rejects_changed_identity_or_host_without_requesting_redirect_target(self):
        for target in ["https://example.com/jobs/view/12345", "/jobs/view/99999", "https://www.linkedin.com:444/jobs/view/12345"]:
            with self.subTest(target=target), patch("details.requests.get", return_value=Mock(
                    status_code=302, is_redirect=True, headers={"Location": target})) as get:
                with self.assertRaises(ValueError):
                    details.hydrate_board("linkedin", record("12345"), "markdown")
                self.assertEqual(get.call_count, 1)

    def test_login_redirect_is_reported_as_blocked_and_stops_requests(self):
        with patch("details.requests.get", return_value=Mock(status_code=302, is_redirect=True,
                  headers={"Location": "/authwall"})) as get:
            with self.assertRaisesRegex(RuntimeError, "blocked"):
                details.hydrate_board("linkedin", record("12345"), "markdown")
        self.assertEqual(get.call_count, 1)

    def test_bad_detail_markup_does_not_starve_later_stored_jobs(self):
        with patch("details.hydrate_board", side_effect=[ValueError("missing description"),
                   {**record("12346"), "description": "SAP CAP details"}]), patch("details.time.sleep"):
            rows, failure = details.enrich_board("linkedin", [], {"results_wanted": 2,
                "detail_jobs": [record("12345"), record("12346")]})
        self.assertIsInstance(failure, ValueError)
        self.assertEqual([row["id"] for row in rows], ["12346"])

    def test_backlog_is_independent_of_search_keyword_and_shares_original_detail_limit(self):
        stored = record("stored-cap")
        fresh = [record("new-joule-1"), record("new-joule-2")]
        with patch("details.hydrate_board", side_effect=lambda _source, row, _format: {**row, "description": "Full SAP description"}) as hydrate, \
                patch("details.time.sleep"):
            rows, failure = details.enrich_board("linkedin", fresh, {"results_wanted": 2, "search_term": "SAP Joule", "detail_jobs": [stored]})
        self.assertIsNone(failure)
        self.assertEqual(hydrate.call_count, 2)
        self.assertEqual(hydrate.call_args_list[0].args[1]["id"], "stored-cap")
        self.assertEqual(next(row for row in rows if row["id"] == "stored-cap")["description"], "Full SAP description")
        self.assertIsNone(next(row for row in rows if row["id"] == "new-joule-2")["description"])

    def test_known_urls_are_requested_only_once_and_upstream_failure_stops_enrichment(self):
        row = record("same")
        with patch("details.hydrate_board", side_effect=requests.HTTPError("429 Too Many Requests")) as hydrate:
            rows, failure = details.enrich_board("linkedin", [row], {"results_wanted": 5, "detail_jobs": [row, record("other")]})
        self.assertEqual(len(rows), 1)
        self.assertEqual(hydrate.call_count, 1)
        self.assertIn("429", str(failure))

    def test_rejects_unexpected_hosts_before_requesting(self):
        with patch("details.requests.get") as get:
            with self.assertRaises(ValueError):
                details.hydrate_board("linkedin", {**record("bad"), "job_url": "https://example.com/private"}, "markdown")
        get.assert_not_called()
