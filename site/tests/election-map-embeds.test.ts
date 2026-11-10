import { describe, expect, it } from "vitest";
import headers from "../public/_headers?raw";
import { renderBlock, renderHtmlBlock } from "../../packages/content-core/src/content-render";
import { apResultsLayoutSrc } from "../../packages/content-core/src/embed-player";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { servePreviewRequest } from "../../workers/src/preview-worker";
import { hasVideoPlayer } from "../../packages/content-core/src/video-page";
import { publishedResourceIssues } from "../src/lib/published-resource-check";

// Public embeds observed on Spotlight's NJ Decides hub and June results pages.
const embeds = [
  "https://datawrapper.dwcdn.net/lefpS/1/",
  "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29196.html",
  "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html",
];
const path = "/nj-decides-2026/";

describe("Spotlight election map embeds", () => {
  it.each(embeds.slice(1))("renders an AP layout directly with fixed space and analytics excluded: %s", url => {
    const block = { id: "ap-map", type: "embed", order: 0, visible: true, data: { url, heading: 'New Jersey <results>', caption: "Archived primary results", mapSize: "large", mobileHeight: 700, mapWidth: "wide" } };
    const parsed = parseBlocks([block]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Valid AP map controls were rejected");
    const html = renderBlock(parsed.blocks[0]);
    expect(html).toContain(`src="${url}"`);
    expect(html).toContain('height="1200"');
    expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    expect(html).toContain('New Jersey &lt;results&gt;');
    expect(html).toContain("Source: AP");
    expect(html).toContain("Archived primary results");
    expect(html).toContain("election-map--wide");
    expect(html).toContain("--ap-map-mobile-height:700px");
    expect(html).not.toMatch(/srcdoc|sandbox|<script/);
    expect(publishedResourceIssues(html, path)).toEqual([]);
    expect(hasVideoPlayer(html)).toBe(true);
    expect(publishedResourceIssues(html + '<div data-analytics-consent></div>', path)).toEqual(["Site analytics on a Kids or video page"]);
  });

  it.each([["small", 600], ["medium", 900], ["large", 1200]] as const)("reserves the %s AP map size before load", (mapSize, height) => {
    const html = renderBlock({ id: "ap-map", type: "embed", order: 0, visible: true, data: { url: embeds[1], mapSize } });
    expect(html).toContain(`height="${height}"`);
    expect(html).toContain(`--ap-map-mobile-height:${height}px`);
  });

  it.each([{ mapSize: "huge" }, { mapSize: ["small"] }, { mapWidth: "edge-to-edge" }, { mobileHeight: 319 }, { mobileHeight: 4097 }])("rejects invalid persisted map controls: %j", settings => {
    expect(parseBlocks([{ id: "ap-map", type: "embed", order: 0, visible: true, data: { url: embeds[1], ...settings } }]).ok).toBe(false);
  });

  it.each([
    embeds[1].replace("https:", "http:"),
    embeds[1].replace(".org/", ".org.example.test/"),
    embeds[1].replace(".org/", ".org:8443/"),
    embeds[1].replace("https://", "https://user:password@"),
    embeds[1] + "?test=true",
    embeds[1] + "#layout",
    "https://interactives.apelections.org/election-results/assets/microsite/layoutClient.js",
    `<iframe src="${embeds[1]}"></iframe>`,
  ])("does not render unapproved AP links as direct frames: %s", url => {
    expect(apResultsLayoutSrc(url)).toBeNull();
    const html = renderBlock({ id: "ap-map", type: "embed", order: 0, visible: true, data: { url } });
    expect(html).not.toContain("<iframe");
  });

  it.each(embeds)("admits %s in Custom HTML and excludes site analytics", src => {
    const html = renderHtmlBlock({ html: `<iframe title="Election map" src="${src}"></iframe>` });
    expect(publishedResourceIssues(html, path)).toEqual([]);
    expect(hasVideoPlayer(html)).toBe(true);
    for (const analytics of ['<div data-analytics-consent></div>', '<aside data-activecampaign-enabled></aside>', '<script id="mcjs"></script>', '<script id="wisepopsjs"></script>']) {
      expect(publishedResourceIssues(html + analytics, path)).toEqual(["Site analytics on a Kids or video page"]);
    }
  });

  it("permits only the exact AP frame host without admitting its scripts", () => {
    expect(publishedResourceIssues(renderHtmlBlock({ html: '<iframe src="https://interactives.apelections.org.example.test/map"></iframe>' }), path)).toEqual([
      "Unreviewed iframe resource host: interactives.apelections.org.example.test",
    ]);
    expect(publishedResourceIssues('<script src="https://interactives.apelections.org/election-results/assets/microsite/resizeClient.js"></script>', path)).toEqual([
      "Unreviewed script resource host: interactives.apelections.org",
    ]);
  });

  it("includes the reviewed map origins in both report-only frame policies", () => {
    const staticPolicy = /Content-Security-Policy-Report-Only: (.+)/.exec(headers)![1];
    for (const policy of [staticPolicy, SECURITY_HEADER_BASELINE["content-security-policy-report-only"]]) {
      const frameOrigins = policy.split(";").find(directive => directive.trim().startsWith("frame-src "))!.trim().split(/\s+/).slice(1);
      for (const src of embeds) expect(frameOrigins).toContain(new URL(src).origin);
    }
  });

  it("admits the existing AP frame origin in preview responses without admitting its scripts", async () => {
    const response = await servePreviewRequest(new Request("https://preview.njpbs.org/not-a-preview/"), {
      bucket: { get: async () => null, head: async () => null }, now: () => 0,
    });
    const policy = response.headers.get("content-security-policy-report-only")!;
    const origins = (directive: string) => policy.split(";").find(value => value.trim().startsWith(`${directive} `))!.trim().split(/\s+/).slice(1);
    expect(origins("frame-src")).toContain("https://interactives.apelections.org");
    expect(origins("frame-src")).not.toContain("https://*.apelections.org");
    expect(origins("script-src")).not.toContain("https://interactives.apelections.org");
  });
});
