"""Synthetic completion errors only; never contact the broker or load a model."""
import contextlib
import io
import json
import os
import unittest
from unittest.mock import Mock, patch
import urllib.error

import worker


INPUT_HOST = "input.example.org"
_broker_patch = patch.object(worker, "BROKER", "https://broker.fixture.test/")
_host_patch = patch.object(worker, "INPUT_HOST", INPUT_HOST)
_environment_patch = patch.dict(os.environ, {"BOARDWALK_INPUT_HOST": INPUT_HOST})


def setUpModule():
    _environment_patch.start()
    _broker_patch.start()
    _host_patch.start()


def tearDownModule():
    _host_patch.stop()
    _broker_patch.stop()
    _environment_patch.stop()


SECRET = 'private-title transcript https://private.invalid/?token=lease-secret'


class BoundedBody(io.BytesIO):
    def __init__(self, content):
        super().__init__(content)
        self.read_sizes = []

    def read(self, size=-1):
        self.read_sizes.append(size)
        if size < 0 or size > 4097:
            raise AssertionError('Unbounded completion-error read')
        return super().read(size)


def response_error(status, content):
    stream = BoundedBody(content)
    return urllib.error.HTTPError('https://private.invalid', status, SECRET,
                                 {'Secret': SECRET}, stream), stream


class CompletionDiagnosticsTest(unittest.TestCase):
    def rejected(self, content, status=400, body=None):
        if body is None:
            body = {'jobId': SECRET, 'leaseToken': SECRET, 'segments': [{'text': SECRET}]}
        error, stream = response_error(status, content)
        broker = worker.Broker('a' * 48)
        broker.http = Mock()
        broker.http.open.side_effect = error
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            with self.assertRaisesRegex(worker.CompletionRejected, '^local_processing_failed$'):
                broker.call('Complete', body)
        broker.http.open.assert_called_once()
        lines = output.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        diagnostic = json.loads(lines[0])
        self.assertEqual(set(diagnostic), {'event', 'category', 'httpStatus', 'requestBytes'})
        self.assertEqual(diagnostic['event'], 'local_transcript_completion_rejected')
        self.assertEqual(diagnostic['httpStatus'], status)
        self.assertEqual(diagnostic['requestBytes'], len(json.dumps(
            body, allow_nan=False, separators=(',', ':')).encode()))
        self.assertEqual(stream.read_sizes, [4097])
        self.assertTrue(stream.closed)
        for private in (SECRET, 'lease-secret', 'private.invalid', 'a' * 48, 'Secret'):
            self.assertNotIn(private, output.getvalue())
        return diagnostic

    def test_allowlisted_controlled_messages(self):
        messages = {
            'Worker request is invalid': 'worker_request_invalid',
            'Transcript result is invalid': 'transcript_result_invalid',
            'Transcript word timing is invalid': 'transcript_word_timing_invalid',
        }
        for message, category in messages.items():
            with self.subTest(message=message):
                result = self.rejected(json.dumps({'error': message}).encode())
                self.assertEqual(result['category'], category)

    def test_untrusted_malformed_and_oversized_bodies_are_generic(self):
        cases = [
            b'', b'not JSON', b'\xff\xfe', b'[]', b'null', b'42',
            json.dumps(SECRET).encode(),
            json.dumps({'error': SECRET}).encode(),
            b'{"error":{"message":"Transcript result is invalid"}}',
            b'{"error":["Transcript result is invalid"]}',
            b'{"error":true}',
            b'{"error":"Transcript result is invalid","extra":"private"}',
            b'{"error":"Transcript result is invalid","error":"Transcript result is invalid"}',
            b'{"error":"Transcript result is invalid "}',
            b'{"error":"Transcript result is invalid"} trailing',
            b'[' * 2048 + b']' * 2048,
            b'{"error":"Transcript result is invalid"}' + b' ' * 4097,
            b'x' * (1024 * 1024),
        ]
        for content in cases:
            with self.subTest(size=len(content), prefix=content[:15]):
                self.assertEqual(self.rejected(content)['category'], 'local_processing_failed')

    def test_exact_limit_is_allowed_but_one_more_byte_is_not(self):
        body = b'{"error":"Transcript result is invalid"}'
        exact = body + b' ' * (4096 - len(body))
        self.assertEqual(self.rejected(exact)['category'], 'transcript_result_invalid')
        self.assertEqual(self.rejected(exact + b' ')['category'], 'local_processing_failed')

    def test_413_retains_status_without_guessing_a_validation_rule(self):
        self.assertEqual(self.rejected(b'<html>too large</html>', 413)['category'],
                         'local_processing_failed')

    def test_request_count_uses_wire_encoding_not_character_count(self):
        self.rejected(b'{}', body={'segments': [{'text': 'Espa\u00f1a \U0001f3a5'}]})

    def test_failed_error_read_does_not_turn_known_rejection_into_uncertainty(self):
        for failure in (TimeoutError(SECRET), OSError(SECRET), ValueError(SECRET)):
            with self.subTest(failure=type(failure).__name__):
                error, stream = response_error(400, b'')
                error.read = Mock(side_effect=failure)
                broker = worker.Broker('a' * 48)
                broker.http = Mock()
                broker.http.open.side_effect = error
                output = io.StringIO()
                with contextlib.redirect_stderr(output):
                    with self.assertRaises(worker.CompletionRejected):
                        broker.call('Complete', {})
                self.assertEqual(json.loads(output.getvalue())['category'], 'local_processing_failed')
                self.assertNotIn(SECRET, output.getvalue())
                error.read.assert_called_once_with(4097)
                self.assertTrue(stream.closed)

    def test_failed_log_or_close_does_not_change_rejection(self):
        for target in ('print', 'close'):
            error, _ = response_error(400, b'{"error":"Transcript result is invalid"}')
            broker = worker.Broker('a' * 48)
            broker.http = Mock()
            broker.http.open.side_effect = error
            with patch('builtins.print') as printer:
                if target == 'print':
                    printer.side_effect = OSError(SECRET)
                else:
                    error.close = Mock(side_effect=OSError(SECRET))
                with self.assertRaises(worker.CompletionRejected):
                    broker.call('Complete', {})

    def test_other_statuses_and_actions_do_not_read_or_log_body(self):
        cases = [('Complete', status, worker.LeaseLost if status in (401, 403, 409) else RuntimeError)
                 for status in (401, 403, 409, 408, 429, 500, 503)]
        cases += [(action, status, RuntimeError)
                  for action in ('Claim', 'Heartbeat', 'Fail') for status in (400, 413)]
        for action, status, expected in cases:
            with self.subTest(action=action, status=status):
                error, stream = response_error(status, SECRET.encode())
                broker = worker.Broker('a' * 48)
                broker.http = Mock()
                broker.http.open.side_effect = error
                output = io.StringIO()
                with contextlib.redirect_stderr(output):
                    with self.assertRaises(expected):
                        broker.call(action, {})
                self.assertEqual(output.getvalue(), '')
                self.assertEqual(stream.read_sizes, [])
                stream.close()

    def test_local_serialization_rejection_has_no_http_receipt(self):
        broker = worker.Broker('a' * 48)
        broker.http = Mock()
        for body in ({'value': float('nan')}, {'value': object()}, {'value': 'x' * 100}):
            with patch.object(worker, 'MAX_RESULT', 50), patch('builtins.print') as printer:
                with self.assertRaises(worker.CompletionRejected):
                    broker.call('Complete', body)
                printer.assert_not_called()
        broker.http.open.assert_not_called()

    def test_lost_fail_response_reuses_rejection_without_second_inference(self):
        job = {'id': 'job', 'leaseToken': 'lease', 'engineRevision': worker.ENGINE,
               'languageCode': 'en-US', 'maxSpeakers': 2, 'durationSeconds': 20,
               'input': {'url': 'https://' + worker.INPUT_HOST + '/outputs/job/preview.mp4?versionId=v1',
                         'versionId': 'v1', 'sizeBytes': 100}}
        broker = worker.Broker('a' * 48)
        broker.http = Mock()
        error, _ = response_error(400, b'{"error":"Transcript word timing is invalid"}')
        broker.http.open.side_effect = error
        complete = broker.call
        actions = []
        def call(action, body):
            actions.append(action)
            if action == 'Complete':
                return complete(action, body)
            if action == 'Fail' and actions.count('Fail') == 1:
                raise TimeoutError()
            if action == 'Fail':
                self.assertEqual(body, {'jobId': 'job', 'leaseToken': 'lease',
                                        'errorCode': 'local_processing_failed'})
            return {}
        broker.call = call
        attempt = worker.resume_attempt(job)
        args = Mock(work_dir=None, asr_model=None, diarization_model=None)
        output = io.StringIO()
        with contextlib.redirect_stderr(output), contextlib.redirect_stdout(io.StringIO()), \
                patch.object(worker, 'download'), \
                patch.object(worker, 'transcribe_in_process', return_value=[]) as inference:
            with self.assertRaises(TimeoutError):
                worker.run_job(broker, job, args, deadline=attempt[1], attempt_state=attempt[2])
            recovered = worker.resume_attempt(job, attempt)
            worker.run_job(broker, job, args, deadline=recovered[1], attempt_state=recovered[2])
            inference.assert_called_once()
        self.assertEqual(actions, ['Heartbeat', 'Complete', 'Fail', 'Fail'])
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(json.loads(output.getvalue())['category'], 'transcript_word_timing_invalid')


if __name__ == '__main__':
    unittest.main()
