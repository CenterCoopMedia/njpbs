import { describe, expect, it } from "vitest";
import { assertLiveBlogData, LIVE_BLOG_MAX_BYTES, LIVE_BLOG_MAX_UPDATES, orderedLiveBlogUpdates, type LiveBlogData, type LiveBlogUpdate } from "../../packages/content-core/src/live-blog";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";

function update(id = "entry-a", overrides: Partial<LiveBlogUpdate> = {}): LiveBlogUpdate {
  return {
    id, headline: `Update ${id}`,
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Synthetic coverage for review." }] }] },
    credits: [{ kind: "custom", name: "Example newsroom" }],
    publishedAt: "2026-11-04T01:00:00Z", updatedAt: "2026-11-04T01:00:00Z",
    keyUpdate: false, ...overrides,
  };
}

function blog(overrides: Partial<LiveBlogData> = {}): LiveBlogData {
  return { schemaVersion: 1, coverageState: "ongoing", updatedAt: "2026-11-04T03:00:00Z", updates: [update()], ...overrides };
}

const options = { id: "post-example", asOf: "2026-11-04T04:00:00Z" };

describe("live blog published contract", () => {
  it("accepts all coverage states and an empty published feed", () => {
    for (const coverageState of ["ongoing", "paused", "ended"] as const) {
      expect(() => assertLiveBlogData(blog({ coverageState, updates: [] }))).not.toThrow();
    }
  });

  it.each([
    null, {}, { ...blog(), schemaVersion: 2 }, { ...blog(), coverageState: "draft" },
    { ...blog(), status: "published" }, { ...blog(), draft: { privateNotes: "not public" } },
    { ...blog(), updates: [update(), update()] },
    { ...blog(), updates: [update("bad\" id")] },
    { ...blog(), updates: [update("x", { headline: " " })] },
    { ...blog(), updates: [update("x", { body: { type: "doc", content: [] } })] },
    { ...blog(), updates: [update("x", { body: "<p>HTML</p>" as never })] },
    { ...blog(), updates: [update("x", { credits: [] })] },
    { ...blog(), updates: [update("x", { credits: [{ kind: "registered", authorId: "unknown" }] })] },
    { ...blog(), updates: [update("x", { credits: [{ kind: "custom", name: "Name\nspoof" }] })] },
    { ...blog(), updates: [{ ...update(), status: "draft" }] },
    { ...blog(), updates: [{ ...update(), privateNotes: "secret" }] },
    { ...blog(), updates: [update("x", { correction: "" })] },
    { ...blog(), updates: [update("x", { correction: "A correction without an edit date" })] },
  ])("rejects malformed, draft-shaped or ambiguous data (%#)", (value) => {
    expect(() => assertLiveBlogData(value)).toThrow();
  });

  it.each(["2026-02-30T01:00:00Z", "2026-11-04T01:00", "2026-11-04", "2026-11-04T01:00:00-05:00"])("refuses noncanonical or impossible instants: %s", (publishedAt) => {
    expect(() => assertLiveBlogData(blog({ updates: [update("x", { publishedAt })] }))).toThrow();
  });

  it("requires ordered publication and correction dates inside the snapshot", () => {
    expect(() => assertLiveBlogData(blog({ updates: [update("x", { updatedAt: "2026-11-04T00:00:00Z" })] }))).toThrow();
    expect(() => assertLiveBlogData(blog({ updates: [update("x", { updatedAt: "2026-11-05T00:00:00Z" })] }))).toThrow();
    expect(() => assertLiveBlogData(blog({ updates: [update("x", { updatedAt: "2026-11-04T02:00:00Z", correction: "The earlier location was incorrect." })] }))).not.toThrow();
  });

  it("refuses large or cyclic snapshots instead of dropping reporting", () => {
    expect(() => assertLiveBlogData(blog({ updates: Array.from({ length: LIVE_BLOG_MAX_UPDATES + 1 }, (_, i) => update(`entry-${i}`)) }))).toThrow();
    const oversized = update();
    oversized.body.content[0].content![0].text = "x".repeat(LIVE_BLOG_MAX_BYTES);
    expect(() => assertLiveBlogData(blog({ updates: [oversized] }))).toThrow(/size limit/);
    const cyclic = update();
    cyclic.body.content.push(cyclic.body);
    expect(() => assertLiveBlogData(blog({ updates: [cyclic] }))).toThrow(/serializable/);
  });

  it("sorts by first publication, breaks ties by immutable id and leaves source order intact", () => {
    const source = blog({ updates: [update("z"), update("a"), update("new", { publishedAt: "2026-11-04T02:00:00Z", updatedAt: "2026-11-04T02:00:00Z" })] });
    const before = structuredClone(source);
    expect(orderedLiveBlogUpdates(source).map((entry) => entry.id)).toEqual(["new", "a", "z"]);
    expect(source).toEqual(before);
  });
});

describe("live blog reader scaffold", () => {
  it("renders semantic sections, Eastern dates, ordered bylines and stable key-update links", () => {
    document.body.innerHTML = renderLiveBlog(blog({ updates: [update("polls", { keyUpdate: true, credits: [{ kind: "custom", name: "Example A" }, { kind: "custom", name: "Example B" }] })] }), options);
    const section = document.querySelector("section")!;
    expect(document.getElementById(section.getAttribute("aria-labelledby")!)?.textContent).toBe("Live updates");
    expect(section.textContent).toContain("Coverage ongoing");
    expect(section.textContent).toContain("Nov. 3, 2026, 8:00 PM EST");
    expect(Array.from(section.querySelectorAll(".live-blog__reporter-name"), node => node.textContent)).toEqual(["Example A", "Example B"]);
    const target = document.querySelector("nav a")!.getAttribute("href")!.slice(1);
    expect(document.getElementById(target)?.tagName).toBe("ARTICLE");
    expect(document.querySelectorAll("ol > li > article")).toHaveLength(1);
    expect(document.querySelector("ol")?.getAttribute("role")).toBe("list");
    const article = document.querySelector("article")!;
    expect(article.querySelector(".live-blog__key-mark")?.textContent).toBe("Key update");
    // The gutter contains credits and timestamp before the headline/reporting.
    const readingOrder = [".live-blog__reporters", ".live-blog__stamp>.live-blog__metadata", "h3", ".live-blog__body", ".live-blog__permalink"]
      .map(selector => article.querySelector(selector)!);
    for (let index = 1; index < readingOrder.length; index++) {
      expect(readingOrder[index - 1].compareDocumentPosition(readingOrder[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const permalink = document.querySelector(".live-blog__permalink")!;
    expect(permalink.getAttribute("aria-label")).toContain(permalink.textContent);
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-04T03:00:00Z");
  });

  it("uses EDT before the clock change and EST in the repeated hour", () => {
    const entries = [
      update("early", { publishedAt: "2026-11-01T05:30:00Z", updatedAt: "2026-11-01T05:30:00Z" }),
      update("late", { publishedAt: "2026-11-01T06:30:00Z", updatedAt: "2026-11-01T06:30:00Z" }),
    ];
    const html = renderLiveBlog(blog({ updates: entries }), options);
    expect(html).toContain("1:30 AM EDT");
    expect(html).toContain("1:30 AM EST");
  });

  it("keeps edited entries in place and their permalink stable while showing the correction", () => {
    const entry = update("stable", { updatedAt: "2026-11-04T02:00:00Z", correction: "The earlier location was incorrect." });
    const first = renderLiveBlog(blog({ updates: [entry] }), options);
    const changed = renderLiveBlog(blog({ updates: [{ ...entry, headline: "Revised heading" }] }), options);
    expect(first).toContain('id="live-blog-12-post-example-entry-6-stable"');
    expect(changed).toContain('id="live-blog-12-post-example-entry-6-stable"');
    expect(changed).toContain("Correction:</strong> The earlier location was incorrect.");
    expect(changed).toContain("Updated <time");
  });

  it("escapes metadata, strips unsafe body links and keeps body headings below the entry", () => {
    const entry = update("safe", { headline: '<img src=x onerror="alert(1)">', correction: "<script>bad()</script>", updatedAt: "2026-11-04T02:00:00Z" });
    entry.body = { type: "doc", content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Nested heading" }] },
      { type: "paragraph", content: [{ type: "text", text: "Read <script>", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
    ] };
    document.body.innerHTML = renderLiveBlog(blog({ updates: [entry] }), options);
    expect(document.querySelector("script:not([type='application/json']), img, h1, [href^='javascript:']")).toBeNull();
    expect(document.querySelector("h4")?.textContent).toBe("Nested heading");
    expect(document.querySelector("article h3")?.textContent).toBe(entry.headline);
    expect(document.querySelector(".live-blog__correction")?.textContent).toContain(entry.correction);
  });

  it("preserves archived reporting and describes empty, paused and ended coverage", () => {
    for (const [coverageState, label] of [["paused", "Coverage paused"], ["ended", "Coverage ended"]] as const) {
      const html = renderLiveBlog(blog({ coverageState }), options);
      expect(html).toContain(label);
      expect(html).toContain("Synthetic coverage for review.");
    }
    expect(renderLiveBlog(blog({ updates: [] }), options)).toContain("No updates have been published yet.");
    expect(renderLiveBlog(blog({ updates: [], coverageState: "ended" }), options)).toContain("No updates were published.");
  });

  it("refuses future revisions and unsafe anchors rather than rendering partial snapshots", () => {
    expect(() => renderLiveBlog(blog(), { ...options, asOf: "2026-11-04T02:00:00Z" })).toThrow(/cutoff/);
    expect(() => renderLiveBlog(blog(), { ...options, asOf: "not a date" })).toThrow();
    expect(() => renderLiveBlog(blog(), { ...options, id: 'bad" id' })).toThrow();
  });

  it("renders multiple blogs without duplicate ids, executable scripts or whole-feed announcements", () => {
    document.body.innerHTML = renderLiveBlog(blog(), options) + renderLiveBlog(blog(), { ...options, id: "post-other" });
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.querySelector("script:not([type='application/json']), iframe, [aria-live='assertive'], [role='log']")).toBeNull();
    expect([...document.querySelectorAll("[aria-live]")].every(node => !node.textContent)).toBe(true);
  });

  it("keeps entry, heading and parent namespaces distinct for adversarial but valid ids", () => {
    document.body.innerHTML = renderLiveBlog(blog({ updates: [update("foo"), update("foo-heading"), update("b-update-c")] }), { ...options, id: "a" })
      + renderLiveBlog(blog({ updates: [update("c")] }), { ...options, id: "a-update-b" });
    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const article of document.querySelectorAll("article")) {
      expect(document.getElementById(article.getAttribute("aria-labelledby")!)?.closest("article")).toBe(article);
    }
  });
});
