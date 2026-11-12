"""Qualify installed GPU libraries with trusted offline models and local speech."""
import argparse
from importlib.metadata import version
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import time
from unittest.mock import patch

import worker

TEXT = 'This is a short English speech sample. Each spoken word has a clear place in time.'
SECOND_CLAUSE = 'Each spoken word has a clear place in time.'


def tokens(text):
    return re.findall(r'[a-z]+', text.lower())


class EmptyInput(io.StringIO):
    def __init__(self):
        super().__init__('')
        self.reads = 0

    def readline(self, *args):
        self.reads += 1
        return super().readline(*args)


def check_startup(args):
    original = worker.BROKER, sys.argv, sys.stdin
    try:
        # Exercise the actual startup before its credential boundary. This
        # reserved origin and empty stdin cannot authenticate or claim work.
        worker.BROKER = 'https://broker.invalid/'
        for digest, expected in [('0' * 64, 'cache-refused'), (args.alignment_cache_sha256, 'credential-boundary')]:
            with tempfile.TemporaryDirectory(prefix='transcription-runtime-') as directory:
                sys.argv = ['worker.py', '--token-stdin', '--work-dir', directory,
                    '--asr-model', str(args.asr_model), '--diarization-model', str(args.diarization_model),
                    '--alignment-model', str(args.alignment_model), '--alignment-model-repository', worker.ALIGNMENT_REPOSITORY,
                    '--alignment-model-revision', args.alignment_model_revision, '--alignment-cache-sha256', digest]
                sys.stdin = EmptyInput()
                try:
                    worker.main()
                except json.JSONDecodeError:
                    assert expected == 'credential-boundary' and sys.stdin.reads == 1
                except ValueError as error:
                    assert expected == 'cache-refused' and str(error) == 'alignment_model_unavailable'
                    assert sys.stdin.reads == 0
                else:
                    raise AssertionError('Startup crossed the empty credential boundary')
    finally:
        worker.BROKER, sys.argv, sys.stdin = original


class LocalLease:
    def checkpoint(self, stage):
        pass

    def check(self):
        pass


def check_fixture(path, args):
    from faster_whisper.audio import decode_audio
    from qwen_asr import Qwen3ForcedAligner
    duration = len(decode_audio(str(path), sampling_rate=16000)) / 16000
    lease = LocalLease()
    transcript = worker.transcribe(path, {'durationSeconds': duration, 'languageCode': 'en-US', 'maxSpeakers': 2},
        lease, args.asr_model, args.diarization_model)
    words = [word for segment in transcript for word in segment['words']]
    assert tokens(' '.join(segment['text'] for segment in transcript)) == tokens(TEXT)
    assert 0 < len(words) <= 200_000
    assert all(0 <= word['startSeconds'] <= word['endSeconds'] <= duration for word in words)
    assert all(0 <= word['confidence'] <= 1 for word in words)
    assert any(segment['speaker'] != 'unknown' for segment in transcript)
    assert len({segment['speaker'] for segment in transcript} - {'unknown'}) <= 2
    # Whisper's independent timing locates the second sentence.
    second_start = next(word['startSeconds'] for word in words if tokens(word['text']) == ['each'])
    passages = [
        {'index': 0, 'startSeconds': 0, 'endSeconds': duration, 'text': TEXT},
        {'index': 1, 'startSeconds': second_start, 'endSeconds': duration, 'text': SECOND_CLAUSE},
    ]
    raw_results = []
    original_align = Qwen3ForcedAligner.align

    def record_alignment(model, *values, **options):
        result = original_align(model, *values, **options)
        raw_results.append(result)
        return result

    # Observe the real third-party result without substituting model output.
    # Qwen may give a zero-duration short word; the worker then conservatively
    # marks that passage unaligned. Check actual model timing and adapter output.
    with patch.object(Qwen3ForcedAligner, 'align', record_alignment):
        aligned = worker.align_passages(path, {'id': 'local-runtime-check', 'durationSeconds': duration,
            'languageCode': 'en-US', 'passages': passages}, LocalLease(), args.alignment_model)
    assert aligned['status'] == 'complete' and len(aligned['passages']) == 2
    assert len(raw_results) == len(passages)
    for passage, result, raw in zip(passages, aligned['passages'], raw_results):
        assert [word['text'] for word in result['words']] == passage['text'].split()
        assert all(passage['startSeconds'] <= word['startSeconds'] <= word['endSeconds'] <= duration
            for word in result['words'])
        assert len(raw) == 1 and tokens(' '.join(item.text for item in raw[0])) == tokens(passage['text'])
        assert all(0 <= item.start_time <= item.end_time <= passage['endSeconds'] - passage['startSeconds']
            for item in raw[0])
        # The fixture's spoken content words must have positive actual timing.
        assert all(item.start_time < item.end_time for item in raw[0] if len(item.text) >= 4)
        if any(item.end_time - item.start_time < worker.MIN_WORD_DURATION_SECONDS for item in raw[0]):
            assert all(not word['aligned'] for word in result['words'])
    return {'fixture': path.name, 'durationSeconds': duration, 'words': len(words),
        'speakers': len({segment['speaker'] for segment in transcript} - {'unknown'}),
        'alignedWords': sum(word['aligned'] for result in aligned['passages'] for word in result['words'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asr-model', type=Path, required=True)
    parser.add_argument('--diarization-model', type=Path, required=True)
    parser.add_argument('--alignment-model', type=Path, required=True)
    parser.add_argument('--alignment-model-revision', required=True)
    parser.add_argument('--alignment-cache-sha256', required=True)
    args = parser.parse_args()
    assert args.alignment_model_revision == worker.ALIGNMENT_REVISION
    assert worker.directory_sha256(args.alignment_model) == args.alignment_cache_sha256
    check_startup(args)
    start = time.monotonic()
    fixtures = Path(__file__).with_name('fixtures')
    results = [check_fixture(fixtures / name, args) for name in
        ['alignment-english.wav', 'alignment-english-h264-aac.mp4']]
    print(json.dumps({'status': 'qualified', 'elapsedSeconds': time.monotonic() - start, 'fixtures': results,
        'alignmentRevision': args.alignment_model_revision, 'alignmentCacheSha256': args.alignment_cache_sha256,
        'versions': {name: version(name) for name in ['torch', 'torchaudio', 'torchcodec', 'pyannote.audio',
            'qwen-asr', 'faster-whisper', 'av', 'ctranslate2', 'nvidia-cublas-cu12']}}))


if __name__ == '__main__':
    main()
