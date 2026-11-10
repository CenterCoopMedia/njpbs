#!/usr/bin/env python3
"""WCAG accessibility scan over a served build, using axe-core.

WCAG 2.1 AA is this project's binding legal floor (ADA Title II, by 2027-04-26 in
the docs). This script makes the a11y evidence reproducible: it injects the
pinned axe-core (site/node_modules/axe-core/axe.min.js) into each page and runs
the wcag2a/wcag2aa/wcag21a/wcag21aa rule tags, then writes the per-page result to
qa/axe-findings.json.

Run against a served build (start `npm run preview` first):
  python3 qa/axe_scan.py --base http://127.0.0.1:4321 --mode full
  python3 qa/axe_scan.py --base http://127.0.0.1:4321 --mode coming-soon

The page list is derived from the emitted build (every index.html / 404.html in
site/dist, via --dist), so the scan covers exactly what was built — it can't
silently miss an emitted route that a hardcoded scan list forgot. --mode is a
coverage sanity check against that derived set (full = the required root public
routes are present; coming-soon = those routes are absent).

Exit code is the number of pages with violations or scan errors (0 = clean), so
it can gate CI. Scan errors are recorded separately from accessibility findings
so a future baseline cannot accept an infrastructure failure as a known issue.
The hero pages need a mount settle, so each page waits before the scan.
Requests to endless streaming embeds (the PBS live player) are blocked, so they
cannot stall the scan or fail the gate. All other outside hosts still load.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from time import monotonic
from urllib.parse import urlsplit

# Playwright is imported inside main() rather than here so routes_from_dist can be
# imported and tested without a browser stack. The route list decides what the gate
# covers, so it is the part most worth testing, and requiring Playwright to test it
# would put it behind an install step that CI does not otherwise need.

HERE = os.path.dirname(os.path.abspath(__file__))
AXE_PATH = os.path.join(HERE, "..", "site", "node_modules", "axe-core", "axe.min.js")
DEFAULT_DIST = os.path.join(HERE, "..", "site", "dist")

# WCAG tag set — the rules that map to the AA legal floor.
TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]

# These stable root routes distinguish the current public build from the retained
# PUBLIC_ONLY coming-soon build. The wiki is intentionally absent from this list:
# it ships in both targets. Keep this small and tied to public route families that
# the source fallback always emits, even when no CMS snapshots are available.
FULL_BUILD_REQUIRED_ROUTES = ("/watch/", "/live/", "/donate/", "/schedule/")


def routes_from_dist(dist: str) -> list[str]:
    """Every emitted page as a route, derived from the built dist directory.

    dist/index.html -> /, dist/404.html -> /404,
    dist/about/index.html -> /about/, dist/archive/404.html -> /archive/404.
    Deriving from the build means the scan covers exactly what shipped, so a new
    route cannot slip past the accessibility gate unscanned.

    This assumes the project's build.format of "directory", where every page but the
    apex 404 lands as <route>/index.html. Under "file" most pages become <name>.html
    and the index.html filter below would drop them; main()'s --mode check catches
    that, because the surviving ["/", "/404"] fails the required-route check
    instead of passing as a clean scan of two pages.
    """
    routes: set[str] = set()
    for root, _dirs, files in os.walk(dist):
        for f in files:
            if f not in ("index.html", "404.html"):
                continue
            rel = os.path.relpath(os.path.join(root, f), dist)
            d = os.path.dirname(rel).replace(os.sep, "/")
            at_root = d in ("", ".")
            if f == "index.html":
                routes.add("/" if at_root else f"/{d}/")
            else:
                # Read the directory for 404.html too, rather than mapping every one
                # to "/404". Under build.format "directory" only the apex gets this
                # shape from a route (astro's STATUS_CODE_PAGES is the exact set
                # {"/404", "/500"}, so a nested /archive/404 emits
                # archive/404/index.html and is covered by the branch above). A
                # nested 404.html still reaches dist two other ways: a passthrough
                # file in site/public/, and a flip to build.format "file", which
                # emits every page as <dir>/<name>.html. Collapsing them onto "/404"
                # would scan the apex twice and leave the nested page unvisited
                # while the run still printed CLEAN.
                routes.add("/404" if at_root else f"/{d}/404")
    # "/" first, then the rest sorted, for stable output.
    rest = sorted(r for r in routes if r != "/")
    return (["/"] if "/" in routes else []) + rest


def mode_mismatch(paths: list[str], mode: str) -> str | None:
    """Return a build-mode error when emitted routes do not match the target."""
    emitted = set(paths)
    if mode == "full":
        for route in FULL_BUILD_REQUIRED_ROUTES:
            if route not in emitted:
                return f"--mode full is missing required route {route}"
        return None

    for route in FULL_BUILD_REQUIRED_ROUTES:
        if route in emitted:
            return f"--mode coming-soon includes full-build route {route}"
    return None


def successful_scan_result(
    violations: list[dict], failed_requests: list[str]
) -> dict[str, object]:
    """Record completed axe output without an infrastructure error."""
    return {
        "violations": violations,
        "scan_error": None,
        "failed_requests": failed_requests,
    }


def failed_scan_result(
    error: Exception, failed_requests: list[str]
) -> dict[str, object]:
    """Record an infrastructure failure outside the accessibility findings list."""
    return {
        "violations": [],
        "scan_error": str(error),
        "failed_requests": failed_requests,
    }


def gate_exit_code(results: dict[str, dict[str, object]]) -> int:
    """Fail when any page has accessibility findings or a scan failure."""
    return int(any(
        result["violations"] or result["scan_error"] is not None
        for result in results.values()
    ))


# Hosts whose embeds stream without end, so a page that frames them never reaches
# network idle. axe runs only in the top document here, so the framed content was
# never scanned; blocking these hosts removes no finding. Every other outside
# host still loads, because outside scripts can add markup to our pages.
STREAMING_EMBED_HOSTS = frozenset({"player.pbs.org"})


def is_blocked_embed(url: str) -> bool:
    """True for requests to an endless streaming embed host."""
    return (urlsplit(url).hostname or "") in STREAMING_EMBED_HOSTS


AXE_RUN = (
    "async () => {"
    "  const r = await axe.run(document, {runOnly: {type: 'tag', values: %s}});"
    "  return r.violations.map(v => ({"
    "    id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,"
    "    sample: (v.nodes[0] && v.nodes[0].target) || []"
    "  }));"
    "}" % json.dumps(TAGS)
)


def scan_page(page, url: str, axe_src: str, settle: int) -> dict[str, object]:
    """Navigate and scan one page; failures remain distinct from violations."""
    failed_requests: list[str] = []
    page.on("requestfailed",
            lambda req: not is_blocked_embed(req.url)
            and failed_requests.append(f"{req.method} {req.url}"))
    try:
        deadline = monotonic() + 20
        is_search = urlsplit(url).path == "/search/"
        # Meaning-search downloads can outlive navigation. The keyword form is
        # revealed only after mountSiteSearch has wired its controls.
        page.goto(url, wait_until="load" if is_search else "networkidle", timeout=20000)
        if is_search:
            page.get_by_role("search", name="NJ PBS site search", exact=True).wait_for(
                state="visible", timeout=max(1, (deadline - monotonic()) * 1000),
            )
        page.wait_for_timeout(settle)  # let the hero mount (tabindex fix applies here)
        page.evaluate(axe_src)
        violations = page.evaluate(AXE_RUN)
        return successful_scan_result(violations, failed_requests)
    except Exception as e:  # noqa: BLE001
        return failed_scan_result(e, failed_requests)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--mode", choices=["full", "coming-soon"], required=True)
    ap.add_argument("--dist", default=DEFAULT_DIST,
                    help="built dist dir to derive the page list from (default site/dist)")
    ap.add_argument("--settle", type=int, default=1500,
                    help="ms to wait for JS islands (the hero) to mount before scanning")
    args = ap.parse_args()

    if not os.path.exists(AXE_PATH):
        sys.exit(f"axe-core not found at {AXE_PATH} — run `npm install` in site/ first")
    if not os.path.isdir(args.dist):
        sys.exit(f"dist not found at {args.dist} — run `npm run build` in site/ first")
    axe_src = open(AXE_PATH, encoding="utf-8").read()

    paths = routes_from_dist(args.dist)
    if not paths:
        sys.exit(f"no index.html or 404.html found under {args.dist} -- "
                 f"run `npm run build` in site/, or point --dist at the build output")
    # Coverage sanity check: the build mode must match what was emitted, so a
    # coming-soon build never passes as a "full" a11y scan and vice versa.
    if mismatch := mode_mismatch(paths, args.mode):
        sys.exit(f"{mismatch} in {args.dist}")
    results: dict[str, dict] = {}
    pages_with_violations = 0
    pages_with_scan_errors = 0

    print(f"=== axe scan: mode={args.mode} base={args.base} (axe {len(axe_src)//1024}KB) ===")
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            channel="chrome",
            chromium_sandbox=True,
        )
        ctx = browser.new_context()
        blocked_hosts: set[str] = set()

        def block_embed(route):
            blocked_hosts.add(urlsplit(route.request.url).netloc)
            route.abort("blockedbyclient")

        ctx.route(is_blocked_embed, block_embed)
        for path in paths:
            page = ctx.new_page()
            result = scan_page(page, args.base + path, axe_src, args.settle)
            results[path] = result
            violations = result["violations"]
            scan_error = result["scan_error"]
            if scan_error is not None:
                pages_with_scan_errors += 1
                print(f"  [ERROR]  {path}: {scan_error}")
            elif violations:
                pages_with_violations += 1
                print(f"  [ISSUES] {path}")
                for v in violations:
                    print(f"      - {v['impact']}: {v['id']} (x{v['n']}) {v['sample']}")
            else:
                print(f"  [CLEAN]  {path}")
            page.close()
        browser.close()

    if blocked_hosts:
        print(f"blocked streaming embed hosts: {', '.join(sorted(blocked_hosts))}")
    out = os.path.join(HERE, "axe-findings.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    total = sum(sum(v["n"] for v in r["violations"]) for r in results.values())
    print(
        f"\n=== {args.mode}: {len(paths)} pages, {pages_with_violations} with violations, "
        f"{pages_with_scan_errors} scan errors, {total} violation nodes -> {out} ==="
    )
    sys.exit(gate_exit_code(results))


if __name__ == "__main__":
    main()
