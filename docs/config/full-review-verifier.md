# Full-review verifier boundary

Rate-control evidence reads two operator-owned startup settings:

| Setting | Contract |
| --- | --- |
| `CMS_PUBLIC_RELEASE_REVIEW_VERIFIER` | Absolute executable path to a trusted read-only review verifier; no shell command string |
| `CMS_PUBLIC_RELEASE_REVIEW_RECEIPT_SCHEMA` | Expected receipt-schema identifier, 1–128 letters, digits or `_.:/-` characters, starting with a letter or digit |

Missing or malformed settings refuse evidence creation before verifier or
provider work. The process captures settings at module startup. Requests cannot
choose the executable, schema, verdict or receipt location.

The verifier receives separate arguments for `--repo`, `--operator-commit`,
`--base`, `--tree` and `--receipt-schema`. It must independently authenticate
complete-diff review evidence under its privately configured review policy and
refuse if that proof is missing, incomplete, stale or bound to another source.
The verifier must not perform a new review or print credentials/private policy
records. It returns only the bounded JSON envelope below on standard output;
standard error is suppressed at this boundary.

The envelope has exactly these fields:

| Field | Required value |
| --- | --- |
| `receiptSchema` | Configured expected identifier |
| `scope` | `complete-diff` |
| `verdict` | `pass` |
| `repo` | Canonical repository path from the invocation |
| `operatorCommitSha` | Exact clean source commit from the invocation |
| `reviewBaseCommitSha` | Exact ancestor base from the invocation |
| `snapshotTreeSha` | Exact source-tree SHA from the invocation |
| `reviewReceiptDigest` | Lowercase SHA-256 digest of the authenticated full-review proof |

The caller rechecks every binding, requires a strict full-review envelope and
limits output to 64 KiB. The executable runs without a shell and with a bounded
read-only environment/time budget. The returned evidence digest binds the whole
envelope. Reviewer identities, effort mapping, private pass-file layouts and
policy implementation remain outside this source tree.
