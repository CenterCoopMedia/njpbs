#!/usr/bin/env python3
"""Required browser interactions, emitted-route errors and search-readiness checks.

Run against each served build: --base URL --mode full|coming-soon --dist site/dist.
Run --mode video-catalog --video-catalog-screenshots DIRECTORY against the
served PR preview with the synthetic catalog installed as launch content.
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


class VideoCatalogInteractions(BrowserChecks):
    @staticmethod
    def catalog_artwork(route):
        name = urlsplit(route.request.url).path.rsplit("/", 1)[-1]
        artwork = {
            "catalog-fixture-show.jpg": "energy-environment.jpg",
            "catalog-fixture-episode.jpg": "energy-environment-02.jpg",
        }.get(name)
        if artwork:
            route.fulfill(path=Path(__file__).resolve().parents[1] / "site/public/brand/spotlight" / artwork)
        else:
            route.fulfill(status=404, body="")

    def assert_artwork(self, image, source, width, height):
        expect(image).to_have_attribute("src", source)
        expect(image).to_have_attribute("width", str(width))
        expect(image).to_have_attribute("height", str(height))
        image.scroll_into_view_if_needed()
        expect(image).to_have_js_property("complete", True)
        self.assertGreater(image.evaluate("image => image.naturalWidth"), 0)

    def assert_fits_viewport(self, page):
        self.assertTrue(page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))

    def test_public_video_catalog_navigation_and_search(self):
        screenshots = VIDEO_CATALOG_SCREENSHOTS
        screenshots.mkdir(parents=True, exist_ok=True)
        show_image = "https://image.pbs.org/contentchannels/catalog-fixture-show.jpg"
        episode_image = "https://image.pbs.org/video-assets/catalog-fixture-episode.jpg"
        fallback_image = "/brand/home/new-jersey-blue.webp"
        for width, height in [(390, 844), (1280, 900)]:
            with self.subTest(width=width), self.browser.new_context(viewport={"width": width, "height": height}) as context:
                context.route(is_blocked_embed, lambda route: route.fulfill(status=200, body=""))
                context.route(re.compile(r"^https://image\.pbs\.org/(contentchannels|video-assets)/catalog-fixture-"),
                              self.catalog_artwork)
                page = context.new_page()
                page.goto(BASE + "/programs/", wait_until="domcontentloaded")
                notice = page.get_by_role("button", name="Do not allow", exact=True)
                if notice.is_visible():
                    notice.click()
                page.get_by_role("link", name="Watch full episodes and specials").click()
                expect(page).to_have_url(BASE + "/watch/programs/")
                program = page.get_by_role("link", name=re.compile(r"^River stories"))
                program_image = program.locator("img")
                self.assert_artwork(program_image, f"{show_image}?format=webp&resize=640x360", 640, 360)
                shore_image = page.get_by_role("link", name=re.compile(r"^Shore stories")).locator("img")
                self.assert_artwork(shore_image, fallback_image, 640, 360)
                self.assert_fits_viewport(page)
                program.press("Tab")
                expect(page.get_by_role("link", name=re.compile(r"^Shore stories"))).to_be_focused()
                page.keyboard.press("Shift+Tab")
                expect(program).to_be_focused()
                expect(program_image).to_have_css("outline-style", "solid")
                page.screenshot(path=str(screenshots / f"directory-{width}.png"), full_page=True)
                page.keyboard.press("Enter")
                expect(page).to_have_url(BASE + "/watch/programs/river-stories/")
                self.assert_artwork(page.locator("article header img"), f"{show_image}?format=webp&resize=960x540", 960, 540)
                crossing = page.get_by_role("link", name=re.compile(r"^The river crossing"))
                expect(crossing).to_contain_text("Season 2 — Waterways · Episode 3 · January 1, 2020")
                self.assert_artwork(crossing.locator("img"), f"{episode_image}?format=webp&resize=640x360", 640, 360)
                voices = page.get_by_role("link", name=re.compile(r"^River voices"))
                self.assert_artwork(voices.locator("img"), fallback_image, 640, 360)
                self.assert_fits_viewport(page)
                page.get_by_role("navigation", name="Breadcrumb").get_by_role("link").press("Tab")
                expect(crossing).to_be_focused()
                expect(crossing.locator("img")).to_have_css("outline-style", "solid")
                page.screenshot(path=str(screenshots / f"program-{width}.png"), full_page=True)
                page.keyboard.press("Enter")
                episode_path = "/watch/programs/river-stories/river-crossing/"
                expect(page).to_have_url(BASE + episode_path)
                expect(page).to_have_title("The river crossing — NJ PBS")
                poster = page.get_by_role("button", name="Open PBS player", exact=True)
                self.assert_artwork(poster.locator("img"), f"{episode_image}?format=webp&resize=960x540", 960, 540)
                actual_width = 640 if width == 390 else 960
                self.assertTrue(poster.locator("img").evaluate("image => image.currentSrc").endswith(
                    f"resize={actual_width}x{actual_width * 9 // 16}"))
                self.assert_fits_viewport(page)
                player = page.get_by_title("Watch The river crossing", exact=True)
                expect(player).to_have_count(0)
                page.get_by_role("navigation", name="Breadcrumb").get_by_role("link", name="River stories").press("Tab")
                expect(poster).to_be_focused()
                expect(poster).to_have_css("outline-style", "solid")
                poster_box = poster.bounding_box()
                page.screenshot(path=str(screenshots / f"episode-{width}.png"), full_page=True)
                page.keyboard.press("Space")
                expect(player).to_have_attribute("src", "https://player.pbs.org/partnerplayer/EXAMPLE==/?autoplay=false")
                expect(player).to_be_focused()
                self.assertEqual(player.bounding_box()["height"], poster_box["height"])
                self.assert_fits_viewport(page)
                fallback = page.get_by_role("link", name="Watch on PBS", exact=True)
                fallback.focus()
                expect(fallback).to_be_focused()
                expect(fallback).to_have_attribute("href", "https://watch.njpbs.org/video/river-crossing/")
                if width == 1280:
                    hits = page.evaluate("""async () => {
                        const pagefind = await import('/pagefind/pagefind.js');
                        const search = await pagefind.search('river stories');
                        const hits = await Promise.all(search.results.map(result => result.data()));
                        return Object.fromEntries(hits.filter(hit => hit.url.startsWith('/watch/programs/'))
                          .map(hit => [hit.url, hit.meta]));
                    }""")
                    self.assertEqual(hits[episode_path]["program"], "River stories")
                    self.assertEqual(hits[episode_path]["season"], "Season 2 — Waterways")
                    self.assertEqual(hits[episode_path]["episode"], "The river crossing")
                    self.assertIn("/watch/programs/river-stories/", hits)
                    for slug in ["expired", "member-only"]:
                        excluded = f"/watch/programs/river-stories/{slug}/"
                        self.assertNotIn(excluded, hits)
                        self.assertEqual(page.request.get(BASE + excluded).status, 404)


class PublicInteractions(BrowserChecks):
    def test_live_player_fallback_offers_the_schedule_when_the_embed_fails(self):
        with self.browser.new_context(java_script_enabled=False) as context:
            player = "https://player.pbs.org/**"
            context.route(player, lambda route: route.fulfill(status=503, body=""))
            page = context.new_page()
            with page.expect_response(player, timeout=10000) as response:
                page.goto(BASE + "/live/", wait_until="domcontentloaded")
                page.get_by_title("PBS livestream", exact=True).scroll_into_view_if_needed(timeout=5000)
            self.assertEqual(response.value.status, 503)

            fallback = page.locator("[data-player-fallback]")
            expect(fallback).to_contain_text("If the player does not load")
            livestream = fallback.get_by_role("link", name=re.compile(r"^NJ PBS livestream"))
            expect(livestream).to_be_visible()
            expect(livestream).to_have_attribute("href", "https://watch.njpbs.org/livestream/")
            schedule = fallback.get_by_role("link", name="NJ PBS TV schedule", exact=True)
            expect(schedule).to_be_visible()
            expect(schedule).to_have_attribute("href", "/schedule/")

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

    def test_privacy_notice_fits_a_short_mobile_viewport(self):
        for width, height in [(320, 480), (390, 600), (844, 390)]:
            with self.subTest(width=width, height=height):
                with self.browser.new_context(viewport={"width": width, "height": height},
                                              has_touch=True) as context:
                    page = context.new_page()
                    page.goto(BASE + "/about/", wait_until="domcontentloaded")
                    notice = page.get_by_role("complementary", name="Help us improve njpbs.org")
                    heading = notice.get_by_role("heading", name="Help us improve njpbs.org")
                    policy = notice.get_by_role("link", name="Read the privacy policy")
                    expect(heading).to_be_in_viewport(ratio=1)
                    self.assertGreaterEqual(policy.bounding_box()["height"], 24)
                    page.add_style_tag(content="html { font-size: 200% !important; }")
                    expect(heading).to_be_in_viewport(ratio=1)
                    geometry = notice.bounding_box()
                    self.assertGreaterEqual(geometry["y"], 0)
                    self.assertLessEqual(geometry["y"] + geometry["height"], height)

                    choices = [policy, notice.get_by_role("button", name="Do not allow"),
                               notice.get_by_role("button", name="Allow analytics and newsletter tools")]
                    for choice in choices:
                        choice.focus()
                        choice.evaluate("el => el.scrollIntoView({ block: 'center', behavior: 'instant' })")
                        expect(choice).to_be_focused()
                        expect(choice).to_be_in_viewport(ratio=1)

    def test_mobile_chrome_fits_at_double_text_size(self):
        with self.browser.new_context(
            viewport={"width": 320, "height": 568}, is_mobile=True, reduced_motion="reduce",
        ) as context:
            page = context.new_page()
            page.goto(BASE + "/", wait_until="domcontentloaded")
            page.evaluate("document.fonts.ready")
            donate = page.locator(".site-head .donate")
            original_size = donate.evaluate("link => parseFloat(getComputedStyle(link).fontSize)")
            page.add_style_tag(content="html, body { -webkit-text-size-adjust: 200% !important; }")
            self.assertAlmostEqual(donate.evaluate("link => parseFloat(getComputedStyle(link).fontSize)"),
                                   2 * original_size, places=1)
            label = page.get_by_text("FCC public inspection file:", exact=True)

            for width in (320, 375):
                with self.subTest(width=width):
                    page.set_viewport_size({"width": width, "height": 568})
                    self.assertLessEqual(donate.evaluate("link => link.getBoundingClientRect().right"), width)
                    self.assertLessEqual(label.evaluate("""el => {
                        const range = document.createRange();
                        range.selectNodeContents(el);
                        return range.getBoundingClientRect().right;
                    }"""), width)

                    page.get_by_role("button", name="Menu", exact=True).press("Enter")
                    nav = page.get_by_role("navigation", name="Primary", exact=True)
                    expect(nav).to_be_visible()
                    self.assertLessEqual(nav.evaluate("el => el.getBoundingClientRect().bottom"), 569)
                    page.keyboard.press("Escape")

            page.set_viewport_size({"width": 768, "height": 568})
            fcc = page.locator(".foot-fcc")
            self.assertTrue(fcc.evaluate("row => row.scrollWidth > row.clientWidth"))
            self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), 768)

    def test_homepage_honors_native_scroll(self):
        with self.browser.new_context(viewport={"width": 1280, "height": 720}) as context:
            page = context.new_page()
            page.goto(BASE + "/", wait_until="load")
            page.mouse.wheel(0, 600)
            page.wait_for_function("window.scrollY >= 500", timeout=5000)
            # Observe 250ms for delayed scroll snap-back.
            page.wait_for_timeout(250)
            self.assertGreaterEqual(page.evaluate("window.scrollY"), 500)

    def test_homepage_program_shelves_use_local_art_when_pbs_images_fail(self):
        with self.browser.new_context() as context:
            context.route("https://image.pbs.org/**", lambda route: route.fulfill(status=503))
            page = context.new_page()
            page.goto(BASE + "/", wait_until="domcontentloaded")

            for shelf in ("featured-rail", "more-rail"):
                with self.subTest(shelf=shelf):
                    card = page.locator(f"#{shelf} a").filter(has=page.locator("img")).first
                    image = card.locator("img")
                    image.scroll_into_view_if_needed(timeout=5000)
                    expect(image).to_have_attribute("src", "/brand/home/new-jersey-blue.webp")
                    page.wait_for_function(
                        "image => image.complete && image.naturalWidth > 0",
                        arg=image.element_handle(), timeout=5000,
                    )
                    expect(image).to_have_attribute("alt", "")
                    box = image.bounding_box()
                    self.assertAlmostEqual(box["width"] / box["height"], 16 / 9, places=2)
                    expect(card).to_have_attribute("href", re.compile(r"^https://watch\.njpbs\.org/"))
                    expect(card).to_have_accessible_name(re.compile(r"\w"))

    def test_budget_treemap_keeps_department_labels_inside_the_tiles(self):
        # The full CI build keeps the Data Hub publication flag off. Serve the
        # shipped reader fragment and CSS with the fonts from the full build.
        source = Path(__file__).resolve().parents[1] / "site" / "src"
        reader = (source / "data" / "njpbs-data-hub-v16.html").read_text(encoding="utf-8")
        styles = (source / "styles" / "data-hub.css").read_text(encoding="utf-8")
        html = f"""<!doctype html><html lang="en">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            @font-face {{ font-family: "PBS Sans"; font-weight: 700;
                          src: url("/brand/fonts/PBSSans-Bold.woff2"); }}
            @font-face {{ font-family: "PBS Sans"; font-weight: 900;
                          src: url("/brand/fonts/PBSSans-Black.woff2"); }}
            body {{ margin: 0; --gutter: 16px; --wrap: 72rem; --bg-0: #000; }}
            {styles}
        </style><main class="data-hub">{reader}</main></html>"""
        with self.browser.new_context(viewport={"width": 320, "height": 568}) as context:
            page = context.new_page()
            page.route(BASE + "/data-hub/", lambda route: route.fulfill(
                content_type="text/html; charset=utf-8", body=html,
            ))
            page.goto(BASE + "/data-hub/", wait_until="domcontentloaded")
            budget = page.locator("#metric-statebudget")
            budget.get_by_role("button", name="Departments & accounts").click()
            plot = budget.get_by_role("region", name="Departments and accounts treemap")
            expect(plot).to_contain_text("Interdepartmental")
            expect(plot).to_contain_text("$5.68B")
            page.evaluate("document.fonts.ready")

            for width in (320, 390):
                with self.subTest(width=width):
                    page.set_viewport_size({"width": width, "height": 568})
                    clipped = plot.evaluate("""plot => {
                        return [...plot.querySelectorAll(".budget-tile > *")].filter(label => {
                            const tile = label.parentElement.getBoundingClientRect();
                            const range = document.createRange();
                            range.selectNodeContents(label);
                            return [...range.getClientRects()].some(line =>
                                line.left < tile.left || line.right > tile.right ||
                                line.top < tile.top || line.bottom > tile.bottom
                            );
                        }).map(label => label.textContent);
                    }""")
                    self.assertEqual(clipped, [])
                    self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width)


    def test_homepage_passport_label_fits_at_double_text_size(self):
        with self.browser.new_context(viewport={"width": 320, "height": 720}, is_mobile=True) as context:
            page = context.new_page()
            page.goto(BASE + "/", wait_until="domcontentloaded")
            page.evaluate("document.fonts.ready")
            label = page.locator(".passport__mark-name")
            original_size = label.evaluate("el => parseFloat(getComputedStyle(el).fontSize)")
            page.add_style_tag(content="html, body { -webkit-text-size-adjust: 200% !important; }")
            self.assertAlmostEqual(label.evaluate("el => parseFloat(getComputedStyle(el).fontSize)"),
                                   2 * original_size, places=1)
            self.assertTrue(label.evaluate("""el => {
                const band = el.closest(".passport__inner").getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(el);
                return [...range.getClientRects()].every(rect => rect.left >= band.left && rect.right <= band.right);
            }"""))


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
    parser.add_argument("--mode", choices=["full", "coming-soon", "video-catalog"], default="full")
    parser.add_argument("--dist", default="site/dist")
    parser.add_argument("--video-catalog-screenshots", type=Path)
    args = parser.parse_args()
    BASE = args.base.rstrip("/")
    MODE, DIST = args.mode, args.dist
    VIDEO_CATALOG_SCREENSHOTS = args.video_catalog_screenshots
    if MODE == "video-catalog":
        if VIDEO_CATALOG_SCREENSHOTS is None:
            parser.error("--video-catalog-screenshots is required in video-catalog mode")
        classes = [VideoCatalogInteractions]
    elif MODE == "full":
        classes = [EmittedRoutes, SearchReadiness, PublicInteractions]
    else:
        classes = [EmittedRoutes, ComingSoonInteractions]
    suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls) for cls in classes)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
