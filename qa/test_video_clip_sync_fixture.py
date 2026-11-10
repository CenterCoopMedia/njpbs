"""Offline synthetic fixture tests; encoder checks require explicit opt-in."""
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import video_clip_sync_fixture as sync


class SyncFixtureTest(unittest.TestCase):
    def test_pulses_are_frame_and_sample_aligned(self):
        for second in sync.PULSES:
            self.assertEqual(second * sync.FPS, int(second * sync.FPS))
            self.assertEqual(second * sync.SAMPLE_RATE, int(second * sync.SAMPLE_RATE))
        self.assertEqual(sync.pulse_starts([0, 255, 255, 0, 0, 255], 180, 1 / 30), [0.033333, 0.166667])

    def test_fixed_commands_never_overwrite_or_use_network_inputs(self):
        for variant, dimensions in sync.VARIANTS.items():
            argv = sync.command(Path('/tmp/fixture.mp4'), variant)
            self.assertIn('-n', argv)
            self.assertNotIn('-y', argv)
            self.assertIn('-nostdin', argv)
            self.assertIn(f's={dimensions[0]}x{dimensions[1]}', ' '.join(argv))
            self.assertNotIn('http', ' '.join(argv))
            self.assertEqual(argv[-1], '/tmp/fixture.mp4')
            self.assertEqual('-an' in argv, variant == 'silent')
            self.assertEqual('aac' in argv, variant != 'silent')

    def test_unknown_variant_is_rejected(self):
        with self.assertRaises(ValueError):
            sync.command(Path('/tmp/x'), 'https://private.invalid')

    def test_output_must_be_new_and_existing_files_are_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            keep = root / 'keep.txt'; keep.write_text('keep')
            with patch.object(sync, 'run') as run:
                with self.assertRaises(FileExistsError):
                    sync.generate(root)
                run.assert_not_called()
            self.assertEqual(keep.read_text(), 'keep')

    def test_manifest_never_claims_boardwalk_or_human_verification(self):
        manifest = sync.manifest_template()
        self.assertEqual(manifest['humanSyncReview'], 'not_performed')
        self.assertEqual(manifest['boardwalkExport'], 'not_performed')
        self.assertEqual(manifest['pulseSeconds'], [2, 6, 10])
        self.assertEqual(manifest['reviewRanges'][0]['expectedPulseSeconds'], [0.6, 4.6, 8.6])
        self.assertEqual(manifest['reviewRanges'][1]['expectedPulseSeconds'], [0, 4])

    def test_a_frame_of_offset_is_bounded_but_large_offsets_fail(self):
        sync.assert_pulses([2, 6, 10], [2.02, 6.02, 10.02])
        for audio in ([2.2, 6.2, 10.2], [2, 6], [2, 6, 10, 11]):
            with self.assertRaises(ValueError):
                sync.assert_pulses([2, 6, 10], audio)

    def test_missing_or_misplaced_video_cues_fail(self):
        for video in ([], [2, 6], [2.1, 6, 10]):
            with self.assertRaises(ValueError):
                sync.assert_pulses(video, None)

    def test_encoder_errors_and_timeouts_do_not_echo_paths_or_stderr(self):
        import subprocess
        for failure in (subprocess.CalledProcessError(1, ['private'], stderr=b'private'),
                        subprocess.TimeoutExpired(['private'], 1), OSError('private')):
            with patch.object(sync.subprocess, 'run', side_effect=failure):
                with self.assertRaisesRegex(RuntimeError, '^Local media tool failed$'):
                    sync.run(['ffmpeg', 'private'])

    @unittest.skipUnless(os.environ.get('BOARDWALK_SYNC_INTEGRATION') == '1'
                         and shutil.which('ffmpeg') and shutil.which('ffprobe'),
                         'Set BOARDWALK_SYNC_INTEGRATION=1 with ffmpeg/ffprobe for local media checks')
    def test_real_encodes_decode_expected_dimensions_audio_and_pulses(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'new-fixtures'
            manifest = sync.generate(output)
            self.assertEqual(len(manifest['files']), 3)
            self.assertEqual(json.loads((output / 'manifest.json').read_text()), manifest)
            for item in manifest['files']:
                self.assertEqual(item['sha256'], sync.sha256(output / item['file']))
                self.assertEqual(item['verification']['videoPulseSeconds'], [2.0, 6.0, 10.0])
                self.assertEqual(item['verification']['frameCount'], 360)
                if item['variant'] == 'silent':
                    self.assertIsNone(item['verification']['audioPulseSeconds'])
                else:
                    self.assertEqual(len(item['verification']['audioPulseSeconds']), 3)
            # Prove the verifier detects a real encoded 120 ms audio delay.
            source = output / 'landscape.mp4'
            original_hash = sync.sha256(source)
            delayed = output / 'delayed-control.mp4'
            sync.run(['ffmpeg', '-nostdin', '-v', 'error', '-n',
                      '-protocol_whitelist', 'file,pipe', '-i', str(source),
                      '-c:v', 'copy', '-af', 'adelay=120:all=1', '-c:a', 'aac',
                      '-t', '12', str(delayed)])
            with self.assertRaisesRegex(ValueError, '^Synthetic audio pulse verification failed$'):
                sync.verify(delayed, 'landscape')
            self.assertEqual(sync.sha256(source), original_hash)


if __name__ == '__main__':
    unittest.main()
