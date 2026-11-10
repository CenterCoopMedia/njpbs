"""Generate local editor-format analogues and verify them with ffprobe. No cloud calls."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


WIDTH = 1920
HEIGHT = 1080
FRAME_RATE = "25/1"
SAMPLE_RATE = 48000
DURATION_SECONDS = 1

FORMATS = {
    "xdcam.mxf": {
        "video": ["-c:v", "mpeg2video", "-profile:v", "0", "-pix_fmt", "yuv422p",
                  "-b:v", "50M", "-minrate", "50M", "-maxrate", "50M", "-bufsize", "17825792",
                  "-g", "12", "-bf", "2"],
        "container": ["-f", "mxf"], "format": "mxf", "codec": "mpeg2video", "profile": "4:2:2",
    },
    "prores.mov": {
        "video": ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"],
        "container": [], "format": "mov", "codec": "prores", "profile": "HQ",
    },
    "avid.mxf": {
        "video": ["-c:v", "dnxhd", "-profile:v", "dnxhd", "-pix_fmt", "yuv422p", "-b:v", "120M"],
        "container": ["-f", "mxf"], "format": "mxf", "codec": "dnxhd", "profile": "DNXHD",
    },
}


def run(argv):
    try:
        return subprocess.run(argv, check=True, capture_output=True, timeout=90).stdout
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError("Local media tool failed") from None


def command(path, settings):
    return ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
            "-f", "lavfi", "-i", f"testsrc2=size={WIDTH}x{HEIGHT}:rate=25:duration={DURATION_SECONDS}",
            "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate={SAMPLE_RATE}:duration={DURATION_SECONDS}",
            "-f", "lavfi", "-i", f"sine=frequency=880:sample_rate={SAMPLE_RATE}:duration={DURATION_SECONDS}",
            "-map", "0:v", "-map", "1:a", "-map", "2:a", *settings["video"],
            "-c:a", "pcm_s24le", "-ar", str(SAMPLE_RATE), "-ac", "1", *settings["container"], str(path)]


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_entries",
        "format=format_name,duration:stream=codec_type,codec_name,profile,width,height,r_frame_rate,field_order,channels,sample_rate,bits_per_sample",
        "-of", "json", str(path)]))


def verify(path, settings):
    result = probe(path)
    videos = [stream for stream in result["streams"] if stream["codec_type"] == "video"]
    audios = [stream for stream in result["streams"] if stream["codec_type"] == "audio"]
    if len(videos) != 1 or videos[0].get("codec_name") != settings["codec"] or videos[0].get("profile") != settings["profile"]:
        raise ValueError("Local editor video format verification failed")
    if ((videos[0].get("width"), videos[0].get("height")) != (WIDTH, HEIGHT) or
            videos[0].get("r_frame_rate") != FRAME_RATE or videos[0].get("field_order") != "progressive"):
        raise ValueError("Local editor video properties verification failed")
    if settings["format"] not in result["format"].get("format_name", "").split(","):
        raise ValueError("Local editor container verification failed")
    if len(audios) != 2 or any(stream.get("codec_name") != "pcm_s24le" or
                               stream.get("sample_rate") != str(SAMPLE_RATE) or
                               stream.get("channels") != 1 or stream.get("bits_per_sample") != 24
                               for stream in audios):
        raise ValueError("Local editor audio layout verification failed")
    return {"container": result["format"]["format_name"], "durationSeconds": float(result["format"]["duration"]),
            "video": videos[0], "audio": audios}


def generate(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"schemaVersion": 1, "purpose": "local editor-format analogue",
                "providerOutput": "not_performed", "nativeEditorImport": "not_performed",
                "stationCompliance": "not_established", "files": []}
    manifest["ffmpegVersion"] = run(["ffmpeg", "-version"]).decode("utf-8").splitlines()[0]
    for name, settings in FORMATS.items():
        path = output / name
        run(command(path, settings))
        verification = verify(path, settings)
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        manifest["files"].append({"file": name, "sha256": digest, "sizeBytes": path.stat().st_size,
                                  "verification": verification})
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True, help="New local directory; must not exist")
    args = parser.parse_args()
    try:
        generate(args.output_dir)
    except (OSError, ValueError, RuntimeError):
        print("Fixture generation failed; use a new output directory.", file=sys.stderr)
        return 1
    print("Three local editor-format analogues passed ffprobe checks. Provider output and editor import were not tested.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
