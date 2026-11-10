# Studio build suppliers

The Admin build, connector package and Functions commissioning service need
matching configuration from the operator's validated Studio preset. Supply
these inputs before building or deploying the corresponding component.

| Input | Workflow supplier | Consumer |
| --- | --- | --- |
| `CMS_STUDIO_API_ORIGIN` | Repository variable, exact-source Studio connector package build | `agents/vmix/build-windows.mjs` validates the origin before packaging and derives the pairing endpoint |
| `VITE_CMS_STUDIO_CONFIGURATION` | Production environment secret, Admin build | `admin/src/lib/live-production-setup.ts` parses the full operator preset at module startup |
| `CMS_STUDIO_TITLE_FILES` | Validated `titleFiles` from the same production `VITE_CMS_STUDIO_CONFIGURATION` secret | The Functions dotenv writer supplies the separate server parameter; journal commissioning compares native basenames against it |

The release planner validates the same preset and compares the derived parameter
in memory against every serving function. It uses the existing secret-derived
runtime parameter check, so a changed preset cannot silently reuse a release.
The repository-variable fingerprint allowlist remains limited to repository
variables; no private preset value or new value digest is added to receipts.
The existing repository variable `LIVE_PRODUCTION_ENABLED` supplies the process
flag `VITE_LIVE_PRODUCTION_ENABLED` to Admin and both Functions preparation steps.
When this flag is `true`, malformed or missing presets
refuse the writer before it creates the dotenv file. When it is `false`, a valid
preset still supplies the titles; an unavailable preset supplies an empty
parameter so unrelated Functions releases remain available. Commissioning then
refuses with HTTP 503. The existing feature flag is included in the repository
variable fingerprint. Neither the planner nor the writer logs the preset. Single-quoted dotenv
serialization preserves valid basename punctuation and Unicode.

Verify that the supplied values match the installed preset before commissioning. The guide does not
provision settings or authorize a deployment.
