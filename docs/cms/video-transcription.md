# Video transcription requests

`cmsRequestVideoTranscript` accepts `provider: "local"` without `newAttemptOf`
for an initial local-only request. The deployed transcription and local-processing
switches must both permit it. This request never falls back to a paid provider
and does not consume a free-retry allowance.

The provider policy forms part of the job's cache identity. Matching active work
under the same policy is reused; active work under a different policy is refused
before admission. A default request can reuse active local-only work when local
processing is enabled. It cannot create duplicate paid work when local processing
is disabled.

For another attempt, supply `provider: "local"` or `"amazon-transcribe"` with
the terminal previous request's ID as `newAttemptOf`. An optional `attemptKey`
must be a UUID v4. An explicit Amazon request requires a predecessor. Local
retries retain the existing per-person daily and active-request limits.
Matching active work under the same provider policy or a ready local result can
be returned without consuming another local retry.

`cmsRequestByokVideoTranscript` accepts `newAttemptOf` and `attemptKey` with its
ElevenLabs credential fields. A retry preserves the earlier request and its
history.
