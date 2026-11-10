# QA tools

This folder contains checks for the current NJ PBS site. Test results are valid
only for the source and build that produced them. Do not treat saved output from
an older build as current evidence.

## Setup

The browser checks need Python Playwright and installed Google Chrome
156.0.8078.73 or newer. Chrome runs with its sandbox enabled.
`axe_scan.py` also loads the pinned `axe-core` package from `site/node_modules`.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r qa/requirements.txt
cd site
npm ci
```

## Checks

- `audit_dist.py` checks built HTML, links, metadata, and the sitemap. Run
  `python3 qa/audit_dist.py site/dist`. Add `--coming-soon` for a
  `PUBLIC_ONLY` build.
- `axe_scan_browser_test.py` checks emitted routes for console/page errors,
  full-homepage native scrolling and mobile Menu/Escape behavior, and
  coming-soon scene selection, automatic rotation, pause/resume and reduced
  motion. Run `python3 qa/axe_scan_browser_test.py --base
  http://127.0.0.1:4321 --mode full --dist site/dist`; use `--mode coming-soon`
  for the `PUBLIC_ONLY=1` build. Timers use Playwright's clock.
- `axe_scan.py` scans every emitted HTML route with the repository's pinned
  axe rules. Run `python3 qa/axe_scan.py --base http://127.0.0.1:4321 --mode
  full --dist site/dist`.
- `adr_guard.py` checks the decision-record index. Run `python3 qa/adr_guard.py`
  or `python3 qa/adr_guard.py --selftest`.

`axe_scan.py` writes `qa/axe-findings.json`, which is ignored by Git. Its exit
code is nonzero for accessibility findings, navigation or scan errors, or a
build-mode mismatch. Failed browser requests are recorded for diagnosis but do
not fail this accessibility gate. A clean result applies only to the scanned
build.

On `/search/`, the scan waits for page load and the visible, mounted keyword
search form. Background meaning-search downloads do not delay that check.
Other axe-scanned routes retain their network-idle wait and existing mount-settle
time. The console sweep waits for load and a 400ms error-observation window, plus the
mounted search form; external model downloads do not stall it. Streaming PBS embeds
are outside the top-document checks.
If the search form never mounts, the scan records a blocking error.

`python3 qa/axe_scan_browser_test.py --base http://127.0.0.1:4321` checks this
boundary against a served full build in fresh browser contexts. It holds the
model request at the network boundary and verifies that the mounted form is
scanned, an injected missing-label violation still fails, and a broken search
script causes a scan error. CI runs it before the full-build scan, using the
same pinned browser and axe runtime.

The required Site CI job runs the browser checks against each existing build
before it is replaced: coming-soon first, then full. The full target additionally
runs search-readiness and the axe scan over every emitted route, uploading the
JSON result. Both modes verify their emitted route families.

Automated checks do not replace keyboard, screen-reader, zoom, or content
review. Run those checks for affected pages and during scheduled accessibility
audits.
