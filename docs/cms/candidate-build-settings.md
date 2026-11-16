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
same snapshot. The seal producer compares the restored compiler file with the
requested production settings before provider upload. Native seal acceptance
compares that snapshot with the durable checkpoint.
Native fresh check compares the sealed settings with the approved operator inputs
before pause. The four values are under `publicBuildSettings.values`;
`overridesAbsent` must be true, and `commitSha` must equal the original NEW source.

CMS contract capture validates the active renderer's checkpoint with the native
reader from its pinned `R-source` dependency. The freshly observed renderer SHA
must still match that dependency before the reader is loaded.
Capture and the post-replay state read share the same bound dependency snapshot.

Use the existing prepare, seal and fresh-check wrappers with the same original
operation, source and approved public input values. Their terminal summaries
keep the existing operation/source/generation/status contract. Native checkpoint
and proof records provide the settings evidence; the caller environment alone
does not. Read those original records for a mismatch. Never edit a checkpoint,
write a replacement proof or select a second activation path to pass the check.

The credential session and release authority remain separate requirements. This
source change creates no production candidate and authorizes no deployment.
