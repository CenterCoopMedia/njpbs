"""Version-pinned original-range remux. The caller owns admission and reconciliation."""
from __future__ import annotations

import hashlib
import http.server
import json
import math
import os
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from fractions import Fraction
from pathlib import Path

REVISION = "original-copy-v1"
MAX_SOURCE = 250 * 1024**3
MAX_OUTPUT = 64 * 1024**3
MAX_READ = 512 * 1024**3
MAX_MANIFEST = 512 * 1024**2
MAX_PACKETS = 1_000_000
MAX_PACKET = 64 * 1024**2
MAX_EXPANSION = 30
PART_BYTES = 16 * 1024**2
HEX = re.compile(r"^[a-f0-9]{64}$")
ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
AUDIO_CODECS = {"aac", "pcm_s16le", "pcm_s24le"}
MEDIA_FAILURES = {
    "stream_layout_unsupported", "video_codec_unsupported", "audio_codec_unsupported",
    "h264_representation_unsupported", "frame_rate_unsupported", "dimensions_unsupported",
    "duration_unsupported", "h264_packet_unsupported", "variable_frame_rate_unsupported",
}
TIMING_FAILURES = {
    "timeline_unsupported", "packet_timeline_unsupported", "safe_boundary_unavailable",
    "movie_timescale_unsupported", "output_stream_layout_changed", "output_codec_changed",
    "output_codec_parameters_changed", "output_stream_empty", "source_mapping_ambiguous",
    "source_mapping_unverified", "audio_video_offset_changed", "output_start_not_random_access",
    "output_packet_interval_invalid", "output_coverage_invalid", "output_duration_invalid",
}
LIMIT_FAILURES = {"packet_limit_exceeded", "tool_output_limit_exceeded", "output_size_exceeded"}


class Rejected(RuntimeError):
    """A bounded, non-secret failure code safe for an external receipt."""


def check(condition, code):
    if not condition:
        raise Rejected(code)


def rational(value):
    try:
        result = Fraction(str(value))
        check(abs(result) <= 10**12, "timeline_unsupported")
        return result
    except (ValueError, ZeroDivisionError):
        raise Rejected("timeline_unsupported") from None


def digest_file(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Budget:
    def __init__(self, seconds=3600):
        self.deadline = time.monotonic() + seconds
        self.bytes = 0
        self.requests = 0
        self.lock = threading.Lock()

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        check(remaining > 0, "task_deadline_exceeded")
        return remaining

    def read(self, size):
        self.remaining()
        with self.lock:
            self.bytes += size
            self.requests += 1
            check(self.bytes <= MAX_READ and self.requests <= 100_000, "source_read_budget_exceeded")


def artifact_identity():
    directory = Path(os.environ.get("FFMPEG_DIRECTORY", "/opt/bin"))
    manifest = json.loads((directory / "ffmpeg-manifest.json").read_text())
    binaries = [digest_file(directory / name) for name in ("ffmpeg", "ffprobe")]
    identity = hashlib.sha256(("\n".join(binaries) + "\n").encode()).hexdigest()
    check(manifest.get("schemaVersion") == 1 and manifest.get("ffmpegVersion") == "9.0.2" and
          manifest.get("ffmpegSha256") == binaries[0] and manifest.get("ffprobeSha256") == binaries[1] and
          manifest.get("artifactSha256") == identity == os.environ.get("FFMPEG_ARTIFACT_SHA256"),
          "artifact_identity_invalid")
    return directory, identity


def validate_job(job):
    required = {"id", "attemptId", "kind", "scope", "format", "sourceId", "assetId",
                "sourceObjectKey", "sourceObjectVersionId", "sourceSizeBytes", "inMs", "outMs"}
    optional = {"inputObjectKey", "inputObjectVersionId", "inputSizeBytes"}
    check(isinstance(job, dict) and required <= set(job) <= required | optional, "job_fields_invalid")
    check(isinstance(job["id"], str) and HEX.fullmatch(job["id"]) and
          all(isinstance(job[k], str) and ID.fullmatch(job[k]) for k in ("attemptId", "assetId")), "job_identity_invalid")
    check((job["kind"], job["scope"], job["format"], job["sourceId"]) ==
          ("clip", "clip", "original_copy", "video-library"), "job_format_invalid")
    check(isinstance(job["sourceObjectKey"], str) and job["sourceObjectKey"].startswith("objects/") and
          len(job["sourceObjectKey"]) <= 1024 and "\x00" not in job["sourceObjectKey"] and
          isinstance(job["sourceObjectVersionId"], str) and 0 < len(job["sourceObjectVersionId"]) <= 1024,
          "source_identity_invalid")
    check(job["sourceObjectVersionId"] != "null", "source_identity_invalid")
    check(type(job["sourceSizeBytes"]) is int and 0 < job["sourceSizeBytes"] <= MAX_SOURCE, "source_size_invalid")
    check(type(job["inMs"]) is int and type(job["outMs"]) is int and 0 <= job["inMs"] and
          250 <= job["outMs"] - job["inMs"] <= 1_800_000 and job["outMs"] <= 86_400_000, "range_invalid")
    return job


class S3Source:
    def __init__(self, s3, bucket, owner, job, budget):
        self.s3, self.bucket, self.owner, self.job, self.budget = s3, bucket, owner, job, budget
        self.size = job["sourceSizeBytes"]
        head = s3.head_object(**self.target())
        check(head.get("VersionId") == job["sourceObjectVersionId"] and head.get("ContentLength") == self.size,
              "source_changed")

    def target(self):
        return {"Bucket": self.bucket, "Key": self.job["sourceObjectKey"],
                "VersionId": self.job["sourceObjectVersionId"], "ExpectedBucketOwner": self.owner}

    def read(self, start, size):
        check(0 <= start < self.size and 0 < size <= MAX_PACKET and start + size <= self.size, "source_range_invalid")
        self.budget.read(size)
        response = self.s3.get_object(**self.target(), Range=f"bytes={start}-{start + size - 1}")
        try:
            check(response.get("VersionId") == self.job["sourceObjectVersionId"] and
                  response.get("ContentLength") == size and
                  response.get("ContentRange") == f"bytes {start}-{start + size - 1}/{self.size}", "source_changed")
            data = response["Body"].read(size + 1)
            check(len(data) == size, "source_read_incomplete")
            return data
        finally:
            response["Body"].close()


@contextmanager
def input_server(source):
    """FFmpeg gets only a loopback URL; S3 credentials never enter its command or logs."""
    path = "/" + secrets.token_hex(24)

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path != path:
                self.send_error(404)
                return
            match = re.fullmatch(r"bytes=(\d+)-(\d*)", self.headers.get("Range", ""))
            if self.headers.get("Range") and not match:
                self.send_error(416)
                return
            start = int(match[1]) if match else 0
            end = min(int(match[2]) if match and match[2] else source.size - 1, source.size - 1)
            if not 0 <= start <= end < source.size:
                self.send_error(416)
                return
            self.send_response(206 if match else 200)
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Accept-Ranges", "bytes")
            if match:
                self.send_header("Content-Range", f"bytes {start}-{end}/{source.size}")
            self.end_headers()
            try:
                while start <= end:
                    data = source.read(start, min(8 * 1024 * 1024, end + 1 - start))
                    self.wfile.write(data)
                    start += len(data)
            except Exception:
                # SDK exceptions can contain source keys. Never let the HTTP server log them.
                self.close_connection = True

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}{path}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


class Tools:
    def __init__(self, directory, work, budget):
        self.directory, self.work, self.budget = Path(directory), Path(work), budget

    def run(self, name, args, output, limit=MAX_MANIFEST, media=None):
        # Poll disk use as well as the wall clock. Linux adds a hard per-file limit.
        command = [str(self.directory / name), "-v", "error", *args]
        if os.name == "posix":
            command = [sys.executable, str(Path(__file__).with_name("limit_exec.py")),
                       str(MAX_OUTPUT if media else limit), *command]
        with Path(output).open("wb") as stdout, tempfile.TemporaryFile() as stderr:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
            try:
                while child.poll() is None:
                    self.budget.remaining()
                    check(stdout.tell() <= limit and stderr.tell() <= 1024 * 1024, "tool_output_limit_exceeded")
                    if media and Path(media).exists():
                        check(Path(media).stat().st_size <= MAX_OUTPUT, "output_size_exceeded")
                    time.sleep(0.02)
                if child.returncode and media and Path(media).exists():
                    check(Path(media).stat().st_size < MAX_OUTPUT, "output_size_exceeded")
                if child.returncode:
                    check(stdout.tell() < limit, "tool_output_limit_exceeded")
                check(child.returncode == 0, "media_tool_failed")
                check(stdout.tell() <= limit and stderr.tell() <= 1024 * 1024, "tool_output_limit_exceeded")
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait()

    @staticmethod
    def input_args(url):
        # The MOV demuxer cannot follow external data references. Other demuxers are disabled.
        return ["-protocol_whitelist", "file,http,tcp", "-enable_drefs", "0", "-f", "mov", "-i", str(url)]

    def probe(self, url):
        path = self.work / (secrets.token_hex(8) + ".json")
        self.run("ffprobe", [*self.input_args(url), "-show_streams", "-show_format", "-show_data_hash", "sha256", "-of", "json"], path, 1024 * 1024)
        return json.loads(path.read_text(encoding="utf-8"))

    def packets(self, url, name, interval=None):
        path = self.work / (name + ".packets")
        args = (["-read_intervals", interval] if interval else [])
        self.run("ffprobe", [*args, *self.input_args(url), "-show_packets", "-show_data_hash", "sha256",
                 "-show_entries", "packet=stream_index,pts,dts,duration,size,pos,flags,data_hash",
                 "-of", "compact=p=0:nk=0"], path)
        database = sqlite3.connect(self.work / (name + ".sqlite"))
        database.execute("CREATE TABLE packets(stream INTEGER, ordinal INTEGER, pts INTEGER, dts INTEGER, duration INTEGER, size INTEGER, position INTEGER, flags TEXT, hash TEXT, skip INTEGER, padding INTEGER, PRIMARY KEY(stream,ordinal))")
        counts = {}
        try:
            with path.open(encoding="utf-8") as rows:
                for index, line in enumerate(rows):
                    check(index < MAX_PACKETS and len(line) < 4096, "packet_limit_exceeded")
                    fields = dict(part.split("=", 1) for part in line.strip().split("|") if "=" in part)
                    try:
                        stream = int(fields["stream_index"])
                        pts, dts, duration, size, position = (int(fields[key]) for key in ("pts", "dts", "duration", "size", "pos"))
                        digest = fields["data_hash"].removeprefix("SHA256:")
                        skip = int(next((v for k, v in fields.items() if k.endswith(":skip_samples")), "0"))
                        padding = int(next((v for k, v in fields.items() if k.endswith(":discard_padding")), "0"))
                    except (KeyError, ValueError):
                        raise Rejected("packet_timeline_unsupported") from None
                    flags = fields.get("flags", "")
                    check(duration > 0 and 0 < size <= MAX_PACKET and HEX.fullmatch(digest) and
                          skip >= 0 and padding >= 0 and len(flags) <= 8, "packet_timeline_unsupported")
                    ordinal = counts.get(stream, 0)
                    database.execute("INSERT INTO packets VALUES(?,?,?,?,?,?,?,?,?,?,?)", (stream, ordinal, pts, dts, duration, size, position, flags, digest, skip, padding))
                    counts[stream] = ordinal + 1
            database.execute("CREATE INDEX hashes ON packets(stream,hash,size)")
            database.commit()
            check((self.work / (name + ".sqlite")).stat().st_size <= MAX_MANIFEST, "packet_limit_exceeded")
        except BaseException:
            database.close()
            raise
        return database


def inspect(probe):
    streams = probe.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    check(len(videos) == 1 and len(audios) <= 8 and len(streams) == 1 + len(audios), "stream_layout_unsupported")
    check(all(type(s.get("index")) is int and 0 <= s["index"] <= 32 for s in streams), "stream_layout_unsupported")
    video = videos[0]
    check(video.get("codec_name") in ("h264", "prores") and not video.get("disposition", {}).get("attached_pic"), "video_codec_unsupported")
    check(all(s.get("codec_name") in AUDIO_CODECS and 1 <= s.get("channels", 0) <= 8 for s in audios), "audio_codec_unsupported")
    check(all(s.get("codec_name") != "aac" or s.get("profile") == "LC" for s in audios), "audio_codec_unsupported")
    check(video.get("codec_name") != "h264" or (video.get("is_avc") == "true" and video.get("nal_length_size") in ("1", "2", "4")), "h264_representation_unsupported")
    rate = rational(video.get("avg_frame_rate", "0"))
    check(1 <= rate <= 60 and rate == rational(video.get("r_frame_rate", "0")), "frame_rate_unsupported")
    check(all(rational(s.get("time_base", "0")) > 0 and "start_pts" in s for s in streams), "timeline_unsupported")
    check(0 < int(video.get("width", 0)) <= 16384 and 0 < int(video.get("height", 0)) <= 16384, "dimensions_unsupported")
    check(0 < rational(video.get("duration", "0")) <= 86400, "duration_unsupported")
    return video, audios


def is_idr(source, row, video):
    if video["codec_name"] == "prores":
        return "K" in row[7]
    if "K" not in row[7]:
        return False
    data = source.read(row[6], row[5])
    check(hashlib.sha256(data).hexdigest() == row[8], "packet_source_mismatch")
    width = int(video["nal_length_size"])
    position, idr = 0, False
    while position < len(data):
        length = int.from_bytes(data[position:position + width], "big")
        position += width
        check(0 < length <= len(data) - position, "h264_packet_unsupported")
        nal_type = data[position] & 31
        if nal_type == 1:
            return False
        idr |= nal_type == 5
        position += length
    return idr


def choose_bounds(source, database, video, job):
    tb = rational(video["time_base"])
    origin = int(video["start_pts"]) * tb
    wanted_start, wanted_end = Fraction(job["inMs"], 1000), Fraction(job["outMs"], 1000)
    safe = []
    for row in database.execute("SELECT * FROM packets WHERE stream=? AND flags LIKE '%K%' ORDER BY pts", (video["index"],)):
        when = row[2] * tb - origin
        if wanted_start - MAX_EXPANSION <= when <= wanted_end + MAX_EXPANSION and is_idr(source, row, video):
            safe.append((when, row[1]))
    starts = [p for p in safe if 0 <= p[0] <= wanted_start]
    ends = [p for p in safe if p[0] >= wanted_end]
    duration = rational(video["duration"])
    if duration >= wanted_end and duration - wanted_end <= MAX_EXPANSION:
        last = database.execute("SELECT MAX(ordinal) FROM packets WHERE stream=?", (video["index"],)).fetchone()[0]
        ends.append((duration, last + 1))
    check(starts and ends, "safe_boundary_unavailable")
    first, last = max(starts), min(ends)
    check(last[1] > first[1], "safe_boundary_unavailable")
    return first[0], last[0], origin, last[1] - first[1]


def verify_packets(source_db, output_db, source_streams, output_streams, origin):
    check(len(source_streams) == len(output_streams), "output_stream_layout_changed")
    receipts, common_offset = [], None
    for original, output in zip(source_streams, output_streams):
        check(original["codec_name"] == output["codec_name"] and original["codec_type"] == output["codec_type"], "output_codec_changed")
        for field in ("width", "height", "pix_fmt", "sample_rate", "channels", "bits_per_sample", "extradata_size", "extradata_hash"):
            check(original.get(field) == output.get(field), "output_codec_parameters_changed")
        source_tb, output_tb = rational(original["time_base"]), rational(output["time_base"])
        first = output_db.execute("SELECT * FROM packets WHERE stream=? ORDER BY ordinal LIMIT 1", (output["index"],)).fetchone()
        check(first, "output_stream_empty")
        candidates = source_db.execute("SELECT ordinal FROM packets WHERE stream=? AND hash=? AND size=? LIMIT 17",
                                       (original["index"], first[8], first[5])).fetchall()
        check(0 < len(candidates) <= 16, "source_mapping_ambiguous")
        matches = []
        for (ordinal,) in candidates:
            inputs = source_db.execute("SELECT * FROM packets WHERE stream=? AND ordinal>=? ORDER BY ordinal", (original["index"], ordinal))
            outputs = output_db.execute("SELECT * FROM packets WHERE stream=? ORDER BY ordinal", (output["index"],))
            digest, count, offset, bounds = hashlib.sha256(), 0, None, None
            skip, padding = 0, 0
            for out in outputs:
                src = next(inputs, None)
                if not src or src[5] != out[5] or src[8] != out[8]:
                    break
                delta = out[2] * output_tb - src[2] * source_tb
                offset = delta if offset is None else offset
                tolerance = max(source_tb, output_tb)
                if (abs(delta - offset) > tolerance or
                        abs(out[3] * output_tb - src[3] * source_tb - offset) > tolerance or
                        abs(out[4] * output_tb - src[4] * source_tb) > tolerance):
                    break
                # Trim metadata is allowed only at a stream boundary, never inside a copied stream.
                if out[9] and count:
                    break
                skip = out[9] if count == 0 else skip
                if padding:
                    break
                padding = out[10]
                values = (src[2] * source_tb - origin, (src[2] + src[4]) * source_tb - origin,
                          out[2] * output_tb, (out[2] + out[4]) * output_tb)
                bounds = values if bounds is None else (min(bounds[0], values[0]), max(bounds[1], values[1]),
                                                       min(bounds[2], values[2]), max(bounds[3], values[3]))
                digest.update(bytes.fromhex(src[8]) + src[5].to_bytes(8, "big"))
                count += 1
            else:
                if count:
                    matches.append((ordinal, count, digest.hexdigest(), offset, bounds, skip, padding))
            inputs.close()
            outputs.close()
        check(len(matches) == 1, "source_mapping_unverified")
        ordinal, count, digest, offset, bounds, skip, padding = matches[0]
        normalized_offset = offset + origin
        if common_offset is None:
            common_offset = normalized_offset
        check(abs(normalized_offset - common_offset) <= max(source_tb, output_tb), "audio_video_offset_changed")
        receipts.append({"sourceIndex": original["index"], "outputIndex": output["index"], "kind": original["codec_type"],
                         "codec": original["codec_name"], "packetCount": count, "packetSha256": digest,
                         "sourceTimeBase": f"{source_tb.numerator}/{source_tb.denominator}",
                         "outputTimeBase": f"{output_tb.numerator}/{output_tb.denominator}",
                         "sourceStartSeconds": float(bounds[0]), "sourceEndSeconds": float(bounds[1]),
                         "outputStartSeconds": float(bounds[2]), "outputEndSeconds": float(bounds[3]),
                         "timestampOffsetSeconds": float(normalized_offset),
                         "initialSkipSamples": skip, "discardPadding": padding})
    return receipts


def extract(source, url, job, directory, work, budget):
    tools = Tools(directory, work, budget)
    source_probe = tools.probe(url)
    video, audios = inspect(source_probe)
    start = max(0, job["inMs"] / 1000 - MAX_EXPANSION - 1)
    end = min(float(rational(video["duration"])), job["outMs"] / 1000 + MAX_EXPANSION + 1)
    source_db = tools.packets(url, "source", f"{start:.6f}%{end:.6f}")
    output_db = None
    try:
        actual_in, actual_out, origin, video_packets = choose_bounds(source, source_db, video, job)
        timescale = math.lcm(*(rational(s["time_base"]).denominator for s in [video, *audios]))
        check(timescale < 2**31, "movie_timescale_unsupported")
        path = Path(work) / "original.mov"
        tools.run("ffmpeg", ["-nostdin", "-n", "-ss", str(float(actual_in)), *tools.input_args(url),
                  "-t", str(float(actual_out - actual_in)), "-frames:v", str(video_packets),
                  "-map", "0:v:0", "-map", "0:a?", "-c", "copy",
                  "-map_metadata", "-1", "-map_chapters", "-1", "-avoid_negative_ts", "disabled",
                  "-movie_timescale", str(timescale),
                  "-f", "mov", str(path)], Path(work) / "copy.log", media=path)
        check(0 < path.stat().st_size <= MAX_OUTPUT, "output_size_exceeded")
        output_probe = tools.probe(path)
        out_video, out_audios = inspect(output_probe)
        output_db = tools.packets(path, "output")
        streams = verify_packets(source_db, output_db, [video, *audios], [out_video, *out_audios], origin)
        evidence = streams[0]
        # Re-identify the first retained video packet and require an independently checked IDR/intra frame.
        first_out = output_db.execute("SELECT * FROM packets WHERE stream=? ORDER BY ordinal LIMIT 1", (out_video["index"],)).fetchone()
        first_src = source_db.execute("SELECT * FROM packets WHERE stream=? AND hash=? AND size=?", (video["index"], first_out[8], first_out[5])).fetchall()
        check(len(first_src) == 1 and is_idr(source, first_src[0], video), "output_start_not_random_access")
        frame = 1 / rational(video["avg_frame_rate"])
        check(all(row[0] * rational(video["time_base"]) == frame for row in source_db.execute(
            "SELECT DISTINCT duration FROM packets WHERE stream=?", (video["index"],))), "variable_frame_rate_unsupported")
        unique_pts = output_db.execute("SELECT COUNT(DISTINCT pts) FROM packets WHERE stream=?", (out_video["index"],)).fetchone()[0]
        check(unique_pts == video_packets, "output_packet_interval_invalid")
        source_start, source_end = evidence["sourceStartSeconds"], evidence["sourceEndSeconds"]
        check(abs(source_start - float(actual_in)) < 1e-6 and abs(source_end - float(actual_out)) < 1e-6 and
              evidence["packetCount"] == video_packets and
              abs((source_end - source_start) - video_packets * float(frame)) < 1e-6, "output_packet_interval_invalid")
        check(0 <= job["inMs"] / 1000 - source_start <= MAX_EXPANSION and
              -1e-6 <= source_end - job["outMs"] / 1000 <= MAX_EXPANSION, "output_coverage_invalid")
        check(abs(float(rational(out_video["duration"])) - (source_end - source_start)) <= float(frame), "output_duration_invalid")
        # A decode-only pass rejects broken references; the published MOV remains the copied file.
        tools.run("ffmpeg", ["-nostdin", "-xerror", "-err_detect", "explode", *tools.input_args(path),
                  "-map", "0:v:0", "-an", "-threads", "2", "-c:v", "wrapped_avframe", "-f", "null", "-"], Path(work) / "decode.log")
        return path, {"mimeType": "video/quicktime", "container": "quicktime", "videoCodec": video["codec_name"],
                      "sizeBytes": path.stat().st_size, "sha256": digest_file(path),
                      "width": video["width"], "height": video["height"],
                      "durationSeconds": float(rational(out_video["duration"])), "sourceFrameDurationSeconds": float(frame),
                      "sourceStartSeconds": source_start, "sourceEndSeconds": source_end,
                      "requestedInMs": job["inMs"], "requestedOutMs": job["outMs"],
                      "provenance": {"revision": REVISION, "sourceObjectVersionId": job["sourceObjectVersionId"],
                                     "sourceSizeBytes": job["sourceSizeBytes"], "timingEvidence": "verified-packet-subsequence", "streams": streams}}
    finally:
        source_db.close()
        if output_db:
            output_db.close()


def upload_output(s3, path, bucket, key, owner, budget, sha256):
    import base64
    target = {"Bucket": bucket, "Key": key, "ExpectedBucketOwner": owner}
    started = s3.create_multipart_upload(**target, ContentType="video/quicktime", ChecksumAlgorithm="SHA256",
                                          ServerSideEncryption="AES256", Metadata={"sha256": sha256})
    parts, checksums, version = [], [], None
    try:
        with path.open("rb") as data:
            while chunk := data.read(PART_BYTES):
                budget.remaining()
                raw = hashlib.sha256(chunk).digest()
                checksum = base64.b64encode(raw).decode()
                uploaded = s3.upload_part(**target, UploadId=started["UploadId"], PartNumber=len(parts) + 1,
                                          Body=chunk, ChecksumSHA256=checksum)
                check(uploaded.get("ChecksumSHA256") == checksum, "upload_checksum_invalid")
                checksums.append(raw)
                parts.append({"PartNumber": len(parts) + 1, "ETag": uploaded["ETag"], "ChecksumSHA256": checksum})
        budget.remaining()
        completed = s3.complete_multipart_upload(**target, UploadId=started["UploadId"], MultipartUpload={"Parts": parts}, IfNoneMatch="*")
        version = completed.get("VersionId")
        check(isinstance(version, str) and version, "output_version_missing")
        expected = base64.b64encode(hashlib.sha256(b"".join(checksums)).digest()).decode() + f"-{len(parts)}"
        head = s3.head_object(**target, VersionId=version, ChecksumMode="ENABLED")
        check(head.get("VersionId") == version and head.get("ContentLength") == path.stat().st_size and
              head.get("ChecksumSHA256") == expected and head.get("Metadata", {}).get("sha256") == sha256 and
              head.get("ServerSideEncryption") == "AES256", "uploaded_output_invalid")
        return version
    except BaseException:
        try:
            if version:
                s3.delete_object(**target, VersionId=version)
            else:
                s3.abort_multipart_upload(**target, UploadId=started["UploadId"])
        except Exception:
            # A lost completion response can leave an orphan for the existing lifecycle rule.
            pass
        raise


def write_receipt(s3, receipt, rendition_bucket, owner, budget):
    encoded = json.dumps(receipt, separators=(",", ":"), allow_nan=False).encode()
    check(len(encoded) <= 64 * 1024, "receipt_too_large")
    try:
        budget.remaining()
        s3.put_object(Bucket=rendition_bucket,
                      Key=f"outputs/clips/{receipt['id']}/{receipt['attemptId']}/original-receipt.json",
                      ExpectedBucketOwner=owner, Body=encoded, ContentType="application/json", IfNoneMatch="*",
                      ServerSideEncryption="AES256")
    except BaseException:
        # A lost PutObject response may still have committed. Preserve media for reconciliation.
        raise Rejected("receipt_commit_unconfirmed") from None
    return receipt


def run_job(job, s3, directory, artifact, original_bucket, rendition_bucket, owner, work, budget):
    validate_job(job)
    source = S3Source(s3, original_bucket, owner, job, budget)
    try:
        with input_server(source) as url:
            path, output = extract(source, url, job, directory, work, budget)
    except Rejected as error:
        code = str(error)
        category = ("original_media_unsupported" if code in MEDIA_FAILURES else
                    "original_timing_unsupported" if code in TIMING_FAILURES else
                    "original_output_limit" if code in LIMIT_FAILURES else None)
        if not category:
            raise
        return write_receipt(s3, {"id": job["id"], "attemptId": job["attemptId"], "errorCode": category},
                             rendition_bucket, owner, budget)
    key = f"outputs/clips/{job['id']}/{job['attemptId']}/original.mov"
    version = upload_output(s3, path, rendition_bucket, key, owner, budget, output["sha256"])
    output.update({"objectKey": key, "objectVersionId": version})
    output["provenance"]["ffmpegArtifactSha256"] = artifact
    return write_receipt(s3, {"id": job["id"], "attemptId": job["attemptId"], "original": output},
                         rendition_bucket, owner, budget)


def main():
    import boto3
    from botocore.config import Config
    budget = Budget()
    watchdog = threading.Timer(3600, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    directory, artifact = artifact_identity()
    owner = os.environ.get("ACCOUNT_ID", "")
    original, rendition = os.environ.get("ORIGINAL_BUCKET", ""), os.environ.get("RENDITION_BUCKET", "")
    check(re.fullmatch(r"\d{12}", owner) and original and rendition and original != rendition, "storage_configuration_invalid")
    raw = os.environ.get("JOB_JSON", "")
    check(len(raw.encode()) <= 16 * 1024, "job_too_large")
    job = json.loads(raw)
    client = boto3.client("s3", region_name="us-east-2", config=Config(
        connect_timeout=5, read_timeout=30, retries={"mode": "standard", "total_max_attempts": 2}))
    with tempfile.TemporaryDirectory(prefix="original-clip-", dir=os.environ.get("OUTPUT_DIR", "/work")) as work:
        receipt = run_job(job, client, directory, artifact, original, rendition, owner, work, budget)
    print(json.dumps({"id": receipt["id"], "attemptId": receipt["attemptId"],
                      "status": "failed" if "errorCode" in receipt else "ready"}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK and subprocess errors can contain private keys or input URLs.
        print(json.dumps({"status": "failed", "code": str(error) if isinstance(error, Rejected) else "worker_failed"}))
        raise SystemExit(1) from None
