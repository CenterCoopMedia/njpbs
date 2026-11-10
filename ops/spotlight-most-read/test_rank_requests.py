import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('rank_requests', Path(__file__).with_name('rank_requests.py'))
rank_requests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rank_requests)


class RequestRankings(unittest.TestCase):
    def test_complete_day_excludes_bots_previews_and_failed_requests(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        start = end - timedelta(days=1)
        browser = 'Mozilla/5.0 Chrome/140.0 Safari/537.36'

        def line(stamp, path='/2026/10/example/', agent=browser, status=200, method='GET', client='192.0.2.1'):
            return (client + ' - - [' + stamp.strftime('%d/%b/%Y:%H:%M:%S +0000')
                    + '] "' + method + ' ' + path + ' HTTP/2.0" ' + str(status)
                    + ' 123 "-" "' + agent + '"\n').encode()

        records = [line(start - timedelta(seconds=1)), line(end)]
        records += [line(start + timedelta(seconds=i), '/2026/10/example/?utm_source=mail', client='192.0.2.' + str(i+1)) for i in range(3)]
        records += [line(start + timedelta(seconds=i)) for i in range(10)]
        records += [line(start, agent=browser + ' Googlebot'), line(start, status=404),
                    line(start, method='HEAD'), line(start, path='/2026/10/example/?preview=true'),
                    line(start, path='/wp-admin/'), line(start, agent='curl/8.0'),
                    line(start, path='/2026/10/other/', status=304)]
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            log.write_bytes(b''.join(records))
            report = rank_requests.rank(log, end)
        self.assertEqual(report['articles'], [{'path': '/2026/10/example/', 'requests': 3}])
        self.assertEqual(report['totals']['included_requests'], 4)
        self.assertEqual(report['totals']['excluded_repeat_requests'], 10)
        serialized = str(report)
        self.assertNotIn('192.0.2.1', serialized)
        self.assertNotIn('Mozilla', serialized)
        self.assertNotIn('utm_source', serialized)

    def test_incomplete_reporting_window_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            log.write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'complete reporting day'):
                rank_requests.rank(log, datetime.now(timezone.utc))

    def test_article_aliases_share_the_hourly_visit_limit(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        def line(stamp, client, path):
            return client + ' - - [' + stamp.strftime('%d/%b/%Y:%H:%M:%S +0000') + '] "GET ' + path + ' HTTP/2.0" 200 123 "-" "Mozilla/5.0 Chrome/140.0"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            records = [line(end-timedelta(days=1,seconds=1), '192.0.2.10', '/')]
            for client in ('192.0.2.1', '192.0.2.2', '192.0.2.3'):
                for path in ('/2026/10/example/', '/2026/10/EXAMPLE/', '/2026/10/%65xample/?utm_source=mail'):
                    records.append(line(end-timedelta(hours=1), client, path))
            records.append(line(end, '192.0.2.11', '/'))
            log.write_text(''.join(records))
            report = rank_requests.rank(log, end)
            self.assertEqual(report['articles'], [{'path': '/2026/10/example/', 'requests': 3}])
            self.assertEqual(report['totals']['excluded_repeat_requests'], 6)

    def test_only_local_article_paths_are_allowed(self):
        for path in (b'https://example.test/2026/10/article/', b'//example.test/2026/10/article/',
                     b'/2026/13/article/', b'/2026/10/article/?date_preview=1'):
            self.assertIsNone(rank_requests.article_path(path))
        self.assertEqual(rank_requests.article_path(b'/2017/11/archive/?a=b'), '/2017/11/archive/')

    def test_normalized_paths_fit_the_importer_segment_bound(self):
        prefix = b'/2026/10/'
        self.assertEqual(rank_requests.article_path(prefix + b'!' * 100 + b'/'),
                         '/2026/10/' + '%21' * 100 + '/')
        self.assertIsNone(rank_requests.article_path(prefix + b'!' * 101 + b'/'))
        self.assertIsNone(rank_requests.article_path(prefix + '%C3%A9'.encode() * 51 + b'/'))
        self.assertEqual(rank_requests.article_path(b'/2026/10/caf%c3%a9/'), '/2026/10/caf%C3%A9/')

    def test_rotated_log_supplies_missing_window_boundary(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        line = '192.0.2.1 - - [{date}] "-" 400 0 "-" "-"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            log.write_text(line.format(date=end.strftime('%d/%b/%Y:%H:%M:%S +0000')))
            with self.assertRaises(ValueError):
                rank_requests.rank(log, end)
            log.with_name('access.log.1').write_text(line.format(date=(end-timedelta(days=1)).strftime('%d/%b/%Y:%H:%M:%S +0000')))
            report = rank_requests.rank(log, end)
            self.assertTrue(report['complete'])
            self.assertEqual(report['articles'], [])

    def test_malformed_client_requests_do_not_disable_refresh(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        line = '192.0.2.1 - a [b [{date}] "garbage" 400 0 "-" "-"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            old = line.format(date=(end-timedelta(days=1)).strftime('%d/%b/%Y:%H:%M:%S +0000'))
            new = line.format(date=end.strftime('%d/%b/%Y:%H:%M:%S +0000'))
            log.write_text(old * 100 + new)
            report = rank_requests.rank(log, end)
            self.assertNotIn('unparsed', report['totals'])

    def test_invalid_client_address_is_counted_and_skipped(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        def line(stamp, client):
            return client + ' - - [' + stamp.strftime('%d/%b/%Y:%H:%M:%S +0000') + '] "GET /2026/10/article/ HTTP/2.0" 200 123 "-" "Mozilla/5.0 Chrome/140.0"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            log.write_text(line(end-timedelta(days=1,seconds=1), '192.0.2.10')
                           + line(end-timedelta(hours=2), 'not-an-address')
                           + ''.join(line(end-timedelta(hours=1), '192.0.2.'+str(i)) for i in range(1,4))
                           + line(end, '192.0.2.11'))
            report = rank_requests.rank(log, end)
            self.assertEqual(report['articles'], [{'path':'/2026/10/article/','requests':3}])
            self.assertEqual(report['totals']['invalid_clients'], 1)

    def test_truncated_current_log_cannot_claim_complete_with_previous_log(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        line = '192.0.2.1 - - [{date}] "-" 400 0 "-" "-"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            log.write_text(line.format(date=(end-timedelta(hours=12)).strftime('%d/%b/%Y:%H:%M:%S +0000')) * 3
                           + line.format(date=end.strftime('%d/%b/%Y:%H:%M:%S +0000')))
            log.with_name('access.log.1').write_text(line.format(date=(end-timedelta(days=1)).strftime('%d/%b/%Y:%H:%M:%S +0000')))
            with self.assertRaisesRegex(ValueError, 'Truncated log tail'):
                rank_requests.rank(log, end, max_bytes=len(line) + 80)

    def test_ios_webview_reader_is_included(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        browser = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
        def line(stamp, client):
            return client + ' - - [' + stamp.strftime('%d/%b/%Y:%H:%M:%S +0000') + '] "GET /2026/10/article/ HTTP/2.0" 200 123 "-" "' + browser + '"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            log.write_text(line(end-timedelta(days=1,seconds=1), '192.0.2.10')
                           + ''.join(line(end-timedelta(hours=1), '192.0.2.'+str(i)) for i in range(1,4))
                           + line(end, '192.0.2.11'))
            self.assertEqual(rank_requests.rank(log, end)['articles'], [{'path':'/2026/10/article/','requests':3}])

    def test_ipv6_addresses_share_a_prefix_visit_limit(self):
        end = datetime(2026, 10, 13, 12, tzinfo=timezone.utc)
        def line(stamp, client):
            return client + ' - - [' + stamp.strftime('%d/%b/%Y:%H:%M:%S +0000') + '] "GET /2026/10/article/ HTTP/2.0" 200 123 "-" "Mozilla/5.0 Chrome/140.0"\n'
        with tempfile.TemporaryDirectory() as temporary:
            log = Path(temporary) / 'access.log'
            clients = ['2001:db8:1:1::1', '2001:db8:1:1::2', '2001:db8:1:1::3',
                       '2001:db8:1:2::1', '2001:db8:1:3::1']
            log.write_text(line(end-timedelta(days=1,seconds=1), '192.0.2.10')
                           + ''.join(line(end-timedelta(hours=1), client) for client in clients)
                           + line(end, '192.0.2.11'))
            report = rank_requests.rank(log, end)
            self.assertEqual(report['articles'], [{'path':'/2026/10/article/','requests':3}])
            self.assertEqual(report['totals']['excluded_repeat_requests'], 2)


if __name__ == '__main__':
    unittest.main()
