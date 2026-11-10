# Studio connector configuration

Package builds require `CMS_STUDIO_API_ORIGIN`, an HTTPS origin with no path,
credentials, query or fragment. The release process supplies this value from
private deployment configuration. `build-windows.mjs` validates it before any
download and supplies the same origin to the bundled command-stream transport
and packaged `pairing.json`. A plain development build without the variable
supports simulation and HTTPS polling; it does not opt in to a command socket.
No origin is fetched during command handling.

The Admin build supplies `VITE_FUNCTIONS_BASE_URL` for the same HTTPS API origin
and `VITE_CMS_STUDIO_CONFIGURATION` containing the full validated preset JSON.
The Admin captures these inputs at module startup. Missing or malformed values
refuse Studio setup while leaving the rest of the application available. Its
clipboard handoff keeps the configured `vmixPort` and exact role-specific input
numbers. Supply the same preset to Admin and the installed connector.

Functions requires `CMS_STUDIO_TITLE_FILES`, a JSON object containing exactly
the `headline` and `name_title` basenames from that preset's `titleFiles`. The
deployment workflow validates its existing `VITE_CMS_STUDIO_CONFIGURATION`
secret and derives this separate Functions parameter before deployment. The service captures and
validates it at the first runtime commissioning request. Missing or malformed
configuration refuses commissioning with HTTP 503; other Studio actions remain
available. Native filename evidence must match these independently supplied
names. The contract's example filenames are not an operational allowlist. Null
native paths still require the existing explicit operator attestation.
The workflow maps the repository variable `LIVE_PRODUCTION_ENABLED` to
`VITE_LIVE_PRODUCTION_ENABLED` for Admin and both Functions preparation steps.
When it is `true`, a valid preset is required. When disabled, an unavailable preset writes an empty server parameter
and leaves unrelated Functions releases available.

The studio operator supplies a private `studio-config.json` next to the installed
connector. Start from `studio-config.example.json`; the example deliberately
cannot pass validation. Setup reads the private file once before enrollment,
rejects unknown fields and placeholders, and checks five distinct positive input
numbers plus both GT source filenames. It derives the expected Boardwalk API
origin from the package's validated pairing endpoint. Mapping mismatches still
stop setup before a session configuration is saved.

`vmixHost` is restricted to IPv4 loopback and `apiAccessMode` declares the only
supported setup read mode, `loopback-without-login`. The port, background input,
text inputs, overlay inputs and source filenames are studio configuration. This
file accepts no passwords or other credential fields. Keep it private, outside
the repository and distributed ZIP. Existing credential storage, native routing
checks and session commissioning remain required.

Supplier inventory:

| Value | Supplier | Read time |
| --- | --- | --- |
| `CMS_STUDIO_API_ORIGIN` | Private package-build environment | Build |
| `VITE_CMS_STUDIO_CONFIGURATION` | Private Admin build environment, full preset JSON | Module startup |
| `VITE_FUNCTIONS_BASE_URL` | Private Admin build environment, matching API origin | Module startup |
| `CMS_STUDIO_TITLE_FILES` | Functions parameter derived from the existing private preset secret | First runtime commissioning request |
| `pairing.json.pairingEndpoint` | Package build from the validated origin | Setup |
| `studio-config.json` preset values | Studio operator through private local configuration | Setup, before pairing |

Simulator input numbers, filenames and labels are independent synthetic examples.
