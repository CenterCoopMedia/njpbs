"""Audio receipts bind local recognition and alignment downloads to one version."""
import hashlib
import io
import unittest
import os
from unittest.mock import Mock, patch
from pathlib import Path
import tempfile

import worker
from test_worker import fixture, alignment_fixture, alignment_args



INPUT_HOST = "input.example.org"
_host_patch = patch.object(worker, "INPUT_HOST", INPUT_HOST)
_environment_patch = patch.dict(os.environ, {"BOARDWALK_INPUT_HOST": INPUT_HOST})


def setUpModule():
    _environment_patch.start()
    _host_patch.start()


def tearDownModule():
    _host_patch.stop()
    _environment_patch.stop()


def audio_input():
    preparation = 'a' * 64
    invocation = '00000000-0000-4000-8000-000000000001'
    return {'url': f'https://{worker.INPUT_HOST}/transcripts/inputs/audio/{preparation}'
                   f'/attempts/{invocation}/input.m4a?versionId=audio-v1',
            'versionId': 'audio-v1', 'sizeBytes': 5, 'mimeType': 'audio/x-m4a',
            'preparationId': preparation, 'invocationId': invocation,
            'sha256': hashlib.sha256(b'audio').hexdigest()}


class AudioInputTest(unittest.TestCase):
    def test_recognition_and_alignment_accept_the_same_audio_receipt(self):
        recognition = {**fixture(), 'input': audio_input()}
        alignment = {**alignment_fixture(), 'input': audio_input()}
        self.assertEqual(worker.validate_job(recognition), recognition)
        self.assertEqual(worker.validate_alignment_job(alignment, alignment_args()), alignment)

    def test_rejects_unbound_audio_paths_versions_and_checksums(self):
        for patch_value in [{'sha256': ''}, {'preparationId': 'b' * 64},
                            {'invocationId': 'invalid'}, {'versionId': 'wrong'},
                            {'mimeType': 'video/mp4'}]:
            with self.subTest(patch_value=patch_value):
                with self.assertRaisesRegex(ValueError, '^local_input_failed$'):
                    worker.validate_job({**fixture(), 'input': {**audio_input(), **patch_value}})

    def test_download_checks_exact_version_size_and_receipt_hash(self):
        for body, version, valid in [(b'audio', 'audio-v1', True),
                                     (b'other', 'audio-v1', False),
                                     (b'audio', 'other-version', False)]:
            response = io.BytesIO(body)
            response.headers = {'x-amz-version-id': version}
            opener = Mock()
            opener.open.return_value = response
            with tempfile.TemporaryDirectory() as directory, \
                    patch.object(worker.urllib.request, 'build_opener', return_value=opener):
                destination = Path(directory) / 'input.m4a'
                if valid:
                    worker.download({'input': audio_input()}, destination, Mock())
                    self.assertEqual(destination.read_bytes(), b'audio')
                else:
                    with self.assertRaisesRegex(ValueError, '^local_input_failed$'):
                        worker.download({'input': audio_input()}, destination, Mock())
