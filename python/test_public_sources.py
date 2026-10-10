"""Provider contract regressions; HTTP is mocked and examples contain no secrets."""
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import public_sources as sources
import collector

CARD = '''<div class="search-job-tile"><div class="job-title"><h3>
<a href="/job-detail/sap-btp/ref/jn-102026-123?utm_source=mail">SAP BTP Developer</a></h3></div>
<div class="job-location">Warszawa</div><div class="job-contract-type">Kontrakt B2B</div>
<div class="job-salary">PLN168 - PLN196 per hour</div><div class="job-nature">praca zdalna</div></div>'''


class PublicSourcesTest(unittest.TestCase):
    def tearDown(self):
        sources.fetch.cache_clear()

    def test_michael_page_identity_pay_and_terms_without_fabricating_description_or_country(self):
        rows, more = sources.parse_search("michaelpage", CARD, sources.MICHAEL_MARKETS["Poland"])
        self.assertFalse(more)
        self.assertEqual(rows[0]["id"], "jn-102026-123")
        self.assertEqual(rows[0]["currency"], "PLN")
        self.assertEqual(rows[0]["interval"], "hourly")
        self.assertEqual(rows[0]["max_amount"], 196)
        self.assertEqual(rows[0]["job_type"], "contract")
        self.assertTrue(rows[0]["is_remote"])
        self.assertEqual(rows[0]["location"], "Warszawa")
        self.assertIsNone(rows[0]["description"])
        self.assertIsNone(rows[0]["date_posted"])
        self.assertNotIn("utm_source", rows[0]["job_url"])

    def test_all_seven_markets_use_real_search_parameters_and_zero_based_pagination(self):
        self.assertEqual(sources.MICHAEL_MARKETS["United Arab Emirates"], "https://www.michaelpage.ae")
        for market, root in sources.MICHAEL_MARKETS.items():
            self.assertEqual(sources.search_url("michaelpage", "SAP", market, 2), root + "/jobs?search=SAP&page=1")
            rows, _ = sources.parse_search("michaelpage", CARD, root)
            self.assertTrue(rows[0]["job_url"].startswith(root))
        with self.assertRaises(ValueError):
            sources.market_root("Unknown")

    def test_michael_page_excludes_unrelated_recommendation_cards(self):
        suggestion = CARD.replace("SAP BTP Developer", "Account Manager").replace("jn-102026-123", "jn-102026-999")
        html = '<div class="view-content">' + CARD + '<div class="other-users-also-applied-for-block">' + suggestion + '</div></div>'
        rows, more = sources.parse_search("michaelpage", html, sources.MICHAEL_MARKETS["United Arab Emirates"])
        self.assertEqual([row["title"] for row in rows], ["SAP BTP Developer"])
        self.assertFalse(more)
        empty = '<div class="view-empty">No results</div><div class="other-users-also-applied-for-block">' + suggestion + '</div>'
        self.assertEqual(sources.parse_search("michaelpage", empty, sources.MICHAEL_MARKETS["United Arab Emirates"]), ([], False))

    def test_public_url_rejects_credentials_external_hosts_and_non_https(self):
        for url in ["https://evil.example/job", "http://www.michaelpage.pl/job", "https://user:pass@www.michaelpage.pl/job", "https://www.michaelpage.pl:444/job"]:
            with self.assertRaises(ValueError):
                sources.safe_public_url("michaelpage", url)

    def test_arbeitnow_keeps_regional_listing_urls_and_next_ventures_paginates(self):
        for host in ["www.arbeitnow.com", "www.arbeitnow.co.uk", "www.arbeitnow.ch", "www.arbeitnow.fr"]:
            self.assertEqual(sources.safe_public_url("arbeitnow", f"https://{host}/jobs/sap"), f"https://{host}/jobs/sap")
        html = '<article class="matador-job-listings"><section class="post-content"><a href="/jobs/sap/"><h3>SAP</h3></a></section></article>'
        html += '<div class="wp-pagenavi"><a href="/jobs/page/2/?s=SAP">2</a></div>'
        self.assertTrue(sources.parse_search("nextventures", html, "https://next-ventures.com")[1])

    def test_detail_preserves_actual_date_country_and_us_hours(self):
        html = '<script type="application/ld+json">' + json.dumps({"@type": "JobPosting",
            "datePosted": "2026-09-07", "jobLocation": {"address": {"addressLocality": "Warszawa", "addressCountry": "PL"}},
            "description": "<p>100% remote SAP Fiori contract. US (NYC) hours 14:00-22:00.</p>"}) + '</script>'
        row = sources.hydrate("michaelpage", sources.parse_search("michaelpage", CARD, sources.MICHAEL_MARKETS["Poland"])[0][0], html, "markdown")
        self.assertEqual(row["date_posted"], "2026-09-07")
        self.assertIn("Poland", row["location"])
        self.assertIn("US (NYC)", row["description"])
        self.assertEqual(row["currency"], "PLN")

    def test_preserves_candidate_residence_separately_from_office_location(self):
        html = '<script type="application/ld+json">' + json.dumps({"@type": "JobPosting",
            "jobLocation": {"address": {"addressCountry": "DE"}},
            "applicantLocationRequirements": [{"@type": "Country", "name": "United Kingdom"}],
            "description": "<p>Remote SAP CAP contract.</p>"}) + '</script>'
        record = sources.parse_search("michaelpage", CARD, sources.MICHAEL_MARKETS["Poland"])[0][0]
        hydrated = sources.hydrate("michaelpage", record, html, "markdown")
        self.assertIn("Germany", hydrated["location"])
        self.assertIn("Candidate required location: United Kingdom", hydrated["description"])

    def test_next_ventures_parses_cards_and_excludes_application_forms_from_details(self):
        html = '''<article class="matador-job-listings"><section class="post-content">
        <a href="/jobs/sap-cap/"><h3>SAP CAP Consultant</h3></a>
        <p>Location: Germany Type: Contract Job #75287 SAP project.</p></section></article>'''
        row = sources.parse_search("nextventures", html, "https://next-ventures.com")[0][0]
        self.assertEqual(row["id"], "75287")
        self.assertEqual(row["location"], "Germany")
        updated = sources.hydrate("nextventures", row,
            '<div class="job_description"><p>SAP CAP project</p><form>Upload personal CV</form></div>', "markdown")
        self.assertNotIn("personal CV", updated["description"])

    def test_api_providers_emit_full_descriptions_and_keep_platform_urls(self):
        today = datetime.now(timezone.utc).date().isoformat()
        fixtures = {
            "remotive": {"jobs": [{"id": 1, "url": "https://remotive.com/remote-jobs/1", "title": "SAP CAP Developer",
                "company_name": "Client", "description": "<p>SAP CAP</p>", "candidate_required_location": "Poland only",
                "publication_date": today, "job_type": "contract", "salary": "PLN180 per hour"}]},
            "arbeitnow": {"data": [{"slug": "sap-cap", "url": "https://www.arbeitnow.com/jobs/sap-cap",
                "title": "SAP CAP Developer", "company_name": "Client", "description": "<p>SAP CAP</p>",
                "remote": False, "location": "Berlin", "created_at": datetime.now(timezone.utc).timestamp(), "job_types": ["Full Time"]}], "links": {"next": None}},
            "remoteok": [{"legal": "Keep platform attribution"}, {"id": "1", "url": "https://remoteok.com/remote-jobs/1",
                "position": "SAP CAP Developer", "company": "Client", "description": "<p>SAP CAP</p>", "date": today, "location": "Europe"}],
            "jobicy": {"success": True, "jobs": [{"id": 1, "url": "https://jobicy.com/jobs/1", "jobTitle": "SAP CAP Developer",
                "companyName": "Client", "jobDescription": "<p>SAP CAP</p>", "jobType": ["Contract"], "jobGeo": "Germany",
                "pubDate": today, "salaryMin": 60, "salaryMax": 80, "salaryCurrency": "EUR", "salaryPeriod": "hourly"}]},
        }
        for source, payload in fixtures.items():
            with self.subTest(source=source):
                records = payload if isinstance(payload, list) else payload.get("jobs", payload.get("data"))
                for record in records:
                    record["validThrough"] = "2099-10-11"
                rows, more = sources.parse_api(source, payload, "SAP", "markdown")
                self.assertFalse(more)
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["description"].splitlines()[-1], "SAP CAP")
                self.assertEqual(rows[0]["date_posted"], today)
                self.assertEqual(rows[0]["valid_through"], "2099-10-12T00:00:00+00:00")
        remotive = sources.parse_api("remotive", fixtures["remotive"], "SAP", "markdown")[0][0]
        self.assertIn("Poland only", remotive["description"])
        self.assertNotIn("min_amount", remotive)
        self.assertFalse(sources.parse_api("arbeitnow", fixtures["arbeitnow"], "SAP", "markdown")[0][0]["is_remote"])

    def test_invalid_api_payload_is_not_reported_as_successful_empty_search(self):
        for source, payload in [("remotive", {}), ("arbeitnow", {"data": "broken"}), ("jobicy", {"success": False, "jobs": []})]:
            with self.assertRaises(ValueError):
                sources.parse_api(source, payload, "SAP", "markdown")

    def test_api_queries_preserve_word_boundaries_and_sapui5(self):
        row = {"id": "1", "url": "https://remoteok.com/remote-jobs/1", "position": "Developer", "description": "SAPUI5"}
        self.assertEqual(len(sources.parse_api("remoteok", [row], "SAP", "markdown")[0]), 1)
        row["description"] = "Sapphire application developer"
        self.assertEqual(sources.parse_api("remoteok", [row], "SAP", "markdown")[0], [])

    def test_detail_only_uses_budget_without_searching(self):
        row = sources.parse_search("michaelpage", CARD, sources.MICHAEL_MARKETS["Poland"])[0][0]
        html = '<div class="job_advert__job-desc-role">SAP CAP fully remote B2B.</div>'
        with patch("public_sources.fetch", return_value=html) as fetch:
            rows, failure = sources.scrape_public({"site_name": ["michaelpage"], "enrich_only": True,
                "detail_jobs": [row], "results_wanted": 5, "hours_old": 2160})
        self.assertIsNone(failure)
        self.assertEqual(fetch.call_count, 1)
        self.assertIn("SAP CAP", rows[0]["description"])

    def test_access_blocks_are_classified_without_retrying_provider_requests(self):
        with patch("public_sources.fetch", side_effect=RuntimeError("blocked: access challenge")) as fetch:
            rows, failure = sources.scrape_public({"site_name": ["michaelpage"], "location": "Poland"})
        self.assertEqual(rows, [])
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(collector.classify_error(failure), "blocked")
