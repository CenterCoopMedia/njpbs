// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { preparePrivatePreview } from "../scripts/prepare-private-preview.mjs";
import { renderBlock } from "../../packages/content-core/src/content-render";

const directories: string[] = [];
const queueId = "11111111111111111111";
const base = `/p/${queueId}/`;
const now = 1_780_000_000_000;
const expiresAtMs = now + 60_000;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(
  html: string,
  assets: Record<string, string> = {},
  manifest = {},
  route = "contact",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "njpbs-private-preview-"));
  directories.push(directory);
  for (const [file, body] of Object.entries({ [`${route}/index.html`]: html,
    "_preview-assets.json": JSON.stringify(manifest), ...assets })) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return directory;
}

const pack = (buildDirectory: string, overrides = {}) => preparePrivatePreview({
  buildDirectory, pageId: "contact", queueId, now, expiresAtMs, ...overrides,
});

it("packages the selected route and its transitive browser assets without changing source files", async () => {
  const html = `<link rel="stylesheet" href="/_astro/site.css"><script type="module" src="${base}_astro/main.js"></script>
    <a href="/contact/#form">This page</a><a href="/watch/">Other page</a><img src="/logo.svg">`;
  const directory = await fixture(html, {
    "_astro/site.css": '@import "more.css"; .logo { background: url(../logo.svg) }',
    "_astro/more.css": '@font-face { src: url(/fonts/test.woff2) }',
    "_astro/main.js": 'import("./lazy.js")', "_astro/lazy.js": 'export const ready = true;',
    "fonts/test.woff2": "font", "logo.svg": "<svg/>", "unrelated.html": "private unrelated page",
  }, { main: { file: "_astro/main.js", dynamicImports: ["lazy"] }, lazy: { file: "_astro/lazy.js" } });
  const result = await pack(directory);
  expect([...result.files.keys()].sort()).toEqual(["contact/index.html", "_astro/site.css",
    "_astro/more.css", "_astro/main.js", "_astro/lazy.js", "fonts/test.woff2", "logo.svg"].sort());
  const output = result.files.get("contact/index.html")!.body.toString();
  expect(output).toContain(`href="${base}contact/#form"`);
  expect(output).toContain('href="https://njpbs.org/watch/"');
  expect(output).toContain(`src="${base}logo.svg"`);
  expect(result.files.get("_astro/more.css")!.body.toString()).toContain(`${base}fonts/test.woff2`);
  for (const [file, asset] of result.files) {
    expect(asset.key).toBe(`v1/${queueId}/${file}`);
    expect(asset.customMetadata).toEqual({ schema: "njpbs-preview-v1", queueid: queueId, expiresatms: String(expiresAtMs) });
    expect(asset.sha256).toBe(createHash("sha256").update(asset.body).digest("hex"));
  }
  expect(await readFile(path.join(directory, "contact/index.html"), "utf8")).toBe(html);
});

it("selects dev artifact, asset and preload URLs from the project tuple", async () => {
  const directory = await fixture(`<html><head><script type="module" src="/p/${queueId}/_astro/main.js"></script></head>
    <body><img src="/_astro/logo.svg"></body></html>`, {
    "_astro/main.js": "import './dep.js'", "_astro/dep.js": "export const value = 1;", "_astro/logo.svg": "<svg/>",
  }, { main: { file: "_astro/main.js", imports: ["dep"] }, dep: { file: "_astro/dep.js" } });
  const result = await pack(directory, { deploymentEnvironment: "development", projectId: "njpbs-site-dev" });
  expect(result.previewUrl).toBe(`https://dev-preview.example.org/p/${queueId}/`);
  expect(result.pageUrl).toBe(`https://dev-preview.example.org/p/${queueId}/contact/`);
  const html = result.files.get("contact/index.html")!.body.toString();
  expect(html).toContain(`src="/p/${queueId}/_astro/logo.svg"`);
  expect(html).toContain(`href="/p/${queueId}/_astro/dep.js"`);
});

it.each([["development", "njpbs-site"], ["production", "njpbs-site-dev"]])(
  "refuses artifact output for %s with %s", async (deploymentEnvironment, projectId) => {
    const directory = await fixture("<html><head></head><body>Preview</body></html>");
    await expect(pack(directory, { deploymentEnvironment, projectId })).rejects.toThrow("target differs");
  });

it("rejects an absolute production preview asset in a dev artifact", async () => {
  const directory = await fixture('<html><head></head><body><img src="https://preview.njpbs.org/p/11111111111111111111/logo.svg"></body></html>');
  await expect(pack(directory, { deploymentEnvironment: "development", projectId: "njpbs-site-dev" }))
    .rejects.toThrow("Cross-environment preview asset");
});

it("keeps default and explicit production artifact bytes identical", async () => {
  const directory = await fixture('<html><head></head><body><img src="/logo.svg"></body></html>', {
    "logo.svg": "<svg/>",
  });
  const implicit = await pack(directory);
  const explicit = await pack(directory, { deploymentEnvironment: "production", projectId: "njpbs-site" });
  expect(implicit.previewUrl).toBe(`https://preview.njpbs.org${base}`);
  expect(implicit.pageUrl).toBe(explicit.pageUrl);
  expect([...implicit.files]).toEqual([...explicit.files]);
});

it("packages only the saved post route and its assets under the private queue", async () => {
  const slug = "saved-draft-story";
  const html = `<html><head><meta name="robots" content="noindex, nofollow">
    <link rel="stylesheet" href="/_astro/post.css"></head>
    <body><h1>Exact saved post</h1><p>Only this saved post revision</p></body></html>`;
  const directory = await fixture(html, {
    "_astro/post.css": "body { color: black; }",
    "contact/index.html": "<p>Released page</p>",
    "posts/other-story/index.html": "<p>Other released post</p>",
  }, {}, `posts/${slug}`);

  const result = await pack(directory, {
    collection: "cmsPosts",
    pageId: "post-one",
    snapshot: { published: { metadata: { slug } } },
  });

  expect(result.previewUrl).toBe(`https://preview.njpbs.org${base}`);
  expect(result.pageUrl).toBe(`https://preview.njpbs.org${base}posts/${slug}/`);
  expect([...result.files.keys()].sort()).toEqual([
    "_astro/post.css",
    `posts/${slug}/index.html`,
  ]);
  const output = result.files.get(`posts/${slug}/index.html`)!.body.toString();
  expect(output).toContain('<meta name="robots" content="noindex, nofollow">');
  expect(output).toContain("Exact saved post");
  expect(output).toContain("Only this saved post revision");
  expect(output).toContain(`href="${base}_astro/post.css"`);
  expect([...result.files.keys()].filter(file => file.endsWith(".html")))
    .toEqual([`posts/${slug}/index.html`]);
});

it("handles inline styles, responsive URLs, SVG uses and no-script fallback assets", async () => {
  const directory = await fixture(`<style>.a { background: url('/logo.svg') }</style>
    <div style="background: url(/logo.svg)"></div><svg><use href="/logo.svg#mark"></use></svg>
    <img srcset="/logo.svg 100w, https://images.example/image?crop=1,2 200w">
    <img srcset="data:image/png;base64,AAAA 1x, /logo.svg 2x">
    <noscript><img src="/fallback.png"></noscript><template><img src="/logo.svg"></template>`,
  { "logo.svg": "<svg/>", "fallback.png": "fallback" });
  const result = await pack(directory);
  const output = result.files.get("contact/index.html")!.body.toString();
  expect(output).toContain(`srcset="${base}logo.svg 100w, https://images.example/image?crop=1,2 200w"`);
  expect(output).toContain(`srcset="data:image/png;base64,AAAA 1x, ${base}logo.svg 2x"`);
  expect(output).toContain(`<noscript><img src="${base}fallback.png"></noscript>`);
  expect(output).toContain(`href="${base}logo.svg#mark"`);
  expect(result.files.has("fallback.png")).toBe(true);
});

it("freezes apex brand resources from the build while preserving immutable remote media", async () => {
  const seed = "https://njpbs.org/brand/seed.webp";
  const media = "https://media.njpbs.org/cms-media/original.webp";
  const directory = await fixture(`<img src="${seed}" srcset="${seed} 640w">
    <div style="background: url(${seed})"></div><img src="${media}">`,
    { "brand/seed.webp": "pinned renderer image" });
  const result = await pack(directory);
  const output = result.files.get("contact/index.html")!.body.toString();
  expect(output).not.toContain(seed);
  expect(output).toContain(`src="${base}brand/seed.webp"`);
  expect(output).toContain(`srcset="${base}brand/seed.webp 640w"`);
  expect(output).toContain(media);
  expect(result.files.get("brand/seed.webp")!.body.toString()).toBe("pinned renderer image");
  const missing = await fixture(`<img src="${seed}">`);
  await expect(pack(missing)).rejects.toThrow(/ENOENT/);
});

it("packages only the Home hero's deferred and fallback image attributes", async () => {
  const media = "https://media.njpbs.org/cms-media/original.webp";
  const directory = await fixture(`<img data-home-hero-src="/brand/spotlight/budget.jpg"
      data-fallback-src="/brand/home/new-jersey-blue.webp">
    <img data-home-hero-src="${media}" data-other-src="/brand/not-a-resource.webp">
    <div data-home-hero-src="/brand/not-an-image.webp"></div>`, {
    "brand/spotlight/budget.jpg": "topic image bytes",
    "brand/home/new-jersey-blue.webp": "fallback image bytes",
  });
  const result = await pack(directory);
  const output = result.files.get("contact/index.html")!.body.toString();
  expect(output).toContain(`data-home-hero-src="${base}brand/spotlight/budget.jpg"`);
  expect(output).toContain(`data-fallback-src="${base}brand/home/new-jersey-blue.webp"`);
  expect(output).toContain(`data-home-hero-src="${media}"`);
  expect(output).toContain('data-other-src="/brand/not-a-resource.webp"');
  expect(output).toContain('data-home-hero-src="/brand/not-an-image.webp"');
  expect(result.files.get("brand/spotlight/budget.jpg")!.body.toString()).toBe("topic image bytes");
  expect(result.files.get("brand/home/new-jersey-blue.webp")!.body.toString()).toBe("fallback image bytes");
  expect([...result.files.keys()].sort()).toEqual([
    "brand/home/new-jersey-blue.webp", "brand/spotlight/budget.jpg", "contact/index.html",
  ]);
});

it.each([
  ['<img src="/p/22222222222222222222/logo.svg">', /Cross-queue/],
  ['<img src="/%2e%2e/private.key">', /Invalid private preview file/],
  ['<iframe src="/other/index.html"></iframe>', /another page/],
  ['<iframe src="/other/index.HTML"></iframe>', /another page/],
  ['<base href="https://example.com/">', /base URL/],
  ['<script src="/script.js"></script>', /Missing browser dependency entry/],
])("refuses unsupported or cross-boundary artifacts: %s", async (html, message) => {
  const directory = await fixture(html, { "script.js": "" });
  await expect(pack(directory)).rejects.toThrow(message);
});

it("packages a custom HTML frame, whose document sets only a link target", async () => {
  const frame = renderBlock({ id: "h", type: "html", order: 0, visible: true,
    data: { html: '<a href="https://example.com/">Read</a>', title: "Chart" } }, {})!;
  const result = await pack(await fixture(frame));
  const output = result.files.get("contact/index.html")!.body.toString();
  expect(output).toContain("srcdoc=");
  expect(output).toContain('<base target=&quot;_blank&quot;>');
});

it("refuses an asset symlink outside the build and an expired artifact", async () => {
  const directory = await fixture('<img src="/outside.svg">');
  const outside = await fixture("", { "outside.svg": "<svg/>" });
  await symlink(path.join(outside, "outside.svg"), path.join(directory, "outside.svg"));
  await expect(pack(directory)).rejects.toThrow(/escapes the build directory/);
  await expect(pack(directory, { expiresAtMs: now })).rejects.toThrow(/identity or expiry/);
});

it("preloads only emitted modules' static closure, deduplicating roots, existing hints and cycles", async () => {
  const directory = await fixture(`<link rel="modulepreload" href="/_astro/shared.js">
    <script type="module" src="/_astro/main.js"></script><script type="module" src="/_astro/main.js"></script>
    <script type="module" src="/_astro/second.js"></script>
    <script type="module" src="https://example.com/external.js"></script>
    <template><script type="module" src="/_astro/inert.js"></script></template>`, {
    "_astro/main.js": 'import "./shared.js"; import("./lazy.js");',
    "_astro/second.js": 'import "./leaf.js";', "_astro/shared.js": 'import "./leaf.js";',
    "_astro/leaf.js": 'import "./main.js";', "_astro/lazy.js": 'import "./lazy-child.js";',
    "_astro/lazy-child.js": '', "_astro/inert.js": 'import "./inert-child.js";',
    "_astro/inert-child.js": '',
  }, {
    main: { file: "_astro/main.js", imports: ["shared"], dynamicImports: ["lazy"] },
    second: { file: "_astro/second.js", imports: ["leaf"] },
    shared: { file: "_astro/shared.js", imports: ["leaf"] },
    leaf: { file: "_astro/leaf.js", imports: ["main"] },
    lazy: { file: "_astro/lazy.js", imports: ["lazyChild"] },
    lazyChild: { file: "_astro/lazy-child.js" },
    inert: { file: "_astro/inert.js", imports: ["inertChild"] },
    inertChild: { file: "_astro/inert-child.js" },
    unrelated: { file: "_astro/unrelated.js" },
  });
  const result = await pack(directory);
  const output = result.files.get("contact/index.html")!.body.toString();
  expect(output.match(/<link rel="modulepreload"[^>]*>/g)).toEqual([
    `<link rel="modulepreload" href="${base}_astro/shared.js">`,
    `<link rel="modulepreload" href="${base}_astro/leaf.js">`,
  ]);
  expect(result.files.has("_astro/lazy.js")).toBe(true);
  expect(result.files.has("_astro/lazy-child.js")).toBe(true);
  expect(result.files.has("_astro/inert-child.js")).toBe(true);
  expect(result.files.has("_astro/unrelated.js")).toBe(false);
  expect(await readFile(path.join(directory, "_astro/main.js"), "utf8"))
    .toBe(result.files.get("_astro/main.js")!.body.toString());
});

it("keeps dependency preload URLs under the persistent artifact prefix", async () => {
  const directory = await fixture('<script type="module" src="/_astro/main.js"></script>', {
    "_astro/main.js": 'import "./child.js";', "_astro/child.js": '',
  }, { main: { file: "_astro/main.js", imports: ["child"] }, child: { file: "_astro/child.js" } });
  const result = await pack(directory, { contentKey: "a".repeat(64) });
  expect(result.files.get("contact/index.html")!.body.toString())
    .toContain(`<link rel="modulepreload" href="/s/${queueId}/_astro/child.js">`);
});

it.each(["../outside.js", "/p/22222222222222222222/child.js", "https://example.com/child.js"])(
  "rejects a static manifest dependency outside the package: %s", async dependency => {
    const directory = await fixture('<script type="module" src="/_astro/main.js"></script>', {
      "_astro/main.js": '',
    }, { main: { file: "_astro/main.js", imports: ["child"] }, child: { file: dependency } });
    await expect(pack(directory)).rejects.toThrow(/Invalid private preview file/);
  },
);

it("rejects a missing static dependency instead of emitting an unresolved hint", async () => {
  const directory = await fixture('<script type="module" src="/_astro/main.js"></script>', {
    "_astro/main.js": '',
  }, { main: { file: "_astro/main.js", imports: ["missing"] } });
  await expect(pack(directory)).rejects.toThrow("Missing browser dependency: missing");
});

it("packages the real compiled reader module and leaves Home and Kids unscaled", async () => {
  const { build } = await import("astro");
  const { fileURLToPath } = await import("node:url");
  const site = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(site, ".reader-preview-"));
  directories.push(directory);
  const baseLayout = fileURLToPath(new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url));
  const picker = fileURLToPath(new URL("../src/components/ReaderTextSize.astro", import.meta.url));
  const page = `---
import Base from ${JSON.stringify(baseLayout)};
import ReaderTextSize from ${JSON.stringify(picker)};
---
<Base title="Reading proof" description="Compiled reading proof" childDirected={Astro.url.pathname === "/learning/"} canonicalPath={Astro.url.pathname === "/alias/" ? "/kids/" : undefined} editTarget={Astro.url.pathname === "/young/" ? {type:"page",id:"kids"} : undefined}>
  <ReaderTextSize />
  <div class="cms-block--prose"><p>Reading copy.</p></div>
</Base>`;
  for (const route of ["contact", "kids", "kids/activities", "Kids", "learning", "alias", "young", ""]) {
    const pages = path.join(directory, "src/pages", route);
    await mkdir(pages, { recursive: true });
    await writeFile(path.join(pages, "index.astro"), page);
  }
  await build({
    root: directory, configFile: false, site: "https://njpbs.org", logLevel: "silent", publicDir: path.join(site, "public"),
    vite: { plugins: [{ name: "reader-preview-manifest", configEnvironment(name: string) {
      if (name === "client") return { build: { manifest: "_preview-assets.json" } };
    } }] },
  });
  const output = path.join(directory, "dist");
  const packed = await pack(output);
  const scripts = [...packed.files.keys()].filter(file => /\.js$/.test(file) &&
    packed.files.get(file)!.body.toString().includes("njpbs-reader-text-size"));
  expect(scripts).toHaveLength(1);
  expect(packed.files.get(scripts[0])!.body.toString()).toContain("njpbs-reader-text-size");
  const html = await readFile(path.join(output, "contact/index.html"), "utf8");
  expect(html).toContain("data-reader-text-size-picker");
  expect(html).toContain("njpbs-reader-text-size");
  for (const file of ["index.html", "kids/index.html", "kids/activities/index.html", "Kids/index.html", "learning/index.html", "alias/index.html", "young/index.html"]) {
    const browsing = await readFile(path.join(output, file), "utf8");
    expect(browsing).not.toMatch(/<[^>]*\bdata-reader-text-size-picker(?:\s|>)/);
    expect(browsing).not.toContain("njpbs-reader-text-size");
  }
}, 30_000);
