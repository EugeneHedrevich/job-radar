"""Offline collector regression: standard library only, all upstream modules fake."""
import sys
import types
import unittest
import importlib.util
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
import collector
from transport import LinkedInTransport, RequestBudgetExhausted, SourceStopped, active_transport, use_transport


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
    def collect(self, blocked=False, source='linkedin', request_limit=3, head_only=None):
        events, requests, enrichment = [], [], []

        class Session:
            def request(self, method, url, **options):
                requests.append(url)
                limited = blocked is True or blocked == len(requests)
                return types.SimpleNamespace(status_code=429 if limited else 200,
                    headers={'Retry-After': '1200'} if limited else {}, url=url,
                    text='<title>Jobs</title>', raise_for_status=lambda: None)

        class LinkedIn:
            def _process_job(self, job):
                return job

        board = types.ModuleType(f'jobspy.{source}')
        board.LinkedIn = board.Indeed = LinkedIn
        board.create_session = lambda **options: Session()
        jobspy = types.ModuleType('jobspy')
        jobspy.__path__ = []

        def scrape_jobs(**kwargs):
            session, scraper, rows = board.create_session(), LinkedIn(), []
            # Pinned Indeed starts at the first server cursor, regardless of offset.
            start = kwargs.get('offset', 0) if source == 'linkedin' else 0
            for page in range(5 if source == 'indeed' else 3):
                offset = start + page * 10
                try:
                    session.request('GET', f'https://www.{source}.com/search?offset={offset}')
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
            return Frame(rows[:kwargs['results_wanted']] if source == 'indeed' else rows)

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
        modules = {'jobspy': jobspy, f'jobspy.{source}': board, 'pandas': pandas,
            'sap_sources': agencies, 'public_sources': public, 'details': details}
        with patch.dict(sys.modules, modules), patch.object(collector, 'emit', events.append), \
                patch.object(collector, 'network_config', lambda: (None, True)):
            result = collector.run_task({'task_id': 'backfill', 'source': source, 'search_term': 'SAP CAP',
                'offset': 20, 'results_wanted': 25, 'search_request_limit': request_limit, 'fetch_description': True,
                **({'head_only': head_only} if head_only is not None else {})}, 60)
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

    def test_indeed_walks_from_head_to_backfill_without_restarting_the_first_page(self):
        result, events, requests, enrichment = self.collect(source='indeed')
        self.assertEqual([url.rsplit('=', 1)[1] for url in requests], ['0', '10', '20'])
        self.assertTrue(result['head_checked'])
        self.assertTrue(any(event.get('job', {}).get('title') == 'Inserted at the head' for event in events))
        self.assertEqual([event['cursor'] for event in events if event['type'] == 'search_progress'][-1], {'offset': 30})
        self.assertEqual(enrichment, [])

    def test_reduced_allowance_checks_the_head_before_resuming_backfill(self):
        result, events, requests, _ = self.collect(request_limit=1)
        self.assertEqual(len(requests), 1)
        self.assertIn('offset=0', requests[0])
        self.assertTrue(result['head_checked'])
        self.assertFalse(any(event['type'] == 'search_progress' for event in events))
        result, events, requests, _ = self.collect(request_limit=1, head_only=False)
        self.assertIn('offset=20', requests[0])
        self.assertFalse(result['head_checked'])
        self.assertEqual([event['cursor'] for event in events if event['type'] == 'search_progress'][-1], {'offset': 30})

    def test_indeed_keeps_backfill_when_a_single_request_cannot_reach_it(self):
        result, events, requests, _ = self.collect(source='indeed', request_limit=1)
        self.assertEqual(len(requests), 1)
        self.assertTrue(result['head_checked'])
        self.assertEqual([event['cursor'] for event in events if event['type'] == 'search_progress'][-1], {'offset': 20})

    def test_indeed_keeps_verified_head_and_backfill_after_a_later_429(self):
        result, events, requests, _ = self.collect(source='indeed', blocked=2)
        self.assertEqual(len(requests), 2)
        self.assertEqual(result['error_kind'], 'rate_limit')
        self.assertTrue(result['head_checked'])
        self.assertEqual([event['cursor'] for event in events if event['type'] == 'search_progress'][-1], {'offset': 20})


class DetailRegression(unittest.TestCase):
    def test_successful_canonical_details_are_shared_across_tasks_but_refreshes_fetch_again(self):
        # Load the real enrichment loop with offline dependency stubs.
        markdown = types.ModuleType('markdownify')
        markdown.markdownify = lambda value: value
        agencies = types.ModuleType('sap_sources')
        for name in ('REQUEST_TIMEOUT_SECONDS', 'applicant_location', 'job_posting', 'page_soup', 'published_date'):
            setattr(agencies, name, None)
        spec = importlib.util.spec_from_file_location('details', Path(collector.__file__).with_name('details.py'))
        details = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'requests': types.ModuleType('requests'), 'markdownify': markdown, 'sap_sources': agencies}):
            spec.loader.exec_module(details)
        cache, fetched = {}, []
        def hydrate(source, row, _format):
            active_transport.get().before('detail')
            fetched.append(row['job_url'])
            return {**row, 'description': 'Saved description', 'activity_status': 'active'}
        kwargs = {'detail_cache': cache, 'hydrate_row': hydrate, 'detail_request_limit': 1}
        original = {'id': 'li-123456', 'job_url': 'https://www.linkedin.com/jobs/view/123456'}
        alias = {'id': 'regional-123456', 'job_url': 'https://pl.linkedin.com/jobs/view/sap-cap-123456?trk=search'}
        other = {'job_url': 'https://www.linkedin.com/jobs/view/654321'}
        first = LinkedInTransport()
        with use_transport(first):
            details.enrich_board('linkedin', [original], kwargs)
        second = LinkedInTransport()
        with use_transport(second):
            rows, failure = details.enrich_board('linkedin', [other, alias], kwargs)
            reused, _ = details.enrich_board('linkedin', [alias], {**kwargs, 'detail_request_limit': 0})
        self.assertIsNone(failure)
        self.assertEqual(second.detail_requests, 1)
        self.assertEqual(rows[-1]['id'], alias['id'])
        self.assertEqual(rows[-1]['job_url'], alias['job_url'])
        self.assertEqual(reused[0]['description'], 'Saved description')
        with use_transport(second):
            details.enrich_board('linkedin', [], {**kwargs, 'detail_jobs': [{**alias, 'description': 'Old', 'activity_refresh': True}]})
        self.assertEqual(len(fetched), 3)
        self.assertEqual(first.detail_requests + second.detail_requests, 3)
        def failed(source, row, _format):
            active_transport.get().before('detail')
            raise ValueError('Unrecognized detail page')
        failed_cache, failed_transport = {}, LinkedInTransport()
        with use_transport(failed_transport):
            _, failure = details.enrich_board('linkedin', [original], {**kwargs, 'detail_cache': failed_cache, 'hydrate_row': failed})
            self.assertIsInstance(failure, ValueError)
            details.enrich_board('linkedin', [alias], {**kwargs, 'detail_cache': failed_cache, 'hydrate_row': failed})
        self.assertEqual(failed_transport.detail_requests, 1)


if __name__ == '__main__':
    unittest.main()
