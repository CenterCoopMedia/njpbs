import importlib.util
import json
import multiprocessing
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch
import worker

BROKER_TEMPLATE = worker.BROKER



INPUT_HOST = "input.example.org"
_broker_patch = patch.object(worker, "BROKER", "https://broker.fixture.test/")
_host_patch = patch.object(worker, "INPUT_HOST", INPUT_HOST)
_environment_patch = patch.dict(os.environ, {"BOARDWALK_INPUT_HOST": INPUT_HOST})


def setUpModule():
    _environment_patch.start()
    _host_patch.start()
    _broker_patch.start()


def tearDownModule():
    _broker_patch.stop()
    _host_patch.stop()
    _environment_patch.stop()


def fixture():
    return {'id': 'job', 'leaseToken': 'lease', 'engineRevision': worker.ENGINE,
            'languageCode': 'en-US', 'maxSpeakers': 10, 'durationSeconds': 20,
            'input': {'url': 'https://' + worker.INPUT_HOST + '/outputs/job/preview.mp4?versionId=v1',
                      'versionId': 'v1', 'sizeBytes': 100}}


def alignment_fixture():
    return {'kind': 'alignment', 'id': 'a' * 64, 'leaseToken': '12345678-1234-1234-1234-123456789abc',
            'engine': {'adapterRevision': worker.ALIGNMENT_ADAPTER,
                       'modelRepository': worker.ALIGNMENT_REPOSITORY,
                       'modelRevision': worker.ALIGNMENT_REVISION, 'cacheSha256': 'c' * 64},
            'languageCode': 'es-US', 'durationSeconds': 20,
            'passages': [{'index': 3, 'text': 'Hola María 2026', 'startSeconds': 1,
                          'endSeconds': 8, 'overlappingSpeech': False}],
            'input': fixture()['input']}


def alignment_args(model='model'):
    return SimpleNamespace(alignment_model=Path(model) if model else None,
                           alignment_model_repository=worker.ALIGNMENT_REPOSITORY,
                           alignment_model_revision=worker.ALIGNMENT_REVISION,
                           alignment_cache_sha256='c' * 64,
                           work_dir=None, asr_model=None, diarization_model=None)


def final_stage_child(connection, *_):
    connection.send(('stage', 'finalizing'))
    connection.send(('result', [{'text': 'queued result'}]))
    connection.close()


def empty_child(connection, *_):
    connection.close()


def hung_child(connection, *_):
    connection.send(('stage', 'transcribing'))
    while True:
        time.sleep(1)


class RealChildContext:
    def __init__(self, target):
        self.context = multiprocessing.get_context('spawn')
        self.target = target
        self.child = None

    def Pipe(self, **kwargs):
        return self.context.Pipe(**kwargs)

    def Process(self, **kwargs):
        self.child = self.context.Process(target=self.target, args=kwargs['args'])
        return self.child


class ProtocolTest(unittest.TestCase):
    def test_exact_private_version(self):
        self.assertEqual(worker.validate_job(fixture()), fixture())

    def test_rejects_other_hosts_protocols_versions_and_unbounded_inputs(self):
        urls = ['http://' + worker.INPUT_HOST + '/outputs/x?versionId=v1',
                'https://evil.test/outputs/x?versionId=v1',
                'https://' + worker.INPUT_HOST + '.evil.test/outputs/x?versionId=v1',
                'https://user@' + worker.INPUT_HOST + '/outputs/x?versionId=v1',
                'https://' + worker.INPUT_HOST + '/outputs/x?versionId=v2',
                'https://' + worker.INPUT_HOST + '/outputs/x?versionId=v1&versionId=v2']
        for url in urls:
            with self.subTest(url=url):
                job = fixture()
                job['input']['url'] = url
                with self.assertRaises(ValueError):
                    worker.validate_job(job)
        for key, value in [('durationSeconds', float('nan')), ('durationSeconds', 7201),
                           ('maxSpeakers', 101), ('engineRevision', 'paid'), ('languageCode', 'xx')]:
            job = fixture()
            job[key] = value
            with self.assertRaises(ValueError):
                worker.validate_job(job)

    def test_alignment_job_pins_model_media_language_and_bounded_passages(self):
        job = alignment_fixture()
        self.assertEqual(worker.validate_alignment_job(job, alignment_args()), job)
        mutations = [
            lambda value: value['engine'].__setitem__('modelRevision', 'd' * 40),
            lambda value: value.__setitem__('languageCode', 'fr-FR'),
            lambda value: value['passages'][0].__setitem__('endSeconds', 19_000),
            lambda value: value['passages'][0].__setitem__('overlappingSpeech', True),
            lambda value: value['passages'][0].__setitem__('text', ''),
        ]
        for mutate in mutations:
            changed = alignment_fixture()
            mutate(changed)
            with self.assertRaises(ValueError):
                worker.validate_alignment_job(changed, alignment_args())

    def test_alignment_adapter_preserves_staff_tokens_and_rejects_uncertain_timing(self):
        passage = alignment_fixture()['passages'][0]
        item = lambda text, start, end: SimpleNamespace(text=text, start_time=start, end_time=end)
        result = worker.normalized_alignment_items(passage,
            [item('Hola', 0.1, 0.8), item('María', 1, 2), item('2026', 2.2, 3)],
            ['Hola', 'María', '2026'])
        self.assertEqual([word['text'] for word in result], ['Hola', 'María', '2026'])
        self.assertEqual(result[1]['startSeconds'], 2)
        self.assertTrue(all(word['aligned'] for word in result))
        for items, tokens in [
            ([item('Hola', 0.1, 0.1), item('María', 1, 2), item('2026', 2.2, 3)], ['Hola', 'María', '2026']),
            ([item('Hola', 0.1001, 0.1002), item('María', 1, 2), item('2026', 2.2, 3)], ['Hola', 'María', '2026']),
            ([item('Hola', 0.1, 0.8)], ['Hola']),
            ([item('Changed', 0.1, 0.8), item('María', 1, 2), item('2026', 2.2, 3)], ['Hola', 'María', '2026']),
        ]:
            unavailable = worker.normalized_alignment_items(passage, items, tokens)
            self.assertEqual([word['text'] for word in unavailable], ['Hola', 'María', '2026'])
            self.assertTrue(all(word['aligned'] is False for word in unavailable))

    @unittest.skipUnless(importlib.util.find_spec('faster_whisper'),
                         'Viewing-copy decode requires the worker runtime')
    def test_alignment_decoder_accepts_wav_and_h264_aac_viewing_copy(self):
        fixture_dir = Path(__file__).with_name('fixtures')
        script = """
import av, json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import worker
fixtures = Path(sys.argv[2])
with av.open(str(fixtures / 'alignment-english-h264-aac.mp4')) as container:
    codecs = [container.streams.audio[0].codec_context.name,
              container.streams.video[0].codec_context.name]
    source_audio = [container.streams.audio[0].codec_context.sample_rate,
                    container.streams.audio[0].codec_context.layout.name]
audio = [worker.decode_alignment_audio(fixtures / name) for name in
         ('alignment-english.wav', 'alignment-english-h264-aac.mp4')]
print(json.dumps({'codecs': codecs, 'sourceAudio': source_audio,
                  'dimensions': [item.ndim for item in audio],
                  'dtypes': [str(item.dtype) for item in audio],
                  'lengths': [len(item) for item in audio]}))
"""
        decoded = json.loads(subprocess.run(
            [sys.executable, '-c', script, str(Path(__file__).parent), str(fixture_dir)],
            check=True, capture_output=True, text=True).stdout)
        self.assertEqual(decoded['codecs'], ['aac', 'h264'])
        self.assertEqual(decoded['sourceAudio'], [48000, 'stereo'])
        self.assertEqual(decoded['dimensions'], [1, 1])
        self.assertEqual(decoded['dtypes'], ['float32', 'float32'])
        self.assertTrue(all(7.1 * 16000 < length < 7.3 * 16000 for length in decoded['lengths']))
        self.assertLess(abs(decoded['lengths'][0] - decoded['lengths'][1]), 1600)

    def test_alignment_adapter_handles_punctuation_repeats_and_numbers_without_rewriting(self):
        item = lambda text, start, end: SimpleNamespace(text=text, start_time=start, end_time=end)
        for text, model_tokens in [('José habló español.', ['José', 'habló', 'español']),
                                   ('go go go', ['go', 'go', 'go']),
                                   ('one 2 3.5', ['one', '2', '35'])]:
            passage = {'text': text, 'startSeconds': 2, 'endSeconds': 8}
            items = [item(token, index, index + .5) for index, token in enumerate(model_tokens)]
            words = worker.normalized_alignment_items(passage, items, model_tokens)
            self.assertEqual([word['text'] for word in words], text.split())
            self.assertTrue(all(word['aligned'] for word in words))

    def test_offline_cache_hash_binds_names_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config.json').write_text('{}', encoding='utf-8')
            first = worker.directory_sha256(root)
            (root / 'config.json').write_text('{"changed":true}', encoding='utf-8')
            self.assertNotEqual(worker.directory_sha256(root), first)
            (root / 'config.json').rename(root / 'renamed.json')
            self.assertNotEqual(worker.directory_sha256(root), first)

    def test_redirects_are_never_followed(self):
        with self.assertRaises(ValueError):
            worker.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test')

    def test_diarization_preserves_voice_changes_and_order(self):
        words = [{'start': 0, 'end': 1, 'text': 'Hello', 'confidence': 0.87}, {'start': 1, 'end': 2, 'text': 'there'},
                 {'start': 3, 'end': 4, 'text': 'Reply'}]
        segments = worker.assign_speakers(words, [(0, 2, 'A'), (3, 4, 'B')], 2)
        self.assertEqual([x['speaker'] for x in segments], ['spk_0', 'spk_1'])
        self.assertEqual(segments[0]['text'], 'Hello there')
        self.assertEqual(segments[0]['words'][0]['confidence'], 0.87)
        self.assertEqual(segments[1]['startSeconds'], 3)

    def test_zero_length_model_word_gets_bounded_interval(self):
        words = [{'start': 668.85, 'end': 668.85, 'text': 'Retained'}]
        result = worker.assign_speakers(
            words, [(668, 669, 'A')], 2, duration_seconds=3180.650666666667)
        self.assertEqual(result[0]['text'], 'Retained')
        self.assertEqual(result[0]['startSeconds'], 668.85)
        self.assertAlmostEqual(result[0]['endSeconds'], 668.86)
        self.assertAlmostEqual(result[0]['words'][0]['endSeconds'], 668.86)
        self.assertEqual(result[0]['speaker'], 'spk_0')

    def test_invalid_reversed_or_terminal_word_is_not_repaired(self):
        for word, duration in [
            ({'start': 2, 'end': 1, 'text': 'Reversed'}, 20),
            ({'start': 20, 'end': 20, 'text': 'Terminal'}, 20),
        ]:
            with self.subTest(word=word):
                with self.assertRaisesRegex(ValueError, '^local_processing_failed$'):
                    worker.assign_speakers([word], [], 2, duration_seconds=duration)

    def test_no_invented_speaker_when_diarization_missing(self):
        result = worker.assign_speakers([{'start': 0, 'end': 1, 'text': 'Hello'}], [], 2)
        self.assertEqual(result[0]['speaker'], 'unknown')
        self.assertTrue(result[0]['speakerUncertain'])
        self.assertEqual(worker.assign_speakers([], [], 2), [])

    def test_short_passages_retain_every_word_and_boundaries(self):
        words = [{'start': i, 'end': i + 0.8, 'text': 'word'} for i in range(90)]
        segments = worker.assign_speakers(words, [(0, 90, 'A')], 2)
        self.assertEqual(len(segments), 3)
        self.assertEqual(sum(len(segment['words']) for segment in segments), 90)
        self.assertTrue(all(s['endSeconds'] - s['startSeconds'] <= 30 for s in segments))

    def test_unknown_voice_is_not_inferred_from_distant_speech(self):
        result = worker.assign_speakers([{'start': 10, 'end': 11, 'text': 'unclear'}], [(0, 2, 'A')], 2)
        self.assertEqual(result[0]['speaker'], 'unknown')

    def test_overlap_preserved_separately_from_exclusive_voice(self):
        words = [{'start': 0, 'end': 1, 'text': 'First'}, {'start': 1, 'end': 2, 'text': 'Together'}]
        result = worker.assign_speakers(words, [(0, 2, 'A')], 2, [(0, 2, 'A'), (1, 2, 'B')])
        self.assertEqual([segment['overlappingSpeech'] for segment in result], [False, True])
        self.assertEqual([segment['speaker'] for segment in result], ['spk_0', 'spk_0'])
        self.assertEqual(worker.overlapping_windows([(0, 2, 'A'), (1, 3, 'A')]), [])

    def test_lost_lease_stops_before_checkpoint_request(self):
        class Broker:
            def call(self, *_):
                raise AssertionError('must not make request')
        lease = worker.Lease(Broker(), fixture())
        lease.lost.set()
        with self.assertRaises(worker.LeaseLost):
            lease.checkpoint('finalizing')

    def test_hung_model_lease_has_a_deadline(self):
        lease = worker.Lease(None, fixture())
        lease.deadline = 0
        with self.assertRaises(worker.JobTimedOut):
            lease.check()

    def test_lease_loss_terminates_only_owned_model_child_without_credentials(self):
        context = Mock()
        receive, send = Mock(), Mock()
        context.Pipe.return_value = (receive, send)
        child = context.Process.return_value
        child.is_alive.return_value = True
        lease = Mock()
        lease.check.side_effect = worker.LeaseLost()
        with patch.object(worker.multiprocessing, 'get_context', return_value=context):
            with self.assertRaises(worker.LeaseLost):
                worker.transcribe_in_process('input', fixture(), lease, 'asr', 'diarizer')
        child.terminate.assert_called_once()
        child.kill.assert_called_once()
        settings = context.Process.call_args.kwargs['args'][2]
        self.assertEqual(set(settings), {'languageCode', 'maxSpeakers', 'durationSeconds'})
        receive.close.assert_called_once()

    def test_real_child_result_survives_finalizing_heartbeat_after_exit(self):
        context = RealChildContext(final_stage_child)
        lease = Mock()
        def heartbeat(_stage):
            context.child.join(timeout=5)
            self.assertEqual(context.child.exitcode, 0)
        lease.checkpoint.side_effect = heartbeat
        with patch.object(worker.multiprocessing, 'get_context', return_value=context):
            result = worker.transcribe_in_process('input', fixture(), lease, 'asr', 'diarizer')
        self.assertEqual(result, [{'text': 'queued result'}])
        self.assertFalse(context.child.is_alive())

    def test_real_child_exit_without_result_is_a_controlled_failure(self):
        context = RealChildContext(empty_child)
        with patch.object(worker.multiprocessing, 'get_context', return_value=context):
            with self.assertRaisesRegex(ValueError, '^local_processing_failed$'):
                worker.transcribe_in_process('input', fixture(), Mock(), 'asr', 'diarizer')
        self.assertFalse(context.child.is_alive())

    def test_real_hung_child_is_reaped_and_owned_attempt_failed(self):
        context = RealChildContext(hung_child)
        broker = Mock()
        args = Mock(work_dir=None, asr_model=None, diarization_model=None)
        with patch.object(worker.multiprocessing, 'get_context', return_value=context), patch.object(worker, 'download'):
            worker.run_job(broker, fixture(), args, deadline=time.monotonic() + 0.5)
        self.assertFalse(context.child.is_alive())
        failures = [call for call in broker.call.call_args_list if call.args[0] == 'Fail']
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].args[1], {'jobId': 'job', 'leaseToken': 'lease', 'errorCode': 'local_processing_failed'})
        self.assertNotIn('Complete', [call.args[0] for call in broker.call.call_args_list])

    def test_heartbeat_timeout_stops_renewal_without_claiming_revocation(self):
        broker = Mock()
        lease = worker.Lease(broker, fixture(), deadline=0)
        lease.done.wait = Mock(return_value=False)
        lease.heartbeat()
        self.assertFalse(lease.lost.is_set())
        broker.call.assert_not_called()

    def test_recovered_timed_out_lease_does_not_restart_after_lost_fail_response(self):
        with patch.object(worker.time, 'monotonic', return_value=10):
            attempt = worker.resume_attempt(fixture())
        with patch.object(worker.time, 'monotonic', return_value=1000):
            self.assertEqual(worker.resume_attempt(fixture(), attempt), attempt)
            other = {**fixture(), 'leaseToken': 'new-lease'}
            self.assertGreater(worker.resume_attempt(other, attempt)[1], 1000)
        broker = Mock()
        broker.call.side_effect = [TimeoutError(), {}]
        args = Mock(work_dir=None, asr_model=None, diarization_model=None)
        with patch.object(worker, 'transcribe_in_process') as inference:
            with self.assertRaises(TimeoutError):
                worker.run_job(broker, fixture(), args, deadline=0)
            worker.run_job(broker, fixture(), args, deadline=0)
            inference.assert_not_called()
        self.assertEqual([call.args[0] for call in broker.call.call_args_list], ['Fail', 'Fail'])

    def test_actual_revocation_does_not_send_fail(self):
        broker = Mock()
        broker.call.side_effect = worker.LeaseLost()
        worker.run_job(broker, fixture(), Mock(work_dir=None, asr_model=None, diarization_model=None))
        self.assertEqual([call.args[0] for call in broker.call.call_args_list], ['Heartbeat'])

    def test_completion_http_rejection_is_distinct_from_ambiguous_or_revoked(self):
        broker = worker.Broker('a' * 48)
        broker.http = Mock()
        for status, expected in [(400, worker.CompletionRejected), (413, worker.CompletionRejected),
                                 (500, RuntimeError), (503, RuntimeError), (408, RuntimeError),
                                 (401, worker.LeaseLost), (403, worker.LeaseLost), (409, worker.LeaseLost)]:
            with self.subTest(status=status):
                broker.http.open.side_effect = worker.urllib.error.HTTPError('https://example.invalid', status, 'private', {}, None)
                with self.assertRaises(expected):
                    broker.call('Complete', {})

    def test_broker_uses_rate_limited_cms_edge(self):
        self.assertEqual(BROKER_TEMPLATE, 'https://api.example.org/')

    def test_broker_identifies_worker_at_cms_edge(self):
        broker = worker.Broker('a' * 48)
        response = MagicMock()
        response.read.return_value = b'{}'
        broker.http = Mock()
        broker.http.open.return_value = response
        response.__enter__.return_value = response
        broker.call('Claim', {})
        request = broker.http.open.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'), worker.USER_AGENT)

    def test_empty_claims_back_off_and_work_resets_the_delay(self):
        class StopAfterWaits:
            def __init__(self):
                self.delays = []

            def is_set(self):
                return len(self.delays) == 7

            def wait(self, delay):
                self.delays.append(delay)

        stop = StopAfterWaits()
        broker = Mock()
        broker.call.side_effect = [{}] * 6 + [{'job': fixture()}, {}]
        with patch.object(worker, 'run_job') as run_job:
            worker.poll_jobs(broker, Mock(), stop=stop)
        self.assertEqual(stop.delays, [30, 60, 60, 60, 60, 60, 30])
        run_job.assert_called_once()

    def test_invalid_completion_serialization_is_rejected_before_http(self):
        broker = worker.Broker('a' * 48)
        broker.http = Mock()
        for body in [{'value': float('nan')}, {'value': object()}, {'value': 'x' * 100}]:
            with patch.object(worker, 'MAX_RESULT', 50):
                with self.assertRaises(worker.CompletionRejected):
                    broker.call('Complete', body)
        broker.http.open.assert_not_called()

    def test_rejected_completion_retries_only_fail_after_lost_response(self):
        broker = Mock()
        calls = []
        def call(action, _body):
            calls.append(action)
            if action == 'Complete':
                raise worker.CompletionRejected('local_processing_failed')
            if action == 'Fail' and calls.count('Fail') == 1:
                raise TimeoutError()
            return {}
        broker.call.side_effect = call
        job = fixture()
        attempt = worker.resume_attempt(job)
        args = Mock(work_dir=None, asr_model=None, diarization_model=None)
        with patch.object(worker, 'download'), patch.object(worker, 'transcribe_in_process', return_value=[]) as inference:
            with self.assertRaises(TimeoutError):
                worker.run_job(broker, job, args, deadline=attempt[1], attempt_state=attempt[2])
            recovered = worker.resume_attempt(job, attempt)
            worker.run_job(broker, job, args, deadline=recovered[1], attempt_state=recovered[2])
            inference.assert_called_once()
        self.assertEqual(calls, ['Heartbeat', 'Complete', 'Fail', 'Fail'])
        self.assertEqual(worker.resume_attempt({**job, 'leaseToken': 'other'}, attempt)[2], {})

    def test_uncertain_or_revoked_completion_never_marks_job_failed(self):
        for error in (TimeoutError(), RuntimeError('broker_unavailable'), worker.LeaseLost()):
            with self.subTest(error=type(error).__name__):
                calls = []
                def call(action, _body):
                    calls.append(action)
                    if action == 'Complete':
                        raise error
                    return {}
                broker = Mock()
                broker.call.side_effect = call
                state = {}
                args = Mock(work_dir=None, asr_model=None, diarization_model=None)
                with patch.object(worker, 'download'), patch.object(worker, 'transcribe_in_process', return_value=[]):
                    worker.run_job(broker, fixture(), args, attempt_state=state)
                self.assertIn('Complete', calls)
                self.assertNotIn('Fail', calls)
                self.assertNotIn('failure', state)


class BrokerConfigurationTests(unittest.TestCase):
    def test_requires_a_resolved_origin_before_constructing_http_or_reading_a_token(self):
        for value in ['https://api.example.org/', 'http://broker.fixture.test/',
                      'https://user:canary@broker.fixture.test/', 'https://broker.fixture.test/path',
                      'https://broker.fixture.test/?query=1', 'https://broker.fixture.test:443/']:
            with self.subTest(origin=value), patch.object(worker, 'BROKER', value), patch.object(worker.urllib.request, 'build_opener') as opener:
                with self.assertRaises(ValueError):
                    worker.Broker('a' * 48)
                opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
