// @vitest-environment node
import { expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { retainStaticArtifactOutput } from "../scripts/public-release-pair-static-target-storage";
import { renderPairContentLinkFallback } from "../scripts/public-release-pair-static-artifact";
import { publishedContentLinkRecords } from "../src/lib/content-link-search";
import { contentLinkFallbackHtml } from "../src/lib/content-link-render";
it("retains the sealed 302 Location while spooling body bytes for static-target readback", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "content-link-readback-"));
  try {
    await mkdir(path.join(directory, "bodies"));
    const output = { path: "/posts/story/", status: 302, body: new Uint8Array(), headers: {
      location: "https://example.test/story?edition=nj", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } };
    const read = await retainStaticArtifactOutput(directory, 0, output);
    output.headers.location = "https://example.test/later-mutation";
    const restored = await read();
    expect(restored.status).toBe(302); expect(restored.bytes).toEqual(new Uint8Array());
    expect(restored.headers?.location).toBe("https://example.test/story?edition=nj");
    expect(contentLinkFallbackHtml({ contentLinkMode: "custom", contentLinkUrl: restored.headers!.location })).toContain('content="noindex, nofollow"');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([
  ["cmsPosts/story", "/posts/story/", true], ["cmsPosts/story", "/posts/story/", false],
  ["cmsPages/contact", "/contact/", true], ["cmsPages/contact", "/contact/", false],
] as const)("keeps the frozen new-tab choice in pair static rollback for %s (%s, %s)", async (key, route, newTab) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "content-link-pair-"));
  const url = "https://example.test/report?edition=nj";
  const documents = new Map([[key, { status: "draft", publiclyVisible: true,
    contentLinkMode: "normal", contentLinkNewTab: !newTab,
    published: { sourceVersion: 1, publishedAt: "2026-11-02T12:00:00.000Z", blocks: [],
      metadata: { type: "post", slug: key.split("/")[1], title: "Frozen linked content",
        contentLinkMode: "custom", contentLinkUrl: url, contentLinkNewTab: newTab } } }]]);
  const entries = new Map(publishedContentLinkRecords(documents, new Date("2026-11-02T20:00:00.000Z")).map(entry => [entry.path, entry]));
  try {
    await mkdir(path.join(directory, "bodies"));
    const read = await retainStaticArtifactOutput(directory, 0, { path: route, status: 302,
      body: new Uint8Array(), headers: { location: url, "x-robots-tag": "noindex, nofollow" } });
    const output = await read();
    const html = renderPairContentLinkFallback(output, entries);
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('href="https://example.test/report?edition=nj"');
    expect(html.includes('target="_blank"')).toBe(newTab);
    expect(html.includes("(opens in new tab)")).toBe(newTab);
    expect(() => renderPairContentLinkFallback({ ...output, headers: { location: "https://example.test/wrong" } }, entries)).toThrow();
    expect(() => renderPairContentLinkFallback(output, new Map())).toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
