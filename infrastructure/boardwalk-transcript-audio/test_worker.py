"""Focused tests for the paid transcript audio preparation worker."""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

import worker


ARTIFACT_IDENTITY = worker._artifact_identity
ARTIFACT = "a" * 64
PREPARATION = "b" * 64
INVOCATION = "00000000-0000-4000-8000-000000000001"
BUCKET = "renditions"
ACCOUNT = "123456789012"
FIXTURE = (
    Path(__file__).parents[1]
    / "boardwalk-transcription-worker"
    / "fixtures"
    / "alignment-english-h264-aac.mp4"
)


def client_error(code: str, operation: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": code}}, operation)


class Body(io.BytesIO):
    def iter_chunks(self, chunk_size: int):
        while chunk := self.read(chunk_size):
            yield chunk


class FakeS3:
    def __init__(self):
        self.objects: dict[tuple[str, str, str], dict] = {}
        self.current: dict[tuple[str, str], str] = {}
        self.puts: list[tuple[str, str, str]] = []
        self.deleted: list[tuple[str, str, str]] = []
        self.next_version = 1
        self.fail_head = False
        self.bad_output_head = False
        self.fail_receipt = False

    def seed(self, bucket: str, key: str, version: str, body: bytes, content_type: str = "video/mp4") -> None:
        self.objects[(bucket, key, version)] = {
            "body": body,
            "content_type": content_type,
            "metadata": {},
        }
        self.current[(bucket, key)] = version

    def _object(self, bucket: str, key: str, version: str | None = None) -> tuple[str, dict]:
        resolved = version or self.current.get((bucket, key))
        if resolved is None or (bucket, key, resolved) not in self.objects:
            raise client_error("NoSuchKey", "GetObject")
        return resolved, self.objects[(bucket, key, resolved)]

    def head_object(self, *, Bucket: str, Key: str, VersionId: str | None = None, **_kwargs):
        if self.fail_head:
            raise client_error("AccessDenied", "HeadObject")
        version, value = self._object(Bucket, Key, VersionId)
        if self.bad_output_head and Key.endswith("input.m4a"):
            return {
                "VersionId": version,
                "ContentLength": len(value["body"]) + 1,
                "ContentType": value["content_type"],
                "Metadata": value["metadata"],
            }
        return {
            "VersionId": version,
            "ContentLength": len(value["body"]),
            "ContentType": value["content_type"],
            "Metadata": value["metadata"],
        }

    def get_object(self, *, Bucket: str, Key: str, VersionId: str | None = None, **_kwargs):
        version, value = self._object(Bucket, Key, VersionId)
        return {"VersionId": version, "Body": Body(value["body"])}

    def list_objects_v2(self, *, Bucket: str, Prefix: str, **_kwargs):
        keys = sorted(key for bucket, key in self.current if bucket == Bucket and key.startswith(Prefix))
        return {"IsTruncated": False, "Contents": [{"Key": key} for key in keys[:1]]}

    def list_object_versions(self, *, Bucket: str, Prefix: str, **_kwargs):
        versions = [
            {"Key": key, "VersionId": version}
            for bucket, key, version in self.objects
            if bucket == Bucket and key.startswith(Prefix)
        ]
        return {"IsTruncated": False, "Versions": versions}

    def put_object(self, *, Bucket: str, Key: str, Body, ContentType: str, Metadata=None, IfNoneMatch=None, **_kwargs):
        if self.fail_receipt and Key.endswith(".json"):
            raise client_error("InternalError", "PutObject")
        if IfNoneMatch == "*" and (Bucket, Key) in self.current:
            raise client_error("PreconditionFailed", "PutObject")
        content = Body.read() if hasattr(Body, "read") else bytes(Body)
        version = f"v{self.next_version}"
        self.next_version += 1
        self.seed(Bucket, Key, version, content, ContentType)
        self.objects[(Bucket, Key, version)]["metadata"] = dict(Metadata or {})
        self.puts.append((Bucket, Key, version))
        return {"VersionId": version}

    def delete_object(self, *, Bucket: str, Key: str, VersionId: str, **_kwargs):
        self.objects.pop((Bucket, Key, VersionId), None)
        self.deleted.append((Bucket, Key, VersionId))
        if self.current.get((Bucket, Key)) == VersionId:
            self.current.pop((Bucket, Key), None)
        return {}


def event(source: bytes, *, version: str = "source-v1", duration: float = 7.186) -> dict:
    prefix = f"transcripts/inputs/audio/{PREPARATION}"
    return {
        "schemaVersion": 1,
        "preparationId": PREPARATION,
        "invocationId": INVOCATION,
        "revision": worker.REVISION,
        "ffmpegArtifactSha256": ARTIFACT,
        "input": {
            "bucket": BUCKET,
            "objectKey": "outputs/job/attempt/preview.mp4",
            "objectVersionId": version,
            "sizeBytes": len(source),
            "durationSeconds": duration,
        },
        "output": {
            "bucket": BUCKET,
            "audioKey": f"{prefix}/attempts/{INVOCATION}/input.m4a",
            "receiptKey": f"{prefix}/receipts/{INVOCATION}.json",
        },
    }


class WorkerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = shutil.which("ffmpeg")
        cls.ffprobe = shutil.which("ffprobe")
        if cls.ffmpeg is None or cls.ffprobe is None:
            raise unittest.SkipTest("FFmpeg and ffprobe are required")
        cls.source = FIXTURE.read_bytes()

    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "RENDITION_BUCKET": BUCKET,
                "EXPECTED_BUCKET_OWNER": ACCOUNT,
                "FFMPEG_ARTIFACT_SHA256": ARTIFACT,
                "FFMPEG_PATH": self.ffmpeg,
                "FFPROBE_PATH": self.ffprobe,
            },
            clear=False,
        )
        self.environment.start()
        self.artifact = patch.object(worker, "_artifact_identity", return_value={"artifactSha256": ARTIFACT})
        self.artifact.start()

    def tearDown(self):
        self.artifact.stop()
        self.environment.stop()

    def prepared(self, source: bytes | None = None, **event_options):
        content = self.source if source is None else source
        invocation = event(content, **event_options)
        s3 = FakeS3()
        s3.seed(BUCKET, invocation["input"]["objectKey"], invocation["input"]["objectVersionId"], content)
        return s3, invocation

    def test_remuxes_exact_aac_payload_and_returns_core_receipt(self):
        s3, invocation = self.prepared()
        receipt = worker.handler(invocation, None, s3=s3)
        self.assertEqual(receipt["outcome"], "ready")
        self.assertEqual(receipt["sourceAudio"], receipt["outputAudio"])
        self.assertEqual(receipt["sourceAudio"]["codec"], "aac")
        self.assertEqual(receipt["sourceAudio"]["profile"], "LC")
        self.assertEqual(receipt["sourceAudio"]["startSamples"], 0)
        # ffprobe -select_streams a:0 -count_packets on the generated MP4.
        self.assertEqual(receipt["sourceAudio"]["packetCount"], 339)
        self.assertLess(receipt["output"]["sizeBytes"], len(self.source))
        output = s3.objects[(BUCKET, receipt["output"]["objectKey"], receipt["output"]["objectVersionId"])]
        self.assertEqual(hashlib.sha256(output["body"]).hexdigest(), receipt["output"]["sha256"])
        self.assertEqual(output["metadata"]["artifact-sha256"], ARTIFACT)
        stored_receipt = json.loads(s3._object(BUCKET, invocation["output"]["receiptKey"])[1]["body"])
        self.assertEqual(stored_receipt, receipt)

    def test_repeated_invocation_reuses_version_pinned_receipt(self):
        s3, invocation = self.prepared()
        first = worker.handler(invocation, None, s3=s3)
        put_count = len(s3.puts)
        self.assertEqual(worker.handler(invocation, None, s3=s3), first)
        self.assertEqual(len(s3.puts), put_count)

    def test_missing_exact_input_version_writes_terminal_receipt(self):
        s3, invocation = self.prepared()
        invocation["input"]["objectVersionId"] = "missing-version"
        receipt = worker.handler(invocation, None, s3=s3)
        self.assertEqual(receipt["outcome"], "failed")
        self.assertEqual(receipt["failureCode"], "input_changed")
        self.assertNotIn((BUCKET, invocation["output"]["audioKey"]), s3.current)

    def test_non_aac_audio_fails_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            wav = Path(directory) / "input.wav"
            subprocess.run(
                [self.ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", str(wav)],
                check=True,
            )
            source = wav.read_bytes()
        s3, invocation = self.prepared(source, duration=1.0)
        receipt = worker.handler(invocation, None, s3=s3)
        self.assertEqual(receipt["failureCode"], "audio_codec_unsupported")
        self.assertNotIn((BUCKET, invocation["output"]["audioKey"]), s3.current)

    def test_transient_source_failure_writes_no_receipt(self):
        s3, invocation = self.prepared()
        s3.fail_head = True
        with self.assertRaises(ClientError):
            worker.handler(invocation, None, s3=s3)
        self.assertNotIn((BUCKET, invocation["output"]["receiptKey"]), s3.current)

    def test_input_read_race_rechecks_version_before_terminal_failure(self):
        s3, invocation = self.prepared()

        class DeletedAfterList:
            def __init__(self):
                self.calls = 0

            def list_object_versions(self, **_kwargs):
                self.calls += 1
                versions = [{"Key": invocation["input"]["objectKey"], "VersionId": invocation["input"]["objectVersionId"]}]
                return {"IsTruncated": False, "Versions": versions if self.calls == 1 else []}

            @staticmethod
            def head_object(**_kwargs):
                raise client_error("AccessDenied", "HeadObject")

        raced = DeletedAfterList()
        with self.assertRaisesRegex(worker.TerminalFailure, "input_changed"):
            worker._head_input(raced, invocation, worker._settings())
        self.assertEqual(raced.calls, 2)

    def test_input_version_lookup_paginates_and_stops_after_exact_key(self):
        _s3, invocation = self.prepared()
        source = invocation["input"]

        class Paginated:
            def __init__(self):
                self.requests = []

            def list_object_versions(self, **request):
                self.requests.append(request)
                if len(self.requests) == 1:
                    return {
                        "IsTruncated": True,
                        "Versions": [{"Key": source["objectKey"], "VersionId": "older"}],
                        "NextKeyMarker": source["objectKey"],
                        "NextVersionIdMarker": "older",
                    }
                return {
                    "IsTruncated": True,
                    "Versions": [{"Key": f"{source['objectKey']}.nearby", "VersionId": "other"}],
                    "NextKeyMarker": "not inspected",
                    "NextVersionIdMarker": "not inspected",
                }

        listing = Paginated()
        self.assertFalse(worker._input_version_exists(listing, source, worker._settings()))
        self.assertEqual(listing.requests[1]["KeyMarker"], source["objectKey"])
        self.assertEqual(listing.requests[1]["VersionIdMarker"], "older")

    def test_receipt_write_failure_removes_exact_uploaded_version(self):
        s3, invocation = self.prepared()
        s3.fail_receipt = True
        with self.assertRaises(ClientError):
            worker.handler(invocation, None, s3=s3)
        audio_put = next(value for value in s3.puts if value[1].endswith("input.m4a"))
        self.assertIn(audio_put, s3.deleted)
        self.assertNotIn((audio_put[0], audio_put[1], audio_put[2]), s3.objects)

    def test_output_head_mismatch_removes_exact_uploaded_version(self):
        s3, invocation = self.prepared()
        s3.bad_output_head = True
        with self.assertRaisesRegex(RuntimeError, "output verification failed"):
            worker.handler(invocation, None, s3=s3)
        audio_put = next(value for value in s3.puts if value[1].endswith("input.m4a"))
        self.assertIn(audio_put, s3.deleted)
        self.assertNotIn((audio_put[0], audio_put[1], audio_put[2]), s3.objects)

    def test_event_paths_and_artifact_are_exact(self):
        for change in ("audioKey", "receiptKey"):
            s3, invocation = self.prepared()
            invocation["output"][change] += ".changed"
            with self.assertRaises(worker.InvalidEvent):
                worker.handler(invocation, None, s3=s3)
            self.assertEqual(s3.puts, [])
        s3, invocation = self.prepared()
        invocation["ffmpegArtifactSha256"] = "c" * 64
        with self.assertRaises(worker.InvalidEvent):
            worker.handler(invocation, None, s3=s3)

    def test_artifact_manifest_binds_both_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            ffmpeg = Path(directory) / "ffmpeg"
            ffprobe = Path(directory) / "ffprobe"
            manifest_path = Path(directory) / "manifest.json"
            ffmpeg.write_bytes(b"ffmpeg-test")
            ffprobe.write_bytes(b"ffprobe-test")
            ffmpeg_hash = hashlib.sha256(ffmpeg.read_bytes()).hexdigest()
            ffprobe_hash = hashlib.sha256(ffprobe.read_bytes()).hexdigest()
            artifact_hash = hashlib.sha256(f"{ffmpeg_hash}\n{ffprobe_hash}\n".encode()).hexdigest()
            manifest_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "ffmpegVersion": "test",
                        "sourceSha256": "d" * 64,
                        "ffmpegSha256": ffmpeg_hash,
                        "ffprobeSha256": ffprobe_hash,
                        "artifactSha256": artifact_hash,
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "FFMPEG_PATH": str(ffmpeg),
                    "FFPROBE_PATH": str(ffprobe),
                    "FFMPEG_MANIFEST_PATH": str(manifest_path),
                    "FFMPEG_ARTIFACT_SHA256": artifact_hash,
                },
            ):
                self.assertEqual(ARTIFACT_IDENTITY()["artifactSha256"], artifact_hash)
                ffprobe.write_bytes(b"changed")
                with self.assertRaisesRegex(RuntimeError, "binary mismatch"):
                    ARTIFACT_IDENTITY()

    def test_receipt_audio_uses_ceil_for_tenth_second_minimum(self):
        value = {
            "codec": "aac",
            "profile": "LC",
            "sampleRate": 11025,
            "channels": 1,
            "startSamples": 0,
            "durationSamples": 1102,
            "frameSamples": worker.AAC_FRAME_SAMPLES,
            "packetCount": 1,
            "elementarySha256": "d" * 64,
        }
        with self.assertRaisesRegex(RuntimeError, "stream receipt is invalid"):
            worker._validate_receipt_audio(value)
        value["durationSamples"] = 1103
        self.assertEqual(worker._validate_receipt_audio(value), value)

    def test_probe_rejects_source_over_duration_bound(self):
        probe = {
            "streams": [{
                "codec_name": "aac",
                "profile": "LC",
                "sample_rate": "8000",
                "channels": 1,
                "time_base": "1/8000",
                "start_pts": 0,
                "duration_ts": 8000 * (worker.MAX_DURATION_SECONDS + 1),
            }],
            "packets": [{"stream_index": 0}],
        }
        result = subprocess.CompletedProcess([], 0, json.dumps(probe).encode(), b"")
        with patch.object(worker, "_run", return_value=result):
            with self.assertRaisesRegex(worker.TerminalFailure, "audio_duration_unsupported"):
                worker._probe_audio(Path("unused"), self.ffprobe, None, "audio_codec_unsupported")

    def test_elementary_hash_kills_stalled_process_within_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            program = Path(directory) / "stall.py"
            program.write_text(
                f"#!{sys.executable}\nimport sys, time\nsys.stdout.buffer.write(b'x')\nsys.stdout.flush()\ntime.sleep(5)\n",
                encoding="utf-8",
            )
            program.chmod(0o700)

            class Context:
                @staticmethod
                def get_remaining_time_in_millis():
                    return 60_001

            with self.assertRaises(subprocess.TimeoutExpired):
                worker._elementary_sha256(Path("unused"), str(program), Context(), "audio_output_invalid")


if __name__ == "__main__":
    unittest.main()
