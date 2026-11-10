"""Private R2 is a transport for a canonical, checksum-bound M4A receipt."""
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import worker
from test_worker import fixture, alignment_fixture, alignment_args

HOST = 'a' * 32 + '.r2.cloudflarestorage.com'
BUCKET = 'njpbs-boardwalk-private-video'
GENERATION = '11111111-1111-4111-8111-111111111111'
BINDING = 'b' * 64


def private_input():
    key = f'private-audio/{BINDING}/{GENERATION}/input.m4a'
    return {'url': f'https://{HOST}/{BUCKET}/{key}?X-Amz-Algorithm=AWS4-HMAC-SHA256'
                   f'&X-Amz-Expires=300&X-Amz-Signature={"c" * 64}',
            'storage': 'private-r2', 'objectKey': key, 'bindingId': BINDING,
            'generation': GENERATION, 'preparationId': 'd' * 64,
            'invocationId': '22222222-2222-4222-8222-222222222222',
            'mimeType': 'audio/x-m4a', 'versionId': 'canonical-s3-audio-v1',
            'sizeBytes': 5, 'sha256': hashlib.sha256(b'audio').hexdigest()}


class PrivateR2InputTest(unittest.TestCase):
    def setUp(self):
        self.host = patch.object(worker, 'PRIVATE_R2_INPUT_HOST', HOST)
        self.bucket = patch.object(worker, 'PRIVATE_R2_INPUT_BUCKET', BUCKET)
        self.host.start()
        self.bucket.start()
        self.addCleanup(self.host.stop)
        self.addCleanup(self.bucket.stop)

    def test_recognition_and_alignment_accept_the_same_canonical_audio_binding(self):
        recognition = {**fixture(), 'input': private_input()}
        alignment = {**alignment_fixture(), 'input': private_input()}
        self.assertEqual(worker.validate_job(recognition), recognition)
        self.assertEqual(worker.validate_alignment_job(alignment, alignment_args()), alignment)

    def test_refuses_unconfigured_host_and_changed_host_path_binding_or_expiry(self):
        good = private_input()
        patches = [{'url': good['url'].replace(HOST, 'other.example')},
                   {'url': good['url'].replace(BUCKET, 'public-media')},
                   {'url': good['url'].replace('Expires=300', 'Expires=3600')},
                   {'url': good['url'].replace('X-Amz-Signature=', 'signature=')},
                   {'bindingId': 'e' * 64}, {'generation': 'invalid'},
                   {'objectKey': 'private-audio/other/input.m4a'}, {'mimeType': 'video/mp4'},
                   {'sha256': ''}]
        for values in patches:
            with self.subTest(values=list(values)):
                with self.assertRaisesRegex(ValueError, '^local_input_failed$'):
                    worker.validate_job({**fixture(), 'input': {**good, **values}})
        with patch.object(worker, 'PRIVATE_R2_INPUT_HOST', ''):
            with self.assertRaisesRegex(ValueError, '^local_input_failed$'):
                worker.validate_job({**fixture(), 'input': good})

    def test_download_checks_binding_and_body_hash_without_an_s3_version_header(self):
        for body, binding, valid in [(b'audio', BINDING, True), (b'other', BINDING, False),
                                     (b'audio', 'e' * 64, False)]:
            response = io.BytesIO(body)
            response.headers = {'x-amz-meta-binding': binding, 'x-amz-meta-generation': GENERATION}
            opener = Mock()
            opener.open.return_value = response
            with tempfile.TemporaryDirectory() as directory, \
                    patch.object(worker.urllib.request, 'build_opener', return_value=opener):
                destination = Path(directory) / 'input.m4a'
                if valid:
                    worker.download({'input': private_input()}, destination, Mock())
                    self.assertEqual(destination.read_bytes(), b'audio')
                else:
                    with self.assertRaisesRegex(ValueError, '^local_input_failed$'):
                        worker.download({'input': private_input()}, destination, Mock())


if __name__ == '__main__':
    unittest.main()
