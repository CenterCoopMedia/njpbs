"""Create one exact-version, normal-speed M4A transcript input."""

from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import subprocess
import tempfile
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


REVISION = "aac-m4a-copy-v1"
MIME_TYPE = "audio/x-m4a"
MAX_INPUT_BYTES = 2_000_000_000
MAX_DURATION_SECONDS = 7200
MAX_DURATION_DRIFT_SECONDS = 0.5
MAX_VERSION_LIST_PAGES = 4
AAC_FRAME_SAMPLES = 1024
HEX = re.compile(r"^[a-f0-9]{64}$")
UUID4 = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
TERMINAL_FAILURES = {
    "input_changed",
    "audio_track_missing",
    "audio_codec_unsupported",
    "audio_timeline_unsupported",
    "audio_duration_unsupported",
    "audio_output_invalid",
}

S3 = boto3.client(
    "s3",
    config=Config(
        retries={"mode": "standard", "total_max_attempts": 3},
        connect_timeout=5,
        read_timeout=120,
    ),
)


class InvalidEvent(ValueError):
    """The invocation is outside the narrow preparation contract."""


class TerminalFailure(RuntimeError):
    """The exact input cannot produce a supported paid-provider input."""

    def __init__(self, code: str):
        if code not in TERMINAL_FAILURES:
            raise ValueError("invalid terminal failure code")
        self.code = code
        super().__init__(code)


def _exact_fields(value: Any, fields: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == fields


def _opaque(value: Any, limit: int = 1024) -> bool:
    return (
        isinstance(value, str)
        and 0 < len(value) <= limit
        and all(31 < ord(character) < 127 for character in value)
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_identity() -> dict[str, str]:
    manifest_path = Path(os.environ.get("FFMPEG_MANIFEST_PATH", "/opt/bin/ffmpeg-manifest.json"))
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("ffmpeg artifact manifest unavailable") from error
    fields = {
        "schemaVersion",
        "ffmpegVersion",
        "sourceSha256",
        "ffmpegSha256",
        "ffprobeSha256",
        "artifactSha256",
    }
    if not _exact_fields(manifest, fields) or manifest["schemaVersion"] != 1:
        raise RuntimeError("ffmpeg artifact manifest invalid")
    for field in fields - {"schemaVersion", "ffmpegVersion"}:
        if not HEX.fullmatch(manifest.get(field, "")):
            raise RuntimeError("ffmpeg artifact manifest invalid")
    ffmpeg_path = Path(os.environ.get("FFMPEG_PATH", "/opt/bin/ffmpeg"))
    ffprobe_path = Path(os.environ.get("FFPROBE_PATH", "/opt/bin/ffprobe"))
    if _sha256_file(ffmpeg_path) != manifest["ffmpegSha256"] or _sha256_file(ffprobe_path) != manifest["ffprobeSha256"]:
        raise RuntimeError("ffmpeg artifact binary mismatch")
    combined = hashlib.sha256(
        f"{manifest['ffmpegSha256']}\n{manifest['ffprobeSha256']}\n".encode("ascii")
    ).hexdigest()
    if combined != manifest["artifactSha256"]:
        raise RuntimeError("ffmpeg artifact identity mismatch")
    expected = os.environ.get("FFMPEG_ARTIFACT_SHA256", "")
    if manifest["artifactSha256"] != expected:
        raise RuntimeError("ffmpeg artifact is not the configured build")
    return manifest


def _settings() -> dict[str, str]:
    values = {
        "account_id": os.environ.get("EXPECTED_BUCKET_OWNER", ""),
        "bucket": os.environ.get("RENDITION_BUCKET", ""),
        "ffmpeg": os.environ.get("FFMPEG_PATH", "/opt/bin/ffmpeg"),
        "ffprobe": os.environ.get("FFPROBE_PATH", "/opt/bin/ffprobe"),
    }
    if not re.fullmatch(r"[0-9]{12}", values["account_id"]):
        raise RuntimeError("expected bucket owner is invalid")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", values["bucket"]):
        raise RuntimeError("rendition bucket is invalid")
    return values


def _validate_event(event: Any, settings: dict[str, str], artifact: dict[str, str]) -> dict[str, Any]:
    if not _exact_fields(
        event,
        {
            "schemaVersion",
            "preparationId",
            "invocationId",
            "revision",
            "ffmpegArtifactSha256",
            "input",
            "output",
        },
    ):
        raise InvalidEvent("audio preparation event fields are invalid")
    if (
        event["schemaVersion"] != 1
        or not HEX.fullmatch(event.get("preparationId", ""))
        or not UUID4.fullmatch(event.get("invocationId", ""))
        or event.get("revision") != REVISION
        or event.get("ffmpegArtifactSha256") != artifact["artifactSha256"]
    ):
        raise InvalidEvent("audio preparation event identity is invalid")
    source = event.get("input")
    output = event.get("output")
    if not _exact_fields(source, {"bucket", "objectKey", "objectVersionId", "sizeBytes", "durationSeconds"}):
        raise InvalidEvent("audio preparation input is invalid")
    if not _exact_fields(output, {"bucket", "audioKey", "receiptKey"}):
        raise InvalidEvent("audio preparation output is invalid")
    prefix = f"transcripts/inputs/audio/{event['preparationId']}"
    attempt = f"{prefix}/attempts/{event['invocationId']}/input.m4a"
    receipt = f"{prefix}/receipts/{event['invocationId']}.json"
    if (
        source.get("bucket") != settings["bucket"]
        or not _opaque(source.get("objectKey"))
        or not source["objectKey"].startswith("outputs/")
        or not _opaque(source.get("objectVersionId"))
        or not isinstance(source.get("sizeBytes"), int)
        or isinstance(source.get("sizeBytes"), bool)
        or not 0 < source["sizeBytes"] <= MAX_INPUT_BYTES
        or not isinstance(source.get("durationSeconds"), (int, float))
        or isinstance(source.get("durationSeconds"), bool)
        or not 0.1 <= source["durationSeconds"] <= MAX_DURATION_SECONDS
        or output != {"bucket": settings["bucket"], "audioKey": attempt, "receiptKey": receipt}
    ):
        raise InvalidEvent("audio preparation object identity is invalid")
    return event


def _input_receipt(event: dict[str, Any]) -> dict[str, Any]:
    source = event["input"]
    return {
        "objectKey": source["objectKey"],
        "objectVersionId": source["objectVersionId"],
        "sizeBytes": source["sizeBytes"],
    }


def _base_receipt(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "preparationId": event["preparationId"],
        "invocationId": event["invocationId"],
        "revision": REVISION,
        "ffmpegArtifactSha256": event["ffmpegArtifactSha256"],
        "input": _input_receipt(event),
    }


def _client_error_code(error: ClientError) -> str:
    return str(error.response.get("Error", {}).get("Code", ""))


def _read_receipt(s3: Any, event: dict[str, Any], settings: dict[str, str]) -> dict[str, Any] | None:
    bucket = event["output"]["bucket"]
    key = event["output"]["receiptKey"]
    if not _current_object_exists(s3, bucket, key, settings):
        return None
    try:
        response = s3.get_object(
            Bucket=bucket,
            Key=key,
            ExpectedBucketOwner=settings["account_id"],
        )
    except ClientError:
        if not _current_object_exists(s3, bucket, key, settings):
            return None
        raise
    try:
        body = response["Body"].read(64 * 1024 + 1)
    finally:
        response["Body"].close()
    if len(body) > 64 * 1024:
        raise RuntimeError("audio preparation receipt is too large")
    try:
        receipt = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("audio preparation receipt is invalid") from error
    _validate_existing_receipt(s3, event, receipt, settings)
    return receipt


def _current_object_exists(s3: Any, bucket: str, key: str, settings: dict[str, str]) -> bool:
    listing = s3.list_objects_v2(
        Bucket=bucket,
        Prefix=key,
        MaxKeys=1,
        ExpectedBucketOwner=settings["account_id"],
    )
    return any(value.get("Key") == key for value in listing.get("Contents", []))


def _validate_existing_receipt(
    s3: Any,
    event: dict[str, Any],
    receipt: Any,
    settings: dict[str, str],
) -> None:
    base = _base_receipt(event)
    common = {**base, "outcome": receipt.get("outcome") if isinstance(receipt, dict) else None}
    if not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in common.items()):
        raise RuntimeError("audio preparation receipt conflicts with this invocation")
    if receipt["outcome"] == "failed":
        if set(receipt) != set(base) | {"outcome", "failureCode"} or receipt.get("failureCode") not in TERMINAL_FAILURES:
            raise RuntimeError("audio preparation failure receipt is invalid")
        return
    if receipt["outcome"] != "ready" or set(receipt) != set(base) | {"outcome", "output", "sourceAudio", "outputAudio"}:
        raise RuntimeError("audio preparation ready receipt is invalid")
    output = receipt.get("output")
    if not _exact_fields(output, {"objectKey", "objectVersionId", "sizeBytes", "sha256", "mimeType"}):
        raise RuntimeError("audio preparation output receipt is invalid")
    if output.get("objectKey") != event["output"]["audioKey"] or output.get("mimeType") != MIME_TYPE:
        raise RuntimeError("audio preparation output receipt is invalid")
    if (
        not _opaque(output.get("objectVersionId"))
        or not isinstance(output.get("sizeBytes"), int)
        or isinstance(output.get("sizeBytes"), bool)
        or not 0 < output["sizeBytes"] <= event["input"]["sizeBytes"]
        or not HEX.fullmatch(output.get("sha256", ""))
    ):
        raise RuntimeError("audio preparation output receipt is invalid")
    source_audio = _validate_receipt_audio(receipt.get("sourceAudio"))
    output_audio = _validate_receipt_audio(receipt.get("outputAudio"))
    try:
        _validate_stream_copy(source_audio, output_audio)
    except TerminalFailure as error:
        raise RuntimeError("audio preparation stream receipt is invalid") from error
    source_duration = source_audio["durationSamples"] / source_audio["sampleRate"]
    if abs(source_duration - event["input"]["durationSeconds"]) > MAX_DURATION_DRIFT_SECONDS:
        raise RuntimeError("audio preparation stream receipt is invalid")
    response = s3.head_object(
        Bucket=event["output"]["bucket"],
        Key=output["objectKey"],
        VersionId=output["objectVersionId"],
        ExpectedBucketOwner=settings["account_id"],
    )
    metadata = response.get("Metadata", {})
    if (
        response.get("ContentLength") != output.get("sizeBytes")
        or response.get("ContentType") != MIME_TYPE
        or metadata.get("sha256") != output.get("sha256")
        or metadata.get("preparation-id") != event["preparationId"]
        or metadata.get("invocation-id") != event["invocationId"]
        or metadata.get("artifact-sha256") != event["ffmpegArtifactSha256"]
    ):
        raise RuntimeError("audio preparation output object is invalid")


def _validate_receipt_audio(value: Any) -> dict[str, Any]:
    fields = {
        "codec",
        "profile",
        "sampleRate",
        "channels",
        "startSamples",
        "durationSamples",
        "frameSamples",
        "packetCount",
        "elementarySha256",
    }
    if not _exact_fields(value, fields):
        raise RuntimeError("audio preparation stream receipt is invalid")
    integer_fields = {"sampleRate", "channels", "startSamples", "durationSamples", "frameSamples", "packetCount"}
    if any(not isinstance(value[field], int) or isinstance(value[field], bool) for field in integer_fields):
        raise RuntimeError("audio preparation stream receipt is invalid")
    if (
        value["codec"] != "aac"
        or value["profile"] != "LC"
        or not 8000 <= value["sampleRate"] <= 48000
        or not 1 <= value["channels"] <= 2
        or abs(value["startSamples"]) > 1
        or not (value["sampleRate"] + 9) // 10
        <= value["durationSamples"]
        <= value["sampleRate"] * MAX_DURATION_SECONDS
        or value["frameSamples"] != AAC_FRAME_SAMPLES
        or value["packetCount"] < 1
        or not HEX.fullmatch(value["elementarySha256"])
    ):
        raise RuntimeError("audio preparation stream receipt is invalid")
    return value


def _write_receipt(s3: Any, event: dict[str, Any], receipt: dict[str, Any], settings: dict[str, str]) -> None:
    body = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
    try:
        s3.put_object(
            Bucket=event["output"]["bucket"],
            Key=event["output"]["receiptKey"],
            Body=body,
            ContentType="application/json",
            ServerSideEncryption="AES256",
            IfNoneMatch="*",
            ExpectedBucketOwner=settings["account_id"],
        )
    except ClientError as error:
        if _client_error_code(error) not in {"PreconditionFailed", "412", "ConditionalRequestConflict", "409"}:
            raise
        existing = _read_receipt(s3, event, settings)
        if existing != receipt:
            raise RuntimeError("audio preparation receipt write conflicted") from error


def _head_input(s3: Any, event: dict[str, Any], settings: dict[str, str]) -> None:
    source = event["input"]
    if not _input_version_exists(s3, source, settings):
        raise TerminalFailure("input_changed")
    try:
        response = s3.head_object(
            Bucket=source["bucket"],
            Key=source["objectKey"],
            VersionId=source["objectVersionId"],
            ExpectedBucketOwner=settings["account_id"],
        )
    except ClientError as error:
        if not _input_version_exists(s3, source, settings):
            raise TerminalFailure("input_changed") from error
        raise
    if response.get("VersionId") != source["objectVersionId"] or response.get("ContentLength") != source["sizeBytes"]:
        raise TerminalFailure("input_changed")


def _input_version_exists(s3: Any, source: dict[str, Any], settings: dict[str, str]) -> bool:
    request = {
        "Bucket": source["bucket"],
        "Prefix": source["objectKey"],
        "MaxKeys": 1000,
        "ExpectedBucketOwner": settings["account_id"],
    }
    for _ in range(MAX_VERSION_LIST_PAGES):
        response = s3.list_object_versions(**request)
        versions = response.get("Versions", [])
        if any(
            value.get("Key") == source["objectKey"]
            and value.get("VersionId") == source["objectVersionId"]
            for value in versions
        ):
            return True
        listed_keys = {
            value.get("Key")
            for value in [*versions, *response.get("DeleteMarkers", [])]
            if value.get("Key") is not None
        }
        if any(key != source["objectKey"] for key in listed_keys):
            return False
        if not response.get("IsTruncated"):
            return False
        key_marker = response.get("NextKeyMarker")
        version_marker = response.get("NextVersionIdMarker")
        if not _opaque(key_marker) or not _opaque(version_marker):
            raise RuntimeError("input version listing is invalid")
        request["KeyMarker"] = key_marker
        request["VersionIdMarker"] = version_marker
    raise RuntimeError("input version listing exceeded its bound")


def _download_input(s3: Any, event: dict[str, Any], settings: dict[str, str], destination: Path) -> None:
    source = event["input"]
    try:
        response = s3.get_object(
            Bucket=source["bucket"],
            Key=source["objectKey"],
            VersionId=source["objectVersionId"],
            ExpectedBucketOwner=settings["account_id"],
        )
    except ClientError as error:
        if (
            _client_error_code(error) in {"NoSuchKey", "NoSuchVersion", "404", "NotFound"}
            or not _input_version_exists(s3, source, settings)
        ):
            raise TerminalFailure("input_changed") from error
        raise
    total = 0
    try:
        with destination.open("xb") as handle:
            for chunk in response["Body"].iter_chunks(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > source["sizeBytes"]:
                    raise TerminalFailure("input_changed")
                handle.write(chunk)
    finally:
        response["Body"].close()
    if total != source["sizeBytes"]:
        raise TerminalFailure("input_changed")


def _remaining_seconds(context: Any) -> float:
    if context is None or not hasattr(context, "get_remaining_time_in_millis"):
        return 840.0
    return max(1.0, (context.get_remaining_time_in_millis() - 60_000) / 1000)


def _run(command: list[str], context: Any, *, stdout: int = subprocess.PIPE) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=subprocess.PIPE,
        check=False,
        timeout=_remaining_seconds(context),
    )


def _probe_audio(path: Path, ffprobe: str, context: Any, failure_code: str) -> dict[str, Any]:
    result = _run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_streams",
            "-show_packets",
            "-show_entries",
            "stream=codec_name,profile,sample_rate,channels,time_base,start_pts,duration_ts:packet=stream_index",
            "-of",
            "json",
            str(path),
        ],
        context,
    )
    if result.returncode != 0:
        raise TerminalFailure(failure_code)
    try:
        probe = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TerminalFailure(failure_code) from error
    streams = probe.get("streams", [])
    if not streams:
        raise TerminalFailure("audio_track_missing" if failure_code != "audio_output_invalid" else failure_code)
    if len(streams) != 1:
        raise TerminalFailure("audio_codec_unsupported" if failure_code != "audio_output_invalid" else failure_code)
    stream = streams[0]
    if stream.get("codec_name") != "aac" or stream.get("profile") != "LC":
        raise TerminalFailure("audio_codec_unsupported" if failure_code != "audio_output_invalid" else failure_code)
    try:
        sample_rate = int(stream["sample_rate"])
        channels = int(stream["channels"])
        time_base = Fraction(stream["time_base"])
        start = Fraction(int(stream["start_pts"])) * time_base * sample_rate
        duration = Fraction(int(stream["duration_ts"])) * time_base * sample_rate
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
        raise TerminalFailure("audio_timeline_unsupported" if failure_code != "audio_output_invalid" else failure_code) from error
    if not 8000 <= sample_rate <= 48000 or not 1 <= channels <= 2:
        raise TerminalFailure("audio_codec_unsupported" if failure_code != "audio_output_invalid" else failure_code)
    if start.denominator != 1 or duration.denominator != 1 or abs(start.numerator) > 1:
        raise TerminalFailure("audio_timeline_unsupported" if failure_code != "audio_output_invalid" else failure_code)
    if not (sample_rate + 9) // 10 <= duration.numerator <= sample_rate * MAX_DURATION_SECONDS:
        raise TerminalFailure("audio_duration_unsupported" if failure_code != "audio_output_invalid" else failure_code)
    packets = probe.get("packets", [])
    if not isinstance(packets, list) or not packets:
        raise TerminalFailure("audio_timeline_unsupported" if failure_code != "audio_output_invalid" else failure_code)
    return {
        "codec": "aac",
        "profile": "LC",
        "sampleRate": sample_rate,
        "channels": channels,
        "startSamples": start.numerator,
        "durationSamples": duration.numerator,
        "frameSamples": AAC_FRAME_SAMPLES,
        "packetCount": len(packets),
    }


def _elementary_sha256(path: Path, ffmpeg: str, context: Any, failure_code: str) -> str:
    command = [ffmpeg, "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-c", "copy", "-f", "data", "-"]
    deadline = time.monotonic() + _remaining_seconds(context)
    digest = hashlib.sha256()
    with tempfile.TemporaryFile() as stderr:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr)
        selector = selectors.DefaultSelector()
        try:
            assert process.stdout is not None
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, _remaining_seconds(context))
                if not selector.select(remaining):
                    raise subprocess.TimeoutExpired(command, _remaining_seconds(context))
                chunk = os.read(process.stdout.fileno(), 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, _remaining_seconds(context))
            process.wait(timeout=remaining)
        except BaseException:
            process.kill()
            process.wait()
            raise
        finally:
            selector.close()
            if process.stdout is not None:
                process.stdout.close()
        if process.returncode != 0:
            stderr.seek(0)
            error = stderr.read(500).decode("utf-8", "replace")
            raise TerminalFailure(failure_code) from RuntimeError(error)
    return digest.hexdigest()


def _convert(source: Path, output: Path, ffmpeg: str, context: Any) -> None:
    result = _run(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
            "-y",
            str(output),
        ],
        context,
    )
    if result.returncode != 0 or not output.is_file():
        raise TerminalFailure("audio_output_invalid")


def _validate_stream_copy(source: dict[str, Any], output: dict[str, Any]) -> None:
    if (
        source["sampleRate"] != output["sampleRate"]
        or source["channels"] != output["channels"]
        or abs(source["startSamples"] - output["startSamples"]) > 1
        or source["packetCount"] != output["packetCount"]
        or source["elementarySha256"] != output["elementarySha256"]
        or abs(source["durationSamples"] - output["durationSamples"]) > AAC_FRAME_SAMPLES
    ):
        raise TerminalFailure("audio_output_invalid")


def _upload_output(
    s3: Any,
    event: dict[str, Any],
    settings: dict[str, str],
    output_path: Path,
) -> tuple[dict[str, Any], str]:
    output_hash = _sha256_file(output_path)
    size = output_path.stat().st_size
    if size < 1 or size > event["input"]["sizeBytes"]:
        raise TerminalFailure("audio_output_invalid")
    with output_path.open("rb") as body:
        response = s3.put_object(
            Bucket=event["output"]["bucket"],
            Key=event["output"]["audioKey"],
            Body=body,
            ContentLength=size,
            ContentType=MIME_TYPE,
            ServerSideEncryption="AES256",
            Metadata={
                "sha256": output_hash,
                "preparation-id": event["preparationId"],
                "invocation-id": event["invocationId"],
                "artifact-sha256": event["ffmpegArtifactSha256"],
            },
            ExpectedBucketOwner=settings["account_id"],
        )
    version_id = response.get("VersionId")
    if not _opaque(version_id):
        raise RuntimeError("audio preparation output version is unavailable")
    try:
        head = s3.head_object(
            Bucket=event["output"]["bucket"],
            Key=event["output"]["audioKey"],
            VersionId=version_id,
            ExpectedBucketOwner=settings["account_id"],
        )
        if (
            head.get("VersionId") != version_id
            or head.get("ContentLength") != size
            or head.get("ContentType") != MIME_TYPE
            or head.get("Metadata", {}).get("sha256") != output_hash
        ):
            raise RuntimeError("audio preparation output verification failed")
    except BaseException:
        _delete_output_version(s3, event, settings, version_id)
        raise
    return {
        "objectKey": event["output"]["audioKey"],
        "objectVersionId": version_id,
        "sizeBytes": size,
        "sha256": output_hash,
        "mimeType": MIME_TYPE,
    }, version_id


def _delete_output_version(s3: Any, event: dict[str, Any], settings: dict[str, str], version_id: str) -> None:
    s3.delete_object(
        Bucket=event["output"]["bucket"],
        Key=event["output"]["audioKey"],
        VersionId=version_id,
        ExpectedBucketOwner=settings["account_id"],
    )


def handler(event: Any, context: Any, *, s3: Any = S3) -> dict[str, Any]:
    settings = _settings()
    artifact = _artifact_identity()
    validated = _validate_event(event, settings, artifact)
    existing = _read_receipt(s3, validated, settings)
    if existing is not None:
        return existing

    uploaded_version = ""
    try:
        _head_input(s3, validated, settings)
        with tempfile.TemporaryDirectory(prefix="boardwalk-audio-") as directory:
            source_path = Path(directory) / "input.mp4"
            output_path = Path(directory) / "input.m4a"
            _download_input(s3, validated, settings, source_path)
            source_audio = _probe_audio(source_path, settings["ffprobe"], context, "audio_codec_unsupported")
            duration_seconds = source_audio["durationSamples"] / source_audio["sampleRate"]
            if abs(duration_seconds - validated["input"]["durationSeconds"]) > MAX_DURATION_DRIFT_SECONDS:
                raise TerminalFailure("audio_duration_unsupported")
            source_audio["elementarySha256"] = _elementary_sha256(
                source_path, settings["ffmpeg"], context, "audio_codec_unsupported"
            )
            _convert(source_path, output_path, settings["ffmpeg"], context)
            output_audio = _probe_audio(output_path, settings["ffprobe"], context, "audio_output_invalid")
            output_audio["elementarySha256"] = _elementary_sha256(
                output_path, settings["ffmpeg"], context, "audio_output_invalid"
            )
            _validate_stream_copy(source_audio, output_audio)
            output, uploaded_version = _upload_output(s3, validated, settings, output_path)
            receipt = {
                **_base_receipt(validated),
                "outcome": "ready",
                "output": output,
                "sourceAudio": source_audio,
                "outputAudio": output_audio,
            }
            _write_receipt(s3, validated, receipt, settings)
            uploaded_version = ""
            return receipt
    except TerminalFailure as failure:
        receipt = {**_base_receipt(validated), "outcome": "failed", "failureCode": failure.code}
        _write_receipt(s3, validated, receipt, settings)
        return receipt
    finally:
        if uploaded_version:
            _delete_output_version(s3, validated, settings, uploaded_version)
