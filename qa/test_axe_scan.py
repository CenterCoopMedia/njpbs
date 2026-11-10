#!/usr/bin/env python3
"""Tests for the axe scan's route derivation.

Run from the repo root:
    python3 -m unittest discover -s qa -p 'test_*.py'

routes_from_dist decides which pages the a11y gate visits, so it is where a
coverage claim either holds or quietly stops holding. A page missing from this
list is not reported as a failure; it is reported as nothing at all, and a green
scan that skipped a route reads exactly like a green scan that passed it.

These build real directories rather than mocking os.walk, so the mapping is
checked against a filesystem the way the scan sees one. Note the limit: the
fixtures are written here, not emitted by Astro, so they pin the derivation and
not the build. If Astro changed its output shape these would stay green, and the
route list would go wrong anyway -- keeping the fixtures honest is manual, and
`test_maps_the_shapes_astro_emits` is the one to re-check against a real dist.

Stdlib unittest, and axe_scan imports Playwright lazily, so this runs in CI with
no browser install.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from axe_scan import (  # noqa: E402
    failed_scan_result,
    gate_exit_code,
    is_blocked_embed,
    mode_mismatch,
    routes_from_dist,
    successful_scan_result,
)


def build_dist(root: str, pages: list[str]) -> None:
    """Write each path (relative to dist) as a file, creating parents."""
    for rel in pages:
        full = os.path.join(root, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write("<!doctype html><title>x</title>")


class RoutesFromDist(unittest.TestCase):
    def derive(self, pages: list[str]) -> list[str]:
        with tempfile.TemporaryDirectory() as d:
            build_dist(d, pages)
            return routes_from_dist(d)

    # Verified against the real site/dist: under build.format "directory" every page
    # lands as <route>/index.html, and the apex 404 is the one exception, because
    # astro's STATUS_CODE_PAGES is the exact set {"/404", "/500"}. A nested 404 is a
    # route like any other and emits archive/404/index.html, so it belongs here.
    def test_maps_the_shapes_astro_emits(self):
        self.assertEqual(
            self.derive([
                "index.html",
                "404.html",
                "about/index.html",
                "watch/index.html",
                "archive/404/index.html",
            ]),
            ["/", "/404", "/about/", "/archive/404/", "/watch/"],
        )

    # The apex sorts first and the rest alphabetically, so a diff of two scans is a
    # diff of findings rather than of directory-walk order.
    def test_orders_apex_first_then_sorted(self):
        routes = self.derive([
            "zebra/index.html",
            "alpha/index.html",
            "index.html",
        ])
        self.assertEqual(routes[0], "/")
        self.assertEqual(routes[1:], sorted(routes[1:]))

    # A bare nested 404.html does not come from an Astro route under this config; it
    # comes from a passthrough file in site/public/, or from a flip to build.format
    # "file". Either way it used to collapse onto "/404", so the apex got scanned
    # twice and the nested page was never visited while the run printed CLEAN.
    def test_keeps_a_passthrough_nested_404_distinct_from_the_apex_one(self):
        routes = self.derive(["index.html", "404.html", "archive/404.html"])
        self.assertIn("/404", routes)
        self.assertIn("/archive/404", routes)

    def test_finds_a_passthrough_404_that_only_exists_in_a_subdirectory(self):
        self.assertEqual(self.derive(["archive/404.html"]), ["/archive/404"])

    def test_ignores_files_that_are_not_pages(self):
        routes = self.derive([
            "index.html",
            "assets/app.js",
            "assets/style.css",
            "sitemap.xml",
            "about/notes.html",
        ])
        self.assertEqual(routes, ["/"])

    # main() reads this to tell a full build from a PUBLIC_ONLY one, so a coming-soon
    # build must not contain a full-build route.
    def test_a_coming_soon_build_yields_no_full_build_routes(self):
        routes = self.derive(["index.html", "404.html"])
        self.assertEqual(routes, ["/", "/404"])
        self.assertIsNone(mode_mismatch(routes, "coming-soon"))

    def test_an_empty_dist_yields_no_routes(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(routes_from_dist(d), [])

    def test_deeply_nested_routes_keep_their_full_path(self):
        self.assertEqual(
            self.derive(["about/history/index.html"]),
            ["/about/history/"],
        )


class ScanResult(unittest.TestCase):
    def test_success_keeps_accessibility_findings_in_violations(self):
        violations = [{"id": "image-alt", "impact": "critical", "n": 1}]

        result = successful_scan_result(violations, ["GET /missing.png"])

        self.assertEqual(result["violations"], violations)
        self.assertIsNone(result["scan_error"])
        self.assertEqual(result["failed_requests"], ["GET /missing.png"])
        self.assertEqual(gate_exit_code({"/": result}), 1)

    def test_failure_cannot_look_like_an_accessibility_violation(self):
        result = failed_scan_result(TimeoutError("navigation timed out"), [])

        self.assertEqual(result["violations"], [])
        self.assertEqual(result["scan_error"], "navigation timed out")
        self.assertEqual(gate_exit_code({"/": result}), 1)

    def test_clean_scan_keeps_the_gate_green(self):
        result = successful_scan_result([], [])

        self.assertEqual(gate_exit_code({"/": result}), 0)


class BuildModeContract(unittest.TestCase):
    def test_current_root_routes_identify_a_full_build(self):
        routes = [
            "/",
            "/404",
            "/watch/",
            "/live/",
            "/donate/",
            "/schedule/",
            "/wiki/",
        ]

        self.assertIsNone(mode_mismatch(routes, "full"))

    def test_retained_coming_soon_build_can_include_the_wiki(self):
        routes = ["/", "/404", "/wiki/", "/wiki/org/nj-pbs/"]

        self.assertIsNone(mode_mismatch(routes, "coming-soon"))

    def test_full_build_fails_when_a_required_public_route_is_missing(self):
        routes = ["/", "/404", "/watch/", "/live/", "/donate/"]

        self.assertEqual(
            mode_mismatch(routes, "full"),
            "--mode full is missing required route /schedule/",
        )

    def test_coming_soon_build_fails_when_a_full_public_route_is_present(self):
        routes = ["/", "/404", "/wiki/", "/watch/"]

        self.assertEqual(
            mode_mismatch(routes, "coming-soon"),
            "--mode coming-soon includes full-build route /watch/",
        )


class StreamingEmbedBlocking(unittest.TestCase):
    """Only endless streaming embeds are blocked; other outside hosts still load."""

    def test_pbs_live_player_is_blocked(self):
        self.assertTrue(is_blocked_embed(
            "https://player.pbs.org/ga-livestream-partnerplayer/?station_id=x"))

    def test_served_build_and_outside_scripts_still_load(self):
        for url in (
            "http://127.0.0.1:4321/live/",
            "https://www.pbs.org/livestream/",
            "https://challenges.cloudflare.com/turnstile/v0/api.js",
            "https://maps.nj.gov/arcgis/rest/services",
            "data:image/png;base64,AAAA",
        ):
            self.assertFalse(is_blocked_embed(url), url)

if __name__ == "__main__":
    unittest.main()
