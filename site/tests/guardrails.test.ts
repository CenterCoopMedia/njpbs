import { describe, it, expect } from "vitest";
import {
  findGuardrailViolations,
  isScannableAsset,
  isGuardrailExemptPath,
} from "../src/lib/guardrails";
import {
  passportLearnMoreUrl,
  pbsLivestreamWatchUrl,
  pbsVideoUrl,
} from "../src/data/launch-fallback";

// The binding deploy guardrail for this client site: no accidental use of old
// P-head/logo/wordmark filenames. Approved NJ PBS brand assets live under
// public/brand and favicon.png. The check runs over built public HTML/CSS in CI
// so a violation fails the build.

describe("findGuardrailViolations", () => {
  it("returns nothing for empty input", () => {
    expect(findGuardrailViolations("")).toEqual([]);
  });

  it("flags a reproduced PBS logo image reference", () => {
    const v = findGuardrailViolations(
      '<img src="/assets/pbs-phead-logo.svg" alt="" />',
    );
    expect(v.map((x) => x.rule)).toContain("logo-image");
  });

  it("flags an NJ PBS wordmark image in a CSS url()", () => {
    const v = findGuardrailViolations(
      ".brand{background:url('/img/njpbs-wordmark.png')}",
    );
    expect(v.map((x) => x.rule)).toContain("logo-image");
  });

  it("does NOT flag the text-set wordmark", () => {
    expect(
      findGuardrailViolations('<span class="gs-brand__mark">New NJ PBS</span>'),
    ).toEqual([]);
  });

  it("does NOT flag a generic favicon reference", () => {
    expect(
      findGuardrailViolations('<link rel="icon" href="/favicon.png" />'),
    ).toEqual([]);
  });

  it("does NOT flag the approved NJ PBS header logo and favicon paths", () => {
    expect(
      findGuardrailViolations(
        '<img src="/brand/njpbs-horizontal-white.svg" alt="NJ PBS" /><link rel="icon" href="/favicon.png" />',
      ),
    ).toEqual([]);
  });

  it("allows sourced post-cutover operator language", () => {
    expect(
      findGuardrailViolations(
        "<p>As of July 1, 2026, Montclair State University is the new operator of NJ PBS.</p>",
      ),
    ).toEqual([]);
  });

  it("flags false Montclair ownership language", () => {
    const v = findGuardrailViolations(
      "<p>Montclair State University owns NJ PBS.</p>",
    );
    expect(v.map((x) => x.rule)).toContain("operator-ownership");
  });

  it("flags false CCM licensee language", () => {
    const v = findGuardrailViolations(
      "<p>The NJ PBS licenses are owned by CCM.</p>",
    );
    expect(v.map((x) => x.rule)).toContain("operator-ownership");
  });

  it("allows the State/NJPBA licensee split", () => {
    expect(
      findGuardrailViolations(
        "<p>The State owns the licenses; Montclair State University operates NJ PBS.</p>",
      ),
    ).toEqual([]);
  });

  it("reports the matched text so a failure is actionable", () => {
    const v = findGuardrailViolations('<img src="/assets/pbs-logo.svg" />');
    expect(v[0]).toHaveProperty("match");
    expect(v[0].match.length).toBeGreaterThan(0);
  });

  it("flags a link or resource pointing back at a WNET-era host", () => {
    for (const html of [
      '<a href="https://www.njtvonline.org/programs/">Watch</a>',
      '<a href="https://www.thirteen.org/schedule/">Schedule</a>',
      '<a href="//wnet.org/passport">Passport</a>',
      '<a href="njtvonline.org/live">Live</a>',
      '<a href="https://www.wnet.org">WNET</a>',
      '<img srcset="/local.jpg 1x, https://wnet.org/retina.jpg 2x" />',
      '<img srcset="https://wnet.org, /local.jpg 2x" />',
      ".hero{background:url('https://thirteen.org/img/hero.jpg')}",
      '@import "https://thirteen.org/legacy.css";',
    ]) {
      expect(findGuardrailViolations(html).map((x) => x.rule)).toContain(
        "legacy-host",
      );
    }
  });

  it("allows one marked anchor to keep an intentional WNET-era host link", () => {
    for (const html of [
      '<a href="https://www.wnet.org/about/" data-allow-legacy-host="true">WNET</a>',
      '<a data-allow-legacy-host="true" href="https://thirteen.org/programs/">Source</a>',
    ]) {
      expect(findGuardrailViolations(html)).toEqual([]);
    }
  });

  it("keeps the WNET-era host opt-in exact and local to one anchor", () => {
    for (const html of [
      '<a href="https://www.wnet.org" data-allow-legacy-host="false">WNET</a>',
      '<a href="https://www.wnet.org" data-allow-legacy-host>WNET</a>',
      '<div data-allow-legacy-host="true"><a href="https://www.wnet.org">WNET</a></div>',
      '<a data-allow-legacy-host="true" href="https://example.org">Example</a><a href="https://www.wnet.org">WNET</a>',
      '<img src="https://www.wnet.org/logo.png" data-allow-legacy-host="true" />',
    ]) {
      expect(findGuardrailViolations(html).map((x) => x.rule)).toContain(
        "legacy-host",
      );
    }
  });

  it("does not let the WNET-era host opt-in bypass a same-domain legacy path", () => {
    const violations = findGuardrailViolations(
      '<a href="https://njpbs.org/shows/" data-allow-legacy-host="true">Programs</a>',
    );

    expect(violations.map((violation) => violation.rule)).toContain(
      "legacy-path",
    );
  });

  it("tells an editor how to repair or approve a WNET-era host link", () => {
    const violation = findGuardrailViolations(
      '<a href="https://www.wnet.org/about/">WNET</a>',
    ).find((candidate) => candidate.rule === "legacy-host");

    expect(violation?.message).toBe(
      'Replace this link with a current destination. To keep an intentional WNET-era link, open its CMS link settings and select "Allow this WNET-era host link." Source authors can add data-allow-legacy-host="true" to that <a>.',
    );
  });

  it("flags an unquoted CSS url() whose legacy host has no path", () => {
    for (const css of [
      ".hero{background:url(https://wnet.org)}",
      ".hero{background:url(https://wnet.org )}",
    ]) {
      expect(findGuardrailViolations(css).map((x) => x.rule)).toContain(
        "legacy-host",
      );
    }
  });

  it("does NOT flag a different domain that starts with a legacy host", () => {
    // The host has to end where the authority ends. Without that, the rule is a
    // prefix match and someone else's domain fails our build.
    for (const html of [
      '<a href="https://thirteen.organic.org/beans">Beans</a>',
      '<a href="https://foo.wnet.org.example.com/x">Elsewhere</a>',
      '<a href="https://notthirteen.org/x">Elsewhere</a>',
      '<img srcset="https://foo.wnet.org.example.com/x.jpg 2x" />',
      '@import "https://thirteen.organic.org/theme.css";',
    ]) {
      expect(findGuardrailViolations(html)).toEqual([]);
    }
  });

  it("does NOT flag WNET as history, as a contact, or as a printed URL", () => {
    // The rule is about where a CTA sends a reader, not which hosts a page may
    // name, so a build must not fail on the copy that explains the handoff.
    expect(
      findGuardrailViolations(
        "<p>WNET operated NJ PBS from July 1, 2011, until June 30, 2026.</p>" +
          `<p>Write to <a href="mailto:fixture-contact@${"wnet.org"}">WNET counsel</a>.</p>` +
          "<p>Source: https://thirteen.org/serving-new-jersey-into-the-future/</p>" +
          "<code>https://www.njtvonline.org/programs/</code>",
      ),
    ).toEqual([]);
  });

  // The site's one live citation of WNET is an anchor, not printed text, and this
  // rule flags it. What lets it ship is the wiki exemption, not the link-context
  // narrowing. Pin both halves together so the next reader sees which mechanism
  // is actually holding, and so widening either one cannot quietly take the
  // citation offline or let the same link onto a public page unnoticed.
  it("flags the WNET citation anchor, and the wiki exemption is what ships it", () => {
    const citation =
      '<a href="https://thirteen.org/serving-new-jersey-into-the-future/"' +
      ' rel="noopener noreferrer" target="_blank">Serving New Jersey</a>';

    expect(findGuardrailViolations(citation).map((x) => x.rule)).toContain(
      "legacy-host",
    );
    expect(
      isGuardrailExemptPath("wiki/org/wnet-transition-statement/index.html"),
    ).toBe(true);
    expect(isGuardrailExemptPath("about/index.html")).toBe(false);
  });

  it("does NOT flag the destinations the launch CTAs actually use", () => {
    // Read from launch-fallback rather than retyping the hosts, so this stays
    // true if the approved portal moves. watch.njpbs.org is the live target for
    // the watch/live/passport CTAs and only looks legacy from a distance.
    for (const url of [
      pbsVideoUrl,
      pbsLivestreamWatchUrl,
      passportLearnMoreUrl,
    ]) {
      expect(findGuardrailViolations(`<a href="${url}">Watch</a>`)).toEqual([]);
    }
  });

  it("flags an absolute njpbs.org link when the path is legacy", () => {
    for (const href of [
      "https://www.njpbs.org/shows/",
      "https://njpbs.org/about/some-old-page",
      "//njpbs.org/page/2",
    ]) {
      expect(
        findGuardrailViolations(`<a href="${href}">Legacy page</a>`).map(
          (violation) => violation.rule,
        ),
        href,
      ).toContain("legacy-path");
    }
  });

  it("does not flag absolute links to current public route families", () => {
    for (const href of [
      "https://njpbs.org/",
      "https://www.njpbs.org/about/#team",
      "https://njpbs.org/posts/a-current-post/",
      "https://njpbs.org/authors/a-current-author/",
      "https://njpbs.org/programs/a-current-show/",
      "https://njpbs.org/wiki/org/nj-pbs/",
    ]) {
      expect(
        findGuardrailViolations(`<a href="${href}">Current page</a>`),
        href,
      ).toEqual([]);
    }
  });

  it.each([
    "https://njpbs.org/posts/embed/",
    "https://njpbs.org/authors/embed/",
    "https://njpbs.org/programs/embed/",
    "https://njpbs.org/wiki/embed/",
  ])("does not flag a current route whose valid slug is embed: %s", (href) => {
    expect(findGuardrailViolations(`<a href="${href}">Current page</a>`)).toEqual([]);
  });

  it("does not treat an NJ PBS service subdomain or lookalike host as the apex", () => {
    for (const href of [
      "https://watch.njpbs.org/programs/",
      "https://njpbs.org.example.com/programs/",
      "https://notnjpbs.org/programs/",
    ]) {
      expect(
        findGuardrailViolations(`<a href="${href}">Elsewhere</a>`),
        href,
      ).toEqual([]);
    }
  });

  it("does NOT flag the outward links NJ PBS keeps on purpose", () => {
    expect(
      findGuardrailViolations(
        '<a href="https://www.njspotlightnews.org/2026/07/story/">NJ Spotlight News</a>' +
          '<a href="https://www.pbs.org/">PBS</a>' +
          '<a href="https://pbskids.org/">PBS KIDS</a>',
      ),
    ).toEqual([]);
  });
});

// The logo-image rule's FORBIDDEN_ASSET pattern has a CSS url() branch, but a
// logo can only be caught in emitted CSS if the dist gate actually feeds it
// stylesheet files. The public chooser links external kit CSS, so the gate must
// scan .css alongside .html. This pins the scannable set so the CSS branch is
// never silently un-fed (which would let a logo url() in a kit stylesheet ship).
describe("isScannableAsset", () => {
  it("scans emitted HTML pages", () => {
    expect(isScannableAsset("index.html")).toBe(true);
    expect(isScannableAsset("prototype/about/index.html")).toBe(true);
  });

  it("scans emitted CSS so logo url() references are caught", () => {
    expect(isScannableAsset("kits/gs/gs.css")).toBe(true);
  });

  it("ignores assets the src/href/url() patterns do not target", () => {
    expect(isScannableAsset("kits/gs/gs.js")).toBe(false);
    expect(isScannableAsset("favicon.png")).toBe(false);
    expect(isScannableAsset("og-default.png")).toBe(false);
    expect(isScannableAsset("sitemap-index.xml")).toBe(false);
  });
});

// The public OKF wiki is the provenance-tracked fact layer, so the deploy
// guardrail does not gate it. The dist scan skips dist/wiki/**.
describe("isGuardrailExemptPath", () => {
  it("exempts the wiki subtree", () => {
    expect(isGuardrailExemptPath("wiki/index.html")).toBe(true);
    expect(isGuardrailExemptPath("wiki/org/nj-pbs/index.html")).toBe(true);
    expect(isGuardrailExemptPath("wiki")).toBe(true);
  });

  it("does not exempt the design-preview pages", () => {
    expect(isGuardrailExemptPath("index.html")).toBe(false);
    expect(isGuardrailExemptPath("prototype/about/index.html")).toBe(false);
    // a path that merely contains "wiki" later is not exempt
    expect(isGuardrailExemptPath("prototype/wiki-ish/index.html")).toBe(false);
  });
});
