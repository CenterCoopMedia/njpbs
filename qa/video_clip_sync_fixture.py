"""Generate and verify owned synthetic clip-sync media locally. No cloud calls."""
import argparse
import array
import hashlib
import json
from pathlib import Path
import subprocess
import sys

FPS = 30
SAMPLE_RATE = 48000
DURATION = 12
PULSES = (2, 6, 10)
VARIANTS = {'landscape': (640, 360), 'portrait': (360, 640), 'silent': (640, 360)}


def command(destination, variant):
    if variant not in VARIANTS:
        raise ValueError('Unknown fixture variant')
    width, height = VARIANTS[variant]
    flashes = '+'.join(f'between(n,{second * FPS},{second * FPS + 2})' for second in PULSES)
    video = (f'color=c=black:s={width}x{height}:r={FPS}:d={DURATION},'
             f"drawbox=x=iw/4:y=ih/4:w=iw/2:h=ih/2:color=white:t=fill:enable='{flashes}'")
    argv = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
            '-filter_threads', '1', '-f', 'lavfi', '-i', video]
    if variant != 'silent':
        pulses = '+'.join(f'between(n,{second * SAMPLE_RATE},{second * SAMPLE_RATE + 4799})'
                          for second in PULSES)
        audio = (f"aevalsrc=exprs='0.2*sin(2*PI*1000*n/{SAMPLE_RATE})*({pulses})':"
                 f'sample_rate={SAMPLE_RATE}:duration={DURATION}')
        argv += ['-f', 'lavfi', '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
                 '-c:a', 'aac', '-b:a', '128k']
    else:
        argv += ['-map', '0:v:0', '-an']
    return argv + ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                   '-pix_fmt', 'yuv420p', '-threads', '2', '-t', str(DURATION),
                   '-movflags', '+faststart', '-metadata', 'title=Boardwalk synthetic sync fixture',
                   str(destination)]


def run(argv):
    try:
        return subprocess.run(argv, check=True, capture_output=True, timeout=90).stdout
    except (OSError, subprocess.SubprocessError):
        # Do not copy decoder stderr or command lines into shared receipts.
        raise RuntimeError('Local media tool failed') from None


def sha256(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def pulse_starts(values, threshold, step):
    starts = []
    active = False
    for index, value in enumerate(values):
        current = value > threshold
        if current and not active:
            starts.append(round(index * step, 6))
        active = current
    return starts


def assert_pulses(video, audio):
    if len(video) != len(PULSES) or any(abs(actual - expected) > 0.5 / FPS
                                       for actual, expected in zip(video, PULSES)):
        raise ValueError('Synthetic video pulse verification failed')
    if audio is not None and (len(audio) != len(video) or
                              any(abs(a - v) > 1 / FPS for a, v in zip(audio, video))):
        raise ValueError('Synthetic audio pulse verification failed')


def verify(path, variant):
    """Checks generated signals only; this is not a perceptual-sync reviewer."""
    metadata = json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate',
        '-of', 'json', str(path)]))
    streams = metadata['streams']
    videos = [stream for stream in streams if stream['codec_type'] == 'video']
    audios = [stream for stream in streams if stream['codec_type'] == 'audio']
    if len(videos) != 1 or (videos[0]['width'], videos[0]['height']) != VARIANTS[variant] or videos[0]['codec_name'] != 'h264':
        raise ValueError('Synthetic video format verification failed')
    if len(audios) != (0 if variant == 'silent' else 1):
        raise ValueError('Synthetic audio-track verification failed')
    if audios and (audios[0]['codec_name'] != 'aac' or audios[0]['sample_rate'] != str(SAMPLE_RATE)):
        raise ValueError('Synthetic audio format verification failed')
    base = ['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-threads', '2', '-filter_threads', '1', '-i', str(path)]
    pixels = run(base + ['-map', '0:v:0', '-vf', 'crop=2:2:iw/2:ih/2,scale=1:1',
                         '-frames:v', str(DURATION * FPS + 1), '-pix_fmt', 'gray', '-f', 'rawvideo', '-'])
    if len(pixels) != DURATION * FPS:
        raise ValueError('Synthetic frame count verification failed')
    video = pulse_starts(pixels, 180, 1 / FPS)
    audio = None
    if audios:
        pcm = run(base + ['-map', '0:a:0', '-ac', '1', '-ar', str(SAMPLE_RATE),
                          '-t', '12.05', '-f', 's16le', '-'])
        samples = array.array('h', pcm)
        if sys.byteorder != 'little':
            samples.byteswap()
        if not DURATION * SAMPLE_RATE <= len(samples) <= int(12.05 * SAMPLE_RATE):
            raise ValueError('Synthetic audio length verification failed')
        window = SAMPLE_RATE // 200
        peaks = [max(map(abs, samples[index:index + window]), default=0)
                 for index in range(0, len(samples), window)]
        audio = pulse_starts(peaks, 1500, window / SAMPLE_RATE)
    assert_pulses(video, audio)
    return {'frameCount': len(pixels), 'videoPulseSeconds': video, 'audioPulseSeconds': audio,
            'maxSignalOffsetSeconds': None if audio is None else round(max(abs(a - v) for a, v in zip(audio, video)), 6)}


def manifest_template():
    ranges = [(1.4, 10.4), (6, 12)]
    return {'schemaVersion': 1, 'purpose': 'owned synthetic clip-sync fixture',
            'fps': FPS, 'sampleRate': SAMPLE_RATE, 'durationSeconds': DURATION,
            'pulseSeconds': list(PULSES), 'pulseDurationSeconds': 0.1,
            'humanSyncReview': 'not_performed', 'boardwalkExport': 'not_performed',
            'reviewRanges': [{'inSeconds': start, 'outSeconds': end,
                              'expectedPulseSeconds': [round(second - start, 6) for second in PULSES if start <= second < end]}
                             for start, end in ranges], 'files': []}


def generate(output):
    # A fresh directory is mandatory; never overwrite existing source or output.
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = manifest_template()
    manifest['ffmpegVersion'] = run(['ffmpeg', '-version']).decode('utf-8').splitlines()[0]
    for variant in VARIANTS:
        path = output / f'{variant}.mp4'
        run(command(path, variant))
        verification = verify(path, variant)
        manifest['files'].append({'file': path.name, 'variant': variant,
                                  'sha256': sha256(path), 'sizeBytes': path.stat().st_size,
                                  'verification': verification})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True, help='New local directory; must not exist')
    args = parser.parse_args()
    try:
        generate(args.output_dir)
    except (OSError, ValueError, RuntimeError):
        print('Fixture generation failed; retain partial files for inspection and use a new output directory.', file=sys.stderr)
        return 1
    print('Three local fixtures verified. No Boardwalk export or human sync review was performed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
