"""Offline collector regression: standard library only, all upstream modules fake."""
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
import collector
from transport import RequestBudgetExhausted, SourceStopped


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    @property
    def empty(self):
        return not self.rows

    @property
    def columns(self):
        return list(dict.fromkeys(key for row in self.rows for key in row))

    def __getitem__(self, columns):
        return Frame([{key: row.get(key) for key in columns} for row in self.rows])

    def to_dict(self, orient='records'):
        return self.rows

    def drop_duplicates(self, subset, keep='last'):
        return Frame(list({row['job_url']: row for row in self.rows}.values()))


class FreshnessRegression(unittest.TestCase):
    def collect(self, blocked=False):
        events, requests, enrichment = [], [], []

        class Session:
            def request(self, method, url, **options):
                requests.append(url)
                return types.SimpleNamespace(status_code=429 if blocked else 200,
                    headers={'Retry-After': '1200'} if blocked else {}, url=url,
                    text='<title>Jobs</title>', raise_for_status=lambda: None)

        class LinkedIn:
            def _process_job(self, job):
                return job

        board = types.ModuleType('jobspy.linkedin')
        board.LinkedIn, board.create_session = LinkedIn, lambda **options: Session()
        jobspy = types.ModuleType('jobspy')
        jobspy.__path__ = []

        def scrape_jobs(**kwargs):
            session, scraper, rows = board.create_session(), LinkedIn(), []
            start = kwargs.get('offset', 0)
            for page in range(3):
                offset = start + page * 10
                try:
                    session.request('GET', f'https://www.linkedin.com/search?offset={offset}')
                except (RequestBudgetExhausted, SourceStopped):
                    break  # Pinned JobSpy returns partial/empty data after these errors.
                for index in range(10):
                    identity = offset + index
                    row = {'id': str(identity), 'title': 'Inserted at the head' if identity == 0 else 'Older vacancy',
                        'company_name': 'Example', 'job_url': f'https://www.linkedin.com/jobs/view/{1000 + identity}'}
                    job = types.SimpleNamespace(**row, job_type=None, location=None, compensation=None,
                        model_dump=lambda row=row: dict(row))
                    scraper._process_job(job)
                    rows.append({**row, 'company': 'Example'})
            return Frame(rows)

        jobspy.scrape_jobs = scrape_jobs
        pandas = types.ModuleType('pandas')
        pandas.concat = lambda frames, **options: Frame([row for frame in frames for row in frame.rows])
        pandas.DataFrame = Frame
        agencies, public = types.ModuleType('sap_sources'), types.ModuleType('public_sources')
        agencies.SOURCES, agencies.scrape_agency = {}, lambda kwargs: ([], None)
        public.PUBLIC_SOURCES, public.scrape_public = {}, lambda kwargs: ([], None)
        details = types.ModuleType('details')
        def enrich_board(source, rows, kwargs):
            enrichment.append(len(rows))
            return [{**row, 'description': 'A bounded detail result'} for row in rows], None
        details.enrich_board = enrich_board
        modules = {'jobspy': jobspy, 'jobspy.linkedin': board, 'pandas': pandas,
            'sap_sources': agencies, 'public_sources': public, 'details': details}
        with patch.dict(sys.modules, modules), patch.object(collector, 'emit', events.append), \
                patch.object(collector, 'network_config', lambda: (None, True)):
            result = collector.run_task({'task_id': 'backfill', 'source': 'linkedin', 'search_term': 'SAP CAP',
                'offset': 20, 'results_wanted': 25, 'search_request_limit': 3, 'fetch_description': True}, 60)
        return result, events, requests, enrichment

    def test_new_head_and_saved_backfill_share_three_requests(self):
        result, events, requests, enrichment = self.collect()
        self.assertEqual(len(requests), 3)
        self.assertIn('offset=0', requests[0])
        self.assertIn('offset=20', requests[1])
        self.assertEqual(result['status'], 'succeeded')
        self.assertTrue(result['head_checked'])
        self.assertTrue(any(event.get('job', {}).get('title') == 'Inserted at the head' for event in events))
        self.assertEqual([event['cursor'] for event in events if event['type'] == 'search_progress'][-1], {'offset': 40})
        self.assertEqual(enrichment, [30])
        self.assertTrue(any(event.get('job', {}).get('description') == 'A bounded detail result' for event in events))

    def test_blocked_empty_head_does_not_discard_backfill(self):
        result, events, requests, enrichment = self.collect(blocked=True)
        self.assertEqual(len(requests), 1)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['error_kind'], 'rate_limit')
        self.assertEqual(result['retry_after_seconds'], 1200)
        self.assertFalse(result['head_checked'])
        self.assertFalse(any(event['type'] == 'search_progress' for event in events))
        self.assertEqual(enrichment, [])


if __name__ == '__main__':
    unittest.main()
