import { describe, expect, it, vi } from "vitest";
import { assertPublishedResources, publishedResourceIssues, publishedBlockResourceError } from "../src/lib/published-resource-check";
import { renderHtmlBlock } from "../../packages/content-core/src/content-render";
import flourishBlocks from "./fixtures/flourish-post-blocks.json";

import {
  MAILCHIMP_CONSENT_SNIPPET,
  WISEPOPS_CONSENT_SNIPPET,
} from "../src/lib/analytics-consent-head";

const check = (html: string, path = "/about/") => publishedResourceIssues(html, path);

describe("published resource review boundary (#763)", () => {
  // Read-only published HTML from post 7cc2a9171f7a9406a0103cd305071120, version 15 (#4994).
  it("admits the real three-chart post and Flourish story and iframe methods", () => {
    expect(publishedBlockResourceError(flourishBlocks)).toBeNull();
    const html = flourishBlocks.map(block => renderHtmlBlock(block.data)).join("");
    expect(check(html)).toEqual([]);
    expect(check(renderHtmlBlock({ html: '<div class="flourish-embed" data-src="story/123"><script src="https://public.flourish.studio/resources/embed.js"></script><noscript><img src="https://public.flourish.studio/story/123/thumbnail"></noscript></div><iframe src="https://flo.uri.sh/story/123/embed"></iframe><iframe src="https://flo.uri.sh/visualisation/30830626/embed"></iframe>' }))).toEqual([]);
    for (const tag of ["script", "img", "iframe"]) {
      expect(check(`<${tag} src="https://public.flourish.studio.evil.test/resource"></${tag}>`).join(" ")).toContain("public.flourish.studio.evil.test");
    }
  });

  it("identifies refused visible planks, including nested noscript, without printing URL queries", () => {
    const blocks = [{ id: "hidden-row", type: "row", visible: false, order: 0, data: {} },
      { id: "chart", type: "html", visible: true, order: 1, layout: { rowId: "hidden-row", column: 0 },
        data: { html: '<noscript><img src="https://unapproved.example.test/pixel?private=value"></noscript>' } }];
    expect(publishedBlockResourceError(blocks)).toBeNull();
    blocks[0].visible = true;
    expect(publishedBlockResourceError(blocks)).toBe("Custom HTML plank 2: Unreviewed img resource host: unapproved.example.test. Replace or remove the refused embed before publishing.");
  });
  it("preserves approved media, players, schedule and local assets", () => {
    expect(check('<img src="https://image.pbs.org/art.jpg"><img src="https://media.njpbs.org/art.jpg"><img src="data:image/png;base64,AAAA"><img src="/art.jpg"><script src="/app.js"></script><script src="https://jaws-prod.cdn.pbs.org/js/gc.js"></script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script><iframe src="https://www.youtube-nocookie.com/embed/test"></iframe>')).toEqual([]);
  });
  it.each(["script", "iframe", "img"])("rejects new third-party %s hosts, even with PBS-looking names", tag => {
    for (const host of ["tracker.example.test", "image.pbs.org.evil.test"]) {
      expect(check(`<${tag} src="https://${host}/resource"></${tag}>`)).toEqual([`Unreviewed ${tag} resource host: ${host}`]);
    }
  });
  it("does not classify outbound links or script text in JSON-LD as requests", () => {
    expect(check('<a href="https://example.test/">Visit</a><script type="application/ld+json">{"url":"https://hotjar.example.test/"}</script>')).toEqual([]);
  });
  it("rejects direct analytics resources even when a consent banner exists", () => {
    expect(check('<div data-analytics-consent></div><script src="https://www.googletagmanager.com/gtag/js"></script><img src="https://www.google-analytics.com/collect">')).toHaveLength(2);
  });
  it("rejects ActiveCampaign outside the consent module and on excluded content", () => {
    expect(check('<script src="https://diffuser-cdn.app-us1.com/diffuser/diffuser.js"></script>')).toHaveLength(1);
    expect(check('<script>vgo("process");</script>')).toEqual(["Inline tracker outside the consent loader"]);
    expect(check('<script>const source = "https://trackcmp.net/visit";</script>')).toEqual(["Inline tracker outside the consent loader"]);
    expect(check('<aside data-activecampaign-enabled></aside>', "/kids/games/")).toEqual(["Site analytics on a Kids or video page"]);
    expect(check('<meta data-child-directed><aside data-analytics-consent></aside>', "/learn/")).toEqual(["Site analytics on a Kids or video page"]);
  });
  it("admits only the exact Wisepops consent loader on eligible content", () => {
    expect(check('<script src="https://wisepops.net/h/example/loader.js"></script>')).toEqual([
      "Unreviewed script resource host: wisepops.net",
    ]);
    expect(check('<script>window.wisepops("consent", "granted")</script>')).toEqual([
      "Inline tracker outside the consent loader",
    ]);
    expect(check(`<script id="wisepopsjs">${WISEPOPS_CONSENT_SNIPPET}</script>`)).toEqual([]);
    expect(check(`<script id="wisepopsjs">${WISEPOPS_CONSENT_SNIPPET} </script>`)).toEqual([]);
    expect(check('<script id="wisepopsjs">window.wisepops("consent", "granted")</script>')).toEqual([
      "Inline tracker outside the consent loader",
    ]);
    expect(check(`<script id="wisepopsjs">${WISEPOPS_CONSENT_SNIPPET}</script>`, "/kids/")).toEqual([
      "Site analytics on a Kids or video page",
    ]);
  });
  it("checks beacons in srcset, picture sources, noscript and templates", () => {
    for (const html of [
      '<img src="/art.jpg" srcset="/small.jpg 1x, https://tracker.example.test/pixel 2x">',
      '<picture><source srcset="https://tracker.example.test/pixel 1x"><img src="/art.jpg"></picture>',
      '<noscript><img src="https://tracker.example.test/pixel"></noscript>',
      '<template><img src="https://tracker.example.test/pixel"></template>',
    ]) expect(check(html).join(" ")).toContain("tracker.example.test");
  });
  it("checks sandboxed CMS output and nested escaped srcdoc", () => {
    const html = renderHtmlBlock({ html: renderHtmlBlock({ html: '<img src="https://tracker.example.test/pixel">' }) });
    expect(check(html)).toEqual(["Unreviewed img resource host: tracker.example.test"]);
  });
  it("keeps analytics off Kids and embedded-player pages using current video policy", () => {
    expect(check('<div data-analytics-consent></div>', "/kids/")).toEqual(["Site analytics on a Kids or video page"]);
    for (const player of ['<video></video>', '<iframe src="https://player.pbs.org/player/"></iframe>', '<iframe src="https://www.youtube-nocookie.com/embed/test"></iframe>']) {
      expect(check(`${player}<script id="mcjs"></script>`)).toEqual(["Site analytics on a Kids or video page"]);
      expect(check(`${player}<script id="wisepopsjs"></script>`)).toEqual(["Site analytics on a Kids or video page"]);
      expect(check(renderHtmlBlock({ html: renderHtmlBlock({ html: player }) }) + '<div data-analytics-consent></div>')).toEqual(["Site analytics on a Kids or video page"]);
    }
  });
  it("rejects unapproved inline trackers and cookie writes without banning consent loaders", () => {
    expect(check('<script>fbq("init", "test")</script>')).toEqual(["Inline tracker outside the consent loader"]);
    expect(check('<script>document.cookie = "tracking=1"</script>')).toEqual(["Inline cookie write outside the consent module"]);
    expect(check(`<script id="mcjs">${MAILCHIMP_CONSENT_SNIPPET}</script>`)).toEqual([]);
    expect(check(`<script id="wisepopsjs">${WISEPOPS_CONSENT_SNIPPET}</script>`)).toEqual([]);
    expect(check('<script id="mcjs">fbq("init", "test")</script>')).toEqual(["Inline tracker outside the consent loader"]);
  });
  it("rejects unsupported schemes, remote bases and malformed URLs without printing URL values", () => {
    expect(check('<iframe src="data:text/html,anything"></iframe>')).toEqual(["Unsupported iframe resource URL"]);
    expect(check('<script src="http://njpbs.org/app.js"></script>')).toEqual(["Unsupported script resource URL"]);
    expect(check('<base href="https://tracker.example.test/"><img src="pixel">')).toEqual(["External base URL changes the resource origin"]);
    expect(() => assertPublishedResources('<img src="https://tracker.example.test/pixel?private=value">', "/")).toThrow("Unreviewed img resource host: tracker.example.test");
  });
});

it("does not classify prose or JSON data islands as tracker code", () => {
  expect(check('<script>const narrative = "A plausible explanation for this name";</script><script type="application/json">{"description":"Matomo, Hotjar and plausible names"}</script>')).toEqual([]);
  expect(check('<script type="module">gtag("config", "G-UNREVIEWED")</script>')).toEqual(["Inline tracker outside the consent loader"]);
});

it.each([
  '<video poster="https://tracker.example.test/pixel"></video>',
  '<video src="https://tracker.example.test/movie"></video>',
  '<audio src="https://tracker.example.test/audio"></audio>',
  '<track src="https://tracker.example.test/captions">',
  '<input type="image" src="https://tracker.example.test/pixel">',
  '<svg><image href="https://tracker.example.test/pixel" /></svg>',
  '<embed src="https://tracker.example.test/frame">',
  '<object data="https://tracker.example.test/frame"></object>',
  '<link rel="stylesheet" href="https://tracker.example.test/style.css">',
  '<link rel="preload" as="image" href="https://tracker.example.test/pixel">',
])("checks other declared resource forms: %s", html => {
  expect(check(renderHtmlBlock({ html })).join(" ")).toContain("tracker.example.test");
});

it("admits the development media origin only in development", async () => {
  const html = '<img src="https://dev-media.example.org/cms-media/art.webp"><video><source src="https://dev-media.example.org/cms-media/video.mp4"></video>';
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "production");
  vi.resetModules();
  try {
    const production = await import("../src/lib/published-resource-check");
    expect(production.publishedResourceIssues(html, "/").join(" ")).toContain("dev-media.example.org");
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
    vi.resetModules();
    const development = await import("../src/lib/published-resource-check");
    expect(development.publishedResourceIssues(html, "/")).toEqual([]);
  } finally { vi.unstubAllEnvs(); vi.resetModules(); }
});

it("accepts the compiled deployment's own asset origin without admitting it elsewhere", () => {
  const html = '<script type="module" src="https://dev-public.example.org/posts/_no-build-assets/_astro/page.js"></script>';
  expect(publishedResourceIssues(html, "/", "https://dev-public.example.org")).toEqual([]);
  expect(check(html)).toEqual(["Unreviewed script resource host: dev-public.example.org"]);
});

it("uses the serving deployment origin for block admission and diagnostics", () => {
  const blocks = [{ id: "local", type: "html", visible: true, order: 0,
    data: { html: '<script src="https://dev-public.example.org/embed.js"></script>' } }];
  try {
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
    expect(publishedBlockResourceError(blocks)).toBeNull();
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "production");
    expect(publishedBlockResourceError(blocks)).toContain("Unreviewed script resource host: dev-public.example.org");
  } finally { vi.unstubAllEnvs(); }
});

it("keeps SVG href and xlink:href distinct when reviewing image requests", () => {
  // SVG href takes precedence in browsers. A second approved xlink:href must
  // not overwrite the external request while building the attribute inventory.
  expect(check('<svg><image href="https://tracker.example.test/pixel" xlink:href="https://image.pbs.org/art.jpg"></image></svg>')).toEqual(["Unreviewed img resource host: tracker.example.test"]);
  expect(check('<svg><image xlink:href="https://tracker.example.test/pixel"></image></svg>')).toEqual(["Unreviewed img resource host: tracker.example.test"]);
});
