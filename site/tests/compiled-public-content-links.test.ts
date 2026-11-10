// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseFrontmatter } from "astro/markdown";
import { satteri } from "@astrojs/markdown-satteri";
import privatePreview from "../astro.renderer.config.mjs";
import shadowRuntime from "../astro.shadow.config.mjs";
vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
vi.stubEnv("FIREBASE_PROJECT_ID", undefined);
const { default: publicRuntime } = await import("../astro.public-post.config.mjs");
const { default: publicPageTest } = await import("../astro.public-page-renderer.config.mjs");
const { default: pairRuntime } = await import("../astro.public-release-pair.config.mjs");
const { default: staticPageFixture } = await import("../astro.public-page-fixtures.config.mjs");
afterAll(() => vi.unstubAllEnvs());

const pages = {
  contact: ["/faq/", "/accessibility/", "/closed-captioning/", "/public-file/"],
  "closed-captioning": ["/live/", "/accessibility/"],
};

describe.each([
  ["private saved preview", privatePreview, false],
  ["public Page runtime", publicRuntime, false],
  ["public Page CI fixture", publicPageTest, false],
  ["static Page parity baseline", staticPageFixture, true],
])("%s Markdown links", (_name, config, stripsComments) => {
  it.each(Object.entries(pages))("renders %s help links as public routes", async (slug, expected) => {
    // An omitted processor is the default Satteri path that compiled the bad
    // links in release 96e0344. Normal site config already has this rewriter.
    const processor = await (config.markdown?.processor ?? satteri()).createRenderer({});
    const fileURL = new URL(`../src/content/pages/${slug}.md`, import.meta.url);
    const { content } = parseFrontmatter(await readFile(fileURLToPath(fileURL), "utf8"));
    const html = (await processor.render(content, { fileURL })).code;
    const previous = await satteri().createRenderer({});
    const before = (await previous.render(content, { fileURL })).code;
    // The static oracle follows production's existing removal of internal comments.
    const expectedBefore = stripsComments ? before.replace(/<!--[\s\S]*?-->/g, "") : before;
    // Preserve the existing compiled article markup apart from the rewritten
    // local Markdown links. This also checks the processor change's scope.
    const normalize = (value: string) => value.replace(/<br \/>/g, "<br>").replace(/\n\s*\n/g, "\n").trim();
    expect(normalize(html)).toBe(normalize(expectedBefore.replace(/href="([a-z-]+)\.md"/g, 'href="/$1/"')));
    const helpLinks = [...html.matchAll(/href="([^"]+)"/g)]
      .map(match => match[1]).filter(href => expected.includes(href));
    expect(helpLinks).toEqual(expected);
    expect(html).not.toMatch(/href="[^"\s]*\.md(?:[#?"])/);
  });
});

describe.each([
  ["private preview", privatePreview], ["shadow Post", shadowRuntime],
  ["public runtime", publicRuntime], ["public Page runtime", publicPageTest], ["pair replay", pairRuntime],
])("%s compiled HTML link boundary", (_name, config) => {
  it("loads the shared middleware from the actual configured Astro source directory", async () => {
    const src = new URL(String(config.srcDir).replace(/\/?$/, "/"), new URL("../", import.meta.url));
    expect(await readFile(new URL("middleware.ts", src), "utf8")).toBe('export { onRequest } from "../middleware";\n');
  });
});
