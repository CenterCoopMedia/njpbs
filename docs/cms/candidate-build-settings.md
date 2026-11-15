# Prepared candidate build settings

The production Post compiler records its effective GA4 ID, report endpoint,
share-intake endpoint and Turnstile site key in
`.public-post-renderer/public-build-settings.json`. The retained checkpoint
stores this file at `renderer/public-build-settings.json`. The record names the exact source and
whether optional share/no-build overrides were absent. It contains no ambient
environment or credential fields.

The existing artifact checkpoint hashes this file with the renderer and public
artifact. Preparation validates the restored file before checkpoint work, then
again after the checkpoint can restore the first complete build. Missing proof
or a mismatch refuses the original operation. It does not rebuild a stored
checkpoint with the caller's current values.

The durable record at
`system/publicReleasePreparations/entries/<operation>/checkpoints/artifact`
carries `publicBuildSettings`. The immutable `proofs/complete` record carries the
same snapshot. Native seal checks both against the restored compiler file and
the requested production settings before provider upload and seal acceptance.
Native fresh check compares the sealed settings with the approved operator inputs
before pause. The four values are under `publicBuildSettings.values`;
`overridesAbsent` must be true, and `commitSha` must equal the original NEW source.

Use the existing prepare, seal and fresh-check wrappers with the same original
operation, source and approved public input values. Their terminal summaries
keep the existing operation/source/generation/status contract. Native checkpoint
and proof records provide the settings evidence; the caller environment alone
does not. Read those original records for a mismatch. Never edit a checkpoint,
write a replacement proof or select a second activation path to pass the check.

The credential session and release authority remain separate requirements. This
source change creates no production candidate and authorizes no deployment.
