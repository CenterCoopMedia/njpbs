"""Single-job private transcription worker. Broker credential arrives on stdin."""
import argparse
import gc
import hashlib
import json
import math
import multiprocessing
from numbers import Real
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ENGINE = 'faster-whisper-large-v3-pyannote-community-1-v1'
ALIGNMENT_ADAPTER = 'qwen3-forced-aligner-adapter-v1'
ALIGNMENT_REPOSITORY = 'Qwen/Qwen3-ForcedAligner-0.6B'
ALIGNMENT_REVISION = 'c7cbfc2048c462b0d63a45797104fc9db3ad62b7'
ORIENTATION_ENGINE = 'ffmpeg-orientation-v1'
ORIENTATION_FRAMES = {'vertical': (1080, 1920), 'horizontal': (1920, 1080)}
ORIENTATION_FAILURES = ('export_processing_failed', 'export_input_failed', 'export_upload_failed')
OUTPUT_HOST = os.environ.get('BOARDWALK_OUTPUT_HOST', '')
BROKER = 'https://api.example.org/'
USER_AGENT = 'NJ-PBS-Boardwalk-Transcription-Worker/1.0'
INPUT_HOST = os.environ.get('BOARDWALK_INPUT_HOST', '')
PRIVATE_R2_INPUT_HOST = os.environ.get('BOARDWALK_PRIVATE_R2_INPUT_HOST', '')
PRIVATE_R2_INPUT_BUCKET = os.environ.get('BOARDWALK_PRIVATE_R2_INPUT_BUCKET', 'njpbs-boardwalk-private-video')
MAX_BYTES = 2_000_000_000
MAX_RESULT = 16 * 1024 * 1024
MAX_COMPLETION_ERROR = 4096
MIN_WORD_DURATION_SECONDS = 0.01
COMPLETION_ERROR_CATEGORIES = {
    'Worker request is invalid': 'worker_request_invalid',
    'Transcript result is invalid': 'transcript_result_invalid',
    'Transcript word timing is invalid': 'transcript_word_timing_invalid',
}
STOP = threading.Event()


class LeaseLost(Exception):
    pass


class CompletionRejected(ValueError):
    pass


class JobTimedOut(ValueError):
    pass


def resume_attempt(job, previous=None):
    identity = (job.get("kind", "transcription"), job["id"], job["leaseToken"])
    if previous is not None and previous[0] == identity:
        return previous
    budget = min(14400, max(300, job.get("durationSeconds", 0) * 8 + 180))
    return identity, time.monotonic() + budget, {}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError('redirect_refused')


def validate_job(job):
    if job.get('engineRevision') != ENGINE or job.get('languageCode') not in ('en-US', 'es-US'):
        raise ValueError('local_model_unavailable')
    duration = job.get('durationSeconds')
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 7200:
        raise ValueError('local_input_failed')
    if type(job.get('maxSpeakers')) is not int or not 2 <= job['maxSpeakers'] <= 10:
        raise ValueError('local_input_failed')
    item = job.get('input', {})
    url = urllib.parse.urlsplit(item.get('url', ''))
    query = urllib.parse.parse_qs(url.query)
    audio_path = (f"/transcripts/inputs/audio/{item.get('preparationId')}/attempts/"
                  f"{item.get('invocationId')}/input.m4a")
    is_audio = (item.get('mimeType') == 'audio/x-m4a'
                and re.fullmatch(r'[a-f0-9]{64}', item.get('preparationId', ''))
                and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',
                                 item.get('invocationId', ''))
                and re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')))
    legacy_path = item.get('mimeType') is None and url.path.startswith('/outputs/')
    s3_location = (item.get('storage') is None and url.hostname == INPUT_HOST
                   and ((is_audio and url.path == audio_path) or legacy_path)
                   and query.get('versionId') == [item.get('versionId')])
    r2_key = f"private-audio/{item.get('bindingId')}/{item.get('generation')}/input.m4a"
    r2_location = (item.get('storage') == 'private-r2' and is_audio
                   and re.fullmatch(r'[a-f0-9]{32}\.r2\.cloudflarestorage\.com', PRIVATE_R2_INPUT_HOST)
                   and re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', PRIVATE_R2_INPUT_BUCKET)
                   and url.hostname == PRIVATE_R2_INPUT_HOST
                   and isinstance(item.get('bindingId'), str)
                   and re.fullmatch(r'[a-f0-9]{64}', item['bindingId'])
                   and isinstance(item.get('generation'), str)
                   and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',
                                    item['generation'])
                   and item.get('objectKey') == r2_key
                   and url.path == f"/{PRIVATE_R2_INPUT_BUCKET}/{r2_key}"
                   and 'versionId' not in query
                   and query.get('X-Amz-Algorithm') == ['AWS4-HMAC-SHA256']
                   and len(query.get('X-Amz-Signature', [])) == 1
                   and re.fullmatch(r'[a-f0-9]{64}', query['X-Amz-Signature'][0])
                   and len(query.get('X-Amz-Expires', [])) == 1
                   and query['X-Amz-Expires'][0].isdigit()
                   and 0 < int(query['X-Amz-Expires'][0]) <= 300)
    if (url.scheme != 'https' or url.port not in (None, 443)
            or url.username or url.password or url.fragment or not (s3_location or r2_location)
            or not isinstance(item.get('versionId'), str) or not item['versionId']
            or type(item.get('sizeBytes')) is not int or not 0 < item['sizeBytes'] <= MAX_BYTES):
        raise ValueError('local_input_failed')
    return job


def validate_alignment_job(job, args):
    engine = job.get('engine', {})
    if (job.get('kind') != 'alignment' or engine.get('adapterRevision') != ALIGNMENT_ADAPTER or
            engine.get('modelRepository') != ALIGNMENT_REPOSITORY or
            engine.get('modelRevision') != ALIGNMENT_REVISION or
            engine.get('modelRepository') != args.alignment_model_repository or
            engine.get('modelRevision') != args.alignment_model_revision or
            engine.get('cacheSha256') != args.alignment_cache_sha256 or
            args.alignment_model is None or job.get('languageCode') not in ('en-US', 'es-US')):
        raise ValueError('alignment_model_unavailable')
    duration = job.get('durationSeconds')
    passages = job.get('passages')
    if (not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 7200 or
            type(passages) is not list or not 1 <= len(passages) <= 100):
        raise ValueError('alignment_input_failed')
    previous = -1
    for passage in passages:
        if (type(passage) is not dict or set(passage) != {'index', 'text', 'startSeconds', 'endSeconds', 'overlappingSpeech'} or
                type(passage['index']) is not int or passage['index'] <= previous or
                type(passage['text']) is not str or not passage['text'].strip() or len(passage['text']) > 16000 or
                passage['overlappingSpeech'] is not False or
                not all(isinstance(passage[key], (int, float)) and math.isfinite(passage[key])
                        for key in ('startSeconds', 'endSeconds')) or
                passage['startSeconds'] < 0 or passage['endSeconds'] <= passage['startSeconds'] or
                passage['endSeconds'] > duration or passage['endSeconds'] - passage['startSeconds'] > 180):
            raise ValueError('alignment_input_failed')
        previous = passage['index']
    validate_job({**job, 'engineRevision': ENGINE, 'maxSpeakers': 2})
    return job


def validate_orientation_job(job, args):
    frame = ORIENTATION_FRAMES.get(job.get('orientation'))
    if job.get('kind') != 'orientation' or job.get('engine') != ORIENTATION_ENGINE or args.ffmpeg is None:
        raise ValueError('export_processing_failed')
    duration = job.get('durationSeconds')
    limit = job.get('maxOutputBytes')
    if (frame is None or (job.get('width'), job.get('height')) != frame
            or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= 3600
            or type(limit) is not int or not 0 < limit <= 4_500_000_000):
        raise ValueError('export_input_failed')
    try:
        validate_job({**job, 'engineRevision': ENGINE, 'languageCode': 'en-US', 'maxSpeakers': 2})
    except ValueError:
        raise ValueError('export_input_failed') from None
    return job


def orientation_filter(width, height):
    # The source fills the frame width (vertical) or height (horizontal) at the
    # center, over a cropped, zoomed, softly blurred copy of itself at 25 percent
    # brightness, which matches 25 percent opacity over black.
    return (f'[0:v]split=2[bg][fg];'
            f'[bg]scale={width}:{height}:force_original_aspect_ratio=increase:force_divisible_by=2,'
            f'crop={width}:{height},gblur=sigma=16,colorchannelmixer=rr=0.25:gg=0.25:bb=0.25[back];'
            f'[fg]scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2[front];'
            f'[back][front]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]')


def orientation_command(ffmpeg, source, destination, width, height):
    return [str(ffmpeg), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
            '-filter_complex', orientation_filter(width, height), '-map', '[v]', '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M',
            '-profile:v', 'high', '-level:v', '4.2', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
            '-movflags', '+faststart', '-map_metadata', '-1', str(destination)]


def render_orientation(source, destination, job, lease, ffmpeg):
    command = orientation_command(ffmpeg, source, destination, job['width'], job['height'])
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
    try:
        while process.poll() is None:
            lease.check()
            time.sleep(1)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
    if process.returncode != 0:
        raise ValueError('export_processing_failed')


# The broker checks storage once, two hours after it issues the upload address
# (UPLOAD_DEADLINE_MS). The worker stops sending well before that, so no upload
# can store a file after the check.
UPLOAD_SEND_SECONDS = 100 * 60


class LeaseCheckedReader:
    # http.client reads the body in blocks, so each block confirms the lease
    # and the send deadline.
    def __init__(self, handle, lease, deadline=None):
        self.handle = handle
        self.lease = lease
        self.deadline = deadline

    def read(self, size=-1):
        self.lease.check()
        if self.deadline is not None and time.monotonic() > self.deadline:
            raise ValueError('export_upload_failed')
        return self.handle.read(size)


def validate_upload(upload, size):
    url = urllib.parse.urlsplit(upload.get('url', '') if type(upload) is dict else '')
    headers = upload.get('requiredHeaders') if type(upload) is dict else None
    if (url.scheme != 'https' or url.hostname != OUTPUT_HOST or url.port not in (None, 443)
            or url.username or url.password or url.fragment or not url.path.endswith('.mp4')
            or type(headers) is not dict
            or set(headers) != {'content-type', 'x-amz-checksum-sha256', 'x-amz-meta-boardwalk-session',
                                'x-amz-meta-boardwalk-asset'}
            or headers['content-type'] != 'video/mp4'
            or not all(type(value) is str and value.isprintable() for value in headers.values())):
        raise ValueError('export_upload_failed')
    return {**headers, 'Content-Length': str(size)}


def upload_output(path, upload, lease, send_seconds=UPLOAD_SEND_SECONDS):
    headers = validate_upload(upload, path.stat().st_size)
    deadline = time.monotonic() + send_seconds
    opener = urllib.request.build_opener(NoRedirect())
    with open(path, 'rb') as handle:
        request = urllib.request.Request(upload['url'], data=LeaseCheckedReader(handle, lease, deadline),
                                         headers=headers, method='PUT')
        try:
            with opener.open(request, timeout=120) as response:
                if response.status != 200:
                    raise ValueError('export_upload_failed')
        except (urllib.error.URLError, OSError):
            lease.check()
            raise ValueError('export_upload_failed') from None


def file_sha256(path, lease):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            lease.check()
            digest.update(block)
    return digest.hexdigest()


def export_orientation(broker, job, directory, lease, args):
    source = Path(directory) / 'input.mp4'
    output = Path(directory) / 'output.mp4'
    lease.checkpoint('downloading')
    try:
        download(job, source, lease)
    except JobTimedOut:
        raise
    except ValueError:
        raise ValueError('export_input_failed') from None
    lease.checkpoint('rendering')
    render_orientation(source, output, job, lease, args.ffmpeg)
    size = output.stat().st_size
    if not 0 < size <= job['maxOutputBytes']:
        raise ValueError('export_processing_failed')
    result = {'sizeBytes': size, 'sha256': file_sha256(output, lease)}
    lease.checkpoint('uploading')
    while True:
        reserved = broker.call('Complete', {**lease.identity, 'engine': ORIENTATION_ENGINE,
                                            'output': result, 'uploaded': False})
        if reserved.get('completed') is True:
            return None
        if reserved.get('upload') is not None:
            break
        # The library's viewing-copy queue is full; keep the file and ask again.
        wait = reserved.get('retryAfterSeconds')
        if type(wait) is not int or not 1 <= wait <= 300:
            raise ValueError('export_processing_failed')
        for _ in range(wait):
            lease.check()
            time.sleep(1)
    upload_output(output, reserved.get('upload'), lease)
    lease.checkpoint('finalizing')
    return {**lease.identity, 'engine': ORIENTATION_ENGINE, 'output': result, 'uploaded': True}


def directory_sha256(directory):
    """Hash file names and bytes so a configured offline cache is exact."""
    digest = hashlib.sha256()
    files = sorted(path for path in Path(directory).rglob('*') if path.is_file())
    if not files:
        raise ValueError('alignment_model_unavailable')
    for path in files:
        relative = path.relative_to(directory).as_posix().encode('utf-8')
        digest.update(len(relative).to_bytes(4, 'big'))
        digest.update(relative)
        with path.open('rb') as source:
            while block := source.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def completion_rejection_diagnostic(error, request_bytes):
    """Retain fixed categories and counts only, never broker response content."""
    category = 'local_processing_failed'

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate_field')
            result[key] = value
        return result

    try:
        # One bounded read, including a sentinel byte to detect truncation.
        data = error.read(MAX_COMPLETION_ERROR + 1)
        if len(data) <= MAX_COMPLETION_ERROR:
            body = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object)
            if type(body) is dict and set(body) == {'error'} and type(body['error']) is str:
                category = COMPLETION_ERROR_CATEGORIES.get(body['error'], category)
    except Exception:
        # Broken, malformed or unavailable diagnostics cannot change a known
        # rejection into an uncertain completion or escape with private data.
        pass
    finally:
        try:
            error.close()
        except Exception:
            pass
    return {'event': 'local_transcript_completion_rejected', 'category': category,
            'httpStatus': error.code, 'requestBytes': request_bytes}


def record_completion_rejection(error, request_bytes):
    diagnostic = completion_rejection_diagnostic(error, request_bytes)
    try:
        # The relay inherits stderr; the service journal supplies the timestamp.
        print(json.dumps(diagnostic, separators=(',', ':')), file=sys.stderr, flush=True)
    except Exception:
        # Logging failure must not interfere with the existing Fail/retry path.
        pass


def configured_output_host(value):
    if (not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}', value)
            or re.search(r'(^|\.)example\.(org|com|net)$', value)):
        raise ValueError('worker_output_unconfigured')
    return value


def configured_broker_origin(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
            parsed.port is not None or parsed.path != '/' or parsed.query or parsed.fragment or
            parsed.hostname.endswith('.example.org') or value != 'https://' + parsed.hostname + '/'):
        raise ValueError('worker_broker_unconfigured')
    return value


class Broker:
    def __init__(self, token):
        self.origin = configured_broker_origin(BROKER)
        if not isinstance(token, str) or len(token) != 48 or not token.isascii() or not token.isalnum():
            raise ValueError('worker_credential_invalid')
        self.token = token
        self.http = urllib.request.build_opener(NoRedirect())

    def call(self, action, body):
        try:
            encoded = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
            if len(encoded) > MAX_RESULT:
                raise ValueError('local_processing_failed')
        except (ValueError, TypeError, OverflowError):
            # No HTTP request exists yet, so rejection cannot hide a commit.
            error_type = CompletionRejected if action == 'Complete' else ValueError
            raise error_type('local_processing_failed') from None
        request = urllib.request.Request(self.origin + 'videoTranscriptWorker' + action,
            data=encoded, headers={'Authorization': 'Bearer ' + self.token,
                'Content-Type': 'application/json', 'User-Agent': USER_AGENT})
        try:
            with self.http.open(request, timeout=60 if action == 'Complete' else 20) as response:
                data = response.read(MAX_RESULT + 1)
                if len(data) > MAX_RESULT:
                    raise ValueError('broker_response_too_large')
                return json.loads(data)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 409):
                raise LeaseLost() from None
            if action == 'Complete' and error.code in (400, 413):
                record_completion_rejection(error, len(encoded))
                raise CompletionRejected('local_processing_failed') from None
            raise RuntimeError('broker_unavailable') from None


class Lease:
    def __init__(self, broker, job, deadline=None):
        self.broker = broker
        self.identity = {'jobId': job['id'], 'leaseToken': job['leaseToken']}
        if job.get('kind') in ('alignment', 'orientation'):
            self.identity['kind'] = job['kind']
        self.stage = 'downloading'
        # A hung model must not renew the lease forever.
        self.deadline = resume_attempt(job)[1] if deadline is None else deadline
        self.lost = threading.Event()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.heartbeat, daemon=True)

    def check(self):
        if STOP.is_set() or self.lost.is_set():
            raise LeaseLost()
        if time.monotonic() >= self.deadline:
            raise JobTimedOut("local_processing_failed")

    def checkpoint(self, stage):
        self.check()
        self.stage = stage
        self.broker.call('Heartbeat', {**self.identity, 'stage': stage})

    def heartbeat(self):
        while not self.done.wait(30):
            try:
                self.check()
                self.broker.call('Heartbeat', {**self.identity, 'stage': self.stage})
            except JobTimedOut:
                # The main thread can still retire this owned attempt safely.
                return
            except Exception:
                self.lost.set()
                return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=21)


def download(job, destination, lease):
    item = job['input']
    opener = urllib.request.build_opener(NoRedirect())
    count = 0
    digest = hashlib.sha256()
    with opener.open(item['url'], timeout=30) as response, open(destination, 'wb') as output:
        if item.get('storage') == 'private-r2':
            if (response.headers.get('x-amz-meta-binding') != item['bindingId']
                    or response.headers.get('x-amz-meta-generation') != item['generation']):
                raise ValueError('local_input_failed')
        elif response.headers.get('x-amz-version-id') != item['versionId']:
            raise ValueError('local_input_failed')
        while True:
            lease.check()
            block = response.read(1024 * 1024)
            if not block:
                break
            count += len(block)
            digest.update(block)
            if count > item['sizeBytes']:
                raise ValueError('local_input_failed')
            output.write(block)
    if count != item['sizeBytes'] or (item.get('sha256') and digest.hexdigest() != item['sha256']):
        raise ValueError('local_input_failed')


def overlapping_windows(turns):
    """Find intervals where the regular diarizer reports distinct voices together."""
    events = []
    for start, end, label in turns:
        events.extend([(start, 1, label), (end, -1, label)])
    active = {}
    windows = []
    previous = None
    for at, change, label in sorted(events):
        if previous is not None and at > previous and len(active) > 1:
            windows.append((previous, at))
        active[label] = active.get(label, 0) + change
        if active[label] <= 0:
            del active[label]
        previous = at
    return windows


def word_interval(word, duration_seconds):
    """Repair the model's centisecond zero-length words before delivery."""
    start, end = float(word['start']), float(word['end'])
    if not math.isfinite(start) or not math.isfinite(end):
        raise ValueError('local_processing_failed')
    if end == start and 0 <= start < duration_seconds:
        end = min(duration_seconds, start + MIN_WORD_DURATION_SECONDS)
    if end <= start:
        raise ValueError('local_processing_failed')
    return start, end


def assign_speakers(words, turns, max_speakers, regular_turns=None,
                    duration_seconds=float('inf')):
    """Keep word timing and short passages; never infer a voice across silence."""
    labels = {}
    segments = []
    turn_index = 0
    overlap_index = 0
    overlaps = overlapping_windows(regular_turns or [])
    for word in words:
        text = str(word['text']).strip()
        if not text:
            continue
        # Keep native model scalars out of the result pipe and JSON payload.
        start, end = word_interval(word, duration_seconds)
        while turn_index + 1 < len(turns) and turns[turn_index][1] < start:
            turn_index += 1
        last = turn_index
        while last + 1 < len(turns) and turns[last + 1][0] <= end:
            last += 1
        candidates = turns[max(0, turn_index - 1):min(len(turns), last + 2)]
        matched = [turn for turn in candidates if min(end, turn[1]) > max(start, turn[0])]
        speaker = 'unknown'
        if matched:
            turn = max(matched, key=lambda t: min(end, t[1]) - max(start, t[0]))
            label = turn[2]
            if label not in labels:
                if len(labels) >= max_speakers:
                    raise ValueError('local_processing_failed')
                labels[label] = 'spk_' + str(len(labels))
            speaker = labels[label]
        while overlap_index < len(overlaps) and overlaps[overlap_index][1] <= start:
            overlap_index += 1
        overlap = bool(overlap_index < len(overlaps) and overlaps[overlap_index][0] < end)
        timed_word = {'startSeconds': start, 'endSeconds': end, 'text': text}
        if isinstance(word.get('confidence'), Real) and 0 <= word['confidence'] <= 1:
            timed_word['confidence'] = float(word['confidence'])
        previous = segments[-1] if segments else None
        sentence_break = previous and previous['text'].endswith(('.', '!', '?')) and start - previous['startSeconds'] >= 15
        merge = (previous and previous['speaker'] == speaker
                 and previous['overlappingSpeech'] == overlap
                 and start - previous['endSeconds'] < 2
                 and end - previous['startSeconds'] <= 30 and not sentence_break
                 and len(previous['text']) + len(text) < 4000)
        if merge:
            previous['text'] += ' ' + text
            previous['endSeconds'] = max(previous['endSeconds'], end)
            previous['words'].append(timed_word)
        else:
            segments.append({'startSeconds': start, 'endSeconds': end, 'speaker': speaker,
                             'text': text, 'words': [timed_word],
                             'speakerUncertain': speaker == 'unknown', 'overlappingSpeech': overlap})
    return segments


def transcribe(path, job, lease, asr_path, diarization_path):
    # Imports are lazy so protocol tests do not need a GPU or model installation.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['PYANNOTE_METRICS_ENABLED'] = '0'
    import torch
    import av
    # A source without an audio track has an empty transcript, not a paid retry.
    with av.open(str(path)) as container:
        if not container.streams.audio:
            return []
    # CUDA libraries stay scoped to this worker process.
    if os.name == "nt":
        os.environ["PATH"] = str(Path(torch.__file__).parent / "lib") + os.pathsep + os.environ.get("PATH", "")
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from pyannote.audio import Pipeline
    if not torch.cuda.is_available():
        raise ValueError('local_model_unavailable')
    free, _ = torch.cuda.mem_get_info()
    if free < 6 * 1024 ** 3:
        raise ValueError('local_model_unavailable')
    torch.set_num_threads(4)
    lease.checkpoint('transcribing')
    audio = decode_audio(str(path), sampling_rate=16000)
    if len(audio) / 16000 > job['durationSeconds'] + 1:
        raise ValueError('local_input_failed')
    model = WhisperModel(str(asr_path), device='cuda', compute_type='int8_float16', cpu_threads=4,
                         num_workers=1, local_files_only=True)
    try:
        result, _ = model.transcribe(audio, language=job['languageCode'].split('-')[0],
            beam_size=5, word_timestamps=True, vad_filter=True)
        words = []
        for segment in result:
            lease.check()
            words.extend({'start': w.start, 'end': w.end, 'text': w.word, 'confidence': w.probability} for w in segment.words or [])
            if len(words) > 200_000:
                raise ValueError('local_processing_failed')
    finally:
        del model
        gc.collect()
        torch.cuda.empty_cache()
    if not words:
        return []
    lease.checkpoint('diarizing')
    pipeline = Pipeline.from_pretrained(str(diarization_path))
    try:
        pipeline.to(torch.device('cuda'))
        output = pipeline({'waveform': torch.from_numpy(audio).unsqueeze(0), 'sample_rate': 16000},
                          min_speakers=1, max_speakers=job['maxSpeakers'])
        turns = [(turn.start, turn.end, speaker) for turn, speaker in output.exclusive_speaker_diarization]
        regular_turns = [(turn.start, turn.end, speaker) for turn, speaker in output.speaker_diarization]
    finally:
        del pipeline
        gc.collect()
        torch.cuda.empty_cache()
    lease.checkpoint('finalizing')
    return assign_speakers(words, turns, job['maxSpeakers'], regular_turns,
                           job['durationSeconds'])


def unavailable_words(passage):
    return [{'text': token, 'startSeconds': passage['startSeconds'],
             'endSeconds': passage['startSeconds'], 'aligned': False}
            for token in passage['text'].strip().split()]


def normalized_alignment_items(passage, result, model_tokens):
    expected = passage['text'].strip().split()
    items = list(result)
    if len(expected) != len(model_tokens) or len(items) != len(model_tokens):
        return unavailable_words(passage)
    start_offset = passage['startSeconds']
    duration = passage['endSeconds'] - start_offset
    words = []
    previous = 0.0
    for expected_text, model_text, item in zip(expected, model_tokens, items):
        start = float(item.start_time)
        end = float(item.end_time)
        saved_start = round(start_offset + start, 3)
        saved_end = round(min(passage['endSeconds'], start_offset + end), 3)
        if (str(item.text) != model_text or not math.isfinite(start) or not math.isfinite(end) or
                start < previous or start < 0 or end <= start or end > duration + 0.001 or
                saved_end <= saved_start):
            return unavailable_words(passage)
        words.append({'text': expected_text, 'startSeconds': saved_start,
                      'endSeconds': saved_end,
                      'aligned': True})
        previous = end
    return words


def decode_alignment_audio(path):
    from faster_whisper.audio import decode_audio
    audio = decode_audio(str(path), sampling_rate=16000)
    if getattr(audio, 'ndim', None) != 1 or str(getattr(audio, 'dtype', '')) != 'float32':
        raise ValueError('alignment_input_failed')
    return audio


def align_passages(path, job, lease, model_path):
    os.environ['HF_HUB_OFFLINE'] = '1'
    import torch
    from qwen_asr import Qwen3ForcedAligner
    if not torch.cuda.is_available():
        raise ValueError('alignment_model_unavailable')
    free, _ = torch.cuda.mem_get_info()
    if free < 4 * 1024 ** 3:
        raise ValueError('alignment_model_unavailable')
    torch.set_num_threads(4)
    lease.checkpoint('aligning')
    audio = decode_alignment_audio(path)
    if len(audio) / 16000 > job['durationSeconds'] + 1:
        raise ValueError('alignment_input_failed')
    aligner = Qwen3ForcedAligner.from_pretrained(str(model_path), device_map='cuda:0',
                                                 dtype=torch.bfloat16, local_files_only=True)
    language = 'English' if job['languageCode'] == 'en-US' else 'Spanish'
    try:
        supported = aligner.get_supported_languages()
        if supported is not None and language.lower() not in supported:
            raise ValueError('alignment_model_unavailable')
        aligned = []
        for passage in job['passages']:
            lease.check()
            first = max(0, round(passage['startSeconds'] * 16000))
            last = min(len(audio), round(passage['endSeconds'] * 16000))
            if last <= first:
                raise ValueError('alignment_input_failed')
            model_tokens, _ = aligner.aligner_processor.encode_timestamp(passage['text'], language)
            result = aligner.align(audio=(audio[first:last], 16000), text=passage['text'], language=language)
            if type(result) is not list or len(result) != 1:
                raise ValueError('alignment_processing_failed')
            aligned.append({'index': passage['index'],
                            'words': normalized_alignment_items(passage, result[0], model_tokens)})
    finally:
        del aligner
        gc.collect()
        torch.cuda.empty_cache()
    lease.checkpoint('finalizing')
    return {'requestId': job['id'], 'status': 'complete', 'passages': aligned}



def inference_child(connection, path, settings, asr_path, diarization_path):
    class Progress:
        def check(self):
            pass
        def checkpoint(self, stage):
            connection.send(('stage', stage))
    try:
        segments = transcribe(path, settings, Progress(), asr_path, diarization_path)
        connection.send(('result', segments))
    except Exception:
        connection.send(('error', 'local_processing_failed'))
    finally:
        connection.close()


def alignment_child(connection, path, settings, model_path):
    class Progress:
        def check(self):
            pass
        def checkpoint(self, stage):
            connection.send(('stage', stage))
    try:
        result = align_passages(path, settings, Progress(), model_path)
        connection.send(('result', result))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) else ''
        if code not in ('alignment_processing_failed', 'alignment_model_unavailable', 'alignment_input_failed'):
            code = 'alignment_processing_failed'
        connection.send(('error', code))
    finally:
        connection.close()


def start_inference_process(process):
    if os.name != 'nt':
        process.start()
        return
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.SetStdHandle.argtypes = [wintypes.DWORD, wintypes.HANDLE]
    kernel.SetStdHandle.restype = wintypes.BOOL
    stdin = kernel.GetStdHandle(-10)
    # Windows child startup closes inherited stdin. Keep the SSH control pipe
    # out of the child so that only a real relay disconnect stops the worker.
    with open(os.devnull, 'rb') as empty:
        if not kernel.SetStdHandle(-10, msvcrt.get_osfhandle(empty.fileno())):
            raise ctypes.WinError()
        try:
            process.start()
        finally:
            if not kernel.SetStdHandle(-10, stdin):
                raise ctypes.WinError()


def transcribe_in_process(path, job, lease, asr_path, diarization_path):
    # The child receives no broker credential or lease token. Its GPU process can
    # be stopped if the lease expires, the model hangs, or the worker shuts down.
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    settings = {key: job[key] for key in ('languageCode', 'maxSpeakers', 'durationSeconds')}
    process = context.Process(target=inference_child, args=(send, path, settings, asr_path, diarization_path))
    try:
        start_inference_process(process)
        send.close()
        while True:
            lease.check()
            if receive.poll(1):
                try:
                    kind, value = receive.recv()
                except (EOFError, OSError):
                    raise ValueError("local_processing_failed") from None
                if kind == 'stage':
                    lease.checkpoint(value)
                elif kind == 'result':
                    lease.check()
                    return value
                else:
                    raise ValueError('local_processing_failed')
            # A synchronous stage heartbeat can outlast the child. Drain its
            # queued result before treating process exit as a failure.
            if not process.is_alive() and not receive.poll():
                raise ValueError('local_processing_failed')
    finally:
        send.close()
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(timeout=10)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
        receive.close()


def align_in_process(path, job, lease, model_path):
    context = multiprocessing.get_context('spawn')
    receive, send = context.Pipe(duplex=False)
    settings = {key: job[key] for key in ('id', 'kind', 'engine', 'languageCode',
                                          'durationSeconds', 'passages')}
    process = context.Process(target=alignment_child, args=(send, path, settings, model_path))
    try:
        start_inference_process(process)
        send.close()
        while True:
            lease.check()
            if receive.poll(1):
                try:
                    kind, value = receive.recv()
                except (EOFError, OSError):
                    raise ValueError('alignment_processing_failed') from None
                if kind == 'stage':
                    lease.checkpoint(value)
                elif kind == 'result':
                    lease.check()
                    return value
                else:
                    raise ValueError(value)
            if not process.is_alive() and not receive.poll():
                raise ValueError('alignment_processing_failed')
    finally:
        send.close()
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(timeout=10)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
        receive.close()


def run_job(broker, job, args, deadline=None, attempt_state=None):
    if attempt_state is None:
        attempt_state = {}
    with Lease(broker, job, deadline=deadline) as lease:
        completing = False
        try:
            alignment_job = job.get('kind') == 'alignment'
            orientation_job = job.get('kind') == 'orientation'
            if orientation_job:
                validate_orientation_job(job, args)
            elif alignment_job:
                validate_alignment_job(job, args)
            else:
                validate_job(job)
            if attempt_state.get("failure"):
                lease.check()
                raise ValueError(attempt_state["failure"])
            with tempfile.TemporaryDirectory(prefix='job-', dir=args.work_dir) as directory:
                if orientation_job:
                    completion = export_orientation(broker, job, directory, lease, args)
                    if completion is not None:
                        lease.check()
                        completing = True
                        broker.call('Complete', completion)
                    return
                source = Path(directory) / ('input.m4a' if job['input'].get('mimeType') == 'audio/x-m4a' else 'input.mp4')
                lease.checkpoint('downloading')
                download(job, source, lease)
                result = (align_in_process(source, job, lease, args.alignment_model) if alignment_job else
                          transcribe_in_process(source, job, lease, args.asr_model, args.diarization_model))
                lease.check()
                completing = True
                completion = ({**lease.identity, 'result': result} if alignment_job else
                              {**lease.identity, 'engineRevision': ENGINE, 'segments': result})
                broker.call('Complete', completion)
        except LeaseLost:
            print('Worker lease ended', flush=True)
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) else ''
            failures = (('alignment_processing_failed', 'alignment_model_unavailable', 'alignment_input_failed')
                        if job.get('kind') == 'alignment' else ORIENTATION_FAILURES
                        if job.get('kind') == 'orientation' else
                        ('local_processing_failed', 'local_model_unavailable', 'local_input_failed'))
            if code not in failures:
                code = failures[0]
            if (not completing or isinstance(error, CompletionRejected)) and not lease.lost.is_set() and not STOP.is_set():
                # Persist rejection before Fail: its response can be lost while
                # Claim still returns this token. Never repeat inference then.
                attempt_state["failure"] = code
                broker.call('Fail', {**lease.identity, 'errorCode': code})
            print('Worker job failed', flush=True)


def lock_worker(directory):
    handle = open(directory / "worker.lock", "a+b")
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        if handle.read(1) == b"":
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return handle


def read_token(use_stdin):
    if use_stdin:
        credential = sys.stdin.readline(8193)
        if len(credential) > 8192:
            raise ValueError("worker_credential_invalid")
        return json.loads(credential)["token"]
    if os.name != "nt":
        raise ValueError("Use token stdin outside Windows")
    from keyring.backends.Windows import WinVaultKeyring
    return WinVaultKeyring().get_password("njpbs-boardwalk-transcription", "node-gpu-b")


def poll_jobs(broker, args, once=False, stop=STOP):
    attempt = None
    idle_delay = 30
    while not stop.is_set():
        try:
            # Only a worker with FFmpeg configured asks for export jobs.
            response = broker.call('Claim', {'capabilities': ['orientation']} if getattr(args, 'ffmpeg', None) else {})
            if response.get('job'):
                idle_delay = 30
                # A recovered lease retains its original watchdog budget, even
                # when the previous Fail response was lost.
                attempt = resume_attempt(response['job'], attempt)
                run_job(broker, response['job'], args, deadline=attempt[1], attempt_state=attempt[2])
            elif once:
                return
            else:
                stop.wait(idle_delay)
                idle_delay = min(idle_delay * 2, 60)
        except Exception:
            idle_delay = 30
            print('Worker broker unavailable', flush=True)
            stop.wait(30)
        if once:
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--configure-token', action='store_true')
    parser.add_argument('--token-stdin', action='store_true')
    parser.add_argument('--stop-on-stdin-close', action='store_true')
    parser.add_argument('--asr-model', type=Path)
    parser.add_argument('--diarization-model', type=Path)
    parser.add_argument('--alignment-model', type=Path)
    parser.add_argument('--alignment-model-repository')
    parser.add_argument('--alignment-model-revision')
    parser.add_argument('--alignment-cache-sha256')
    parser.add_argument('--work-dir', type=Path)
    parser.add_argument('--ffmpeg', type=Path)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    configured_broker_origin(BROKER)
    if args.ffmpeg is not None:
        configured_output_host(OUTPUT_HOST)
    if args.configure_token:
        if os.name != "nt":
            raise ValueError("Windows Credential Manager required")
        from keyring.backends.Windows import WinVaultKeyring
        token = read_token(True)
        Broker(token)  # Validate before storing in the OS vault.
        WinVaultKeyring().set_password("njpbs-boardwalk-transcription", "node-gpu-b", token)
        return
    if args.work_dir is None:
        raise ValueError("Worker directory required")
    for path in (args.asr_model, args.diarization_model):
        if path is None or not path.is_dir():
            raise ValueError('local_model_unavailable')
    alignment_values = (args.alignment_model, args.alignment_model_repository,
                        args.alignment_model_revision, args.alignment_cache_sha256)
    if any(value is not None for value in alignment_values):
        if (any(value is None for value in alignment_values) or not args.alignment_model.is_dir() or
                not isinstance(args.alignment_model_revision, str) or
                not all(character in '0123456789abcdef' for character in args.alignment_model_revision) or
                len(args.alignment_model_revision) != 40 or
                not isinstance(args.alignment_cache_sha256, str) or
                not all(character in '0123456789abcdef' for character in args.alignment_cache_sha256) or
                len(args.alignment_cache_sha256) != 64 or
                directory_sha256(args.alignment_model) != args.alignment_cache_sha256):
            raise ValueError('alignment_model_unavailable')
    if args.ffmpeg is not None and not args.ffmpeg.is_file():
        raise ValueError('export_processing_failed')
    args.work_dir.mkdir(parents=True, exist_ok=True)
    worker_lock = lock_worker(args.work_dir)
    broker = Broker(read_token(args.token_stdin))
    if args.stop_on_stdin_close:
        if not args.token_stdin:
            raise ValueError("Stdin relay required")
        def watch_relay():
            sys.stdin.read(1)
            STOP.set()
        threading.Thread(target=watch_relay, daemon=True).start()
    # Keep the OS lock open for this process lifetime.
    assert worker_lock.fileno() >= 0
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: STOP.set())
    poll_jobs(broker, args, once=args.once)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Worker startup failed', flush=True)
        sys.exit(1)
