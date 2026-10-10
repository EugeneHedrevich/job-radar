"""Offline regressions against the installed, pinned JobSpy implementation."""

import contextlib
import io
import json
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import jobspy
import pandas as pd

import collector


def task(task_id="test", source="linkedin"):
    return {"task_id": task_id, "source": source, "search_term": "SAP BTP Developer",
            "location": "Germany", "results_wanted": 1}


class CollectorFailuresTest(unittest.TestCase):
    def test_description_only_never_calls_board_search(self):
        stored = {"id": "123", "title": "SAP CAP", "job_url": "https://www.linkedin.com/jobs/view/123"}
        with patch("jobspy.scrape_jobs") as scrape, patch("details.enrich_board", return_value=([stored], None)) as enrich:
            frame, failure = collector.scrape_with_failures({"site_name": ["linkedin"], "enrich_only": True,
                "fetch_description": True, "results_wanted": 5, "detail_jobs": [stored]})
        scrape.assert_not_called()
        self.assertEqual(enrich.call_args.args[1], [])
        self.assertIsNone(failure)
        self.assertEqual(len(frame), 1)

    def test_backlog_uses_search_without_details_and_reports_enrichment_failure(self):
        stored = {"id": "stored", "title": "SAP CAP", "job_url": "https://www.linkedin.com/jobs/view/1"}
        frame = pd.DataFrame([{**stored, "id": "fresh", "description": float("nan")}])
        with patch("jobspy.scrape_jobs", return_value=frame) as scrape, \
             patch("details.enrich_board", return_value=([stored], RuntimeError("429 detail request"))) as enrich:
            _, failure = collector.scrape_with_failures({"site_name": ["linkedin"], "fetch_description": True,
                                                        "results_wanted": 5, "detail_jobs": [stored]})
        self.assertFalse(scrape.call_args.kwargs["fetch_description"])
        self.assertNotIn("detail_jobs", scrape.call_args.kwargs)
        self.assertIsNone(enrich.call_args.args[1][0]["description"])
        self.assertEqual(failure[0], "rate_limit")

    def collect_response(self, status):
        response = SimpleNamespace(status_code=status, text="")
        with patch("jobspy.util.RequestsRotating.get", return_value=response):
            return collector.run_task(task(), 5)

    def test_http_failures_keep_their_classification(self):
        for status, kind in [(429, "rate_limit"), (403, "blocked"), (500, "error")]:
            with self.subTest(status=status):
                result = self.collect_response(status)
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["error_kind"], kind)
                self.assertEqual(result["count"], 0)

    def test_pinned_linkedin_swallowed_connection_error_is_reported(self):
        with patch("jobspy.util.RequestsRotating.get", side_effect=ConnectionError("connection reset")):
            result = collector.run_task(task(), 5)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_kind"], "network")

    def test_valid_empty_search_remains_successful(self):
        result = self.collect_response(200)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["count"], 0)
        self.assertNotIn("error_kind", result)

    def test_warning_level_block_is_captured_and_partial_records_are_preserved(self):
        def scrape(**kwargs):
            jobspy.util.set_logger_level(kwargs["verbose"])
            logging.getLogger("JobSpy:LinkedIn").warning("429 Response - Blocked by LinkedIn for too many requests")
            return pd.DataFrame([{"id": "partial", "title": "SAP BTP Developer", "job_url": "https://example.com/partial"}])

        output = io.StringIO()
        with patch("jobspy.scrape_jobs", side_effect=scrape), contextlib.redirect_stdout(output):
            result = collector.run_task(task(), 5)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error_kind"], "rate_limit")
        self.assertEqual(result["count"], 1)
        self.assertEqual(json.loads(output.getvalue())["type"], "job")

    def test_unrelated_warning_does_not_turn_a_valid_empty_search_into_a_failure(self):
        def scrape(**kwargs):
            jobspy.util.set_logger_level(kwargs["verbose"])
            logging.getLogger("JobSpy:LinkedIn").warning("LinkedIn: job_type isn't supported, ignoring it")
            return pd.DataFrame()

        with patch("jobspy.scrape_jobs", side_effect=scrape):
            result = collector.run_task(task(), 5)
        self.assertEqual(result["status"], "succeeded")

    def test_log_capture_is_removed_and_does_not_leak_to_the_next_task(self):
        self.collect_response(429)
        self.assertEqual(self.collect_response(200)["status"], "succeeded")

    def test_blocks_stop_remaining_source_tasks_but_leave_other_sources_running(self):
        failure = {"type": "task_result", "status": "failed", "error_kind": "rate_limit", "message": "429", "count": 0, "duration_ms": 1}
        success = {"type": "task_result", "status": "succeeded", "count": 0, "duration_ms": 1}
        request = {"tasks": [task("first"), task("second"), task("other", "indeed")]}
        output = io.StringIO()
        with patch("collector.run_task", side_effect=[failure, success]) as run, \
             patch("sys.stdin", io.StringIO(json.dumps(request))), contextlib.redirect_stdout(output):
            self.assertEqual(collector.main(), 0)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[1].args[0]["source"], "indeed")
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        skipped = next(record for record in results if record.get("task_id") == "second")
        self.assertEqual(skipped["error_kind"], "rate_limit")
        self.assertEqual(skipped["status"], "failed")


if __name__ == "__main__":
    unittest.main()
