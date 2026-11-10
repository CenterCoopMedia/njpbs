import { describe, expect, it } from "vitest";
import {
  classify,
  LEGACY_TAIL_FAMILIES,
  LEGACY_SINGLETONS_410,
  LIVE_EXACT,
  PROTECTED_NEW_PREFIXES,
  REDIRECTS_301,
} from "../src/lib/legacy-redirects";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";

// The legacy-URL classifier (#260) is the tested source of truth for the edge 410/301
// map. The edge entrypoint (site/snippets/legacy-redirects/snippet.js) is a thin wrapper
// over classify, so these tests, not a live edge deploy, are what pins the behavior.
//
// The classifier passes new Program routes, redirects former /shows/ URLs,
// and retains the remaining legacy 410 rules.

describe("classify", () => {
  it("redirects the former meeting page and PDFs without intercepting the new route", () => {
    for (const path of ["/public-meetings", "/public-meetings/", "/closed-meetings/"]) {
      expect(classify(path)).toEqual({ action: "redirect", location: "/meeting-notices/" });
    }
    expect(classify("/public-meetings/njpba-audit-committee-2026-10-16.pdf")).toEqual({
      action: "redirect", location: "/meeting-notices/njpba-audit-committee-2026-10-16.pdf",
    });
    expect(classify("/public-meetings/Board-Notice.pdf")).toEqual({
      action: "redirect", location: "/meeting-notices/Board-Notice.pdf",
    });
    expect(classify("/meeting-notices/")).toBeNull();
    expect(classify("/meeting-notices/njpba-audit-committee-2026-10-16.pdf")).toBeNull();
  });
  it("keeps the new share route live while the old story route stays gone", () => {
    expect(classify("/share/")).toBeNull();
    expect(classify("/share-your-story")).toEqual({ action: "gone" });
  });
  it("collapses repeated slashes before applying exact decisions", () => {
    expect(classify("//all-programs//")).toEqual({
      action: "redirect",
      location: "/watch/",
    });
    expect(classify("//careers//")).toEqual({ action: "gone" });
    expect(classify("///about///")).toBeNull();
  });

  it("redirects only the archived paths with a live semantic replacement", () => {
    expect(REDIRECTS_301).toEqual({
      "/all-programs": "/watch/",
      "/anywhere": "/watch/",
      "/app-support": "/contact/",
      "/closed-meetings": "/meeting-notices/",
      "/public-meetings": "/meeting-notices/",
      "/eguide": "/schedule/",
      "/help": "/contact/",
      "/how-to-watch": "/watch/",
      "/index.htm": "/",
      "/index.html": "/",
    });

    for (const [source, destination] of Object.entries(REDIRECTS_301)) {
      expect(classify(source), `${source} moves to ${destination}`).toEqual({
        action: "redirect",
        location: destination,
      });
      expect(classify(`${source}/`), `${source}/ normalizes before moving`).toEqual({
        action: "redirect",
        location: destination,
      });
    }
  });

  it("410s every archived residual singleton with no semantic replacement", () => {
    const expected = [
      "/about-teaching-channel-presents",
      "/accessibility_statement.html",
      "/api/ajax/ajax-hp-load-on-demand",
      "/broadway-and-beyond",
      "/careers",
      "/classroom-close-up-nj",
      "/coachs_network/index.htm",
      "/connect-with-njtv-for-new-jersey-news",
      "/docs",
      "/documentary/treblinkas-last-witness",
      "/due-process",
      "/email-preferences",
      "/email-preferences/confirmation",
      "/footers/pbsis-footer.html",
      "/funder-spots",
      "/leadershipforum/leadershipforum.html",
      "/links/index.htm",
      "/midtown-men-pledge-special",
      "/neal-shapiro-statement-to-the-community",
      "/newsletters/index.htm",
      "/nj-pbs-is-at-risk",
      "/nj-spotlight-and-njtv-news-join-forces",
      "/nj_success/index.htm",
      "/njtv-benefit",
      "/njvid",
      "/on-the-record",
      "/ournj",
      "/ournj-signup",
      "/private-preview",
      "/rescuing-the-river",
      "/search-results",
      "/search.htm",
      "/serving-new-jersey-into-the-future",
      "/sfmc-proxy/njpbs_preference",
      "/share-your-story",
      "/shore-week",
      "/sitemap.htm",
      "/statement-from-the-wnet-group",
      "/survey-of-media-consumption-habits",
      "/teaching-channel-season-three",
      "/teaching-channel-season-two",
      "/upcoming_events/index.htm",
      "/whats_new/index.htm",
      "/why-sponsor",
      "/x270",
      "/x271",
      "/x272",
      "/x273",
      "/x274",
      "/x275",
      "/x276",
      "/x277",
      "/x279",
      "/x78",
      "/your-election-2024",
    ];

    expect([...LEGACY_SINGLETONS_410]).toEqual(expected);
    for (const path of expected) {
      expect(classify(path), `${path} is retired`).toEqual({ action: "gone" });
    }
  });

  it("keeps redirects and retired singletons clear of every current route", () => {
    const currentRoutes = new Set(
      PUBLIC_PAGES.flatMap((page) => [
        page.path,
        ...("aliases" in page ? page.aliases : []),
      ]).map((path) => (path === "/" ? path : path.replace(/\/$/, ""))),
    );

    for (const route of currentRoutes) {
      expect(classify(route), `${route} resolves to its current page`).toEqual(
        route === "/public-meetings" ? { action: "redirect", location: "/meeting-notices/" } : null,
      );
    }
    for (const [source, destination] of Object.entries(REDIRECTS_301)) {
      expect(PUBLIC_PAGES.some(page => page.path.replace(/\/$/, "") === source), `${source} is not canonical`).toBe(false);
      expect(
        currentRoutes.has(destination === "/" ? destination : destination.replace(/\/$/, "")),
        `${destination} is current`,
      ).toBe(true);
    }
    for (const retired of LEGACY_SINGLETONS_410) {
      expect(currentRoutes.has(retired), `${retired} is not current`).toBe(false);
      expect(
        PROTECTED_NEW_PREFIXES.some((prefix) => retired.startsWith(`${prefix}/`)),
        `${retired} is reachable after the protected-prefix pass-through check`,
      ).toBe(false);
    }
  });

  it("returns Gone for pure-legacy families at the root and below", () => {
    // The bare roots 404 on the new site, so they must 410, not fall through.
    for (const root of ["/njtv-pressroom", "/pbsoauth"]) {
      expect(classify(root), `${root} root is Gone`).toEqual({ action: "gone" });
    }
    expect(classify("/events/some-old-event")).toBeNull();
    expect(classify("/events")).toBeNull();
    expect(classify("/programs/a-show/season-2/episode-4")).toBeNull();
    expect(classify("/njtv-pressroom/2020/01/02/a-release")).toEqual({ action: "gone" });
    // A dead WNET /pbsoauth child still 410s; the one reserved live exception
    // (/pbsoauth/callback) is covered in its own test below.
    expect(classify("/pbsoauth/authorize")).toEqual({ action: "gone" });
  });

  it("returns Gone for every tail-sweep family at the root and below", () => {
    // Each smaller retired namespace 410s at its bare root and on a child. The bare roots
    // 404 on the new site (none is in LIVE_EXACT), so they must 410, not fall through.
    for (const root of LEGACY_TAIL_FAMILIES) {
      expect(classify(root), `${root} root is Gone`).toEqual({ action: "gone" });
      expect(classify(`${root}/some-legacy-child`), `${root}/* child is Gone`).toEqual({
        action: "gone",
      });
    }
    // A couple of the real indexed paths from the CDX inventory, to pin the intent.
    expect(classify("/perspectives/jfk-lessons-in-leadership")).toEqual({ action: "gone" });
    expect(classify("/overview/glossary.htm")).toEqual({ action: "gone" });
    expect(classify("/author/njtv")).toEqual({ action: "gone" });
  });

  it("holds podcast and image namespaces back from the tail sweep", () => {
    // /podcast and /podcasts stay live: NJ PBS still produces these series, so future
    // episode and series routes are plausible and a 410 would be premature. /images is an
    // asset path, not a content namespace, so a 410 would answer a real asset with Gone.
    for (const held of ["/podcast", "/podcasts", "/images"]) {
      expect(LEGACY_TAIL_FAMILIES).not.toContain(held);
      expect(classify(held), `${held} bare passes through`).toBeNull();
    }
    expect(classify("/podcast/off-exit-race-day")).toBeNull();
    expect(classify("/podcasts/hazard-nj/")).toBeNull();
    expect(classify("/images/glogo.jpg")).toBeNull();
  });

  it("410s /about_us without touching the live /about, despite the shared prefix", () => {
    // /about_us is the retired NJPBSIS microsite's about, a distinct first segment from the
    // live /about. The family match is on the whole first segment, so the shared text does
    // not let a tail family shadow a held-back live route.
    expect(classify("/about_us")).toEqual({ action: "gone" });
    expect(classify("/about_us/staff.htm")).toEqual({ action: "gone" });
    expect(classify("/about")).toBeNull();
  });

  it("keeps every tail-sweep family out of the live-route set", () => {
    // A static invariant: no retired namespace may collide with a known-live route, or the
    // sweep would 410 a live page. Guards against a future edit that adds a live family.
    for (const fam of LEGACY_TAIL_FAMILIES) {
      expect(LIVE_EXACT.has(fam), `${fam} is not a live route`).toBe(false);
    }
  });

  it("passes the bare live route of a held-back family but 410s its legacy children", () => {
    for (const bare of ["/kids", "/support", "/about", "/live", "/passport", "/schedule"]) {
      expect(classify(bare), `${bare} is a live route`).toBeNull();
      expect(classify(`${bare}/some-legacy-child`), `${bare}/* child is Gone`).toEqual({
        action: "gone",
      });
    }
    // /schedule children are legacy, not served: the static build emits only the bare
    // /schedule/ route, so a dated child and /schedule/embed both 410.
    expect(classify("/schedule/2026-08-13")).toEqual({ action: "gone" });
    expect(classify("/schedule/embed")).toEqual({ action: "gone" });
    // The 14-day schedule PDF is a served file, so it passes through.
    expect(classify("/schedule/downloads/nj-pbs-schedule.pdf")).toBeNull();
    expect(classify("/schedule/downloads/other.pdf")).toEqual({ action: "gone" });
  });

  it("passes a nested live route under a held-back family via the opts.live escape hatch", () => {
    // The content model is flat today, but if /about/leadership is ever added, listing
    // it in the live set must pass it through before the held-back rule can 410 it.
    const live = new Set([...LIVE_EXACT, "/about/leadership"]);
    expect(classify("/about/leadership", { live })).toBeNull();
    // A sibling legacy child under the same family still 410s.
    expect(classify("/about/old-page", { live })).toEqual({ action: "gone" });
  });

  it("matches an opts.live entry that carries a directory-format trailing slash", () => {
    // Astro builds routes as directories (build.format "directory"), so a build-generated
    // live set carries trailing slashes. The classifier normalizes the request without one,
    // so it must compare both forms or a real page under a held-back family would 410.
    const live = new Set([...LIVE_EXACT, "/about/leadership/"]);
    expect(classify("/about/leadership", { live })).toBeNull();
    expect(classify("/about/leadership/", { live })).toBeNull();
  });

  it("passes the reserved PMSSO callback through while 410ing the rest of /pbsoauth", () => {
    // /pbsoauth is a dead WNET auth namespace, but /pbsoauth/callback is the registered
    // production PMSSO callback. A 410 there would permanently break member sign-in once
    // the handler and edge map land, so it passes through (an unwired callback 404s, which
    // is recoverable) while the bare root and every other child stay Gone.
    expect(classify("/pbsoauth/callback")).toBeNull();
    expect(classify("/pbsoauth/callback/")).toBeNull(); // trailing slash normalizes the same
    expect(classify("/pbsoauth")).toEqual({ action: "gone" });
    expect(classify("/pbsoauth/authorize")).toEqual({ action: "gone" });
  });

  it("redirects the former Program base permanently", () => {
    expect(classify("/shows/")).toEqual({ action: "redirect", location: "/programs/" });
    expect(classify("/shows/old-program/")).toEqual({ action: "redirect", location: "/programs/old-program/" });
  });

  it("passes through protected new namespaces before legacy shape rules", () => {
    expect(PROTECTED_NEW_PREFIXES).toEqual(
      expect.arrayContaining(["/posts", "/authors", "/shows", "/programs", "/wiki"]),
    );

    // /wiki has no legacy equivalent, so no shape rule may turn a child into a 410.
    expect(classify("/wiki/anything/deep")).toBeNull();
    expect(classify("/wiki/embed")).toBeNull();

    // Program pages live under /programs; the former /shows base redirects.
    expect(classify("/shows/a-program")).toEqual({ action: "redirect", location: "/programs/a-program/" });
    expect(classify("/shows/a-program/embed")).toBeNull();
    expect(classify("/programs/a-program")).toBeNull();
  });

  it.each([
    "/posts/embed",
    "/authors/embed",
    "/programs/embed",
    "/wiki/embed",
  ])("passes a valid current route whose slug is embed: %s", (path) => {
    expect(classify(path)).toBeNull();
  });

  it("returns Gone for oEmbed endpoints and pagination stubs", () => {
    expect(classify("/programs/x/embed")).toBeNull();
    expect(classify("/some-post/embed")).toEqual({ action: "gone" });
    expect(classify("/page/2")).toEqual({ action: "gone" });
    expect(classify("/page/not-a-number")).toBeNull(); // only /page/<n> is a stub
  });

  it("lets a hand-picked 301 win over a 410, even under a legacy family", () => {
    const redirects = { "/about/financials": "/give" };
    expect(classify("/about/financials", { redirects })).toEqual({
      action: "redirect",
      location: "/give",
    });
    // Without the entry, the same deep child is a 410.
    expect(classify("/about/financials")).toEqual({ action: "gone" });
  });

  it("normalizes case and a trailing slash before matching", () => {
    expect(classify("/Programs/Foo/")).toBeNull();
    expect(classify("/KIDS/")).toBeNull();
    expect(classify("/")).toBeNull();
  });

  it("passes through unrecognized paths (live routes and future pages)", () => {
    for (const p of LIVE_EXACT) expect(classify(p), `${p} passes`).toBeNull();
    expect(classify("/give")).toBeNull();
    expect(classify("/a-page-added-next-year")).toBeNull();
    expect(classify("/assets/app.css")).toBeNull();
    expect(classify("/sitemap-0.xml")).toBeNull();
  });
});
