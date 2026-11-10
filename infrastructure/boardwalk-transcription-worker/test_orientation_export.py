import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
import worker

FFMPEG = shutil.which('ffmpeg')
FFPROBE = shutil.which('ffprobe')

_input_host_patch = patch.object(worker, 'INPUT_HOST', 'input.example.org')
_output_host_patch = patch.object(worker, 'OUTPUT_HOST', 'objects.example.test')


def setUpModule():
    _input_host_patch.start()
    _output_host_patch.start()


def tearDownModule():
    _output_host_patch.stop()
    _input_host_patch.stop()


def export_fixture(orientation='vertical'):
    width, height = worker.ORIENTATION_FRAMES[orientation]
    return {'kind': 'orientation', 'id': 'e' * 64, 'leaseToken': '12345678-1234-1234-1234-123456789abc',
            'engine': worker.ORIENTATION_ENGINE, 'orientation': orientation, 'width': width, 'height': height,
            'durationSeconds': 2, 'maxOutputBytes': 50_000_000,
            'input': {'url': 'https://' + worker.INPUT_HOST + '/outputs/job/preview.mp4?versionId=v1',
                      'versionId': 'v1', 'sizeBytes': 100}}


def upload_fixture():
    return {'url': 'https://' + worker.OUTPUT_HOST + '/objects/new-asset.mp4?X-Amz-Signature=x',
            'requiredHeaders': {'content-type': 'video/mp4', 'x-amz-checksum-sha256': 'abc=',
                                'x-amz-meta-boardwalk-session': 'e' * 64,
                                'x-amz-meta-boardwalk-asset': 'new-asset'}}


def probe(path):
    result = subprocess.run([FFPROBE, '-v', 'error', '-show_entries',
                             'stream=codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,channels',
                             '-of', 'json', str(path)], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)['streams']


@unittest.skipUnless(FFMPEG and FFPROBE, 'FFmpeg is not installed')
class RenderTests(unittest.TestCase):
    def render(self, source_size, orientation, audio=True):
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        source = directory / 'input.mp4'
        inputs = ['-f', 'lavfi', '-i', f'testsrc2=size={source_size}:rate=30:duration=2']
        if audio:
            inputs += ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2']
        subprocess.run([FFMPEG, '-v', 'error', *inputs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                        '-shortest', str(source)], check=True, stdin=subprocess.DEVNULL)
        output = directory / 'output.mp4'
        lease = Mock()
        worker.render_orientation(source, output, export_fixture(orientation), lease, FFMPEG)
        lease.check.assert_called()
        return probe(output)

    def test_landscape_source_becomes_vertical_1080p_with_one_audio_track(self):
        streams = self.render('1280x720', 'vertical')
        video = [stream for stream in streams if stream['codec_type'] == 'video']
        audio = [stream for stream in streams if stream['codec_type'] == 'audio']
        self.assertEqual([(s['codec_name'], s['width'], s['height'], s['pix_fmt'], s['sample_aspect_ratio'])
                          for s in video], [('h264', 1080, 1920, 'yuv420p', '1:1')])
        self.assertEqual([(s['codec_name'], s['channels']) for s in audio], [('aac', 2)])

    def test_portrait_source_becomes_horizontal_1080p(self):
        streams = self.render('720x1280', 'horizontal')
        self.assertEqual([(s['width'], s['height']) for s in streams if s['codec_type'] == 'video'], [(1920, 1080)])

    def test_silent_source_renders_without_an_audio_track(self):
        streams = self.render('640x480', 'vertical', audio=False)
        self.assertEqual([s['codec_type'] for s in streams], ['video'])

    def test_ffmpeg_failure_is_a_processing_failure(self):
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        (directory / 'input.mp4').write_bytes(b'not a video')
        with self.assertRaisesRegex(ValueError, '^export_processing_failed$'):
            worker.render_orientation(directory / 'input.mp4', directory / 'output.mp4',
                                      export_fixture(), Mock(), FFMPEG)


class ProtocolTests(unittest.TestCase):
    def args(self):
        return SimpleNamespace(work_dir=None, ffmpeg=Path('ffmpeg'), asr_model=None, diarization_model=None)

    def run_export(self, broker, upload=None):
        def render(source, destination, *_):
            Path(destination).write_bytes(b'rendered')
        with patch.object(worker, 'download'), patch.object(worker, 'render_orientation', side_effect=render), \
                patch.object(worker, 'upload_output', side_effect=upload) as uploaded:
            worker.run_job(broker, export_fixture(), self.args())
        return uploaded

    def calls(self, broker, action):
        return [call.args[1] for call in broker.call.call_args_list if call.args[0] == action]

    def test_upload_is_reserved_then_confirmed(self):
        broker = Mock()
        broker.call.side_effect = lambda action, body: (
            {'completed': False, 'upload': upload_fixture()} if action == 'Complete' and not body['uploaded'] else {})
        uploaded = self.run_export(broker)
        identity = {'kind': 'orientation', 'jobId': 'e' * 64, 'leaseToken': export_fixture()['leaseToken']}
        output = {'sizeBytes': 8, 'sha256': hashlib.sha256(b'rendered').hexdigest()}
        completes = self.calls(broker, 'Complete')
        self.assertEqual([body['uploaded'] for body in completes], [False, True])
        self.assertTrue(all(body['engine'] == worker.ORIENTATION_ENGINE and body['output'] == output and
                            {key: body[key] for key in identity} == identity for body in completes))
        uploaded.assert_called_once()
        self.assertEqual(self.calls(broker, 'Fail'), [])

    def test_full_viewing_copy_queue_waits_without_rendering_again(self):
        replies = iter([{'completed': False, 'retryAfterSeconds': 2},
                        {'completed': False, 'upload': upload_fixture()}, {}])
        broker = Mock()
        broker.call.side_effect = lambda action, body: next(replies) if action == 'Complete' else {}
        with patch.object(worker.time, 'sleep') as sleep:
            uploaded = self.run_export(broker)
        self.assertEqual([body['uploaded'] for body in self.calls(broker, 'Complete')], [False, False, True])
        self.assertEqual(sleep.call_count, 2)
        uploaded.assert_called_once()

    def test_upload_failure_releases_the_job(self):
        broker = Mock()
        broker.call.side_effect = lambda action, body: (
            {'completed': False, 'upload': upload_fixture()} if action == 'Complete' else {})
        self.run_export(broker, upload=ValueError('export_upload_failed'))
        self.assertEqual([body['uploaded'] for body in self.calls(broker, 'Complete')], [False])
        self.assertEqual([body['errorCode'] for body in self.calls(broker, 'Fail')], ['export_upload_failed'])

    def test_lost_confirmation_response_does_not_fail_a_possibly_saved_video(self):
        def call(action, body):
            if action == 'Complete' and body['uploaded']:
                raise RuntimeError('broker_unavailable')
            return {'completed': False, 'upload': upload_fixture()} if action == 'Complete' else {}
        broker = Mock()
        broker.call.side_effect = call
        self.run_export(broker)
        self.assertEqual(self.calls(broker, 'Fail'), [])

    def test_job_without_ffmpeg_is_refused(self):
        broker = Mock()
        worker.run_job(broker, export_fixture(), SimpleNamespace(work_dir=None, ffmpeg=None))
        self.assertEqual([body['errorCode'] for body in self.calls(broker, 'Fail')], ['export_processing_failed'])

    def test_claim_requests_exports_only_with_ffmpeg(self):
        for ffmpeg, body in ((Path('ffmpeg'), {'capabilities': ['orientation']}), (None, {})):
            broker = Mock()
            broker.call.return_value = {'job': None}
            worker.poll_jobs(broker, SimpleNamespace(ffmpeg=ffmpeg), once=True)
            broker.call.assert_called_once_with('Claim', body)

    def test_upload_target_must_be_the_originals_bucket(self):
        self.assertEqual(worker.validate_upload(upload_fixture(), 8)['Content-Length'], '8')
        for change in ({'url': 'https://example.com/objects/new-asset.mp4'},
                       {'url': 'http://' + worker.OUTPUT_HOST + '/objects/new-asset.mp4'},
                       {'requiredHeaders': {'content-type': 'video/mp4'}}):
            with self.assertRaisesRegex(ValueError, '^export_upload_failed$'):
                worker.validate_upload({**upload_fixture(), **change}, 8)

    def test_upload_stops_sending_after_its_deadline(self):
        # The broker settles a job two hours after it issues the upload, so the
        # body must stop before that or a late PUT could still store a file.
        self.assertLess(worker.UPLOAD_SEND_SECONDS + 120, 7200 - 600)
        lease = Mock()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'output.mp4'
            path.write_bytes(b'video')

            class Opener:
                def open(self, request, timeout):
                    request.data.read(1)

            with patch.object(worker.urllib.request, 'build_opener', return_value=Opener()):
                with self.assertRaisesRegex(ValueError, '^export_upload_failed$'):
                    worker.upload_output(path, upload_fixture(), lease, send_seconds=-1)


if __name__ == '__main__':
    unittest.main()
