"""Generated media and filesystem/network-boundary tests. No cloud calls."""
import hashlib
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from botocore.session import Session
from botocore.validate import validate_parameters

SPEC = importlib.util.spec_from_file_location("original_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class FileSource:
    def __init__(self, path):
        self.path, self.size, self.read_bytes = Path(path), Path(path).stat().st_size, 0

    def read(self, start, size):
        self.read_bytes += size
        with self.path.open("rb") as source:
            source.seek(start)
            value = source.read(size)
        if len(value) != size:
            raise RuntimeError("short fixture read")
        return value


def job(path, **changes):
    return {"id": "a" * 64, "attemptId": "00000000-0000-4000-8000-000000000001", "kind": "clip",
            "scope": "clip", "format": "original_copy", "sourceId": "video-library", "assetId": "synthetic",
            "sourceObjectKey": "objects/synthetic.mp4", "sourceObjectVersionId": "fixture-version-1",
            "sourceSizeBytes": Path(path).stat().st_size, "inMs": 2500, "outMs": 4500, **changes}


class S3Boundary:
    """In-memory S3 boundary; every request is checked against the SDK service model."""
    def __init__(self, source):
        self.source = Path(source).read_bytes()
        self.model = Session().get_service_model("s3")
        self.parts, self.objects, self.receipts = {}, {}, {}
        self.source_version = "fixture-version-1"
        self.corrupt_checksum = False
        self.aborted = False

    def validate(self, operation, params):
        validate_parameters(params, self.model.operation_model(operation).input_shape)
        assert params["ExpectedBucketOwner"] == "123456789012"

    def head_object(self, **params):
        self.validate("HeadObject", params)
        if params["Bucket"] == "synthetic-originals":
            assert params["VersionId"] == "fixture-version-1"
            return {"VersionId": self.source_version, "ContentLength": len(self.source)}
        assert params["VersionId"] == "output-version-1"
        item = self.objects[params["Key"]]
        hashes = [hashlib.sha256(self.parts[i]).digest() for i in sorted(self.parts)]
        checksum = base64.b64encode(hashlib.sha256(b"".join(hashes)).digest()).decode() + f"-{len(hashes)}"
        return {"VersionId": "output-version-1", "ContentLength": len(item),
                "ChecksumSHA256": "invalid" if self.corrupt_checksum else checksum,
                "Metadata": self.metadata, "ServerSideEncryption": "AES256"}

    def get_object(self, **params):
        self.validate("GetObject", params)
        assert params["Bucket"] == "synthetic-originals" and params["VersionId"] == "fixture-version-1"
        start, end = map(int, params["Range"].removeprefix("bytes=").split("-"))
        body = self.source[start:end + 1]
        return {"VersionId": self.source_version, "ContentLength": len(body),
                "ContentRange": f"bytes {start}-{end}/{len(self.source)}", "Body": io.BytesIO(body)}

    def create_multipart_upload(self, **params):
        self.validate("CreateMultipartUpload", params)
        assert params["ServerSideEncryption"] == "AES256"
        self.metadata = params["Metadata"]
        return {"UploadId": "synthetic-upload"}

    def upload_part(self, **params):
        self.validate("UploadPart", params)
        checksum = base64.b64encode(hashlib.sha256(params["Body"]).digest()).decode()
        assert checksum == params["ChecksumSHA256"]
        self.parts[params["PartNumber"]] = params["Body"]
        return {"ETag": f'"synthetic-etag-{params["PartNumber"]}"', "ChecksumSHA256": checksum}

    def complete_multipart_upload(self, **params):
        self.validate("CompleteMultipartUpload", params)
        assert params["IfNoneMatch"] == "*" and params["Key"] not in self.objects
        self.objects[params["Key"]] = b"".join(self.parts[p["PartNumber"]] for p in params["MultipartUpload"]["Parts"])
        return {"VersionId": "output-version-1"}

    def abort_multipart_upload(self, **params):
        self.validate("AbortMultipartUpload", params)
        self.aborted = True

    def delete_object(self, **params):
        self.validate("DeleteObject", params)
        assert params["VersionId"] == "output-version-1"
        del self.objects[params["Key"]]

    def put_object(self, **params):
        self.validate("PutObject", params)
        assert params["IfNoneMatch"] == "*" and params["Key"] not in self.receipts
        self.receipts[params["Key"]] = json.loads(params["Body"])
        return {"VersionId": "receipt-version-1"}


class WorkerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.generator = os.environ.get("FIXTURE_FFMPEG", shutil.which("ffmpeg"))
        if not cls.generator:
            raise RuntimeError("A fixture-generating FFmpeg is required; tests do not silently skip")
        cls.directory = Path(os.environ.get("FFMPEG_DIRECTORY", str(Path(shutil.which("ffmpeg")).parent)))
        cls.temp = tempfile.TemporaryDirectory(prefix="original-fixtures-")
        cls.root = Path(cls.temp.name)
        cls.h264 = cls.root / "h264.mp4"
        cls.prores = cls.root / "prores.mov"
        cls.unsupported = cls.root / "mpeg4.mp4"
        cls.multi_audio = cls.root / "prores-multi.mov"
        base = [cls.generator, "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=8",
                "-f", "lavfi", "-i", "sine=frequency=731:sample_rate=48000:duration=8", "-threads", "2"]
        subprocess.run([*base, "-c:v", "libx264", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-bf", "2",
                        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(cls.h264)], check=True, timeout=60)
        subprocess.run([*base, "-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le",
                        "-c:a", "pcm_s16le", str(cls.prores)], check=True, timeout=60)
        subprocess.run([*base, "-c:v", "mpeg4", "-c:a", "aac", str(cls.unsupported)], check=True, timeout=60)
        subprocess.run([cls.generator, "-nostdin", "-v", "error", "-i", str(cls.prores),
                        "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=8",
                        "-map", "0:v", "-map", "0:a", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s24le",
                        str(cls.multi_audio)], check=True, timeout=60)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def frames(self, path):
        result = subprocess.run([self.generator, "-v", "error", "-i", str(path), "-map", "0:v:0", "-an",
                                 "-f", "framemd5", "-"], capture_output=True, check=True, timeout=60)
        return [line.rsplit(",", 1)[1].strip() for line in result.stdout.decode().splitlines() if not line.startswith("#")]

    def extract(self, path, **changes):
        directory = tempfile.TemporaryDirectory(prefix="original-output-")
        self.addCleanup(directory.cleanup)
        source = FileSource(path)
        with worker.input_server(source) as url:
            result = worker.extract(source, url, job(path, **changes), self.directory, directory.name, worker.Budget(120))
        return result

    def assert_frame_provenance(self, source, path, receipt):
        original, actual = self.frames(source), self.frames(path)
        matches = [start for start in range(len(original) - len(actual) + 1) if original[start:start + len(actual)] == actual]
        self.assertEqual(len(matches), 1)
        self.assertEqual(receipt["sourceStartSeconds"], matches[0] / 25)
        self.assertEqual(receipt["sourceEndSeconds"], (matches[0] + len(actual)) / 25)
        self.assertEqual(receipt["sourceFrameDurationSeconds"], 1 / 25)

    def test_h264_b_frames_have_proven_source_coverage_and_unchanged_audio_offset(self):
        path, receipt = self.extract(self.h264)
        self.assertEqual(receipt["videoCodec"], "h264")
        self.assertEqual(receipt["sourceStartSeconds"], 2)
        self.assertLessEqual(receipt["sourceStartSeconds"], 2.5)
        self.assertGreaterEqual(receipt["sourceEndSeconds"], 4.5)
        self.assert_frame_provenance(self.h264, path, receipt)
        video, audio = receipt["provenance"]["streams"]
        self.assertAlmostEqual(video["timestampOffsetSeconds"], audio["timestampOffsetSeconds"], places=6)
        self.assertEqual(audio["codec"], "aac")
        self.assertGreater(audio["initialSkipSamples"], 0)
        self.assertEqual(receipt["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_prores_pcm_preserves_frames_and_reports_frame_adjusted_bounds(self):
        path, receipt = self.extract(self.prores)
        self.assertEqual(receipt["videoCodec"], "prores")
        self.assertEqual(receipt["provenance"]["streams"][1]["codec"], "pcm_s16le")
        self.assert_frame_provenance(self.prores, path, receipt)
        self.assertLessEqual(2.5 - receipt["sourceStartSeconds"], 1 / 25)

    def test_multiple_pcm24_tracks_keep_channel_order_and_source_mapping(self):
        path, receipt = self.extract(self.multi_audio)
        self.assert_frame_provenance(self.multi_audio, path, receipt)
        streams = receipt["provenance"]["streams"]
        self.assertEqual([s["codec"] for s in streams], ["prores", "pcm_s24le", "pcm_s24le"])
        self.assertEqual([s["sourceIndex"] for s in streams], [0, 1, 2])
        self.assertEqual(len({s["packetSha256"] for s in streams}), 3)
        self.assertEqual(len({s["timestampOffsetSeconds"] for s in streams}), 1)

    def test_first_frame_and_end_of_file_ranges_preserve_whole_gops(self):
        for start, end in [(0, 250), (6500, 8000)]:
            with self.subTest(start=start, end=end):
                path, receipt = self.extract(self.h264, inMs=start, outMs=end)
                self.assert_frame_provenance(self.h264, path, receipt)

    def publish(self, path, **changes):
        directory = tempfile.TemporaryDirectory(prefix="original-publish-")
        self.addCleanup(directory.cleanup)
        boundary = S3Boundary(path)
        result = worker.run_job(job(path, **changes), boundary, self.directory, "f" * 64,
                                "synthetic-originals", "synthetic-renditions", "123456789012",
                                directory.name, worker.Budget(120))
        return boundary, result

    def test_completed_s3_receipt_points_to_identical_verified_private_bytes(self):
        boundary, result = self.publish(self.h264)
        output = result["original"]
        self.assertEqual(output["objectVersionId"], "output-version-1")
        self.assertEqual((output["sourceStartSeconds"], output["sourceEndSeconds"]), (2, 6))
        self.assertEqual(output["sha256"], hashlib.sha256(boundary.objects[output["objectKey"]]).hexdigest())
        self.assertEqual(list(boundary.receipts.values()), [result])

    def test_known_media_rejection_has_a_bounded_failure_receipt_and_no_media(self):
        boundary, result = self.publish(self.unsupported)
        self.assertEqual(result, {"id": "a" * 64, "attemptId": "00000000-0000-4000-8000-000000000001",
                                  "errorCode": "original_media_unsupported"})
        self.assertEqual(boundary.objects, {})
        self.assertEqual(list(boundary.receipts.values()), [result])



    def test_unknown_codec_is_rejected_before_remux(self):
        with self.assertRaisesRegex(worker.Rejected, "video_codec_unsupported"):
            self.extract(self.unsupported)

    def test_missing_next_boundary_or_range_outside_source_is_rejected(self):
        with self.assertRaisesRegex(worker.Rejected, "safe_boundary_unavailable"):
            self.extract(self.h264, inMs=7500, outMs=9000)

    def test_reencoded_packets_cannot_claim_original_source_provenance(self):
        directory = tempfile.TemporaryDirectory(prefix="changed-packets-")
        self.addCleanup(directory.cleanup)
        changed = Path(directory.name) / "reencoded.mov"
        subprocess.run([self.generator, "-nostdin", "-v", "error", "-ss", "2", "-i", str(self.h264),
                        "-t", "4", "-c:v", "libx264", "-crf", "32", "-c:a", "copy", str(changed)], check=True, timeout=60)
        tools = worker.Tools(self.directory, directory.name, worker.Budget(120))
        source_db = tools.packets(self.h264, "source")
        changed_db = tools.packets(changed, "changed")
        try:
            video, audios = worker.inspect(tools.probe(self.h264))
            out_video, out_audios = worker.inspect(tools.probe(changed))
            with self.assertRaisesRegex(worker.Rejected, "source_mapping_ambiguous|output_codec_parameters_changed"):
                worker.verify_packets(source_db, changed_db, [video, *audios], [out_video, *out_audios], 0)
        finally:
            source_db.close()
            changed_db.close()


    def test_deadline_fails_before_publishing(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = FileSource(self.h264)
        with worker.input_server(source) as url, self.assertRaisesRegex(worker.Rejected, "task_deadline_exceeded"):
            worker.extract(source, url, job(self.h264), self.directory, directory.name, worker.Budget(-1))


class ContractTest(unittest.TestCase):
    """Quick SDK/file boundary checks; no FFmpeg executable or cloud credentials needed."""
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="original-contract-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.directory = self.root / "unused-binaries"
        self.source = self.root / "source.bin"
        self.source.write_bytes(b"synthetic source bytes")

    def test_changed_source_version_never_reads_or_publishes_media(self):
        boundary = S3Boundary(self.source)
        boundary.source_version = "replaced-version"
        with self.assertRaisesRegex(worker.Rejected, "source_changed"):
            worker.run_job(job(self.source), boundary, self.directory, "f" * 64,
                           "synthetic-originals", "synthetic-renditions", "123456789012", self.root, worker.Budget(120))
        self.assertEqual(boundary.objects, {})
        self.assertEqual(boundary.receipts, {})

    def test_multipart_checksum_failure_removes_only_the_bad_output_version(self):
        boundary = S3Boundary(self.source)
        boundary.corrupt_checksum = True
        path = self.root / "multipart.bin"
        path.write_bytes(b"synthetic-block!" * (2 * 1024**2))
        with self.assertRaisesRegex(worker.Rejected, "uploaded_output_invalid"):
            worker.upload_output(boundary, path, "synthetic-renditions", "outputs/synthetic.mov", "123456789012",
                                 worker.Budget(60), hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertGreater(len(boundary.parts), 1)
        self.assertEqual(boundary.objects, {})
        self.assertEqual(boundary.receipts, {})

    def test_job_contract_rejects_cross_source_and_oversized_ranges(self):
        for changes in [{"sourceId": "archive"}, {"sourceSizeBytes": worker.MAX_SOURCE + 1}, {"inMs": True},
                        {"sourceObjectKey": "private/other.mp4"}, {"outMs": 2_000_000}, {"unknown": "field"}]:
            with self.subTest(changes=changes), self.assertRaises(worker.Rejected):
                worker.validate_job(job(self.source, **changes))


if __name__ == "__main__":
    unittest.main()
