# Historical media-credit repair identity

`scripts/backfill-media-public-credit.mjs --record-current` requires
`CMS_MEDIA_PUBLIC_CREDIT_REPAIR_ID` in its trusted process environment. It is
captured once when the module loads and must be the original eight lowercase
hexadecimal characters identifying the historical repair.

Supply the original private identifier on every retry. The command derives the
same audit document key and audit source from it, preserving the existing
exactly-once receipt. Do not generate a new identifier for an existing repair.
Missing or malformed configuration refuses before credentials or database work.
The recording transaction also checks existing record-current receipts and
refuses a different key, so a valid but incorrect identifier cannot repeat the
context update. This check applies to both plan and apply mode.
The ordinary backfill mode does not require this setting. Neither mode accepts
the identifier from CLI arguments.
