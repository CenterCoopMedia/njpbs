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

Before installing the worker, supply `CMS_PRODUCTION_API_ORIGIN`, `CMS_LOCAL_PUBLICATION_OWNER` and `CMS_GPU_WORKER_ID`, then run `node scripts/render-development-config.mjs --production --root <disposable-checkout>` with the source tools. Keep the GPU ID equal to the recorded worker authentication and Windows vault user; this preserves the existing credential lookup and shared lease slot. Install only from that verified rendered checkout. The worker validates the resolved HTTPS broker at startup, before reading a token or making a request; an unrendered placeholder refuses. Focused tests use a synthetic broker.
