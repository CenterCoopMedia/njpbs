import hashlib
import importlib.util
import json
import io
from pathlib import Path
import unittest
import sys
import types
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location("preview_worker", Path(__file__).resolve().parents[1] / "infrastructure/boardwalk-video-previews/worker.py")
worker = importlib.util.module_from_spec(spec)
sdk = {"boto3": types.SimpleNamespace(client=MagicMock()),
       "botocore": types.ModuleType("botocore"),
       "botocore.config": types.SimpleNamespace(Config=MagicMock())}
with patch.dict(sys.modules, sdk), patch.dict("os.environ", {"RENDITION_BUCKET": "renditions", "ORIGINAL_BUCKET": "originals", "ACCOUNT_ID": "123456789012"}):
    spec.loader.exec_module(worker)


def job():
    value = {"sourceId": "video-library", "assetId": "asset", "sourceObjectKey": "objects/asset.mxf",
             "sourceObjectVersionId": "original-v1", "sourceSizeBytes": 1200, "attemptId": "attempt-1"}
    identity = [value["sourceId"], value["assetId"], value["sourceObjectKey"], value["sourceObjectVersionId"], value["sourceSizeBytes"], 1]
    value["id"] = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
    return value


def probe(width=1920, height=1080, audio=True, scan="progressive"):
    tracks = [{"TrackType": "video", "VideoProperties": {"Width": width, "Height": height,
               "FrameRate": {"Numerator": 25, "Denominator": 1}, "CodecMetadata": {"ScanType": scan}}}]
    if audio:
        tracks.append({"TrackType": "audio", "AudioProperties": {"Channels": 2}})
    return {"Container": {"Duration": 3600, "Tracks": tracks}}


def clip_job():
    value = job()
    value.update(kind="clip", inputObjectKey="outputs/" + "a" * 64 + "/attempt-1/preview.mp4",
                 inputObjectVersionId="web-v1", inputSizeBytes=600, inMs=1000, outMs=5000)
    fields = ["sourceId", "assetId", "sourceObjectKey", "sourceObjectVersionId", "sourceSizeBytes",
              "inputObjectKey", "inputObjectVersionId", "inputSizeBytes", "inMs", "outMs"]
    value["id"] = hashlib.sha256(json.dumps([value[key] for key in fields] + ["clip-v1"], separators=(",", ":")).encode()).hexdigest()
    return value


def clip_probe(numerator=25, denominator=1, duration=10):
    value = probe(1080, 1920, audio=False)
    value["Container"]["Duration"] = duration
    value["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"] = {"Numerator": numerator, "Denominator": denominator}
    return value


def editor_job(output_format="broadcast_mxf", scope="clip", frame_rate_mode=None):
    value = clip_job()
    value.update(scope=scope, format=output_format)
    if scope == "source":
        for field in ("inputObjectKey", "inputObjectVersionId", "inputSizeBytes"):
            value.pop(field)
        value.update(inMs=0, outMs=4 * 60 * 60 * 1000)
        identity = [value["sourceId"], value["assetId"], value["sourceObjectKey"],
                    value["sourceObjectVersionId"], value["sourceSizeBytes"],
                    "source-export-v1", output_format]
    else:
        fields = ["sourceId", "assetId", "sourceObjectKey", "sourceObjectVersionId", "sourceSizeBytes",
                  "inputObjectKey", "inputObjectVersionId", "inputSizeBytes", "inMs", "outMs"]
        identity = [value[field] for field in fields] + ["clip-v3", output_format]
    if frame_rate_mode is not None:
        value["frameRateMode"] = frame_rate_mode
        identity.extend(["frame-rate-v1", frame_rate_mode])
    value["id"] = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
    return value


def editor_probe(duration=10, numerator=30000, denominator=1001, scan="interlaced", channels=(2,),
                 container_format=None, video_codec=None, width=1920, height=1080,
                 audio_codec="PCM", audio_bit_depth=24):
    tracks = [{"TrackType": "video", "Codec": video_codec, "VideoProperties": {
        "Width": width, "Height": height, "FrameRate": {"Numerator": numerator, "Denominator": denominator},
        "CodecMetadata": {"ScanType": scan}}}]
    tracks.extend({"TrackType": "audio", "Codec": audio_codec, "AudioProperties": {
        "Channels": count, "SampleRate": 48000, "BitDepth": audio_bit_depth}} for count in channels)
    return {"Container": {"Format": container_format, "Duration": duration, "Tracks": tracks}}


class WorkerTests(unittest.TestCase):
    def original_receipt(self):
        directory = Path(__file__).resolve().parents[1] / "infrastructure/boardwalk-original-clips"
        value = json.loads((directory / "fixture-job.json").read_text())
        result = json.loads((directory / "fixture-receipt.json").read_text())
        return value, result

    def serve_receipt(self, result, output_head=None):
        raw = json.dumps(result).encode()
        worker.s3 = MagicMock()
        worker.s3.head_object.side_effect = [{"VersionId": "receipt-v1", "ContentLength": len(raw)}, output_head]
        worker.s3.get_object.return_value = {"VersionId": "receipt-v1", "Body": io.BytesIO(raw)}

    def test_original_receipt_binds_the_verified_media_version_and_checksum(self):
        value, result = self.original_receipt()
        output = result["original"]
        head = {"VersionId": output["objectVersionId"], "ContentLength": output["sizeBytes"], "Metadata": {"sha256": output["sha256"]}}
        self.serve_receipt(result, head)
        self.assertEqual(worker.verify_original(value), result)
        self.serve_receipt(result, {**head, "VersionId": "replaced"})
        with self.assertRaisesRegex(ValueError, "original_output_changed"):
            worker.verify_original(value)

    def test_original_receipt_is_bounded_and_failure_is_bound_to_attempt(self):
        value, _ = self.original_receipt()
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "receipt-v1", "ContentLength": 65537}
        with self.assertRaisesRegex(ValueError, "original_receipt_invalid"):
            worker.verify_original(value)
        failure = {"id": value["id"], "attemptId": value["attemptId"], "errorCode": "original_media_unsupported"}
        self.serve_receipt(failure)
        with self.assertRaisesRegex(ValueError, "original_media_unsupported"):
            worker.verify_original(value)
        self.serve_receipt({**failure, "attemptId": "other-attempt"})
        with self.assertRaisesRegex(ValueError, "original_receipt_invalid"):
            worker.verify_original(value)

    def test_identity_rejects_changed_version(self):
        value = job()
        self.assertEqual(worker.validate_job(value), value)
        value["sourceObjectVersionId"] = "other"
        with self.assertRaisesRegex(ValueError, "identity_invalid"):
            worker.validate_job(value)

    def test_archive_is_rejected(self):
        value = job()
        value["sourceId"] = "archive-originals"
        with self.assertRaisesRegex(ValueError, "source_not_allowed"):
            worker.validate_job(value)

    def test_prepare_reads_exact_version(self):
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "original-v1", "ContentLength": 1200}
        result = worker.prepare(job())
        self.assertEqual(worker.s3.head_object.call_args.kwargs["VersionId"], "original-v1")
        self.assertIn("versionId=original-v1", result["copySource"])
        self.assertEqual(result["parts"], [{"number": 1, "range": "bytes=0-1199"}])

    def test_prepare_rejects_wrong_length(self):
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "original-v1", "ContentLength": 1201}
        with self.assertRaisesRegex(ValueError, "original_changed"):
            worker.prepare(job())

    def test_progressive_video_avoids_unneeded_deinterlace(self):
        settings = worker.encode_settings(job(), "staging/source", probe())
        web = settings["OutputGroups"][0]["Outputs"][0]
        self.assertNotIn("VideoPreprocessors", web["VideoDescription"])
        self.assertEqual(web["VideoDescription"]["ScalingBehavior"], "FIT_NO_UPSCALE")
        self.assertEqual(web["ContainerSettings"]["Mp4Settings"]["MoovPlacement"], "PROGRESSIVE_DOWNLOAD")
        self.assertIn("AudioDescriptions", web)

    def test_portrait_without_audio(self):
        settings = worker.encode_settings(job(), "staging/source", probe(1080, 1920, audio=False))
        web = settings["OutputGroups"][0]["Outputs"][0]
        self.assertEqual(web["VideoDescription"]["Width"], 1080)
        self.assertEqual(web["VideoDescription"]["Height"], 1920)
        self.assertNotIn("AudioDescriptions", web)
        self.assertNotIn("AudioSelectors", settings["Inputs"][0])

    def test_interlaced_video_gets_deinterlacing(self):
        settings = worker.encode_settings(job(), "staging/source", probe(scan="interlaced"))
        self.assertIn("Deinterlacer", settings["OutputGroups"][0]["Outputs"][0]["VideoDescription"]["VideoPreprocessors"])

    def test_invalid_input_is_not_given_a_fake_preview(self):
        with self.assertRaisesRegex(ValueError, "video_track_missing"):
            worker.encode_settings(job(), "staging/source", {"Container": {"Tracks": []}})

    def test_full_preview_rejects_invalid_probe_metadata(self):
        for duration in (None, 0, float("inf")):
            sample = probe()
            sample["Container"]["Duration"] = duration
            with self.subTest(duration=duration), self.assertRaisesRegex(ValueError, "source_duration_invalid"):
                worker.encode_settings(job(), "staging/source", sample)

        sample = probe()
        sample["Container"]["Duration"] = 4 * 60 * 60
        worker.encode_settings(job(), "staging/source", sample)

        sample = probe()
        sample["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"] = {"Numerator": 120, "Denominator": 1}
        with self.assertRaisesRegex(ValueError, "source_frame_rate_unsupported"):
            worker.encode_settings(job(), "staging/source", sample)

    def test_mxf_preview_uses_video_track_duration_when_container_omits_it(self):
        sample = probe()
        sample["Container"]["Tracks"][0]["Duration"] = sample["Container"].pop("Duration")
        settings = worker.encode_settings(job(), "staging/source", sample)
        self.assertEqual(settings["Inputs"][0]["FileInput"], "s3://renditions/staging/source")

    def test_outputs_need_actual_versions(self):
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"ContentLength": 10}
        with self.assertRaisesRegex(ValueError, "output_missing"):
            worker.verify(job())

    def test_preview_receipt_measures_source_rate_from_staged_original(self):
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 100}
        encoded = probe()
        source = probe()
        source["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"] = {
            "Numerator": 24000, "Denominator": 1001,
        }
        worker.media = MagicMock()
        worker.media.probe.side_effect = [{"ProbeResults": [encoded]}, {"ProbeResults": [source]}]
        result = worker.verify(job())["web"]
        self.assertEqual(result["sourceFrameRateNumerator"], 24000)
        self.assertEqual(result["sourceFrameRateDenominator"], 1001)
        self.assertEqual(worker.media.probe.call_args_list[1].kwargs["InputFiles"], [{
            "FileUrl": f's3://renditions/staging/{job()["id"]}/attempt-1/source',
        }])

    def test_preview_receipt_records_web_copy_rate_apart_from_variable_rate_source(self):
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 100}
        # A phone file reports 29.97 fps; its web copy came out at 25 fps.
        encoded = probe()
        source = probe()
        source["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"] = {"Numerator": 30000, "Denominator": 1001}
        worker.media = MagicMock()
        worker.media.probe.side_effect = [{"ProbeResults": [encoded]}, {"ProbeResults": [source]}]
        result = worker.verify(job())["web"]
        self.assertEqual((result["sourceFrameRateNumerator"], result["sourceFrameRateDenominator"]), (30000, 1001))
        self.assertEqual((result["frameRateNumerator"], result["frameRateDenominator"]), (25, 1))

        del encoded["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"]
        worker.media.probe.side_effect = [{"ProbeResults": [encoded]}, {"ProbeResults": [source]}]
        result = worker.verify(job())["web"]
        self.assertNotIn("frameRateNumerator", result)
        self.assertEqual(result["sourceFrameRateNumerator"], 30000)

    def test_frame_rate_mode_suffix_is_bound_when_present_on_a_preview_job(self):
        value = job()
        value["frameRateMode"] = "broadcast"
        identity = [value[key] for key in ("sourceId", "assetId", "sourceObjectKey",
                                            "sourceObjectVersionId", "sourceSizeBytes")]
        identity.extend([1, "frame-rate-v1", "broadcast"])
        value["id"] = hashlib.sha256(
            json.dumps(identity, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(worker.validate_job(value), value)


class ClipWorkerTests(unittest.TestCase):
    def test_settings_identity_retains_legacy_and_binds_quality(self):
        value = clip_job()
        value.update(resolution="source", quality="balanced")
        self.assertEqual(worker.validate_job(value), value)
        value["quality"] = "high"
        with self.assertRaisesRegex(ValueError, "identity_invalid"):
            worker.validate_job(value)
        fields = ["sourceId", "assetId", "sourceObjectKey", "sourceObjectVersionId", "sourceSizeBytes",
                  "inputObjectKey", "inputObjectVersionId", "inputSizeBytes", "inMs", "outMs"]
        value["id"] = hashlib.sha256(json.dumps([value[key] for key in fields] +
                                              ["clip-v2", "source", "high"], separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(worker.validate_job(value), value)
        value["resolution"] = "4k"
        with self.assertRaisesRegex(ValueError, "clip_settings_invalid"):
            worker.validate_job(value)

    def test_resolution_quality_matrix_preserves_portrait_silence(self):
        for resolution, width, height, expected in [("1080p", 1080, 1920, [2500000, 5000000, 8000000]),
                                                   ("720p", 720, 1280, [1500000, 3000000, 5000000]),
                                                   ("480p", 480, 854, [800000, 1500000, 2500000])]:
            for quality, level, bitrate in zip(["smaller", "balanced", "high"], [6, 7, 9], expected):
                value = {**clip_job(), "resolution": resolution, "quality": quality}
                settings = worker.encode_settings(value, "staging/source", clip_probe())
                web = settings["OutputGroups"][0]["Outputs"][0]
                video = web["VideoDescription"]
                self.assertEqual((video["Width"], video["Height"]), (width, height))
                self.assertEqual(video["ScalingBehavior"], "FIT_NO_UPSCALE")
                self.assertEqual(video["CodecSettings"]["H264Settings"]["MaxBitrate"], bitrate)
                self.assertEqual(video["CodecSettings"]["H264Settings"]["QvbrSettings"]["QvbrQualityLevel"], level)
                self.assertNotIn("AudioDescriptions", web)

    def test_explicit_upscale_rejected_but_source_default_unchanged(self):
        sample = clip_probe()
        sample["Container"]["Tracks"][0]["VideoProperties"].update(Width=854, Height=480)
        with self.assertRaisesRegex(ValueError, "clip_resolution_upscale"):
            worker.encode_settings({**clip_job(), "resolution": "720p"}, "staging/source", sample)
        video = worker.encode_settings(clip_job(), "staging/source", sample)["OutputGroups"][0]["Outputs"][0]["VideoDescription"]
        self.assertEqual((video["Width"], video["Height"]), (1920, 1080))
        self.assertEqual(video["CodecSettings"]["H264Settings"]["MaxBitrate"], 5000000)
        # Full source preview encoding is unchanged even when clip-only settings are present.
        source = {**job(), "resolution": "480p", "quality": "smaller"}
        video = worker.encode_settings(source, "staging/source", probe())["OutputGroups"][0]["Outputs"][0]["VideoDescription"]
        self.assertEqual((video["Width"], video["Height"]), (1920, 1080))
        self.assertEqual(video["CodecSettings"]["H264Settings"]["MaxBitrate"], 5000000)

    def test_clip_identity_binds_viewing_copy_version(self):
        value = clip_job()
        self.assertEqual(worker.validate_job(value), value)
        value["inputObjectVersionId"] = "other"
        with self.assertRaisesRegex(ValueError, "identity_invalid"):
            worker.validate_job(value)

    def test_prepare_checks_original_and_copies_exact_web_version(self):
        worker.s3 = MagicMock()
        worker.s3.head_object.side_effect = [{"VersionId": "original-v1", "ContentLength": 1200},
                                           {"VersionId": "web-v1", "ContentLength": 600}]
        result = worker.prepare(clip_job())
        self.assertEqual(worker.s3.head_object.call_args_list[0].kwargs["Bucket"], "originals")
        self.assertEqual(worker.s3.head_object.call_args_list[1].kwargs["VersionId"], "web-v1")
        self.assertEqual(result["sourceVersion"], "web-v1")
        self.assertIn("versionId=web-v1", result["copySource"])
        self.assertEqual(result["parts"], [{"number": 1, "range": "bytes=0-599"}])

    def test_exclusive_end_maps_to_last_included_frame(self):
        self.assertEqual(worker.clip_timecodes(clip_job(), clip_probe()),
                         {"StartTimecode": "00:00:01:00", "EndTimecode": "00:00:04:24"})

    def test_fractional_frame_rate_rounds_outward(self):
        self.assertEqual(worker.clip_timecodes(clip_job(), clip_probe(30000, 1001)),
                         {"StartTimecode": "00:00:00:29", "EndTimecode": "00:00:04:29"})

    def test_verify_accepts_low_rate_frame_rounding_and_bounds_mismatch(self):
        value = clip_job()
        value.update(inMs=0, outMs=250)
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 100}
        worker.media = MagicMock()
        worker.media.probe.return_value = {"ProbeResults": [clip_probe(1, duration=1)]}
        result = worker.verify(value)
        self.assertEqual(result["web"]["durationSeconds"], 1)
        self.assertEqual(result["web"]["frameDurationSeconds"], 1)
        worker.media.probe.return_value = {"ProbeResults": [clip_probe(1, duration=4)]}
        with self.assertRaisesRegex(ValueError, "clip_output_duration_invalid"):
            worker.verify(value)

    def test_high_frame_rate_rejected_before_conversion_settings(self):
        with self.assertRaisesRegex(ValueError, "clip_frame_rate_unsupported"):
            worker.encode_settings(clip_job(), "staging/source", clip_probe(120))

    def test_end_of_file_does_not_request_a_frame_after_end(self):
        self.assertEqual(worker.clip_timecodes(clip_job(), clip_probe(duration=5)),
                         {"StartTimecode": "00:00:01:00"})

    def test_range_beyond_file_and_missing_frame_rate_fail(self):
        with self.assertRaisesRegex(ValueError, "clip_range_outside_input"):
            worker.clip_timecodes(clip_job(), clip_probe(duration=3.9))
        sample = probe()
        del sample["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"]
        with self.assertRaisesRegex(ValueError, "clip_frame_rate_missing"):
            worker.clip_timecodes(clip_job(), sample)

    def test_clip_has_only_web_output_and_preserves_silent_portrait(self):
        settings = worker.encode_settings(clip_job(), "staging/source", clip_probe())
        outputs = settings["OutputGroups"][0]["Outputs"]
        self.assertEqual(len(outputs), 1)
        self.assertNotIn("AudioDescriptions", outputs[0])
        self.assertEqual(outputs[0]["VideoDescription"]["Width"], 1080)
        self.assertIn("outputs/clips/", settings["OutputGroups"][0]["OutputGroupSettings"]["FileGroupSettings"]["Destination"])


class EditorExportWorkerTests(unittest.TestCase):
    def test_optional_frame_rate_mode_extends_identity_and_broadcast_copy_is_source_only(self):
        legacy = editor_job("prores_mov")
        self.assertEqual(worker.validate_job(legacy), legacy)
        explicit = editor_job("prores_mov", frame_rate_mode="broadcast")
        self.assertEqual(worker.validate_job(explicit), explicit)
        explicit["frameRateMode"] = "source"
        with self.assertRaisesRegex(ValueError, "identity_invalid"):
            worker.validate_job(explicit)
        invalid = editor_job("prores_mov", frame_rate_mode="25/1")
        invalid["frameRateMode"] = "120/1"
        with self.assertRaisesRegex(ValueError, "frame_rate_mode_invalid"):
            worker.validate_job(invalid)

        broadcast_copy = editor_job("broadcast_mp4", "source", "broadcast")
        self.assertEqual(worker.validate_job(broadcast_copy), broadcast_copy)
        self.assertEqual(worker.validate_job(editor_job("broadcast_mp4", "source", "source"))["frameRateMode"],
                         "source")
        self.assertEqual(worker.validate_job(editor_job("broadcast_mp4", "source", "25/1"))["frameRateMode"],
                         "25/1")
        with self.assertRaisesRegex(ValueError, "broadcast_copy_invalid"):
            worker.validate_job(editor_job("broadcast_mp4", "source"))
        with self.assertRaisesRegex(ValueError, "broadcast_copy_invalid"):
            worker.validate_job(editor_job("broadcast_mp4", "clip", "broadcast"))

    def test_all_editor_identities_use_exact_original_and_bound_viewing_identity(self):
        for output_format in ("broadcast_mxf", "prores_mov", "avid_mxf"):
            with self.subTest(output_format=output_format):
                value = editor_job(output_format)
                self.assertEqual(worker.validate_job(value), value)
                worker.s3 = MagicMock()
                worker.s3.head_object.return_value = {"VersionId": "original-v1", "ContentLength": 1200}
                prepared = worker.prepare(value)
                self.assertEqual(worker.s3.head_object.call_count, 1)
                self.assertEqual(prepared["sourceVersion"], "original-v1")
                self.assertIn("versionId=original-v1", prepared["copySource"])

        value = editor_job("broadcast_mp4", "source", "broadcast")
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "original-v1", "ContentLength": 1200}
        prepared = worker.prepare(value)
        self.assertEqual(worker.s3.head_object.call_count, 1)
        self.assertEqual(worker.s3.head_object.call_args.kwargs["Bucket"], "originals")
        self.assertEqual(prepared["sourceVersion"], "original-v1")

    def test_editor_clip_inspect_validates_the_staged_original_size(self):
        for output_format in ("broadcast_mxf", "prores_mov", "avid_mxf"):
            with self.subTest(output_format=output_format):
                value = editor_job(output_format)
                worker.s3 = MagicMock()
                worker.s3.head_object.return_value = {
                    "ContentLength": value["sourceSizeBytes"], "Metadata": {"rendition": value["id"]},
                }
                worker.media = MagicMock()
                sample = editor_probe()
                sample["Container"]["Tracks"][0]["Duration"] = sample["Container"].pop("Duration")
                worker.media.probe.return_value = {"ProbeResults": [sample]}
                settings = worker.inspect(value, {"stagingVersionId": "staging-v1"})
                self.assertEqual(settings["OutputGroups"][0]["Name"], "Editor export")
                self.assertEqual(worker.s3.head_object.call_args.kwargs["VersionId"], "staging-v1")

    def test_editor_clip_allows_only_a_bounded_original_end_clamp(self):
        sample = editor_probe(duration=4.2)
        sample["Container"]["Tracks"][0]["Duration"] = sample["Container"].pop("Duration")
        timing = worker.clip_timing(editor_job(), sample)
        self.assertEqual(timing["sourceEndSeconds"], 4.2)
        with self.assertRaisesRegex(ValueError, "clip_range_outside_input"):
            worker.clip_timing(editor_job(), editor_probe(duration=3.9))

    def test_bounded_media_convert_presets_retain_rate_scan_and_discrete_channel_order(self):
        cases = {
            "broadcast_mxf": ("MXF", "MPEG2", "Mpeg2Settings", "XDCAM_RDD9", "WAV", "mxf"),
            "prores_mov": ("MOV", "PRORES", "ProresSettings", None, "AIFF", "mov"),
            "avid_mxf": ("MXF", "VC3", "Vc3Settings", None, "WAV", "mxf"),
        }
        source_probe = editor_probe(channels=(2, 2))
        for output_format, (container, codec, settings_key, profile, audio_codec, extension) in cases.items():
            with self.subTest(output_format=output_format):
                settings = worker.encode_settings(editor_job(output_format), "staging/source", source_probe)
                source = settings["Inputs"][0]
                output = settings["OutputGroups"][0]["Outputs"][0]
                self.assertEqual(output["ContainerSettings"]["Container"], container)
                self.assertEqual(output["Extension"], extension)
                self.assertEqual(output["ContainerSettings"].get("MxfSettings", {}).get("Profile"), profile)
                self.assertEqual(output["VideoDescription"]["CodecSettings"]["Codec"], codec)
                codec_settings = output["VideoDescription"]["CodecSettings"][settings_key]
                self.assertEqual(codec_settings["FramerateControl"], "INITIALIZE_FROM_SOURCE")
                self.assertNotIn("FramerateConversionAlgorithm", codec_settings)
                self.assertEqual(settings["TimecodeConfig"], {"Source": "ZEROBASED"})
                self.assertEqual(len(output["AudioDescriptions"]), 4)
                self.assertTrue(all(item["CodecSettings"]["Codec"] == audio_codec
                                    for item in output["AudioDescriptions"]))
                self.assertEqual([item["RemixSettings"]["ChannelMapping"]["OutputChannels"][0]["InputChannels"]
                                  for item in output["AudioDescriptions"]],
                                 [[0, -60], [-60, 0], [0, -60], [-60, 0]])
                self.assertIn("InputClippings", source)

    def test_broadcast_mode_uses_hard_telecine_for_all_supported_codecs(self):
        cases = {
            "broadcast_mxf": ("Mpeg2Settings", "FOLLOW_TOP_FIELD", "clip"),
            "prores_mov": ("ProresSettings", "FOLLOW_TOP_FIELD", "clip"),
            "avid_mxf": ("Vc3Settings", "INTERLACED", "clip"),
            "broadcast_mp4": ("H264Settings", "FOLLOW_TOP_FIELD", "source"),
        }
        for output_format, (settings_key, interlace, scope) in cases.items():
            with self.subTest(output_format=output_format):
                value = editor_job(output_format, scope, "broadcast")
                duration = 4 * 60 * 60 if scope == "source" else 10
                sample = editor_probe(duration=duration, numerator=24000, denominator=1001,
                                      scan="progressive")
                settings = worker.encode_settings(value, "staging/source", sample)
                output = settings["OutputGroups"][0]["Outputs"][0]
                codec = output["VideoDescription"]["CodecSettings"][settings_key]
                self.assertEqual(codec["FramerateControl"], "SPECIFIED")
                self.assertEqual((codec["FramerateNumerator"], codec["FramerateDenominator"]),
                                 (30000, 1001))
                self.assertEqual(codec["Telecine"], "HARD")
                self.assertEqual(codec["InterlaceMode"], interlace)
                self.assertNotIn("FramerateConversionAlgorithm", codec)
                self.assertNotIn("TimecodeInsertion", output["VideoDescription"])
                self.assertEqual(output["VideoDescription"]["DropFrameTimecode"], "ENABLED")
                self.assertEqual(settings["TimecodeConfig"], {"Source": "EMBEDDED"})
                self.assertEqual(settings["Inputs"][0]["TimecodeSource"], "ZEROBASED")

    def test_broadcast_mode_interpolates_other_rates_without_frameformer(self):
        for output_format, settings_key, scope in [
                ("broadcast_mxf", "Mpeg2Settings", "clip"),
                ("prores_mov", "ProresSettings", "clip"),
                ("avid_mxf", "Vc3Settings", "clip"),
                ("broadcast_mp4", "H264Settings", "source")]:
            with self.subTest(output_format=output_format):
                value = editor_job(output_format, scope, "broadcast")
                duration = 4 * 60 * 60 if scope == "source" else 10
                sample = editor_probe(duration=duration, numerator=60, denominator=1, scan="progressive")
                output = worker.encode_settings(value, "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
                codec = output["VideoDescription"]["CodecSettings"][settings_key]
                self.assertEqual(codec["FramerateControl"], "SPECIFIED")
                self.assertEqual(codec["FramerateConversionAlgorithm"], "INTERPOLATE")
                self.assertNotEqual(codec["FramerateConversionAlgorithm"], "FRAMEFORMER")
                self.assertEqual(codec["InterlaceMode"], "PROGRESSIVE")

    def test_interlaced_film_is_deinterlaced_and_interpolated_instead_of_using_telecine(self):
        sample = editor_probe(numerator=24000, denominator=1001, scan="interlaced")
        output = worker.encode_settings(
            editor_job("prores_mov", frame_rate_mode="broadcast"),
            "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
        video = output["VideoDescription"]
        codec = video["CodecSettings"]["ProresSettings"]
        self.assertEqual(codec["FramerateConversionAlgorithm"], "INTERPOLATE")
        self.assertNotIn("Telecine", codec)
        self.assertEqual(codec["InterlaceMode"], "PROGRESSIVE")
        self.assertEqual(video["VideoPreprocessors"]["Deinterlacer"]["Mode"], "ADAPTIVE")

    def test_standard_rate_choices_set_exact_targets_and_admitted_rasters(self):
        targets = {
            "24000/1001": (24000, 1001), "24/1": (24, 1), "25/1": (25, 1), "30/1": (30, 1),
            "50/1": (50, 1), "60000/1001": (60000, 1001), "60/1": (60, 1),
        }
        for output_format, settings_key, scope in [
                ("prores_mov", "ProresSettings", "clip"),
                ("avid_mxf", "Vc3Settings", "clip"),
                ("broadcast_mp4", "H264Settings", "source")]:
            for mode, target in targets.items():
                with self.subTest(output_format=output_format, mode=mode):
                    value = editor_job(output_format, scope, mode)
                    duration = 4 * 60 * 60 if scope == "source" else 10
                    sample = editor_probe(duration=duration, numerator=25, denominator=1, scan="progressive")
                    output = worker.encode_settings(value, "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
                    codec = output["VideoDescription"]["CodecSettings"][settings_key]
                    self.assertEqual(codec["FramerateControl"], "SPECIFIED")
                    self.assertEqual((codec["FramerateNumerator"], codec["FramerateDenominator"]), target)
                    if mode == "25/1":
                        self.assertNotIn("FramerateConversionAlgorithm", codec)
                    else:
                        self.assertEqual(codec["FramerateConversionAlgorithm"], "INTERPOLATE")
                    expected_size = ((1280, 720) if output_format == "avid_mxf" and
                                     target[0] / target[1] > 30 else (1920, 1080))
                    self.assertEqual((output["VideoDescription"]["Width"], output["VideoDescription"]["Height"]),
                                     expected_size)

    def test_selected_rates_retain_720p_except_for_hard_telecine(self):
        sample = editor_probe(numerator=25, denominator=1, scan="progressive", width=1280, height=720)
        for output_format in ("broadcast_mxf", "prores_mov", "avid_mxf"):
            for mode in ("25/1", "50/1"):
                with self.subTest(output_format=output_format, mode=mode):
                    output = worker.encode_settings(editor_job(output_format, frame_rate_mode=mode),
                                                    "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
                    self.assertEqual((output["VideoDescription"]["Width"], output["VideoDescription"]["Height"]),
                                     (1280, 720))

    def test_xdcam_uses_only_documented_target_rates(self):
        sample = editor_probe(numerator=25, denominator=1, scan="progressive")
        for mode in ("24000/1001", "25/1", "broadcast", "50/1", "60000/1001"):
            with self.subTest(mode=mode):
                worker.encode_settings(editor_job("broadcast_mxf", frame_rate_mode=mode),
                                       "staging/source", sample)
        for mode in ("24/1", "30/1", "60/1"):
            with self.subTest(mode=mode), self.assertRaisesRegex(
                    ValueError, "broadcast_frame_rate_format_unsupported"):
                worker.encode_settings(editor_job("broadcast_mxf", frame_rate_mode=mode),
                                       "staging/source", sample)

    def test_matching_explicit_rate_is_specified_without_conversion_and_inserts_supported_timecode(self):
        for output_format, settings_key, scope, inserts_timecode in [
                ("broadcast_mxf", "Mpeg2Settings", "clip", True),
                ("prores_mov", "ProresSettings", "clip", True),
                ("avid_mxf", "Vc3Settings", "clip", False),
                ("broadcast_mp4", "H264Settings", "source", True)]:
            with self.subTest(output_format=output_format):
                value = editor_job(output_format, scope, "broadcast")
                duration = 4 * 60 * 60 if scope == "source" else 10
                sample = editor_probe(duration=duration)
                output = worker.encode_settings(value, "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
                codec = output["VideoDescription"]["CodecSettings"][settings_key]
                self.assertEqual(codec["FramerateControl"], "SPECIFIED")
                self.assertEqual((codec["FramerateNumerator"], codec["FramerateDenominator"]),
                                 (30000, 1001))
                self.assertNotIn("FramerateConversionAlgorithm", codec)
                if inserts_timecode:
                    self.assertEqual(output["VideoDescription"]["TimecodeInsertion"], "PIC_TIMING_SEI")
                else:
                    self.assertNotIn("TimecodeInsertion", output["VideoDescription"])

    def test_720p_telecine_scales_only_fixed_hd_formats(self):
        sample = editor_probe(numerator=24000, denominator=1001, scan="progressive",
                              width=1280, height=720)
        for output_format, settings_key in (("broadcast_mxf", "Mpeg2Settings"),
                                            ("prores_mov", "ProresSettings"),
                                            ("avid_mxf", "Vc3Settings")):
            with self.subTest(output_format=output_format):
                output = worker.encode_settings(
                    editor_job(output_format, frame_rate_mode="broadcast"),
                    "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
                self.assertEqual((output["VideoDescription"]["Width"], output["VideoDescription"]["Height"]),
                                 (1280, 720) if output_format == "prores_mov" else (1920, 1080))
                codec = output["VideoDescription"]["CodecSettings"][settings_key]
                self.assertEqual(codec["Telecine"], "HARD")

        mp4 = editor_job("broadcast_mp4", "source", "broadcast")
        sample["Container"]["Duration"] = 4 * 60 * 60
        output = worker.encode_settings(mp4, "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
        self.assertEqual((output["VideoDescription"]["Width"], output["VideoDescription"]["Height"]),
                         (1920, 1080))
        self.assertEqual(output["VideoDescription"]["ScalingBehavior"], "FIT_NO_UPSCALE")

    def test_verify_720p_telecine_preserves_prores_and_scales_fixed_hd(self):
        cases = {
            "broadcast_mxf": ("MXF", "MPEG2", "broadcast"),
            "prores_mov": ("QuickTime", "PRORES", "prores"),
            "avid_mxf": ("MXF", "VC3", "avid"),
        }
        source = editor_probe(duration=10, numerator=24000, denominator=1001,
                              scan="progressive", width=1280, height=720)
        for output_format, (container, codec, result_key) in cases.items():
            with self.subTest(output_format=output_format):
                value = editor_job(output_format, frame_rate_mode="broadcast")
                timing = worker.source_timing(value, source)
                expected_size = (1280, 720) if output_format == "prores_mov" else (1920, 1080)
                encoded = editor_probe(duration=timing["sourceEndSeconds"] - timing["sourceStartSeconds"],
                                       numerator=30000, denominator=1001, scan="interlaced",
                                       container_format=container, video_codec=codec,
                                       width=expected_size[0], height=expected_size[1], channels=(1, 1))
                worker.s3 = MagicMock()
                worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
                worker.media = MagicMock()
                worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
                result = worker.verify(value)[result_key]
                self.assertEqual((result["width"], result["height"], result["scanType"]),
                                 (*expected_size, "interlaced"))
                self.assertEqual((result["sourceFrameRateNumerator"], result["sourceFrameRateDenominator"]),
                                 (24000, 1001))
                self.assertEqual(result["conversionMethod"], "telecine")

    def test_720i_broadcast_editor_output_is_deinterlaced_to_supported_720p(self):
        sample = editor_probe(numerator=25, denominator=1, scan="interlaced", width=1280, height=720)
        output = worker.encode_settings(editor_job("prores_mov", frame_rate_mode="broadcast"),
                                        "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
        video = output["VideoDescription"]
        self.assertEqual((video["Width"], video["Height"]), (1280, 720))
        self.assertEqual(video["CodecSettings"]["ProresSettings"]["InterlaceMode"], "PROGRESSIVE")
        self.assertEqual(video["VideoPreprocessors"]["Deinterlacer"]["Mode"], "ADAPTIVE")

    def test_broadcast_mp4_accepts_small_portrait_and_silent_sources_without_upscale(self):
        value = editor_job("broadcast_mp4", "source", "broadcast")
        source = editor_probe(duration=4 * 60 * 60, numerator=25, denominator=1, scan="progressive",
                              channels=(), width=720, height=1280)
        settings = worker.encode_settings(value, "staging/source", source)
        output = settings["OutputGroups"][0]["Outputs"][0]
        self.assertEqual((output["VideoDescription"]["Width"], output["VideoDescription"]["Height"]),
                         (1080, 1920))
        self.assertEqual(output["VideoDescription"]["ScalingBehavior"], "FIT_NO_UPSCALE")
        self.assertEqual(settings["Inputs"][0]["VideoSelector"], {"Rotate": "AUTO"})
        self.assertNotIn("AudioDescriptions", output)

        encoded = editor_probe(duration=4 * 60 * 60, numerator=30000, denominator=1001,
                               scan="progressive", channels=(), width=1280, height=720,
                               container_format="MPEG-4", video_codec="H264")
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
        worker.media = MagicMock()
        worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
        result = worker.verify(value)["broadcastMp4"]
        self.assertEqual((result["width"], result["height"]), (1280, 720))
        self.assertEqual((result["audioChannels"], result["audioTracks"], result["audioCodec"]),
                         (0, 0, "none"))

    def test_explicit_mode_uses_video_duration_and_rejects_real_video_drift(self):
        value = editor_job("broadcast_mp4", "source", "broadcast")
        value["outMs"] = 10000
        source = editor_probe(duration=10.1, numerator=25, denominator=1, scan="progressive",
                              channels=())
        source["Container"]["Tracks"][0]["Duration"] = 10
        worker.encode_settings(value, "staging/source", source)
        self.assertEqual(worker.source_timing(value, source)["sourceEndSeconds"], 10)
        self.assertEqual(worker.source_timing(editor_job("prores_mov", "source"), source)["sourceEndSeconds"],
                         10.1)

        def verify_with_video_duration(duration):
            encoded = editor_probe(duration=10.1, numerator=30000, denominator=1001,
                                   scan="progressive", channels=(), container_format="MPEG-4",
                                   video_codec="H264")
            encoded["Container"]["Tracks"][0]["Duration"] = duration
            worker.s3 = MagicMock()
            worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
            worker.media = MagicMock()
            worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
            return worker.verify(value)["broadcastMp4"]

        result = verify_with_video_duration(10.03)
        self.assertEqual(result["durationSeconds"], 10.03)
        self.assertEqual(result["sourceEndSeconds"], 10)
        with self.assertRaisesRegex(ValueError, "broadcast_output_duration_invalid"):
            verify_with_video_duration(10.04)

    def test_full_source_audio_tail_uses_container_admission_and_video_timing(self):
        for output_format in ("broadcast_mp4", "broadcast_mxf", "prores_mov", "avid_mxf"):
            with self.subTest(output_format=output_format):
                value = editor_job(output_format, "source", "broadcast")
                value["outMs"] = 12000
                source = editor_probe(duration=12, numerator=25, denominator=1, scan="progressive")
                source["Container"]["Tracks"][0]["Duration"] = 10
                settings = worker.encode_settings(value, "staging/source", source)
                self.assertNotIn("InputClippings", settings["Inputs"][0])
                self.assertEqual(worker.source_timing(value, source)["sourceEndSeconds"], 10)
                source["Container"]["Duration"] = 14
                with self.assertRaisesRegex(ValueError, "source_export_duration_mismatch"):
                    worker.encode_settings(value, "staging/source", source)
                source["Container"]["Duration"] = 12
                source["Container"]["Tracks"][0]["Duration"] = 14
                with self.assertRaisesRegex(ValueError, "source_export_duration_mismatch"):
                    worker.encode_settings(value, "staging/source", source)

    def test_source_export_has_no_clip_boundary_and_can_exceed_thirty_minutes(self):
        value = editor_job("prores_mov", "source")
        sample = editor_probe(duration=4 * 60 * 60, numerator=25, denominator=1, scan="progressive")
        settings = worker.encode_settings(value, "staging/source", sample)
        self.assertNotIn("InputClippings", settings["Inputs"][0])
        sample["Container"]["Duration"] = 4 * 60 * 60 + 2
        with self.assertRaisesRegex(ValueError, "source_export_duration_mismatch"):
            worker.encode_settings(value, "staging/source", sample)
        sample["Container"]["Duration"] = 86400.1
        with self.assertRaisesRegex(ValueError, "duration_unsupported"):
            worker.encode_settings(value, "staging/source", sample)

    def test_explicit_source_mode_keeps_source_rate(self):
        value = editor_job("prores_mov", frame_rate_mode="source")
        sample = editor_probe(numerator=25, denominator=1, scan="progressive")
        settings = worker.encode_settings(value, "staging/source", sample)
        output = settings["OutputGroups"][0]["Outputs"][0]
        codec = output["VideoDescription"]["CodecSettings"]["ProresSettings"]
        self.assertEqual(codec["FramerateControl"], "INITIALIZE_FROM_SOURCE")
        self.assertNotIn("FramerateNumerator", codec)
        self.assertNotIn("FramerateConversionAlgorithm", codec)
        self.assertEqual(output["VideoDescription"]["TimecodeInsertion"], "PIC_TIMING_SEI")
        self.assertEqual(settings["TimecodeConfig"], {"Source": "EMBEDDED"})

    def test_presets_refuse_unsupported_rate_resolution_scan_and_xdcam_audio(self):
        for change in ("rate", "resolution", "scan", "audio"):
            sample = editor_probe()
            if change == "rate":
                sample["Container"]["Tracks"][0]["VideoProperties"]["FrameRate"] = {"Numerator": 24, "Denominator": 1}
            elif change == "resolution":
                sample["Container"]["Tracks"][0]["VideoProperties"]["Width"] = 3840
            elif change == "scan":
                sample["Container"]["Tracks"][0]["VideoProperties"]["CodecMetadata"]["ScanType"] = "unknown"
            else:
                sample["Container"]["Tracks"][1]["AudioProperties"]["Channels"] = 1
            with self.subTest(change=change), self.assertRaises(ValueError):
                worker.encode_settings(editor_job("broadcast_mxf"), "staging/source", sample)

    def test_prores_accepts_even_rasters_and_standard_rates_outside_xdcam(self):
        for width, height, numerator, denominator in (
                (1920, 1080, 60000, 1001), (3840, 2160, 30000, 1001),
                (1080, 1920, 30, 1), (4096, 4096, 24, 1), (640, 480, 60, 1)):
            with self.subTest(raster=(width, height), rate=(numerator, denominator)):
                sample = editor_probe(numerator=numerator, denominator=denominator, scan="progressive")
                sample["Container"]["Tracks"][0]["VideoProperties"].update(Width=width, Height=height)
                settings = worker.encode_settings(editor_job("prores_mov"), "staging/source", sample)
                output = settings["OutputGroups"][0]["Outputs"][0]
                self.assertEqual(output["VideoDescription"]["Width"], width)
                self.assertEqual(output["VideoDescription"]["Height"], height)
                self.assertEqual(output["VideoDescription"]["CodecSettings"]["ProresSettings"]["CodecProfile"],
                                 "APPLE_PRORES_422_HQ")
                self.assertEqual(output["AudioDescriptions"][0]["CodecSettings"]["AiffSettings"],
                                 {"BitDepth": 24, "Channels": 1, "SampleRate": 48000})
                with self.assertRaisesRegex(ValueError, "broadcast_video_format_unsupported"):
                    worker.encode_settings(editor_job("broadcast_mxf"), "staging/source", sample)

    def test_prores_broadcast_conversion_accepts_large_25_and_5994_sources(self):
        for source_rate in ((25, 1), (60000, 1001)):
            with self.subTest(source_rate=source_rate):
                value = editor_job("prores_mov", frame_rate_mode="broadcast")
                source = editor_probe(numerator=source_rate[0], denominator=source_rate[1],
                                      scan="progressive", width=3840, height=2160)
                settings = worker.encode_settings(value, "staging/source", source)
                video = settings["OutputGroups"][0]["Outputs"][0]["VideoDescription"]
                codec = video["CodecSettings"]["ProresSettings"]
                self.assertEqual((video["Width"], video["Height"]), (3840, 2160))
                self.assertEqual((codec["FramerateNumerator"], codec["FramerateDenominator"]),
                                 (30000, 1001))
                self.assertEqual(codec["FramerateConversionAlgorithm"], "INTERPOLATE")

                timing = worker.source_timing(value, source)
                encoded = editor_probe(
                    duration=timing["sourceEndSeconds"] - timing["sourceStartSeconds"],
                    numerator=30000, denominator=1001, scan="progressive",
                    container_format="QuickTime", video_codec="PRORES", channels=(1, 1),
                    width=3840, height=2160)
                worker.media = MagicMock()
                worker.media.probe.return_value = {"ProbeResults": [encoded]}
                result = {}
                worker.verify_editor(value, "outputs/clips/example/", result, source)
                self.assertEqual((result["width"], result["height"]), (3840, 2160))
                self.assertEqual((result["sourceFrameRateNumerator"],
                                  result["sourceFrameRateDenominator"]), source_rate)
                self.assertEqual((result["frameRateNumerator"], result["frameRateDenominator"]),
                                 (30000, 1001))
                self.assertEqual(result["conversionMethod"], "interpolate")

    def test_prores_telecine_retains_every_admitted_720_high_raster(self):
        for width in (960, 720, 3840, 1280):
            with self.subTest(width=width):
                source = editor_probe(numerator=24000, denominator=1001, scan="progressive",
                                      width=width, height=720)
                value = editor_job("prores_mov", frame_rate_mode="broadcast")
                settings = worker.encode_settings(value, "staging/source", source)
                video = settings["OutputGroups"][0]["Outputs"][0]["VideoDescription"]
                self.assertEqual((video["Width"], video["Height"]), (width, 720))
                codec = video["CodecSettings"]["ProresSettings"]
                self.assertEqual(codec["Telecine"], "HARD")
                self.assertEqual(codec["InterlaceMode"], "FOLLOW_TOP_FIELD")

    def test_prores_rejects_invalid_rasters_and_nonstandard_rates(self):
        for width, height, numerator in ((31, 1080, 25), (1921, 1080, 25), (4098, 1080, 25),
                                         (1920, 4098, 25), (True, 1080, 25), (1920, 1080, 27)):
            with self.subTest(raster=(width, height), rate=numerator):
                sample = editor_probe(numerator=numerator, denominator=1, scan="progressive")
                sample["Container"]["Tracks"][0]["VideoProperties"].update(Width=width, Height=height)
                with self.assertRaisesRegex(ValueError, "prores_video_format_unsupported"):
                    worker.encode_settings(editor_job("prores_mov"), "staging/source", sample)

    def test_avid_has_its_own_hd_rate_matrix(self):
        for width, height, numerator, scan, accepted in (
                (1920, 1080, 24, "progressive", True), (1920, 1080, 60, "progressive", True),
                (1920, 1080, 30, "interlaced", True), (1280, 720, 60, "progressive", True),
                (3840, 2160, 25, "progressive", False), (1080, 1920, 25, "progressive", False),
                (1280, 720, 25, "interlaced", False), (1920, 1080, 60, "interlaced", False)):
            with self.subTest(raster=(width, height), rate=numerator, scan=scan):
                sample = editor_probe(numerator=numerator, denominator=1, scan=scan)
                sample["Container"]["Tracks"][0]["VideoProperties"].update(Width=width, Height=height)
                if accepted:
                    output = worker.encode_settings(editor_job("avid_mxf"), "staging/source", sample)["OutputGroups"][0]["Outputs"][0]
                    self.assertEqual(output["VideoDescription"]["CodecSettings"]["Vc3Settings"]["Vc3Class"],
                                     "CLASS_145_8BIT")
                else:
                    with self.assertRaisesRegex(ValueError, "avid_video_format_unsupported"):
                        worker.encode_settings(editor_job("avid_mxf"), "staging/source", sample)

    def test_prores_verification_retains_raster_rate_scan_and_audio(self):
        source = editor_probe(numerator=60000, denominator=1001, scan="progressive")
        start, end = 59 * 1001 / 60000, 300 * 1001 / 60000
        encoded = editor_probe(duration=end - start, numerator=60000, denominator=1001,
                               scan="progressive", container_format="QuickTime", video_codec="PRORES", channels=(1, 1))
        for sample in (source, encoded):
            sample["Container"]["Tracks"][0]["VideoProperties"].update(Width=3840, Height=2160)
        worker.media = MagicMock()
        worker.media.probe.return_value = {"ProbeResults": [encoded]}
        output = {}
        worker.verify_editor(editor_job("prores_mov"), "outputs/clips/example/", output, source)
        self.assertEqual((output["width"], output["height"]), (3840, 2160))
        self.assertEqual((output["frameRateNumerator"], output["frameRateDenominator"]), (60000, 1001))
        self.assertEqual(output["scanType"], "progressive")
        self.assertEqual(output["audioTracks"], 2)
        self.assertEqual(output["audioBitDepth"], 24)
        encoded["Container"]["Tracks"][0]["VideoProperties"]["Width"] = 1920
        with self.assertRaisesRegex(ValueError, "broadcast_output_video_invalid"):
            worker.verify_editor(editor_job("prores_mov"), "outputs/clips/example/", {}, source)

    def test_verify_records_actual_codec_layout_and_frame_rounded_timing(self):
        cases = {
            "broadcast_mxf": ("mxf", "MPEG2", "broadcast"),
            "prores_mov": ("quicktime", "PRORES", "prores"),
            "avid_mxf": ("mxf", "VC3", "avid"),
        }
        for output_format, (container, codec, result_key) in cases.items():
            with self.subTest(output_format=output_format):
                value = editor_job(output_format)
                source = editor_probe(duration=10)
                source["Container"]["Tracks"][0]["Duration"] = source["Container"].pop("Duration")
                start = 29 * 1001 / 30000
                end = 150 * 1001 / 30000
                probed_container = "MXF" if container == "mxf" else "QuickTime"
                encoded = editor_probe(duration=end - start, container_format=probed_container, video_codec=codec,
                                       channels=(1, 1))
                if container == "mxf":
                    encoded["Container"]["Tracks"][0]["Duration"] = encoded["Container"].pop("Duration")
                worker.s3 = MagicMock()
                worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
                worker.media = MagicMock()
                worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
                result = worker.verify(value)[result_key]
                self.assertEqual(result["videoCodecEvidence"], "probe")
                self.assertEqual(result["audioChannels"], 2)
                self.assertEqual(result["audioTracks"], 2)
                self.assertEqual(result["audioBitDepth"], 24)
                self.assertEqual(result["sourceFrameRateNumerator"], 30000)
                self.assertEqual(result["sourceFrameRateDenominator"], 1001)
                self.assertEqual(result["frameRateNumerator"], 30000)
                self.assertEqual(result["frameRateDenominator"], 1001)
                self.assertEqual(result["conversionMethod"], "none")
                self.assertEqual(result["timecodeMode"], "zero_based")
                self.assertAlmostEqual(result["sourceStartSeconds"], start)
                self.assertAlmostEqual(result["sourceEndSeconds"], end)

    def test_verify_converted_output_records_measured_rates_and_one_frame_duration_bound(self):
        value = editor_job("prores_mov", frame_rate_mode="broadcast")
        source = editor_probe(duration=10, numerator=25, denominator=1, scan="progressive")
        start, end = 1, 5

        def verify_with_duration(duration, numerator=30000, denominator=1001):
            encoded = editor_probe(duration=duration, numerator=numerator, denominator=denominator,
                                   scan="progressive", container_format="QuickTime",
                                   video_codec="PRORES", channels=(1, 1))
            worker.s3 = MagicMock()
            worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
            worker.media = MagicMock()
            worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
            return worker.verify(value)["prores"]

        result = verify_with_duration(end - start + 0.03)
        self.assertEqual(result["sourceFrameRateNumerator"], 25)
        self.assertEqual(result["sourceFrameRateDenominator"], 1)
        self.assertEqual(result["frameRateNumerator"], 30000)
        self.assertEqual(result["frameRateDenominator"], 1001)
        self.assertEqual(result["frameRateMode"], "broadcast")
        self.assertEqual(result["conversionMethod"], "interpolate")
        self.assertEqual(result["timecodeMode"], "embedded_or_zero_based")

        with self.assertRaisesRegex(ValueError, "broadcast_output_duration_invalid"):
            verify_with_duration(end - start + 0.04)
        with self.assertRaisesRegex(ValueError, "broadcast_output_video_invalid"):
            verify_with_duration(end - start, 25, 1)

    def test_verify_selected_standard_rates_records_exact_output(self):
        source = editor_probe(duration=10, numerator=25, denominator=1, scan="progressive")
        for mode, rate in (("24/1", (24, 1)), ("50/1", (50, 1))):
            with self.subTest(mode=mode):
                value = editor_job("prores_mov", frame_rate_mode=mode)
                timing = worker.source_timing(value, source)
                encoded = editor_probe(duration=timing["sourceEndSeconds"] - timing["sourceStartSeconds"],
                                       numerator=rate[0], denominator=rate[1], scan="progressive",
                                       container_format="QuickTime", video_codec="PRORES", channels=(1, 1))
                worker.s3 = MagicMock()
                worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
                worker.media = MagicMock()
                worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
                result = worker.verify(value)["prores"]
                self.assertEqual((result["frameRateNumerator"], result["frameRateDenominator"]), rate)
                self.assertEqual(result["frameRateMode"], mode)
                self.assertEqual(result["conversionMethod"], "interpolate")

    def test_verify_broadcast_mp4_receipt_uses_aac_stereo_contract(self):
        value = editor_job("broadcast_mp4", "source", "broadcast")
        source = editor_probe(duration=4 * 60 * 60, numerator=25, denominator=1, scan="progressive")
        encoded = editor_probe(duration=4 * 60 * 60, numerator=30000, denominator=1001,
                               scan="progressive", container_format="MPEG-4", video_codec="H264",
                               channels=(2,), audio_codec="AAC", audio_bit_depth=None)
        worker.s3 = MagicMock()
        worker.s3.head_object.return_value = {"VersionId": "output-v1", "ContentLength": 1000}
        worker.media = MagicMock()
        worker.media.probe.side_effect = [{"ProbeResults": [source]}, {"ProbeResults": [encoded]}]
        result = worker.verify(value)["broadcastMp4"]
        self.assertEqual(result["objectKey"].rsplit("/", 1)[1], "broadcast.mp4")
        self.assertEqual(result["container"], "mp4")
        self.assertEqual(result["videoCodec"], "h264")
        self.assertEqual(result["profile"], "frame_rate_copy")
        self.assertEqual(result["audioCodec"], "aac")
        self.assertEqual(result["audioChannels"], 2)
        self.assertEqual(result["audioTracks"], 1)
        self.assertEqual(result["audioSampleRate"], 48000)
        self.assertIsNone(result["audioBitDepth"])

    def test_prores_missing_scan_probe_uses_configured_source_scan_only(self):
        source = editor_probe(duration=10)
        encoded = editor_probe(duration=4, container_format="QuickTime", video_codec="PRORES",
                               channels=(1, 1))
        properties = encoded["Container"]["Tracks"][0]["VideoProperties"]
        properties.pop("CodecMetadata")
        worker.media = MagicMock()
        worker.media.probe.return_value = {"ProbeResults": [encoded]}
        result = {}
        worker.verify_editor(editor_job("prores_mov"), "outputs/clips/example/", result, source)
        self.assertEqual(result["scanType"], "interlaced")
        self.assertEqual(result["scanTypeEvidence"], "encoder-setting")
        self.assertEqual(worker.media.probe.call_count, 1)

        properties["CodecMetadata"] = {"ScanType": "unknown"}
        with self.assertRaisesRegex(ValueError, "broadcast_scan_type_missing"):
            worker.verify_editor(editor_job("prores_mov"), "outputs/clips/example/", {}, source)

        properties.pop("CodecMetadata")
        encoded["Container"]["Format"] = "MXF"
        encoded["Container"]["Tracks"][0]["Codec"] = "MPEG2"
        with self.assertRaisesRegex(ValueError, "broadcast_scan_type_missing"):
            worker.verify_editor(editor_job("broadcast_mxf"), "outputs/clips/example/", {}, source)

    def test_avid_probe_mpeg2_label_uses_explicit_vc3_encoder_only(self):
        source = editor_probe(duration=10)
        encoded = editor_probe(duration=4, container_format="MXF", video_codec="MPEG2",
                               channels=(1, 1))
        worker.media = MagicMock()
        worker.media.probe.return_value = {"ProbeResults": [encoded]}
        result = {}
        worker.verify_editor(editor_job("avid_mxf"), "outputs/clips/example/", result, source)
        self.assertEqual(result["videoCodec"], "vc3")
        self.assertEqual(result["videoCodecEvidence"], "encoder-setting")

        encoded["Container"]["Tracks"][0]["Codec"] = "UNKNOWN"
        with self.assertRaisesRegex(ValueError, "broadcast_output_format_invalid"):
            worker.verify_editor(editor_job("avid_mxf"), "outputs/clips/example/", {}, source)

        encoded["Container"]["Tracks"][0]["Codec"] = "MPEG2"
        encoded["Container"]["Format"] = "QuickTime"
        with self.assertRaisesRegex(ValueError, "broadcast_output_format_invalid"):
            worker.verify_editor(editor_job("prores_mov"), "outputs/clips/example/", {}, source)


if __name__ == "__main__":
    unittest.main()
