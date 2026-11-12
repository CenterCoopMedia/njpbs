# Transcription worker

The worker polls the configured broker for bounded transcription work. Source input must match BOARDWALK_INPUT_HOST or the explicitly configured private object-storage origin. Tokens arrive on standard input. The relay reads its command and credential_command arrays from operator-owned JSON, fetches a credential in memory, and forwards it only to the owned child stdin. No host or credential-store entry is selected by this source. Use a process supervisor for restart and shutdown. The supplied user service is an installation example; configure its executable paths and relay file before use.

Run the adjacent focused tests before changing a template or worker. Deployment needs separate authorization and configured credentials.

## GPU runtime qualification

Use an isolated Python environment and trusted, already downloaded model directories.
The worker loads Whisper and Qwen offline. The runtime check exercises actual
transcription, diarization and word alignment on both committed speech fixtures;
it also checks that startup rejects a changed cache before reading credentials.
It supplies no broker credential and never claims a job.

Torch 2.13 uses CUDA 13. CTranslate2 4.8.2 requires the separate CUDA 12 cuBLAS
package; the worker loads those libraries from its own Python environment.
TorchAudio 2.11 uses the [stable Torch ABI](https://docs.pytorch.org/audio/stable/installation.html)
and supports Torch 2.13. PyAV 18 retains the decoder API used by faster-whisper 1.2.1.

In a Bash session in this directory, set `RUNTIME_PYTHON` to the isolated Python
executable and supply the three trusted model paths, approved alignment revision
and the source cache's SHA-256 through the variables below. Keep the live worker
environment unchanged.

```bash
"$RUNTIME_PYTHON" -m pip install -r requirements.txt
"$RUNTIME_PYTHON" -m pip check
"$RUNTIME_PYTHON" -m unittest discover -s . -p 'test_*.py'
"$RUNTIME_PYTHON" check_runtime.py \
  --asr-model "$ASR_MODEL" \
  --diarization-model "$DIARIZATION_MODEL" \
  --alignment-model "$ALIGNMENT_MODEL" \
  --alignment-model-revision "$ALIGNMENT_MODEL_REVISION" \
  --alignment-cache-sha256 "$ALIGNMENT_CACHE_SHA256"
```

Before installing the worker, supply `CMS_PRODUCTION_API_ORIGIN` and run `node scripts/render-development-config.mjs --production --root <disposable-checkout>` with the source tools. Install only from that verified rendered checkout. The worker validates the resolved HTTPS broker at startup, before reading a token or making a request; an unrendered placeholder refuses. Focused tests use a synthetic broker.

## Video exports

With FFmpeg configured, the worker can export library videos in vertical or
horizontal format. It keeps the source sharp over a blurred background and
returns the result through the broker's bounded upload protocol.

Supply BOARDWALK_OUTPUT_HOST with the permitted originals-storage hostname in
the worker's process environment before enabling FFmpeg. An empty or invalid
host refuses before credentials are read or jobs are claimed. Workers without
FFmpeg do not need this input.

In a Bash session in a disposable source checkout, with
CMS_PRODUCTION_API_ORIGIN supplied, render the broker before installation:

```bash
node scripts/render-development-config.mjs --production --root "$PWD"
```

Pass the installed FFmpeg executable with --ffmpeg. A worker without that option
keeps handling transcription and alignment jobs. Run the adjacent orientation
tests before installation. Deployment requires separate authorization.
