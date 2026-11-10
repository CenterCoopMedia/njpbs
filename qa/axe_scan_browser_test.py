#!/usr/bin/env python3
"""Required browser interactions, emitted-route errors and search-readiness checks.

Run against each served build: --base URL --mode full|coming-soon --dist site/dist.
The existing Site CI consumer runs both targets before replacing their artifacts.
"""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

from axe_scan import (
    AXE_PATH, gate_exit_code, is_blocked_embed, mode_mismatch,
    routes_from_dist, scan_page,
)


class BrowserChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            channel="chrome", chromium_sandbox=True,
        )
        cls.axe = Path(AXE_PATH).read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()


class SearchReadiness(BrowserChecks):
    def setUp(self):
        # A new context has no browser cache. Hold the real model request at the
        # network boundary, without a delay, retry, or extra compute load.
        self.context = self.browser.new_context()
        self.held = []
        self.context.route("https://huggingface.co/**", lambda route: self.held.append(route))
        self.page = self.context.new_page()

    def tearDown(self):
        for route in self.held:
            route.abort()
        self.context.unroute_all(behavior="ignoreErrors")
        self.context.close()

    def scan(self):
        with self.context.expect_event(
            "request", predicate=lambda request: urlsplit(request.url).hostname == "huggingface.co",
        ):
            return scan_page(self.page, BASE + "/search/", self.axe, settle=0)

    def test_scans_the_mounted_form_while_the_model_request_is_pending(self):
        result = self.scan()
        self.assertTrue(self.held, "The test must exercise an unfinished model request")
        self.assertTrue(self.page.get_by_role("search", name="NJ PBS site search").is_visible())
        self.assertEqual(result["scan_error"], None)
        self.assertEqual(result["violations"], [])
        self.assertEqual(gate_exit_code({"/search/": result}), 0)

    def test_a_violation_in_the_mounted_form_still_blocks_the_gate(self):
        # Deliberately break the input's accessible name once the application
        # reveals the form. A scan of the hidden fallback would miss this defect.
        self.context.add_init_script("""
            new MutationObserver(() => {
                const form = document.querySelector('[data-site-search] form:not([hidden])');
                if (form) form.querySelector('label')?.remove();
            }).observe(document, {subtree: true, attributes: true, childList: true});
        """)
        result = self.scan()
        self.assertEqual(result["scan_error"], None)
        self.assertIn("label", [violation["id"] for violation in result["violations"]])
        self.assertEqual(gate_exit_code({"/search/": result}), 1)

    def test_a_form_that_never_mounts_is_a_blocking_scan_error(self):
        self.context.route("**/SiteSearch.*.js", lambda route: route.abort())
        result = scan_page(self.page, BASE + "/search/", self.axe, settle=0)
        self.assertIsNotNone(result["scan_error"])
        self.assertEqual(result["violations"], [])
        self.assertEqual(gate_exit_code({"/search/": result}), 1)


class PublicInteractions(BrowserChecks):
    def test_mobile_navigation_closes_with_escape_and_restores_focus(self):
        with self.browser.new_context(viewport={"width": 375, "height": 720}) as context:
            page = context.new_page()
            page.goto(BASE + "/", wait_until="load")
            menu = page.get_by_role("button", name="Menu", exact=True)
            nav = page.get_by_role("navigation", name="Primary", exact=True, include_hidden=True)
            expect(menu).to_be_visible()
            menu.click()
            expect(menu).to_have_attribute("aria-expanded", "true")
            expect(nav).to_have_attribute("data-open", "")
            expect(nav).to_be_visible()
            nav.get_by_role("link").first.focus()
            page.keyboard.press("Escape")
            expect(menu).to_have_attribute("aria-expanded", "false")
            expect(nav).not_to_have_attribute("data-open", "")
            expect(nav).to_be_hidden()
            expect(menu).to_be_focused()

    def test_homepage_honors_native_scroll(self):
        with self.browser.new_context(viewport={"width": 1280, "height": 720}) as context:
            page = context.new_page()
            page.goto(BASE + "/", wait_until="load")
            page.mouse.wheel(0, 600)
            page.wait_for_function("window.scrollY >= 500", timeout=5000)
            # Observe 250ms for delayed scroll snap-back.
            page.wait_for_timeout(250)
            self.assertGreaterEqual(page.evaluate("window.scrollY"), 500)


class ComingSoonInteractions(BrowserChecks):
    def open_scene(self, context):
        page = context.new_page()
        # Advance the application interval/clearInterval on a controlled clock.
        page.clock.install()
        page.goto(BASE + "/", wait_until="load")
        choices = page.get_by_role("button", name=re.compile("^Show background "))
        self.assertGreater(choices.count(), 1)
        return page, choices, page.locator("[data-hero-toggle]")

    def assert_scene(self, page, choices, index):
        expect(choices.nth(index)).to_have_attribute("aria-current", "true")
        expect(page.locator('[data-hero-choice][aria-current="true"]')).to_have_count(1)
        # ARIA state alone cannot prove the actual background changed.
        hero = page.locator("[data-hero-backgrounds]")
        expected_src = hero.evaluate("(el, index) => JSON.parse(el.dataset.heroBackgrounds)[index].src", index)
        self.assertIn(expected_src, hero.evaluate("el => el.style.getPropertyValue('--heroBackgroundImage')"))

    def test_scene_selection_pauses_and_toggle_resumes_real_rotation(self):
        with self.browser.new_context(reduced_motion="no-preference") as context:
            page, choices, toggle = self.open_scene(context)
            page.clock.fast_forward(13000)
            self.assert_scene(page, choices, 1)
            choices.nth(0).click()
            self.assert_scene(page, choices, 0)
            expect(toggle).to_have_text("Resume rotation")
            expect(toggle).to_have_attribute("aria-pressed", "true")
            page.clock.fast_forward(13000)
            self.assert_scene(page, choices, 0)
            toggle.click()
            expect(toggle).to_have_text("Pause rotation")
            expect(toggle).to_have_attribute("aria-pressed", "false")
            page.clock.fast_forward(13000)
            self.assert_scene(page, choices, 1)
            toggle.click()
            expect(toggle).to_have_text("Resume rotation")
            expect(toggle).to_have_attribute("aria-pressed", "true")
            page.clock.fast_forward(13000)
            self.assert_scene(page, choices, 1)

    def test_reduced_motion_stops_rotation_but_keeps_scene_selection(self):
        with self.browser.new_context(reduced_motion="reduce") as context:
            page, choices, toggle = self.open_scene(context)
            expect(toggle).to_be_hidden()
            expect(choices.nth(0)).to_have_attribute("aria-current", "true")
            page.clock.fast_forward(13000)
            expect(choices.nth(0)).to_have_attribute("aria-current", "true")
            choices.nth(1).click()
            self.assert_scene(page, choices, 1)
            page.clock.fast_forward(13000)
            self.assert_scene(page, choices, 1)


class EmittedRoutes(BrowserChecks):
    def test_emitted_routes_have_no_console_or_page_errors(self):
        paths = routes_from_dist(DIST)
        self.assertTrue(paths, f"no emitted HTML under {DIST}")
        self.assertIsNone(mode_mismatch(paths, MODE))
        with self.browser.new_context() as context:
            # Local preview uses proof fonts; production font CORS is a live-origin check.
            def serve_proof_font(route):
                name = route.request.url.rsplit("/", 1)[-1]
                face = "Black" if name == "PBSSans-Black.woff2" else "Bold" if name == "PBSSans-Bold.woff2" else "Regular"
                font = Path(__file__).resolve().parent.parent / "site/src/assets/pdf-fonts" / f"PublicSans-{face}.ttf"
                route.fulfill(path=str(font), content_type="font/ttf", headers={"access-control-allow-origin": "*"})

            context.route(re.compile(r"^https://media\.njpbs\.org/cms-media/fonts/[a-f0-9]{64}/PBSSans(?:-(?:Light|Medium|Bold|Black))?\.woff2$"), serve_proof_font)
            # Endless third-party player embeds are outside the top-document
            # contract, as in the axe scan. Fulfill them without an abort error.
            context.route(is_blocked_embed, lambda route: route.fulfill(status=200, body=""))
            for path in paths:
                with self.subTest(route=path):
                    page = context.new_page()
                    errors = []
                    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    try:
                        page.goto(BASE + path, wait_until="load", timeout=20000)
                        if path == "/search/":
                            expect(page.get_by_role("search", name="NJ PBS site search", exact=True)).to_be_visible()
                        # Observe async errors for 400ms, including meta-refresh
                        # pages changing document.
                        page.wait_for_timeout(400)
                        self.assertEqual(errors, [], f"{path}: console/page errors")
                    finally:
                        page.close()
        print(f"Console sweep: {len(paths)} emitted routes ({MODE})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--mode", choices=["full", "coming-soon"], default="full")
    parser.add_argument("--dist", default="site/dist")
    args = parser.parse_args()
    BASE = args.base.rstrip("/")
    MODE, DIST = args.mode, args.dist
    classes = (
        [EmittedRoutes, SearchReadiness, PublicInteractions]
        if MODE == "full" else [EmittedRoutes, ComingSoonInteractions]
    )
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls) for cls in classes)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
