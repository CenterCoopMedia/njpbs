import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { prose, video, registeredAuthor, withdrawnAuthor, uploadedImages, uploadedAuthors, uploadedImageUrl } from "../../site/tests/fixtures/shadow-posts/fixtures";

const require = createRequire(import.meta.url);
const target = require("../../functions/lib/publication-target.js").publicationTarget(process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const rendererRelease = new URL("../../site/.public-post-renderer/renderer-release.json", import.meta.url);

// Compile with build:public-post-renderer first. This uses the complete Astro
// graph in the production Worker runtime, without Node globals or live services.
it("serves immediate, scheduled, uploaded and live-blog Posts in one compiled renderer in workerd", async () => {
  // Keep the Site type graph outside this isolated harness, as for the projector below.
  const resources = await build({ entryPoints: [fileURLToPath(new URL("../../site/src/lib/published-resource-check.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm" });
  const { assertPublishedResources } = await import(`data:text/javascript;base64,${Buffer.from(resources.outputFiles[0].text).toString("base64")}`);
  const fixtureCode = await build({ entryPoints: [fileURLToPath(new URL("../../site/tests/fixtures/live-blog-post.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm" });
  const { liveBlogPostFixture } = await import(`data:text/javascript;base64,${Buffer.from(fixtureCode.outputFiles[0].text).toString("base64")}`);
  const release = JSON.parse(await readFile(rendererRelease, "utf8"));
  const { rendererSha } = release;
  expect(release).toEqual({ schemaVersion: 1, rendererSha, liveBlogVersion: 1, electionResultsVersion: 2, pageReaderVersion: 1,
    ...(target.environment === "development" ? { environment: "development" } : {}) });
  const secondPost = { ...video, document: { ...video.document, id: "runtime-video" } };
  // A scheduled fire freezes the actual publication instant and scheduler actor.
  // The later working title must stay outside the rendered snapshot.
  const firedAt = "2026-10-09T12:04:00.000Z";
  const scheduledPost = { ...prose, document: { ...prose.document, id: "runtime-scheduled",
    published: { ...prose.document.published, publishedAt: firedAt, publishedBy: "system:scheduler",
      metadata: { ...prose.document.published.metadata, title: "Scheduled fixture", slug: "scheduled-story",
        date: "2026-10-09", firstPublishedAt: firedAt, editorialDateSource: "firstPublish" } } } };
  const liveBlogs = (["image", "library-video", "embed", "linked-video"] as const).map(media => {
    const read: typeof prose = liveBlogPostFixture({ media });
    const slug = `runtime-live-blog-${media}`;
    return { ...read, document: { ...read.document, id: slug, published: { ...read.document.published,
      metadata: { ...read.document.published.metadata, slug } } } };
  });
  const replies = [prose, secondPost, registeredAuthor, withdrawnAuthor, ...uploadedAuthors, ...uploadedImages.filter(read => read.document.published.metadata.slug.endsWith("-current") && !read.document.published.metadata.slug.includes("-interactive-")), scheduledPost, ...liveBlogs].map((published, index) => {
    const slug = published.document.published.metadata.slug;
    return { kind: "post", published, receipt: { schemaVersion: 1, postId: published.document.id,
      operationId: String(index + 1).padStart(20, "0"), sourceVersion: published.document.published.sourceVersion,
      rendererSha, generation: 5, admissionRevision: 1, slug, ownedSlugs: [slug], visible: true, contextDigest: "b".repeat(64) } };
  });
  const bundle = await build({ stdin: { resolveDir: repo, contents: `
    import { createNoBuildPostWorker } from './workers/src/no-build-post-worker.ts';
    import { renderPublishedPost, rendererSha } from './site/.public-post-renderer/server/entry.mjs';
    const replies = ${JSON.stringify(replies)};
    export default { fetch(request) { return createNoBuildPostWorker({
      rendererSha, render: renderPublishedPost, cache: caches.default, target: ${JSON.stringify(target)},
      getDecision: async path => structuredClone(replies.find(reply => path === "/posts/" + reply.receipt.slug + "/")),
      fetchAsset: async () => new Response(null, { status: 404 }),
    }).fetch(request); } };
  ` }, bundle: true, write: false, platform: "browser", format: "esm" });
  const runtime = new Miniflare({ workers: [{ config: { name: "public-post-runtime", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js",
      modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } } } },
    dev: { outboundService: { type: "fetcher", handler: () => new WorkerResponse(null, { status: 502 }) } } }] });
  try {
    await runtime.ready;
    for (const reply of replies) {
      const { receipt } = reply;
      const analytics = target.environment === "production" && !["runtime-live-blog-library-video", "runtime-live-blog-embed", "runtime-live-blog-linked-video"].includes(receipt.slug)
        && !reply.published.document.published.blocks.some(block => block.type === "video");
      const response = await runtime.dispatchFetch(`${target.origin}/posts/${receipt.slug}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-njpbs-publication-operation")).toBe(receipt.operationId);
      expect(response.headers.get("x-njpbs-admission-revision")).toBe("1");
      const html = await response.text();
      assertPublishedResources(html, `/posts/${receipt.slug}/`, target.origin);
      if (analytics && receipt.slug !== "scheduled-story" && !receipt.slug.startsWith("runtime-live-blog-")) expect(html).toContain("A published fixture");
      if (receipt.slug === "scheduled-story") expect(html).toContain("Scheduled fixture");
      if (receipt.slug.startsWith("runtime-live-blog-")) {
        expect(html).toContain("Live coverage across New Jersey");
        expect(html).toContain("Council confirms the meeting time");
        expect(html).toContain("An earlier update named the wrong room.");
        expect(html).toContain("The report could not be verified.");
        if (receipt.slug.endsWith("-library-video")) expect(html).toMatch(/<video[^>]*controls[^>]*preload="none"/);
        if (receipt.slug.endsWith("-image")) expect(html).toContain('alt="Residents on the platform"');
        if (receipt.slug.endsWith("-embed")) expect(html).toContain("data-lead-template");
      }
      if (receipt.slug.startsWith("uploaded-")) {
        expect(html).toContain(`src="${uploadedImageUrl}"`);
        expect(html).toContain("Current &lt;photographer&gt; &amp; NJ PBS");
        expect(html).toContain("Frozen lead caption");
        expect(html).toContain("Frozen body caption");
        expect(html).not.toContain("Private draft caption");
      }
      if (receipt.slug.startsWith("uploaded-") && "authors" in reply.published && Array.isArray(reply.published.authors)) {
        expect(html).toContain(reply.published.authors.length ? "Ada Reporter" : "Ada when published");
        expect(html).toContain("Guest writer");
      }
      expect(html).not.toContain("Private working title");
      expect(html).toMatch(/<!doctype html>/i);
      expect(html).toContain("</html>");
      expect(html.includes('id="analytics-consent-default"'), receipt.slug).toBe(analytics);
      expect(html.includes('id="mcjs"')).toBe(analytics);
      expect(html.includes('id="wisepopsjs"')).toBe(analytics);
      expect(/data-endpoint="https:\/\/[^\"]+"/.test(html)).toBe(target.environment === "production");
      expect(/data-sitekey="[^\"]+"/.test(html)).toBe(target.environment === "production");
      if (receipt.slug === "registered-fixture") {
        expect(html).toContain("Ada Reporter");
        expect(html).toContain("/authors/ada-reporter/");
        expect(html).not.toContain("Ada when published");
      }
      if (receipt.slug === "withdrawn-author-fixture") {
        expect(html).toContain("Ada when published");
        expect(html).not.toContain("/authors/ada-reporter/");
      }
    }
  } finally { await runtime.dispose(); }
});

it.each([["prose", prose], ["video", video], ["registered author", registeredAuthor], ["withdrawn author", withdrawnAuthor], ...uploadedAuthors.map(read => [read.document.published.metadata.slug, read] as const), ...uploadedImages.filter(read => read.document.published.metadata.slug.endsWith("-current") && !read.document.published.metadata.slug.includes("-interactive-")).map(read => [read.document.published.metadata.slug, read] as const)] as const)(
  "runs the same compiled %s release in Node and rejects another source", async (_name, published) => {
    // Load the actual projector at runtime, as the Worker bundle above does.
    // Its Astro type graph is checked by Site, outside this isolated harness.
    const projector = await build({ entryPoints: [fileURLToPath(new URL("../../site/src/lib/published-post-shadow.ts", import.meta.url))],
      bundle: true, write: false, platform: "node", format: "esm" });
    const { projectPublishedPostRead } = await import(`data:text/javascript;base64,${Buffer.from(projector.outputFiles[0].text).toString("base64")}`);
    const compiled = await import(new URL("../../site/.public-post-renderer/server/entry.mjs", import.meta.url).href);
    const slug = published.document.published.metadata.slug;
    const content = projectPublishedPostRead(published, slug, compiled.rendererSha, new Date("2026-10-10T12:00:00Z"))!;
    const html = await compiled.renderPublishedPost(content);
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).not.toContain("Private working title");
    const comparison = await build({ entryPoints: [fileURLToPath(new URL("../../site/src/lib/post-html-comparison.ts", import.meta.url))],
      bundle: true, write: false, platform: "node", format: "esm" });
    const { comparePostHtml } = await import(`data:text/javascript;base64,${Buffer.from(comparison.outputFiles[0].text).toString("base64")}`);
    const baseline = await readFile(new URL(`../../site/.shadow-static-fixtures/posts/${slug}/index.html`, import.meta.url), "utf8");
    expect(comparePostHtml(baseline, html)).toEqual([]);
    await expect(compiled.renderPublishedPost({ ...content, target: { ...content.target, rendererSha: "f".repeat(40) } }))
      .rejects.toThrow("Invalid published Post target");
  },
);

it("defers public YouTube frames only when their loader is emitted", async () => {
  const { publishedPageRead, now } = await import(
    new URL("../../site/tests/fixtures/published-pages/fixtures.ts", import.meta.url).href);
  const projector = await build({ entryPoints: [fileURLToPath(new URL("../../site/src/lib/published-page-render.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "esm" });
  const { projectPublishedPageRead } = await import(`data:text/javascript;base64,${Buffer.from(projector.outputFiles[0].text).toString("base64")}`);
  const compiled = await import(new URL("../../site/.public-post-renderer/server/entry.mjs", import.meta.url).href);
  const src = "https://www.youtube-nocookie.com/embed/tqG0Eyoi0EQ";
  for (const childDirected of [false, true]) {
    const read = publishedPageRead("about", compiled.rendererSha);
    read.page.childDirected = childDirected;
    read.page.blocks.push({ id: "youtube", type: "embed", order: read.page.blocks.length, visible: true,
      data: { url: "https://www.youtube.com/watch?v=tqG0Eyoi0EQ" } });
    const content = await projectPublishedPageRead(read, "about", compiled.rendererSha, now);
    const html = await compiled.renderPublishedPage(content);
    const player = html.match(/<iframe\b[^>]*title="YouTube video player"[^>]*>/)?.[0];
    expect(player, `childDirected=${childDirected}`).toBeDefined();
    expect(player).toContain(` ${childDirected ? "src" : "data-deferred-youtube-src"}="${src}"`);
    expect(html.includes("IntersectionObserver")).toBe(!childDirected);
  }
});

it("retains actual Astro Home, About and Post HTML with AP controls in Worker R2", async () => {
  const { publishedPageRead, fallbackPageRead, retainedHomeSources, now } = await import(
    new URL("../../site/tests/fixtures/published-pages/fixtures.ts", import.meta.url).href);
  const { rendererSha } = JSON.parse(await readFile(rendererRelease, "utf8"));
  const sources = retainedHomeSources(rendererSha);
  const published = publishedPageRead("home", rendererSha);
  const frame = fallbackPageRead("about", rendererSha);
  const post = structuredClone(prose);
  Object.assign(post.document.published, { blocks: [...post.document.published.blocks,
    { id: "ap-map", type: "embed", order: 20, visible: true, data: {
      url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29196.html",
    } },
  ] });
  const page = { kind: "page", published, homeSources: sources, receipt: {
    schemaVersion: 1, pageId: "home", operationId: "H".repeat(20), rendererSha,
    sourceVersion: published.page.sourceVersion, snapshotDigest: "b".repeat(64),
    contextDigest: published.sourceSeal.contextDigest, path: "/", ownedPaths: ["/"],
    generation: 5, operationGeneration: 5, codeGeneration: 5, visible: true, admissionRevision: 1,
  } };
  const context = { kind: "context-page", renderContext: frame, contextReceipt: {
    ...frame.sourceSeal, path: "/about/", source: "site",
  } };
  const slug = post.document.published.metadata.slug;
  const receipt = { schemaVersion: 1, postId: post.document.id, operationId: "P".repeat(20),
    rendererSha, sourceVersion: post.document.published.sourceVersion, slug, ownedSlugs: [slug],
    generation: 9, visible: true, contextDigest: "b".repeat(64), admissionRevision: 1 };
  const bundle = await build({ stdin: { resolveDir: repo, contents: `
    import { createNoBuildPageWorker } from './workers/src/no-build-page-worker.ts';
    import { createTransitionalPostReadWorker } from './workers/src/transitional-post-read-worker.ts';
    import { createPublicContentLastGood } from './workers/src/public-content-last-good.ts';
    import { renderPublishedPage, renderPublicPageContext, renderPublishedPost, rendererSha }
      from './site/.public-post-renderer/server/entry.mjs';
    const target = ${JSON.stringify(target)}, page = ${JSON.stringify(page)}, context = ${JSON.stringify(context)};
    const receipt = ${JSON.stringify(receipt)}, published = ${JSON.stringify(post)};
    export default { async fetch(request, env, ctx) {
      const common = { target, rendererSha, rendererReady: true, cache: caches.default,
        lastGood: createPublicContentLastGood({ store: env.CONTENT, target, rendererSha }),
        waitUntil: task => ctx.waitUntil(task), readWithdrawal: async () => null,
        fetchAsset: async () => Response.json({ schemaVersion: 1, commitSha: rendererSha, generation: 5 }) };
      if (!new URL(request.url).pathname.startsWith('/posts/')) return createNoBuildPageWorker({ ...common,
        render: renderPublishedPage, renderContext: renderPublicPageContext, now: () => new Date(${JSON.stringify(now)}),
        getDecision: async path => structuredClone(path === '/' ? page : context) }).fetch(request);
      return createTransitionalPostReadWorker({ ...common, render: renderPublishedPost,
        getDecision: async path => path === '/_publication.json' ? { kind: 'receipts', catalog: {
          schemaVersion: 1, rendererSha, generation: 9, contextDigest: receipt.contextDigest,
          admissionRevision: 1, posts: [receipt] } } : { kind: 'post', receipt, published } }).fetch(request);
    } };` }, bundle: true, write: false, platform: "browser", format: "esm" });
  const runtime = new Miniflare({ workers: [{ config: { name: "actual-astro-last-good", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
    } }, env: { CONTENT: { type: "r2", name: "actual-astro-last-good" } } },
    dev: { outboundService: { type: "fetcher", handler: () => new WorkerResponse(null, { status: 502 }) } } }] });
  try {
    const bucket = await runtime.getR2Bucket("CONTENT") as unknown as {
      head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>;
      get(key: string): Promise<{ text(): Promise<string> } | null>;
    };
    for (const [path, source] of [["/", "cms-page-no-build"], ["/about/", "cms-page-context"], [`/posts/${slug}/`, "cms-no-build"]]) {
      const response = await runtime.dispatchFetch(`${target.origin}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("x-njpbs-content-source"), path).toBe(source);
      const html = await response.text();
      expect(html, path).toContain("embed-size-query");
      const key = `public-content-last-good/v1/${target.workerName}/${rendererSha}/5/${encodeURIComponent(path)}.html`;
      await expect.poll(async () => (await bucket.head(key))?.customMetadata?.bodyDigest, { message: path })
        .toBe(response.headers.get("x-njpbs-html-sha256"));
      expect(await (await bucket.get(key))!.text(), path).toBe(html);
    }
  } finally { await runtime.dispose(); }
});
