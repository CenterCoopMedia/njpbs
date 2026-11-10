"""Exercise the real preview job matrix and transcript extractor with camera audio.

MediaConvert is a managed encoder: execute its generated dB matrix with FFmpeg
locally, without creating a production job. Service acceptance is a deploy canary.
"""
import array
import hashlib
import importlib.util
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from test_video_preview_worker import worker, job, probe, sdk, clip_job

spec = importlib.util.spec_from_file_location(
    "transcript_audio_worker", Path(__file__).resolve().parents[1] /
    "infrastructure/boardwalk-transcript-audio/worker.py")
transcript = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {**sdk, "botocore.exceptions": types.SimpleNamespace(ClientError=RuntimeError)}):
    spec.loader.exec_module(transcript)


class PreviewAudioTests(unittest.TestCase):
    def test_web_clips_keep_the_viewing_copy_loudness(self):
        settings = worker.encode_settings(clip_job(), "staging/source", probe())
        audio = settings["OutputGroups"][0]["Outputs"][0]["AudioDescriptions"][0]
        self.assertNotIn("AudioNormalizationSettings", audio)

    def test_every_track_and_channel_is_selected(self):
        for counts in ([1], [2], [4], [1, 1, 1, 1], [2, 2], [1, 2], [2, 1], [3], [6], [8]):
            with self.subTest(counts=counts):
                selectors, descriptions = worker.preview_audio([
                    {"TrackType": "audio", "AudioProperties": {"Channels": count}}
                    for count in counts])
                self.assertEqual(selectors["Audio"]["Tracks"], list(range(1, len(counts) + 1)))
                self.assertEqual(selectors["Audio"]["SelectorType"], "TRACK")
                description = descriptions[0]
                remix = description["RemixSettings"]
                self.assertEqual((remix["ChannelsIn"], remix["ChannelsOut"]), (sum(counts), 2))
                matrix = [channel["InputChannelsFineTune"] for channel in remix["ChannelMapping"]["OutputChannels"]]
                for index in range(sum(counts)):
                    self.assertTrue(any(row[index] > -60 for row in matrix))
                for row in matrix:
                    self.assertLessEqual(sum(10 ** (gain / 20) for gain in row if gain > -60), 1.001)
                self.assertEqual(description["AudioNormalizationSettings"]["AlgorithmControl"], "CORRECT_AUDIO")
                self.assertEqual(description["AudioNormalizationSettings"]["TargetLkfs"], -23)

    def test_mono_tracks_are_centered_without_swapping_adjacent_stereo(self):
        for counts, expected in (([1, 2], [[0, 1], [0, 2]]),
                                 ([2, 1], [[0, 2], [1, 2]]),
                                 ([1, 1, 1, 1], [[0, 1, 2, 3], [0, 1, 2, 3]]),
                                 ([6], [list(range(6)), list(range(6))])):
            with self.subTest(counts=counts):
                _, descriptions = worker.preview_audio([
                    {"TrackType": "audio", "AudioProperties": {"Channels": count}}
                    for count in counts])
                rows = descriptions[0]["RemixSettings"]["ChannelMapping"]["OutputChannels"]
                self.assertEqual([[i for i, gain in enumerate(row["InputChannelsFineTune"]) if gain > -60]
                                  for row in rows], expected)

    def test_missing_or_invalid_channel_metadata_fails_instead_of_dropping_tracks(self):
        for value in (None, 0, -1, True, "4", 65):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "source_audio_channels_unsupported"):
                worker.preview_audio([{"TrackType": "audio", "AudioProperties": {"Channels": value}}])
        self.assertEqual(worker.preview_audio([]), ({}, []))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires FFmpeg and ffprobe")
    def test_camera_signal_survives_preview_and_transcript(self):
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        def run(*args):
            return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20).stdout

        def amplitude(path, channel, frequency):
            samples = array.array("f", run(ffmpeg, "-v", "error", "-i", str(path), "-map", "0:a:0",
                "-af", f"pan=mono|c0=c{channel}", "-ar", "48000", "-f", "f32le", "-"))
            # Check both distinct source tones, rather than merely a nonempty AAC file.
            samples = samples[4800:48000]
            real = sum(value * math.cos(2 * math.pi * frequency * i / 48000) for i, value in enumerate(samples))
            imag = sum(value * math.sin(2 * math.pi * frequency * i / 48000) for i, value in enumerate(samples))
            return 2 * math.hypot(real, imag) / len(samples)

        for counts in ([1], [2], [4], [1, 1, 1, 1], [6]):
            with self.subTest(counts=counts), tempfile.TemporaryDirectory() as directory:
                source, preview, audio = [Path(directory) / name for name in ("camera.mov", "preview.mp4", "transcript.m4a")]
                tone1, tone2 = "0.3*sin(2*PI*440*t)", "0.3*sin(2*PI*880*t)"
                channels = ([tone1] if counts == [1] else [tone1, tone2] if counts == [2] else ["0", "0", tone1, tone2])
                if counts == [6]:
                    channels = ["0", "0", tone1, "0", tone2, "0"]
                args = [ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=s=160x90:r=25:d=2"]
                if len(counts) == 1:
                    args += ["-f", "lavfi", "-i", "aevalsrc=" + "|".join(channels) + ":s=48000:d=2"]
                else:
                    for expression in channels:
                        args += ["-f", "lavfi", "-i", f"aevalsrc={expression}:s=48000:d=2"]
                args += ["-map", "0:v"]
                for index in range(len(counts)):
                    args += ["-map", f"{index + 1}:a"]
                run(*args, "-c:v", "mpeg4", "-c:a", "pcm_s16le", str(source))
                original_digest = hashlib.sha256(source.read_bytes()).hexdigest()
                if len(counts) == 4:
                    # The old default selector is the silent first camera track.
                    old = Path(directory) / "old.m4a"
                    run(ffmpeg, "-v", "error", "-i", str(source), "-map", "0:a:0", "-c:a", "aac", str(old))
                    self.assertLess(amplitude(old, 0, 440), 0.00001)
                metadata = probe()
                metadata["Container"]["Tracks"] = metadata["Container"]["Tracks"][:1] + [
                    {"TrackType": "audio", "AudioProperties": {"Channels": count}} for count in counts]
                settings = worker.encode_settings(job(), "staging/source", metadata)
                selected = settings["Inputs"][0]["AudioSelectors"]["Audio"]["Tracks"]
                description = settings["OutputGroups"][0]["Outputs"][0]["AudioDescriptions"][0]
                remix = description["RemixSettings"]
                filters = []
                labels = "".join(f"[0:a:{track - 1}]" for track in selected)
                if len(selected) > 1:
                    filters.append(labels + f"amerge=inputs={len(selected)}[all]")
                    labels = "[all]"
                mapping = remix["ChannelMapping"]["OutputChannels"]
                rows = ["+".join(f"{10 ** (gain / 20):.9f}*c{i}" for i, gain in enumerate(row["InputChannelsFineTune"]) if gain > -60) for row in mapping]
                filters.append(labels + f"pan=stereo|c0={rows[0]}|c1={rows[1]},loudnorm=I=-23:TP=-2:LRA=7[mix]")
                run(ffmpeg, "-v", "error", "-i", str(source), "-filter_complex", ";".join(filters),
                    "-map", "0:v:0", "-map", "[mix]", "-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-ac", "2", str(preview))
                transcript._convert(preview, audio, ffmpeg, None)
                source_audio = transcript._probe_audio(preview, ffprobe, None, "audio_codec_unsupported")
                output_audio = transcript._probe_audio(audio, ffprobe, None, "audio_output_invalid")
                for path, data in ((preview, source_audio), (audio, output_audio)):
                    data["elementarySha256"] = transcript._elementary_sha256(path, ffmpeg, None, "audio_output_invalid")
                    self.assertEqual(data["channels"], 2)
                    self.assertGreater(amplitude(path, 0, 440), 0.01)
                    self.assertGreater(amplitude(path, 1, 440 if counts == [1] else 880), 0.01)
                    if counts == [6]:
                        self.assertGreater(amplitude(path, 1, 440), 0.01)
                transcript._validate_stream_copy(source_audio, output_audio)
                self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_digest)
