import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import worker


class OutputHostTests(unittest.TestCase):
    def command(self, directory, ffmpeg=True):
        source = Path(worker.__file__).read_text()
        marker = 'BROKER = ' + repr(worker.BROKER)
        self.assertEqual(source.count(marker), 1)
        configured = source.replace(marker, "BROKER = 'https://api.worker.test/'")
        path = directory / 'worker.py'
        path.write_text(configured)
        models = directory / 'models'
        models.mkdir()
        command = [sys.executable, '-c',
                   'import runpy,sys; path=sys.argv[1]; sys.argv=sys.argv[1:]; runpy.run_path(path)["main"]()',
                   str(path), '--token-stdin', '--once', '--asr-model', str(models),
                   '--diarization-model', str(models), '--work-dir', str(directory / 'work')]
        if ffmpeg:
            command.extend(['--ffmpeg', sys.executable])
        return command

    def test_configured_host_reaches_the_credential_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run(self.command(Path(temporary)), input='', capture_output=True,
                                    text=True, timeout=5,
                                    env={**os.environ, 'BOARDWALK_OUTPUT_HOST': 'objects.worker.test'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('JSONDecodeError', result.stderr)
        self.assertNotIn('worker_output_unconfigured', result.stderr)

    def test_missing_host_refuses_without_reading_the_open_credential_pipe(self):
        with tempfile.TemporaryDirectory() as temporary:
            environment = {key: value for key, value in os.environ.items() if key != 'BOARDWALK_OUTPUT_HOST'}
            process = subprocess.Popen(self.command(Path(temporary)), stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
            try:
                # The writer stays open without a credential. A read would block.
                process.wait(timeout=5)
                stdout, stderr = process.communicate(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        self.assertNotEqual(process.returncode, 0)
        self.assertIn('worker_output_unconfigured', stderr)
        self.assertNotIn('JSONDecodeError', stderr)

    def test_transcription_startup_needs_no_output_host(self):
        with tempfile.TemporaryDirectory() as temporary:
            environment = {key: value for key, value in os.environ.items() if key != 'BOARDWALK_OUTPUT_HOST'}
            result = subprocess.run(self.command(Path(temporary), ffmpeg=False), input='',
                                    capture_output=True, text=True, timeout=5, env=environment)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('JSONDecodeError', result.stderr)
        self.assertNotIn('worker_output_unconfigured', result.stderr)

    def test_output_host_accepts_only_a_configured_hostname(self):
        self.assertEqual(worker.configured_output_host('objects.worker.test'), 'objects.worker.test')
        for value in ('', 'video-originals.example.org', 'objects.worker.test:443',
                      'https://objects.worker.test/', 'operator@objects.worker.test'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^worker_output_unconfigured$'):
                worker.configured_output_host(value)


if __name__ == '__main__':
    unittest.main()
