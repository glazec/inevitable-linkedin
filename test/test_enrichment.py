import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import csv
import sys
import hashlib
from unittest.mock import patch
from io import BytesIO

spec = importlib.util.spec_from_file_location('enrich', Path(__file__).parents[1] / 'scripts/enrich_connections.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class EnrichmentTests(unittest.TestCase):
    def setUp(self):
        self.row = {'name': 'Original', 'linkedin_url': 'https://www.linkedin.com/in/example', 'connection_date': '3 Jan 2020'}
        self.profile = {'profile_url': 'https://linkedin.com/in/example', 'full_name': 'Example',
                        'experiences': [
                            {'company': 'Prior', 'title': 'Intern', 'employment_type': 'Internship', 'starts_at': '2017-01-01', 'ends_at': '2017-06-01'},
                            {'company': 'Prior', 'title': 'Engineer', 'employment_type': 'Full-time', 'starts_at': '2019-08-01', 'ends_at': '2021-01-01'},
                            {'company': 'Current', 'title': 'Lead', 'employment_type': 'Full-time', 'starts_at': '2021-02-01'}],
                        'educations': [{'school': 'School A'}, {'school': 'School B'}],
                        'location': {'city': 'City', 'country': 'Country'}}

    def test_history_and_earliest_explicit_full_time_role(self):
        out = m.merge(self.row, self.profile, 'now')
        self.assertEqual(out['earliest_listed_full_time_start'], '2019-08')
        self.assertEqual(json.loads(out['past_companies']), ['Prior'])
        self.assertEqual(out['current_company'], 'Current')
        self.assertEqual(json.loads(out['titles']), ['Lead'])
        self.assertEqual(len(json.loads(out['education'])), 2)
        self.assertEqual(out['connection_date'], '3 Jan 2020')
        self.assertEqual(out['name'], 'Original')

    def test_missing_employment_type_does_not_invent_career_start(self):
        for job in self.profile['experiences']:
            job.pop('employment_type')
        self.assertEqual(m.merge(self.row, self.profile, 'now')['earliest_listed_full_time_start'], '')

    def test_invalid_dates_do_not_become_career_start(self):
        for job in self.profile['experiences']:
            job['starts_at'] = '2010-99-99'
        self.assertEqual(m.merge(self.row, self.profile, 'now')['earliest_listed_full_time_start'], '')

    def test_identity_mismatch_rejected(self):
        self.profile['profile_url'] = 'https://linkedin.com/in/other'
        with self.assertRaises(ValueError):
            m.merge(self.row, self.profile, 'now')

    def test_multiple_current_roles_and_existing_values(self):
        self.profile['experiences'].append({'company': 'BoardCo', 'title': 'Advisor'})
        out = m.merge({**self.row, 'current_company': 'Observed company'}, self.profile, 'now')
        self.assertEqual(out['current_company'], 'Observed company')
        self.assertEqual(json.loads(out['titles']), ['Lead', 'Advisor'])
        self.assertEqual(out['lima_company'], 'Current; BoardCo')

    def test_csv_roundtrip_lists_unicode_and_formulas(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'out.csv'
            m.write_csv(path, ['name', 'education'], [{'name': ' =1+1', 'education': '["北京", "A,B"]'}])
            with path.open(encoding='utf-8-sig', newline='') as f:
                row = next(csv.DictReader(f))
            self.assertEqual(row['name'], "' =1+1")
            self.assertEqual(json.loads(row['education']), ['北京', 'A,B'])

    def test_resume_polls_saved_job_without_resubmitting_and_keeps_all_rows(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            source, output, cache = root / 'input.csv', root / 'output.csv', root / 'cache'
            cache.mkdir()
            m.write_csv(source, list(self.row), [self.row, {**self.row, 'linkedin_url': 'https://linkedin.com/in/other'}])
            job = cache / (hashlib.sha256(b'example').hexdigest() + '.job.json')
            job.write_text(json.dumps({'batch_id': 123}))
            requests = []
            profile = self.profile
            class Opener:
                def open(self, req, timeout):
                    requests.append(req)
                    return BytesIO(json.dumps({'status': 'completed', 'items': [{'status': 'Completed', 'request': self_url, 'data': profile}]}).encode())
            self_url = self.row['linkedin_url']
            # Existing job consumes no new submission. A cached second profile keeps
            # this test entirely within the saved-result path.
            second = {**profile, 'profile_url': 'https://linkedin.com/in/other'}
            (cache / (hashlib.sha256(b'other').hexdigest() + '.json')).write_text(json.dumps({'response': second, 'checked_at': 'now'}))
            argv = ['enrich', str(source), str(output), '--run', '--cache', str(cache)]
            with patch.object(sys, 'argv', argv), patch.dict(m.os.environ, {'LIMA_API_KEY': 'test'}), patch.object(m, 'build_opener', return_value=Opener()), patch.object(m.time, 'sleep'):
                m.main()
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].get_method(), 'GET')
            self.assertIsNone(requests[0].get_header('Content-type'))
            with output.open(encoding='utf-8-sig', newline='') as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(r['enrichment_status'] == 'enriched_needs_review' for r in rows))


if __name__ == '__main__':
    unittest.main()
