"""Small metadata and validation steps; Step Functions owns the job lifecycle."""
import hashlib
import json
import math
import os
import re
from urllib.parse import quote

import boto3
from botocore.config import Config

CONFIG = Config(retries={"mode": "standard", "total_max_attempts": 3},
                connect_timeout=5, read_timeout=60)
s3 = boto3.client("s3", config=CONFIG)
media = boto3.client("mediaconvert", config=CONFIG)
BUCKET = os.environ["RENDITION_BUCKET"]
ORIGINALS = os.environ["ORIGINAL_BUCKET"]
ACCOUNT = os.environ["ACCOUNT_ID"]
PART_BYTES = 512 * 1024 * 1024
MAX_PREVIEW_FRAME_RATE = 60
MAX_EXPORT_DURATION_SECONDS = 86400
MAX_SOURCE_DURATION_DRIFT_SECONDS = 1.001
BROADCAST_FRAME_RATE = (30000, 1001)
FRAME_RATE_TARGETS = {
    "broadcast": BROADCAST_FRAME_RATE,
    "24000/1001": (24000, 1001),
    "24/1": (24, 1),
    "25/1": (25, 1),
    "30/1": (30, 1),
    "50/1": (50, 1),
    "60000/1001": (60000, 1001),
    "60/1": (60, 1),
}


def export_scope(job):
    return job.get("scope", "clip")


def export_format(job):
    return job.get("format", "web_mp4")


def frame_rate_mode(job):
    return job.get("frameRateMode", "source")


def clip_settings(job):
    resolution = job.get("resolution", "source")
    quality = job.get("quality", "balanced")
    if resolution not in ("source", "1080p", "720p", "480p") or quality not in ("smaller", "balanced", "high"):
        raise ValueError("clip_settings_invalid")
    return resolution, quality


def validate_job(job):
    if job.get("sourceId") != "video-library":
        raise ValueError("source_not_allowed")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job.get("assetId", "")):
        raise ValueError("asset_invalid")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", job.get("attemptId", "")):
        raise ValueError("attempt_invalid")
    key = job.get("sourceObjectKey", "")
    version = job.get("sourceObjectVersionId", "")
    size = job.get("sourceSizeBytes")
    if not key.startswith("objects/") or len(key) > 1024 or not version or len(version) > 1024:
        raise ValueError("original_invalid")
    if type(size) is not int or not 0 < size <= 250 * 1024 ** 3:
        raise ValueError("size_invalid")
    identity = [job["sourceId"], job["assetId"], key, version, size, 1]
    if job.get("kind") == "clip":
        scope, output_format = export_scope(job), export_format(job)
        if scope not in ("clip", "source") or output_format not in ("web_mp4", "broadcast_mxf", "prores_mov", "avid_mxf", "broadcast_mp4", "original_copy"):
            raise ValueError("clip_format_invalid")
        if output_format == "broadcast_mp4" and (scope != "source" or "frameRateMode" not in job):
            raise ValueError("broadcast_copy_invalid")
        if scope == "source":
            if (output_format in ("web_mp4", "original_copy") or job.get("inMs") != 0 or
                    type(job.get("outMs")) is not int or not 0 < job["outMs"] <= MAX_EXPORT_DURATION_SECONDS * 1000):
                raise ValueError("source_export_invalid")
            identity = [job["sourceId"], job["assetId"], key, version, size,
                        "source-export-v1", output_format]
        else:
            input_key = job.get("inputObjectKey", "")
            input_version = job.get("inputObjectVersionId", "")
            input_size = job.get("inputSizeBytes")
            if not re.fullmatch(r"outputs/[a-f0-9]{64}/[A-Za-z0-9_-]{1,128}/preview\.mp4", input_key):
                raise ValueError("clip_input_invalid")
            if not input_version or len(input_version) > 1024 or type(input_size) is not int or not 0 < input_size <= 250 * 1024 ** 3:
                raise ValueError("clip_input_invalid")
            start, end = job.get("inMs"), job.get("outMs")
            if type(start) is not int or type(end) is not int or start < 0 or not 250 <= end - start <= 1800000:
                raise ValueError("clip_range_invalid")
            identity = [job["sourceId"], job["assetId"], key, version, size,
                        input_key, input_version, input_size, start, end]
            if output_format != "web_mp4":
                if "resolution" in job or "quality" in job:
                    raise ValueError("clip_settings_invalid")
                identity.extend(["original-copy-v1" if output_format == "original_copy" else "clip-v3", output_format])
            else:
                resolution, quality = clip_settings(job)
                identity.extend(["clip-v1"] if (resolution, quality) == ("source", "balanced")
                                else ["clip-v2", resolution, quality])
    elif job.get("kind") is not None:
        raise ValueError("job_kind_invalid")
    if "frameRateMode" in job:
        if frame_rate_mode(job) not in ("source", *FRAME_RATE_TARGETS):
            raise ValueError("frame_rate_mode_invalid")
        identity.extend(["frame-rate-v1", frame_rate_mode(job)])
    digest = hashlib.sha256(json.dumps(identity, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if digest != job.get("id"):
        raise ValueError("identity_invalid")
    return job


def prepare(job):
    head = s3.head_object(Bucket=ORIGINALS, Key=job["sourceObjectKey"],
                          VersionId=job["sourceObjectVersionId"], ExpectedBucketOwner=ACCOUNT)
    if head.get("VersionId") != job["sourceObjectVersionId"] or head["ContentLength"] != job["sourceSizeBytes"]:
        raise ValueError("original_changed")
    bucket, key, version, size = ORIGINALS, job["sourceObjectKey"], job["sourceObjectVersionId"], job["sourceSizeBytes"]
    if job.get("kind") == "clip" and export_scope(job) == "clip" and export_format(job) == "web_mp4":
        bucket, key, version, size = BUCKET, job["inputObjectKey"], job["inputObjectVersionId"], job["inputSizeBytes"]
        head = s3.head_object(Bucket=bucket, Key=key, VersionId=version, ExpectedBucketOwner=ACCOUNT)
        if head.get("VersionId") != version or head.get("ContentLength") != size:
            raise ValueError("clip_input_changed")
    return {
        "job": job,
        "sourceVersion": version,
        "stagingKey": f'staging/{job["id"]}/{job["attemptId"]}/source',
        "copySource": f'{bucket}/{quote(key, safe="/")}?versionId={quote(version, safe="")}',
        "parts": [{"number": index + 1, "range": f'bytes={index * PART_BYTES}-{min((index + 1) * PART_BYTES, size) - 1}'}
                  for index in range(math.ceil(size / PART_BYTES))],
    }


def output_prefix(job):
    category = "outputs/clips" if job.get("kind") == "clip" else "outputs"
    return f'{category}/{job["id"]}/{job["attemptId"]}/'


def probe_duration(container, video_track, prefer_video=False):
    primary, fallback = (video_track, container) if prefer_video else (container, video_track)
    duration = primary.get("Duration")
    return fallback.get("Duration") if duration is None else duration


def clip_timing(job, probe, prefer_video_duration=False):
    container = probe.get("Container", {})
    track = next((item for item in container.get("Tracks", []) if item.get("TrackType") == "video"), {})
    rate = track.get("VideoProperties", {}).get("FrameRate", {})
    numerator, denominator = rate.get("Numerator"), rate.get("Denominator")
    duration = probe_duration(container, track, prefer_video_duration)
    if type(numerator) is not int or type(denominator) is not int or min(numerator, denominator) <= 0:
        raise ValueError("clip_frame_rate_missing")
    fps = numerator / denominator
    if not 1 <= fps <= 60:
        raise ValueError("clip_frame_rate_unsupported")
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("clip_duration_invalid")
    end_tolerance_ms = 1000 if export_format(job) != "web_mp4" else 0
    if job["outMs"] > math.ceil(duration * 1000) + end_tolerance_ms or duration > MAX_EXPORT_DURATION_SECONDS:
        raise ValueError("clip_range_outside_input")
    start_frame = job["inMs"] * numerator // (1000 * denominator)
    end_frame = min(math.ceil(job["outMs"] * numerator / (1000 * denominator)), math.ceil(duration * fps))
    if end_frame <= start_frame:
        raise ValueError("clip_range_empty")
    nominal = math.ceil(fps)

    def timecode(frame):
        seconds, frames = divmod(frame, nominal)
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frames:02d}"

    # MediaConvert includes both boundary frames. UI out is exclusive.
    clipping = {"StartTimecode": timecode(start_frame)}
    if job["outMs"] < math.floor(duration * 1000):
        clipping["EndTimecode"] = timecode(end_frame - 1)
    return {
        "timecodes": clipping,
        "sourceStartSeconds": start_frame * denominator / numerator,
        "sourceEndSeconds": min(duration, end_frame * denominator / numerator),
        "sourceFrameDurationSeconds": denominator / numerator,
    }


def clip_timecodes(job, probe, prefer_video_duration=False):
    return clip_timing(job, probe, prefer_video_duration)["timecodes"]


def normalized_rate(properties):
    rate = properties.get("FrameRate", {})
    numerator, denominator = rate.get("Numerator"), rate.get("Denominator")
    if type(numerator) is not int or type(denominator) is not int or min(numerator, denominator) <= 0:
        raise ValueError("broadcast_frame_rate_missing")
    common = math.gcd(numerator, denominator)
    return numerator // common, denominator // common


def scan_type(properties):
    scan = str(properties.get("CodecMetadata", {}).get("ScanType", "")).lower()
    if "interlac" in scan or "mbaff" in scan:
        return "interlaced"
    if "progress" in scan:
        return "progressive"
    raise ValueError("broadcast_scan_type_missing")


def editor_profile(probe, output_format, rate_mode="source", prefer_video_duration=False):
    container = probe.get("Container", {})
    tracks = container.get("Tracks", [])
    video_tracks = [track for track in tracks if track.get("TrackType") == "video"]
    if len(video_tracks) != 1:
        raise ValueError("broadcast_video_track_unsupported")
    duration = probe_duration(container, video_tracks[0], prefer_video_duration)
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_EXPORT_DURATION_SECONDS:
        raise ValueError("broadcast_duration_unsupported")
    properties = video_tracks[0].get("VideoProperties", {})
    dimensions = properties.get("Width"), properties.get("Height")
    rate = normalized_rate(properties)
    scan = scan_type(properties)
    standard_rates = {(24000, 1001), (24, 1), (25, 1), (30000, 1001), (30, 1),
                      (50, 1), (60000, 1001), (60, 1)}
    xdcam_rates = {
        (1920, 1080, "progressive"): {(24000, 1001), (25, 1), (30000, 1001)},
        (1920, 1080, "interlaced"): {(25, 1), (30000, 1001)},
        (1280, 720, "progressive"): {(24000, 1001), (25, 1), (50, 1), (30000, 1001), (60000, 1001)},
    }
    avid_rates = {(1920, 1080, "progressive"): standard_rates,
                  (1920, 1080, "interlaced"): {(25, 1), (30000, 1001), (30, 1)},
                  (1280, 720, "progressive"): standard_rates}
    dimensions_valid = all(type(value) is int and value > 0 for value in dimensions)
    source_rate_valid = 1 <= rate[0] / rate[1] <= MAX_PREVIEW_FRAME_RATE
    if output_format == "broadcast_mp4":
        if not dimensions_valid or not source_rate_valid:
            raise ValueError("broadcast_video_format_unsupported")
    elif output_format == "prores_mov":
        # AWS limits ProRes to 4096x4096; VideoDescription requires at least 32 pixels.
        # https://docs.aws.amazon.com/mediaconvert/latest/ug/supported-output-resolution-maximums-by-codec.html
        if (any(type(size) is not int or not 32 <= size <= 4096 or size % 2 for size in dimensions) or
                (rate not in standard_rates if rate_mode == "source" else not source_rate_valid)):
            raise ValueError("prores_video_format_unsupported")
    elif output_format == "avid_mxf":
        # CLASS_145_8BIT is DNxHD, not the variable-raster DNxHR codec.
        if (rate not in avid_rates.get((*dimensions, scan), set()) if rate_mode == "source"
                else dimensions not in ((1920, 1080), (1280, 720)) or not source_rate_valid):
            raise ValueError("avid_video_format_unsupported")
    elif output_format == "broadcast_mxf":
        if (rate not in xdcam_rates.get((*dimensions, scan), set()) if rate_mode == "source"
                else dimensions not in ((1920, 1080), (1280, 720)) or not source_rate_valid):
            raise ValueError("broadcast_video_format_unsupported")
    audio_tracks = [track for track in tracks if track.get("TrackType") == "audio"]
    channel_counts = []
    for track in audio_tracks:
        channels = track.get("AudioProperties", {}).get("Channels")
        if type(channels) is not int or not 1 <= channels <= 8:
            raise ValueError("broadcast_audio_layout_unsupported")
        channel_counts.append(channels)
    total_channels = sum(channel_counts)
    allowed_channels = (2, 4, 8) if output_format == "broadcast_mxf" else tuple(range(9))
    if total_channels not in allowed_channels:
        raise ValueError("broadcast_audio_layout_unsupported")
    return {"width": dimensions[0], "height": dimensions[1], "rate": rate, "scanType": scan,
            "durationSeconds": duration, "audioChannelCounts": channel_counts,
            "audioChannels": total_channels}


def conversion_plan(job, profile):
    output_format = export_format(job)
    mode = frame_rate_mode(job)
    target_rate = profile["rate"] if mode == "source" else FRAME_RATE_TARGETS[mode]
    target_fps = target_rate[0] / target_rate[1]
    film_to_broadcast = profile["rate"] == (24000, 1001) and target_rate == BROADCAST_FRAME_RATE
    if output_format == "broadcast_mxf" and mode != "source" and target_rate not in {
            (24000, 1001), (25, 1), BROADCAST_FRAME_RATE, (50, 1), (60000, 1001)}:
        # The XDCAM RDD9 output table has no exact 24, 30, or 60 fps profile.
        raise ValueError("broadcast_frame_rate_format_unsupported")

    method = "none"
    if target_rate != profile["rate"]:
        method = ("telecine" if film_to_broadcast and profile["scanType"] == "progressive"
                  else "interpolate")

    def geometry():
        if output_format == "broadcast_mp4":
            return (1080, 1920) if profile["height"] > profile["width"] else (1920, 1080)
        if (method == "telecine" and (profile["width"], profile["height"]) == (1280, 720) and
                output_format in ("broadcast_mxf", "avid_mxf")):
            return 1920, 1080
        if (mode != "source" and target_fps > 30 and
                output_format in ("broadcast_mxf", "avid_mxf") and profile["height"] == 1080):
            return 1280, 720
        return profile["width"], profile["height"]

    if method == "telecine":
        output_scan = "interlaced"
    elif mode != "source" and (profile["height"] == 720 or target_fps > 30 or film_to_broadcast or
                               target_rate in ((24000, 1001), (24, 1), (30, 1))):
        output_scan = "progressive"
    else:
        output_scan = profile["scanType"]
    deinterlace = profile["scanType"] == "interlaced" and output_scan == "progressive"
    width, height = geometry()
    return {"rate": target_rate, "scanType": output_scan, "method": method,
            "width": width, "height": height, "deinterlace": deinterlace,
            "gopSize": 15 if target_rate == BROADCAST_FRAME_RATE else 12}


def apply_frame_rate(settings, mode, conversion):
    if mode == "source":
        settings["FramerateControl"] = "INITIALIZE_FROM_SOURCE"
    else:
        settings.update({"FramerateControl": "SPECIFIED",
                         "FramerateNumerator": conversion["rate"][0],
                         "FramerateDenominator": conversion["rate"][1]})
    if conversion["method"] == "telecine":
        settings["Telecine"] = "HARD"
    elif conversion["method"] == "interpolate":
        settings["FramerateConversionAlgorithm"] = "INTERPOLATE"


def editor_audio(profile, output_format):
    selectors = {}
    descriptions = []
    for track_index, channels in enumerate(profile["audioChannelCounts"], 1):
        selector = f"Audio {track_index}"
        selectors[selector] = {"SelectorType": "TRACK", "Tracks": [track_index]}
        for channel in range(channels):
            mapping = [-60] * channels
            mapping[channel] = 0
            codec = "AIFF" if output_format == "prores_mov" else "WAV"
            settings_key = "AiffSettings" if codec == "AIFF" else "WavSettings"
            descriptions.append({"AudioSourceName": selector,
                                 "CodecSettings": {"Codec": codec, settings_key: {
                                     "BitDepth": 24, "Channels": 1, "SampleRate": 48000}},
                                 "RemixSettings": {"ChannelsIn": channels, "ChannelsOut": 1,
                                     "ChannelMapping": {"OutputChannels": [{"InputChannels": mapping}]}}})
    return selectors, descriptions


def editor_format(output_format):
    formats = {
        "broadcast_mxf": {"key": "broadcast", "filename": "broadcast.mxf", "mimeType": "application/mxf",
                          "container": "mxf", "videoCodec": "mpeg2", "profile": "xdcam_rdd9"},
        "prores_mov": {"key": "prores", "filename": "prores.mov", "mimeType": "video/quicktime",
                       "container": "quicktime", "videoCodec": "prores", "profile": "prores_422_hq"},
        "avid_mxf": {"key": "avid", "filename": "avid.mxf", "mimeType": "application/mxf",
                     "container": "mxf", "videoCodec": "vc3", "profile": "vc3_class_145_8bit"},
        "broadcast_mp4": {"key": "broadcastMp4", "filename": "broadcast.mp4", "mimeType": "video/mp4",
                          "container": "mp4", "probeContainers": ("mp4", "mpeg-4"),
                          "videoCodec": "h264", "profile": "frame_rate_copy"},
    }
    try:
        return formats[output_format]
    except KeyError:
        raise ValueError("clip_format_invalid") from None


def editor_settings(job, staging_key, probe):
    output_format = export_format(job)
    explicit_mode = "frameRateMode" in job
    profile = editor_profile(probe, output_format, frame_rate_mode(job), explicit_mode)
    if export_scope(job) == "source":
        # Request bounds and allowance use the viewing copy's container duration.
        # Output verification still uses the original video track duration.
        container = probe.get("Container", {})
        video_track = next(track for track in container.get("Tracks", []) if track.get("TrackType") == "video")
        duration = probe_duration(container, video_track)
        if (not isinstance(duration, (int, float)) or not math.isfinite(duration) or
                abs(duration - job["outMs"] / 1000) > MAX_SOURCE_DURATION_DRIFT_SECONDS or
                profile["durationSeconds"] - job["outMs"] / 1000 > MAX_SOURCE_DURATION_DRIFT_SECONDS):
            raise ValueError("source_export_duration_mismatch")
    format_settings = editor_format(output_format)
    conversion = conversion_plan(job, profile)
    video_selector = {"Rotate": "AUTO"} if output_format == "broadcast_mp4" else {}
    source = {"FileInput": f"s3://{BUCKET}/{staging_key}", "TimecodeSource": "ZEROBASED",
              "VideoSelector": video_selector}
    if export_scope(job) == "clip":
        source["InputClippings"] = [clip_timecodes(job, probe, explicit_mode)]
    if output_format == "broadcast_mp4":
        selectors = {"Audio": {"DefaultSelection": "DEFAULT"}} if profile["audioChannels"] else {}
        audio = [] if not selectors else [{"AudioSourceName": "Audio", "CodecSettings": {"Codec": "AAC",
            "AacSettings": {"Bitrate": 128000, "CodingMode": "CODING_MODE_2_0", "SampleRate": 48000}}}]
    else:
        selectors, audio = editor_audio(profile, output_format)
    if selectors:
        source["AudioSelectors"] = selectors
    interlaced = conversion["scanType"] == "interlaced"
    if output_format == "broadcast_mxf":
        container = {"Container": "MXF", "MxfSettings": {"Profile": "XDCAM_RDD9"}}
        settings = {
            "RateControlMode": "CBR", "Bitrate": 50000000, "CodecProfile": "PROFILE_422",
            "GopSize": conversion["gopSize"], "GopSizeUnits": "FRAMES",
            "InterlaceMode": "FOLLOW_TOP_FIELD" if interlaced else "PROGRESSIVE"}
        codec = {"Codec": "MPEG2", "Mpeg2Settings": settings}
    elif output_format == "prores_mov":
        container = {"Container": "MOV", "MovSettings": {}}
        settings = {"CodecProfile": "APPLE_PRORES_422_HQ", "ParControl": "INITIALIZE_FROM_SOURCE",
                    "InterlaceMode": "FOLLOW_TOP_FIELD" if interlaced else "PROGRESSIVE"}
        codec = {"Codec": "PRORES", "ProresSettings": settings}
    elif output_format == "avid_mxf":
        # An omitted profile makes MediaConvert select Generic OP1a for VC-3.
        container = {"Container": "MXF", "MxfSettings": {}}
        settings = {"Vc3Class": "CLASS_145_8BIT",
                    "InterlaceMode": "INTERLACED" if interlaced else "PROGRESSIVE"}
        codec = {"Codec": "VC3", "Vc3Settings": settings}
    else:
        container = {"Container": "MP4", "Mp4Settings": {"MoovPlacement": "PROGRESSIVE_DOWNLOAD"}}
        hd_1080 = max(conversion["width"], conversion["height"]) == 1920
        settings = {"RateControlMode": "QVBR", "MaxBitrate": 6000000 if hd_1080 else 4000000,
                    "QvbrSettings": {"QvbrQualityLevel": 9 if hd_1080 else 8},
                    "QualityTuningLevel": "SINGLE_PASS_HQ", "CodecProfile": "HIGH", "CodecLevel": "AUTO",
                    "GopSize": conversion["gopSize"], "GopSizeUnits": "FRAMES",
                    "ParControl": "INITIALIZE_FROM_SOURCE",
                    "InterlaceMode": "FOLLOW_TOP_FIELD" if interlaced else "PROGRESSIVE"}
        codec = {"Codec": "H_264", "H264Settings": settings}
    apply_frame_rate(settings, frame_rate_mode(job), conversion)
    video = {"Width": conversion["width"], "Height": conversion["height"], "CodecSettings": codec}
    if output_format == "broadcast_mp4":
        video["ScalingBehavior"] = "FIT_NO_UPSCALE"
    if conversion["deinterlace"]:
        video["VideoPreprocessors"] = {"Deinterlacer": {"Algorithm": "INTERPOLATE", "Mode": "ADAPTIVE"}}
    if "frameRateMode" in job:
        if conversion["rate"] == BROADCAST_FRAME_RATE:
            video["DropFrameTimecode"] = "ENABLED"
        if conversion["method"] == "none" and output_format != "avid_mxf":
            video["TimecodeInsertion"] = "PIC_TIMING_SEI"
    output = {"ContainerSettings": container, "VideoDescription": video,
              "Extension": format_settings["filename"].rsplit(".", 1)[1]}
    if audio:
        output["AudioDescriptions"] = audio
    timecode_source = "EMBEDDED" if "frameRateMode" in job else "ZEROBASED"
    return {"TimecodeConfig": {"Source": timecode_source}, "Inputs": [source],
            "OutputGroups": [{"Name": "Editor export", "OutputGroupSettings": {"Type": "FILE_GROUP_SETTINGS",
                "FileGroupSettings": {"Destination": f's3://{BUCKET}/{output_prefix(job)}{format_settings["filename"].rsplit(".", 1)[0]}'}},
                "Outputs": [output]}]}


def preview_audio(tracks):
    """Keep every camera track/channel in the browser and transcript mix."""
    audio_tracks = [track for track in tracks if track.get("TrackType") == "audio"]
    if not audio_tracks:
        return {}, []
    counts = [track.get("AudioProperties", {}).get("Channels") for track in audio_tracks]
    if any(type(count) is not int or count < 1 for count in counts) or sum(counts) > 64:
        raise ValueError("source_audio_channels_unsupported")
    channels = sum(counts)
    # Tracks are numbered among audio tracks, independently of container/video indexes.
    selectors = {"Audio": {"SelectorType": "TRACK", "Tracks": list(range(1, len(counts) + 1)),
                           "DefaultSelection": "NOT_DEFAULT"}}
    # Preserve stereo/four-channel camera pairs. Without layout metadata, center
    # other channel counts so surround dialogue never plays on only one side.
    # Headroom prevents clipping when several live microphones share an output.
    mapping = []
    for side in range(2):
        selected = []
        offset = 0
        for count in counts:
            selected.extend(range(offset + side, offset + count, 2) if count in (2, 4)
                            else range(offset, offset + count))
            offset += count
        gain = round(-20 * math.log10(len(selected)), 3)
        mapping.append({"InputChannelsFineTune": [gain if index in selected else -60
                                                 for index in range(channels)]})
    description = {"AudioSourceName": "Audio", "CodecSettings": {"Codec": "AAC",
        "AacSettings": {"Bitrate": 128000, "CodingMode": "CODING_MODE_2_0", "SampleRate": 48000}},
        "RemixSettings": {"ChannelsIn": channels, "ChannelsOut": 2,
                          "ChannelMapping": {"OutputChannels": mapping}},
        # Correct the measured mix after summing, including silent camera inputs.
        "AudioNormalizationSettings": {"Algorithm": "ITU_BS_1770_4", "AlgorithmControl": "CORRECT_AUDIO",
            "TargetLkfs": -23, "PeakCalculation": "TRUE_PEAK", "TruePeakLimiterThreshold": -2}}
    return selectors, [description]


def encode_settings(job, staging_key, probe):
    if job.get("kind") == "clip" and export_format(job) != "web_mp4":
        return editor_settings(job, staging_key, probe)
    container = probe.get("Container", {})
    tracks = probe.get("Container", {}).get("Tracks", [])
    video_track = next((track for track in tracks if track.get("TrackType") == "video"), None)
    if not video_track:
        raise ValueError("video_track_missing")
    properties = video_track.get("VideoProperties", {})
    width, height = properties.get("Width"), properties.get("Height")
    if not isinstance(width, int) or not isinstance(height, int) or min(width, height) <= 0:
        raise ValueError("dimensions_missing")
    if job.get("kind") != "clip":
        duration = probe_duration(container, video_track)
        if (not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0):
            raise ValueError("source_duration_invalid")
        rate = properties.get("FrameRate", {})
        numerator, denominator = rate.get("Numerator"), rate.get("Denominator")
        if (type(numerator) is not int or type(denominator) is not int or min(numerator, denominator) <= 0 or
                not 1 <= numerator / denominator <= MAX_PREVIEW_FRAME_RATE):
            raise ValueError("source_frame_rate_unsupported")
    portrait = height > width
    cap_width, cap_height = (1080, 1920) if portrait else (1920, 1080)
    max_bitrate, quality_level = 5000000, 7
    if job.get("kind") == "clip":
        resolution, quality = clip_settings(job)
        cap = 1080 if resolution == "source" else int(resolution[:-1])
        if resolution != "source" and cap > min(width, height):
            raise ValueError("clip_resolution_upscale")
        long_cap = {1080: 1920, 720: 1280, 480: 854}[cap]
        cap_width, cap_height = (cap, long_cap) if portrait else (long_cap, cap)
        quality_level = {"smaller": 6, "balanced": 7, "high": 9}[quality]
        max_bitrate = {"smaller": {1080: 2500000, 720: 1500000, 480: 800000},
                       "balanced": {1080: 5000000, 720: 3000000, 480: 1500000},
                       "high": {1080: 8000000, 720: 5000000, 480: 2500000}}[quality][cap]
    video = {
        "Width": cap_width, "Height": cap_height, "ScalingBehavior": "FIT_NO_UPSCALE",
        "CodecSettings": {"Codec": "H_264", "H264Settings": {
            "RateControlMode": "QVBR", "MaxBitrate": max_bitrate,
            "QvbrSettings": {"QvbrQualityLevel": quality_level}, "QualityTuningLevel": "SINGLE_PASS_HQ",
            "CodecProfile": "MAIN", "CodecLevel": "AUTO", "InterlaceMode": "PROGRESSIVE",
            "FramerateControl": "INITIALIZE_FROM_SOURCE", "GopSize": 2, "GopSizeUnits": "SECONDS",
            "ParControl": "SPECIFIED", "ParNumerator": 1, "ParDenominator": 1,
        }},
    }
    scan = str(properties.get("CodecMetadata", {}).get("ScanType", "")).lower()
    if "interlac" in scan or "mbaff" in scan:
        video["VideoPreprocessors"] = {"Deinterlacer": {"Algorithm": "INTERPOLATE", "Mode": "ADAPTIVE"}}
    source = {"FileInput": f"s3://{BUCKET}/{staging_key}", "TimecodeSource": "ZEROBASED",
              "VideoSelector": {"Rotate": "AUTO"}}
    if job.get("kind") == "clip":
        source["InputClippings"] = [clip_timecodes(job, probe)]
    web = {"ContainerSettings": {"Container": "MP4", "Mp4Settings": {"MoovPlacement": "PROGRESSIVE_DOWNLOAD"}},
           "VideoDescription": video}
    selectors, audio = preview_audio(tracks)
    if selectors:
        if job.get("kind") == "clip":
            # Web clips inherit the viewing copy's level, including quiet passages.
            audio[0].pop("AudioNormalizationSettings")
        source["AudioSelectors"] = selectors
        web["AudioDescriptions"] = audio
    poster = {"NameModifier": "-poster", "ContainerSettings": {"Container": "RAW"},
              "VideoDescription": {"Width": 360 if portrait else 640, "Height": 640 if portrait else 360,
                  "ScalingBehavior": "FIT_NO_UPSCALE", "CodecSettings": {"Codec": "FRAME_CAPTURE",
                      "FrameCaptureSettings": {"FramerateNumerator": 1, "FramerateDenominator": 1,
                                                "MaxCaptures": 1, "Quality": 80}}}}
    return {"TimecodeConfig": {"Source": "ZEROBASED"}, "Inputs": [source],
            "OutputGroups": [{"Name": "Web copy", "OutputGroupSettings": {"Type": "FILE_GROUP_SETTINGS",
                "FileGroupSettings": {"Destination": f's3://{BUCKET}/{output_prefix(job)}preview'}},
                "Outputs": [web] if job.get("kind") == "clip" else [web, poster]}]}


def inspect(job, event):
    key = f'staging/{job["id"]}/{job["attemptId"]}/source'
    head = s3.head_object(Bucket=BUCKET, Key=key, VersionId=event["stagingVersionId"], ExpectedBucketOwner=ACCOUNT)
    uses_web_copy = (job.get("kind") == "clip" and export_scope(job) == "clip" and
                     export_format(job) == "web_mp4")
    expected_size = job["inputSizeBytes"] if uses_web_copy else job["sourceSizeBytes"]
    if head["ContentLength"] != expected_size or head.get("Metadata", {}).get("rendition") != job["id"]:
        raise ValueError("staging_invalid")
    result = media.probe(InputFiles=[{"FileUrl": f"s3://{BUCKET}/{key}"}])
    probes = result.get("ProbeResults", [])
    if len(probes) != 1:
        raise ValueError("probe_failed")
    return encode_settings(job, key, probes[0])


def probe_one(key):
    result = media.probe(InputFiles=[{"FileUrl": f"s3://{BUCKET}/{key}"}])
    probes = result.get("ProbeResults", [])
    if len(probes) != 1:
        raise ValueError("probe_failed")
    return probes[0]


def source_timing(job, probe):
    explicit_mode = "frameRateMode" in job
    if export_scope(job) == "clip":
        timing = clip_timing(job, probe, explicit_mode)
        timing.pop("timecodes")
        return timing
    profile = editor_profile(probe, export_format(job), frame_rate_mode(job), explicit_mode)
    return {"sourceStartSeconds": 0, "sourceEndSeconds": profile["durationSeconds"],
            "sourceFrameDurationSeconds": profile["rate"][1] / profile["rate"][0]}


def verify_editor(job, prefix, output, source_probe):
    output_format = export_format(job)
    explicit_mode = "frameRateMode" in job
    format_settings = editor_format(output_format)
    output_probe = probe_one(prefix + format_settings["filename"])
    source_profile = editor_profile(source_probe, output_format, frame_rate_mode(job), explicit_mode)
    conversion = conversion_plan(job, source_profile)
    container = output_probe.get("Container", {})
    tracks = container.get("Tracks", [])
    videos = [track for track in tracks if track.get("TrackType") == "video"]
    audios = [track for track in tracks if track.get("TrackType") == "audio"]
    probe_containers = format_settings.get("probeContainers", (format_settings["container"],))
    if str(container.get("Format", "")).strip().lower() not in probe_containers or len(videos) != 1:
        raise ValueError("broadcast_output_format_invalid")
    reported_codec = str(videos[0].get("Codec", "")).lower()
    if reported_codec == format_settings["videoCodec"]:
        codec_evidence = "probe"
    elif output_format == "avid_mxf" and reported_codec == "mpeg2":
        # For VC-3 jobs with MPEG2 probe metadata, use the validated encoder
        # setting as codec evidence.
        codec_evidence = "encoder-setting"
    else:
        raise ValueError("broadcast_output_format_invalid")
    properties = videos[0].get("VideoProperties", {})
    output_rate = normalized_rate(properties)
    if output_format == "prores_mov" and not properties.get("CodecMetadata"):
        # MediaConvert Probe can omit ProRes scan metadata. The encoder was
        # configured from the validated source scan type.
        output_scan = conversion["scanType"]
        scan_evidence = "encoder-setting"
    else:
        output_scan = scan_type(properties)
        scan_evidence = "probe"
    output_width, output_height = properties.get("Width"), properties.get("Height")
    if output_format == "broadcast_mp4":
        source_long = max(source_profile["width"], source_profile["height"])
        source_short = min(source_profile["width"], source_profile["height"])
        dimensions_valid = (type(output_width) is int and type(output_height) is int and
                            min(output_width, output_height) > 0 and max(output_width, output_height) <= 1920 and
                            min(output_width, output_height) <= 1080 and
                            max(output_width, output_height) <= source_long and
                            min(output_width, output_height) <= source_short)
    else:
        dimensions_valid = (output_width, output_height) == (conversion["width"], conversion["height"])
    if (not dimensions_valid or output_rate != conversion["rate"] or output_scan != conversion["scanType"]):
        raise ValueError("broadcast_output_video_invalid")
    if output_format == "broadcast_mp4":
        expected_audio_tracks = 1 if source_profile["audioChannels"] else 0
        if len(audios) != expected_audio_tracks:
            raise ValueError("broadcast_output_audio_invalid")
        for track in audios:
            audio = track.get("AudioProperties", {})
            if (str(track.get("Codec", "")).lower() != "aac" or audio.get("Channels") != 2 or
                    audio.get("SampleRate") != 48000):
                raise ValueError("broadcast_output_audio_invalid")
        audio_channels, audio_codec, audio_bit_depth = (2, "aac", None) if audios else (0, "none", None)
    else:
        if len(audios) != source_profile["audioChannels"]:
            raise ValueError("broadcast_output_audio_invalid")
        for track in audios:
            audio = track.get("AudioProperties", {})
            if track.get("Codec") != "PCM" or audio.get("Channels") != 1 or audio.get("SampleRate") != 48000 or audio.get("BitDepth") != 24:
                raise ValueError("broadcast_output_audio_invalid")
        audio_channels, audio_codec = source_profile["audioChannels"], "none" if not audios else "pcm"
        audio_bit_depth = None if not audios else 24
    duration = probe_duration(container, videos[0], explicit_mode)
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("broadcast_output_duration_invalid")
    timing = source_timing(job, source_probe)
    tolerance = (conversion["rate"][1] / conversion["rate"][0] if frame_rate_mode(job) != "source"
                 else max(0.5, timing["sourceFrameDurationSeconds"] * 2))
    if abs(duration - (timing["sourceEndSeconds"] - timing["sourceStartSeconds"])) > tolerance:
        raise ValueError("broadcast_output_duration_invalid")
    output.update({"container": format_settings["container"], "videoCodec": format_settings["videoCodec"],
                   "videoCodecEvidence": codec_evidence,
                   "profile": format_settings["profile"],
                   "width": output_width, "height": output_height,
                   "durationSeconds": duration, "frameRateNumerator": output_rate[0],
                   "frameRateDenominator": output_rate[1],
                   "sourceFrameRateNumerator": source_profile["rate"][0],
                   "sourceFrameRateDenominator": source_profile["rate"][1],
                   "conversionMethod": conversion["method"],
                   "timecodeMode": "embedded_or_zero_based" if "frameRateMode" in job else "zero_based",
                   "scanType": output_scan,
                   "scanTypeEvidence": scan_evidence,
                   "audioChannels": audio_channels, "audioTracks": len(audios),
                   "audioCodec": audio_codec,
                   "audioSampleRate": None if not audios else 48000,
                   "audioBitDepth": audio_bit_depth, **timing})
    if "frameRateMode" in job:
        output["frameRateMode"] = frame_rate_mode(job)


def verify(job):
    prefix = output_prefix(job)
    editor = job.get("kind") == "clip" and export_format(job) != "web_mp4"
    format_settings = editor_format(export_format(job)) if editor else None
    targets = [(format_settings["key"], format_settings["filename"], format_settings["mimeType"])] if editor else [("web", "preview.mp4", "video/mp4")]
    if job.get("kind") != "clip":
        targets.append(("poster", "preview-poster.0000000.jpg", "image/jpeg"))
    outputs = {}
    for name, filename, mime in targets:
        head = s3.head_object(Bucket=BUCKET, Key=prefix + filename, ExpectedBucketOwner=ACCOUNT)
        if not head.get("VersionId") or head.get("ContentLength", 0) <= 0:
            raise ValueError("output_missing")
        outputs[name] = {"objectKey": prefix + filename, "objectVersionId": head["VersionId"],
                         "sizeBytes": head["ContentLength"], "mimeType": mime}
    if editor:
        source_probe = probe_one(f'staging/{job["id"]}/{job["attemptId"]}/source')
        verify_editor(job, prefix, outputs[format_settings["key"]], source_probe)
        primary = format_settings["key"]
    else:
        output_probe = probe_one(prefix + "preview.mp4")
        container = output_probe.get("Container", {})
        track = next((item for item in container.get("Tracks", []) if item.get("TrackType") == "video"), {})
        properties = track.get("VideoProperties", {})
        width, height = properties.get("Width"), properties.get("Height")
        if type(width) is not int or type(height) is not int or min(width, height) <= 0 or max(width, height) > 1920 or min(width, height) > 1080:
            raise ValueError("output_dimensions_invalid")
        outputs["web"].update({"width": width, "height": height})
        duration = probe_duration(container, track)
        if isinstance(duration, (float, int)) and math.isfinite(duration) and duration >= 0:
            outputs["web"]["durationSeconds"] = duration
        if job.get("kind") == "clip":
            resolution, _ = clip_settings(job)
            cap = 1080 if resolution == "source" else int(resolution[:-1])
            if min(width, height) > cap or max(width, height) > {1080: 1920, 720: 1280, 480: 854}[cap]:
                raise ValueError("clip_output_dimensions_invalid")
            rate = properties.get("FrameRate", {})
            numerator, denominator = rate.get("Numerator"), rate.get("Denominator")
            if type(numerator) is not int or type(denominator) is not int or min(numerator, denominator) <= 0 or not 1 <= numerator / denominator <= 60:
                raise ValueError("clip_output_frame_rate_invalid")
            frame_seconds = denominator / numerator
            timing = clip_timing(job, probe_one(f'staging/{job["id"]}/{job["attemptId"]}/source'))
            timing.pop("timecodes")
            outputs["web"].update({"frameDurationSeconds": frame_seconds, **timing})
            tolerance_ms = max(500, frame_seconds * 2000)
            if not isinstance(duration, (float, int)) or not math.isfinite(duration) or duration <= 0 or abs(duration * 1000 - (job["outMs"] - job["inMs"])) > tolerance_ms:
                raise ValueError("clip_output_duration_invalid")
        else:
            source_probe = probe_one(f'staging/{job["id"]}/{job["attemptId"]}/source')
            source_track = next((item for item in source_probe.get("Container", {}).get("Tracks", [])
                                 if item.get("TrackType") == "video"), {})
            source_rate = normalized_rate(source_track.get("VideoProperties", {}))
            if not 1 <= source_rate[0] / source_rate[1] <= MAX_PREVIEW_FRAME_RATE:
                raise ValueError("source_frame_rate_unsupported")
            outputs["web"].update({"sourceFrameRateNumerator": source_rate[0],
                                   "sourceFrameRateDenominator": source_rate[1]})
            # Frame-accurate comments use the web copy's own rate; a variable-rate source can differ.
            try:
                output_rate = normalized_rate(properties)
            except ValueError:
                output_rate = None
            if output_rate is not None:
                outputs["web"].update({"frameRateNumerator": output_rate[0],
                                       "frameRateDenominator": output_rate[1]})
        primary = "web"
    current = s3.head_object(Bucket=BUCKET, Key=outputs[primary]["objectKey"], ExpectedBucketOwner=ACCOUNT)
    if current.get("VersionId") != outputs[primary]["objectVersionId"]:
        raise ValueError("output_changed")
    return {"id": job["id"], "attemptId": job["attemptId"], **outputs}


def verify_original(job):
    if export_format(job) != "original_copy" or export_scope(job) != "clip":
        raise ValueError("original_format_invalid")
    prefix = output_prefix(job)
    receipt_key = prefix + "original-receipt.json"
    receipt_head = s3.head_object(Bucket=BUCKET, Key=receipt_key, ExpectedBucketOwner=ACCOUNT)
    if not receipt_head.get("VersionId") or not 0 < receipt_head.get("ContentLength", 0) <= 65536:
        raise ValueError("original_receipt_invalid")
    response = s3.get_object(Bucket=BUCKET, Key=receipt_key, VersionId=receipt_head["VersionId"], ExpectedBucketOwner=ACCOUNT)
    try:
        raw = response["Body"].read(65537)
    finally:
        response["Body"].close()
    if len(raw) != receipt_head["ContentLength"] or response.get("VersionId") != receipt_head["VersionId"]:
        raise ValueError("original_receipt_changed")
    result = json.loads(raw)
    if (result.get("id") == job["id"] and result.get("attemptId") == job["attemptId"] and
            result.get("errorCode") in ("original_media_unsupported", "original_timing_unsupported", "original_output_limit")):
        raise ValueError(result["errorCode"])
    output = result.get("original", {})
    proof = output.get("provenance", {})
    if (result.get("id") != job["id"] or result.get("attemptId") != job["attemptId"] or
            output.get("objectKey") != prefix + "original.mov" or not output.get("objectVersionId") or
            output.get("mimeType") != "video/quicktime" or output.get("container") != "quicktime" or
            output.get("videoCodec") not in ("h264", "prores") or
            type(output.get("sizeBytes")) is not int or not 0 < output["sizeBytes"] <= 64 * 1024 ** 3 or
            not re.fullmatch(r"[a-f0-9]{64}", output.get("sha256", "")) or
            output.get("requestedInMs") != job["inMs"] or output.get("requestedOutMs") != job["outMs"] or
            proof.get("revision") != "original-copy-v1" or proof.get("timingEvidence") != "verified-packet-subsequence" or
            proof.get("sourceObjectVersionId") != job["sourceObjectVersionId"] or proof.get("sourceSizeBytes") != job["sourceSizeBytes"] or
            not re.fullmatch(r"[a-f0-9]{64}", proof.get("ffmpegArtifactSha256", ""))):
        raise ValueError("original_receipt_invalid")
    start, end = output.get("sourceStartSeconds"), output.get("sourceEndSeconds")
    duration, frame = output.get("durationSeconds"), output.get("sourceFrameDurationSeconds")
    if (not all(type(value) in (int, float) and math.isfinite(value) for value in (start, end, duration, frame)) or
            not 0 <= start < end <= MAX_EXPORT_DURATION_SECONDS or not 0 < frame <= 1 or duration <= 0 or
            not -1e-6 <= job["inMs"] / 1000 - start <= 30 or not -1e-6 <= end - job["outMs"] / 1000 <= 30 or
            abs(duration - (end - start)) > max(0.5, frame * 2)):
        raise ValueError("original_output_timing_invalid")
    head = s3.head_object(Bucket=BUCKET, Key=output["objectKey"], VersionId=output["objectVersionId"], ExpectedBucketOwner=ACCOUNT)
    if (head.get("VersionId") != output["objectVersionId"] or head.get("ContentLength") != output["sizeBytes"] or
            head.get("Metadata", {}).get("sha256") != output["sha256"]):
        raise ValueError("original_output_changed")
    # Firestore admission applies the bounded stream-proof schema before marking ready.
    return {"id": job["id"], "attemptId": job["attemptId"], "original": output}


def handler(event, context):
    job = validate_job(event["job"])
    operations = {"prepare": prepare, "verify": verify, "verify_original": verify_original}
    if event.get("operation") == "inspect":
        return inspect(job, event)
    operation = operations.get(event.get("operation"))
    if not operation:
        raise ValueError("operation_invalid")
    return operation(job)
