import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";
import { liveBlogFeed, liveBlogManifest, parseLiveBlogManifest } from "../../packages/content-core/src/live-blog-manifest";
import type { LiveBlogData } from "../../packages/content-core/src/live-blog";
import { installLiveBlogUpdates } from "../src/lib/live-blog-updates";
import { installLiveBlogInteractions } from "../../packages/content-core/src/live-blog-interactions";
import { LIVE_BLOG_SPECIMEN } from "./fixtures/live-blog";

function blog(size: number): LiveBlogData {
  const updates = Array.from({ length: size }, (_, index) => {
    const stamp = new Date(Date.parse("2026-11-04T03:00:00.000Z") + index * 1000).toISOString();
    return { ...structuredClone(LIVE_BLOG_SPECIMEN.updates[0]), id: `report-${index}`, headline: `Report ${index + 1}`,
      keyUpdate: false, correction: undefined, withdrawal: undefined, publishedAt: stamp, updatedAt: stamp };
  });
  return { schemaVersion: 1, coverageState: "ongoing", updatedAt: "2026-11-04T04:00:00.000Z", updates };
}
const html = (value: LiveBlogData, preview = false) => renderLiveBlog(value, { id: "coverage", asOf: value.updatedAt, preview });
function mount(size = 25, value = blog(size), chrome = "") {
  document.body.innerHTML = chrome + html(value);
  const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
  const loaded = vi.fn(); installLiveBlogUpdates(root, loaded);
  return { root, loaded, button: root.querySelector<HTMLButtonElement>("[data-live-blog-load]")!,
    visible: () => root.querySelectorAll(".live-blog__updates > li:not([hidden])").length };
}
beforeEach(() => { vi.useFakeTimers(); history.replaceState({}, "", "/posts/coverage/"); vi.spyOn(document, "hidden", "get").mockReturnValue(false); });
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ""; });
describe("explicit live blog updates", () => {
  it.each(["added", "withdrawn"])("synchronizes reporter counts on reused cards when an update is %s", async change => {
    const initial = blog(2), authorId = `au_${"a".repeat(32)}`;
    for (const parent of initial.updates) {
      parent.credits = [{ kind: "registered", authorId, displayName: "Reporter" }];
      parent.followUps = [{ id: "reply", body: parent.body, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt }];
    }
    const next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z";
    if (change === "added") next.updates.push({ ...next.updates[0], id: "newest", publishedAt: next.updatedAt, updatedAt: next.updatedAt, followUps: undefined });
    else {
      Object.assign(next.updates[0], { headline: "Update withdrawn", body: { type: "doc", content: [] }, withdrawal: "Unverified.", updatedAt: next.updatedAt });
      delete next.updates[0].followUps;
    }
    const render = (value: LiveBlogData) => renderLiveBlog(value, { id: "coverage", asOf: value.updatedAt,
      reporters: [{ authorId, displayName: "Reporter", path: "/authors/reporter/" }] });
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(render(next), { headers: { "content-type": "text/html" } }));
    document.body.innerHTML = render(initial);
    const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
    installLiveBlogInteractions(root); installLiveBlogUpdates(root);
    const reused = root.querySelector<HTMLElement>('[data-live-blog-entry="report-1"]')!;
    const card = reused.querySelector<HTMLElement>(".live-blog__reporter-card")!;
    const trigger = reused.querySelector<HTMLButtonElement>(".live-blog__reporter-trigger")!;
    trigger.click();
    expect(card.querySelector(".live-blog__card-count")?.textContent).toBe("2 updates in this live blog");
    await vi.advanceTimersByTimeAsync(30_000);
    if (change === "added") { root.querySelector<HTMLButtonElement>("[data-live-blog-load]")!.click(); await vi.advanceTimersByTimeAsync(0); }
    expect(root.querySelector('[data-live-blog-entry="report-1"]')).toBe(reused);
    expect(reused.querySelector(".live-blog__reporter-card")).toBe(card);
    expect(card.hidden).toBe(false);
    expect(root.querySelectorAll(".live-blog__card-count").length).toBeGreaterThan(1);
    for (const count of root.querySelectorAll(".live-blog__card-count")) expect(count.textContent).toBe(change === "added" ? "3 updates in this live blog" : "1 update in this live blog");
  });
  it("preserves an unchanged enhanced thread and announces the older parent that actually changed", async () => {
    const initial = blog(2);
    for (const parent of initial.updates) parent.followUps = [{ id: "reply", body: parent.body, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt }];
    const next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z";
    const changed = next.updates[0]; changed.updatedAt = next.updatedAt;
    changed.followUps!.push({ ...changed.followUps![0], id: "added-reply", publishedAt: next.updatedAt, updatedAt: next.updatedAt });
    const render = (value: LiveBlogData) => renderLiveBlog(value, { id: "coverage", asOf: value.updatedAt, canonicalUrl: "https://njpbs.org/posts/coverage/" });
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(render(next), { headers: { "content-type": "text/html" } }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } });
    document.body.innerHTML = render(initial);
    const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
    installLiveBlogInteractions(root); installLiveBlogUpdates(root);
    const newer = root.querySelector<HTMLElement>('[data-live-blog-entry="report-1"]')!;
    const unchangedThread = newer.querySelector<HTMLElement>(".live-blog-follow-ups")!;
    unchangedThread.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle")!.click();
    unchangedThread.querySelector<HTMLButtonElement>(".live-blog-follow-up .live-blog__copy-button")!.click();
    await vi.advanceTimersByTimeAsync(0);
    const input = unchangedThread.querySelector<HTMLInputElement>(".live-blog-follow-up input")!;
    expect(document.activeElement).toBe(input);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(newer.querySelector(".live-blog-follow-ups")).toBe(unchangedThread);
    expect(document.activeElement).toBe(input);
    expect(input.closest<HTMLElement>("label")?.hidden).toBe(false);
    expect(root.querySelectorAll('[data-live-blog-entry="report-0"] .live-blog-follow-up')).toHaveLength(2);
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("New follow-up on Report 1");
  });
  it("inserts the first thread in its content slot and preserves an enhanced copy control's focus", async () => {
    const initial = blog(1), next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z";
    next.updates[0].updatedAt = next.updatedAt;
    next.updates[0].followUps = [{ id: "first-reply", body: next.updates[0].body, credits: next.updates[0].credits, publishedAt: next.updatedAt, updatedAt: next.updatedAt }];
    const render = (value: LiveBlogData) => renderLiveBlog(value, { id: "coverage", asOf: value.updatedAt, canonicalUrl: "https://njpbs.org/posts/coverage/" });
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(render(next), { headers: { "content-type": "text/html" } }));
    document.body.innerHTML = render(initial);
    const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
    installLiveBlogInteractions(root); installLiveBlogUpdates(root);
    const copy = root.querySelector<HTMLButtonElement>(".live-blog__copy-button")!; copy.focus();
    await vi.advanceTimersByTimeAsync(30_000);
    const slot = root.querySelector(".live-blog__content>.live-blog-follow-ups")!;
    expect(slot.querySelectorAll(".live-blog-follow-up")).toHaveLength(1);
    expect(slot.querySelector(".live-blog__footer>.live-blog__copy-control")).not.toBeNull();
    expect(root.querySelectorAll(".live-blog__content")).toHaveLength(1);
    expect(document.activeElement?.id).toBe(copy.id);
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("New follow-up on Report 1");
  });
  it("refreshes follow-ups on an old parent without counting updates or closing an open thread", async () => {
    const initial = blog(120), next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z";
    const parent = initial.updates[0];
    const followUp = { id: "follow-a", body: { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text: "Initial follow-up" }] }] },
      credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt };
    parent.followUps = [followUp]; next.updates[0].followUps = [structuredClone(followUp), { ...structuredClone(followUp), id: "follow-b", publishedAt: next.updatedAt, updatedAt: next.updatedAt }];
    next.updates[0].updatedAt = next.updatedAt;
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const scroll = vi.spyOn(window, "scrollBy");
    const { root, button } = mount(120, initial);
    const toggle = root.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle")!; toggle.click(); toggle.focus();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(".live-blog-follow-ups__toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelectorAll(".live-blog-follow-up")).toHaveLength(2);
    expect(root.querySelector<HTMLElement>(".live-blog-follow-ups__list")!.hidden).toBe(false);
    expect(document.activeElement).toBe(root.querySelector(".live-blog-follow-ups__toggle"));
    expect(button.hidden).toBe(true); expect(scroll).not.toHaveBeenCalled();
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("New follow-up on Report 1");
    expect(root.querySelectorAll(".live-blog__updates > li")).toHaveLength(120);
    expect(() => parseLiveBlogManifest(JSON.parse(root.querySelector("[data-live-blog-manifest]")!.textContent!))).not.toThrow();
  });
  it("retries a final follow-up revision when its first HTML read fails", async () => {
    const initial = blog(1), next = structuredClone(initial);
    next.coverageState = "ended";
    next.updates[0].updatedAt = next.updatedAt;
    next.updates[0].followUps = [{ id: "final-follow", body: initial.updates[0].body, credits: initial.updates[0].credits, publishedAt: next.updatedAt, updatedAt: next.updatedAt }];
    const feed = liveBlogFeed(liveBlogManifest("coverage", next));
    const fetch = vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(feed)).mockRejectedValueOnce(new Error("temporary HTML failure"))
      .mockResolvedValueOnce(Response.json(feed)).mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root } = mount(1, initial);
    await vi.advanceTimersByTimeAsync(30_000); expect(root.querySelectorAll(".live-blog-follow-up")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000); expect(root.querySelectorAll(".live-blog-follow-up")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(300_000); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("anchors a visible follow-up when earlier reporting in the same thread changes height", async () => {
    const initial = blog(1), parent = initial.updates[0];
    const reply = { id: "follow-a", body: parent.body, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt };
    parent.followUps = [reply, { ...reply, id: "follow-b" }];
    const next = structuredClone(initial); next.updates[0].updatedAt = next.updatedAt;
    Object.assign(next.updates[0].followUps![0], { body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Expanded reporting" }] }] }, correction: "Expanded the detail.", updatedAt: next.updatedAt });
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const scroll = vi.spyOn(window, "scrollBy");
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      const top = this.id.endsWith("follow-up-follow-b") ? (document.body.textContent?.includes("Expanded reporting") ? 160 : 120) : -300;
      return { top, bottom: top + 100 } as DOMRect;
    });
    const { root } = mount(1, initial); root.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle")!.click();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(scroll).toHaveBeenCalledWith(0, 40);
  });
  it("removes reporting, key links and the thread when a parent is withdrawn, without a new-update count", async () => {
    const initial = blog(1), parent = initial.updates[0]; parent.keyUpdate = true;
    parent.followUps = [{ id: "follow", body: parent.body, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt }];
    const next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z";
    Object.assign(next.updates[0], { headline: "Update withdrawn", keyUpdate: false, body: { type: "doc", content: [] }, withdrawal: "Unverified reporting.", updatedAt: next.updatedAt });
    delete next.updates[0].followUps;
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(1, initial); await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector(".live-blog-follow-ups")).toBeNull();
    expect(root.querySelector("h3")?.textContent).toBe("Update withdrawn");
    expect(root.textContent).toContain("Unverified reporting."); expect(button.hidden).toBe(true);
    expect(root.querySelector(".live-blog__keys")).toBeNull(); expect(root.textContent).not.toContain("Report 1");
  });
  it("refreshes entry HTML and root appearance on settings alone while keeping its open thread", async () => {
    const initial = blog(1), parent = initial.updates[0];
    parent.followUps = [{ id: "follow", body: parent.body, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt }];
    const next = structuredClone(initial); next.presentation = { reporterPhotos: false, reporterCards: false, playful: true }; next.updatedAt = "2026-11-04T05:00:00.000Z";
    const updatedHtml = html(next).replace('class="live-blog" data-live-blog ', 'class="live-blog" data-live-blog data-live-blog-reporter-photos="false" data-live-blog-reporter-cards="false" data-live-blog-playful="true" ');
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(updatedHtml, { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(1, initial); const old = root.querySelector("[data-live-blog-entry]");
    const toggle = root.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle")!; toggle.click(); toggle.focus();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector("[data-live-blog-entry]")).not.toBe(old);
    expect(root.querySelector("[data-live-blog-entry] noscript")).toBeNull();
    expect(root.dataset.liveBlogReporterPhotos).toBe("false"); expect(root.dataset.liveBlogReporterCards).toBe("false"); expect(root.dataset.liveBlogPlayful).toBe("true");
    expect(root.querySelector(".live-blog-follow-ups__toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(root.querySelector(".live-blog-follow-ups__toggle")); expect(button.hidden).toBe(true);
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("Live blog appearance updated.");
  });
  it("focuses the stable follow-up when a revision removes its focused reporting link", async () => {
    const initial = blog(1), parent = initial.updates[0];
    parent.followUps = [{ id: "follow", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Source", marks: [{ type: "link", attrs: { href: "/old-source/" } }] }] }] }, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt }];
    const next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z"; next.updates[0].updatedAt = next.updatedAt;
    Object.assign(next.updates[0].followUps![0], { body: { type: "doc", content: [] }, withdrawal: "Could not verify the source.", updatedAt: next.updatedAt });
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root } = mount(1, initial); root.querySelector<HTMLButtonElement>(".live-blog-follow-ups__toggle")!.click();
    root.querySelector<HTMLAnchorElement>('.live-blog-follow-up__body a')!.focus();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.activeElement).toBe(root.querySelector(".live-blog-follow-up"));
    expect(root.querySelector('.live-blog-follow-up__body a')).toBeNull();
  });
  it("does not import no-script fallback styles when explicitly loading updated entries", async () => {
    const initial = blog(1), next = blog(2), parent = next.updates[0];
    parent.updatedAt = next.updatedAt;
    parent.followUps = [{ id: "follow", body: parent.body, credits: parent.credits, publishedAt: parent.publishedAt, updatedAt: parent.updatedAt }];
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(1, initial); await vi.advanceTimersByTimeAsync(30_000);
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelectorAll(".live-blog-follow-up")).toHaveLength(1);
    expect(root.querySelector("noscript style")).toBeNull();
  });
  it("announces a new follow-up when appearance changes in the same revision", async () => {
    const initial = blog(1), next = structuredClone(initial); next.updatedAt = "2026-11-04T05:00:00.000Z"; next.presentation = { playful: true };
    const parent = next.updates[0]; parent.updatedAt = next.updatedAt;
    parent.followUps = [{ id: "follow", body: parent.body, credits: parent.credits, publishedAt: next.updatedAt, updatedAt: next.updatedAt }];
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(1, initial); await vi.advanceTimersByTimeAsync(30_000);
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("New follow-up on Report 1");
    expect(button.hidden).toBe(true);
  });
  it("keeps one control below the header while reading older entries and yields to its menu", async () => {
    let listTop = 500, headerBottom = 90;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      return { top: this.classList.contains("live-blog__updates") ? listTop : 0, bottom: this.classList.contains("site-head") ? headerBottom : 0 } as DOMRect;
    });
    vi.spyOn(window, "fetch").mockResolvedValue(Response.json(liveBlogManifest("coverage", blog(28))));
    const { root, button } = mount(25, blog(25), '<header class="site-head"><button class="nav-toggle" aria-expanded="false">Menu</button></header>');
    const controls = root.querySelector<HTMLElement>("[data-live-blog-refresh]")!;
    const link = root.querySelector<HTMLAnchorElement>(".live-blog__permalink")!; link.focus();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controls.hasAttribute("data-sticky")).toBe(false);
    listTop = -400; window.dispatchEvent(new Event("scroll"));
    expect(controls.hasAttribute("data-sticky")).toBe(true); expect(root.style.getPropertyValue("--live-blog-header-bottom")).toBe("90px");
    expect(document.activeElement).toBe(link);
    document.querySelector(".nav-toggle")!.setAttribute("aria-expanded", "true"); await vi.advanceTimersByTimeAsync(0);
    expect(controls.hasAttribute("data-menu-open")).toBe(true);
    headerBottom = 120; window.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--live-blog-header-bottom")).toBe("120px");
    listTop = 500; window.dispatchEvent(new Event("scroll")); expect(controls.hasAttribute("data-sticky")).toBe(false);
    expect(root.querySelectorAll("[data-live-blog-load]")).toHaveLength(1);
    expect(root.querySelectorAll("[data-live-blog-announcement]")).toHaveLength(1);
    expect(button.textContent).toBe("3 new updates");
  });
  it("clears a header taller than the default article margin after loading", async () => {
    const next = blog(26);
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", next)))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
      return { top: 140, bottom: this.classList.contains("site-head") ? 220 : 170 } as DOMRect;
    });
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { root, button } = mount(25, blog(25), '<header class="site-head"></header>');
    await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(scroll).toHaveBeenCalledOnce();
    expect(root.style.getPropertyValue("--live-blog-header-bottom")).toBe("220px");
    expect(document.activeElement?.getAttribute("data-live-blog-entry")).toBe("report-25");
  });
  it("scrolls a clipped focused heading into view, but leaves a fully visible reading start in place", async () => {
    for (const clipped of [false, true]) {
      const next = blog(26);
      const fetch = vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", next)))
        .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
        return { top: 140, bottom: this.tagName === "H3" && clipped ? window.innerHeight + 15 : 170 } as DOMRect;
      });
      const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
      const { button } = mount(); await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
      expect(scroll).toHaveBeenCalledTimes(clipped ? 1 : 0);
      rect.mockRestore(); scroll.mockRestore(); fetch.mockRestore();
      window.dispatchEvent(new Event("pagehide")); document.body.innerHTML = "";
    }
  });
  it.each([false, true])("refreshes election branding from an initially branded=%s snapshot", async branded => {
    const initial = blog(25), next = blog(26);
    if (branded) initial.branding = "nj-decides-2026"; else next.branding = "nj-decides-2026";
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(25, initial);
    await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
    if (branded) expect(root.querySelector("[data-live-blog-branding]")).toBeNull();
    else expect(root.firstElementChild?.hasAttribute("data-live-blog-branding")).toBe(true);
  });
  it("counts and loads new entries when a 120-entry archive has a bounded feed", async () => {
    const next = blog(123);
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogFeed(liveBlogManifest("coverage", next))))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button, visible } = mount(120);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(button.textContent).toBe("3 new updates");
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(visible()).toBe(23); expect(root.querySelectorAll(".live-blog__updates > li")).toHaveLength(123);
    expect(document.activeElement?.getAttribute("data-live-blog-entry")).toBe("report-122");
  });
  it("polls only small metadata, then uses one HTML read and focuses the newest loaded article", async () => {
    const next = blog(28);
    const fetch = vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", next)))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button, visible, loaded } = mount();
    const unchanged = root.querySelector("article")!;
    const link = root.querySelector<HTMLAnchorElement>(".live-blog__permalink")!; link.focus();
    expect(visible()).toBe(20); expect(button.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][0]).toBe("http://localhost:3000/posts/coverage/?live-blog=updates");
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
    expect(root.querySelectorAll(".live-blog__updates > li")).toHaveLength(25);
    expect(document.activeElement).toBe(link); expect(button.textContent).toBe("3 new updates");
    expect(button.getAttribute("aria-label")).toBe("Load 3 new updates");
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("3 new updates available.");
    button.focus(); button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2); expect(new URL(String(fetch.mock.calls[1][0])).search).toBe("");
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: "same-origin", redirect: "error" });
    expect(visible()).toBe(23); expect(root.querySelectorAll(".live-blog__updates > li")).toHaveLength(28);
    expect(root.contains(unchanged)).toBe(true);
    expect(document.activeElement?.getAttribute("data-live-blog-entry")).toBe("report-27");
    expect(button.hidden).toBe(true); expect(loaded).toHaveBeenCalledOnce();
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("3 new updates loaded.");
    expect(root.querySelector("[data-live-blog-count]")?.getAttribute("aria-live")).toBe("off");
  });
  it("uses singular names, leaves failed loads retryable, and never mutates reporting on a failed read", async () => {
    const fetch = vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", blog(26))))
      .mockRejectedValueOnce(new Error("offline"));
    const { root, button } = mount(); await vi.advanceTimersByTimeAsync(30_000);
    expect(button.textContent).toBe("1 new update"); expect(button.getAttribute("aria-label")).toBe("Load 1 new update");
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2); expect(button.hidden).toBe(false); expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(root.querySelectorAll(".live-blog__updates > li")).toHaveLength(25);
    expect(root.querySelector("[data-live-blog-announcement]")?.textContent).toBe("Updates could not be loaded. Try again.");
  });
  it("pauses in a hidden tab and resumes on the normal interval", async () => {
    const fetch = vi.spyOn(window, "fetch").mockResolvedValue(Response.json(liveBlogManifest("coverage", blog(25))));
    mount(); vi.mocked(Object.getOwnPropertyDescriptor(document, "hidden")!.get!).mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(90_000); expect(fetch).not.toHaveBeenCalled();
    vi.mocked(Object.getOwnPropertyDescriptor(document, "hidden")!.get!).mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(30_000); expect(fetch).toHaveBeenCalledOnce();
  });
  it("backs off after errors and installs only once", async () => {
    const fetch = vi.spyOn(window, "fetch").mockRejectedValue(new Error("offline"));
    const { root } = mount(); installLiveBlogUpdates(root);
    await vi.advanceTimersByTimeAsync(30_000); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("can load the first entries into an empty blog and stop after loading ended coverage", async () => {
    const next = { ...blog(3), coverageState: "ended" as const };
    const fetch = vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", next)))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button, visible } = mount(0);
    await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(visible()).toBe(3); expect(root.querySelector("[data-live-blog-empty]")).toBeNull();
    expect(root.querySelector(".live-blog__state")?.textContent).toBe("Coverage ended");
    await vi.advanceTimersByTimeAsync(300_000); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("applies corrections without replacing unchanged entries or resetting expanded paging", async () => {
    const next = blog(28); next.updates[24].headline = "Corrected report"; next.updates[24].correction = "Corrected the description.";
    next.updates[24].updatedAt = next.updatedAt;
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", next)))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button, visible } = mount();
    root.querySelector<HTMLButtonElement>("[data-live-blog-older]")!.click(); expect(visible()).toBe(25);
    const retained = root.querySelector('[data-live-blog-entry="report-23"]');
    await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(visible()).toBe(28); expect(root.contains(retained)).toBe(true);
    expect(root.querySelector('[data-live-blog-entry="report-24"] h3')?.textContent).toBe("Corrected report");
  });
  it("refuses an older HTML response without losing the pending control or existing reporting", async () => {
    const fetch = vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", blog(28))))
      .mockResolvedValueOnce(new Response(html(blog(26)), { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(); await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2); expect(root.querySelectorAll(".live-blog__updates > li")).toHaveLength(25); expect(button.hidden).toBe(false);
  });
  it("keeps the focused pending control when an edge returns older metadata", async () => {
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", blog(28))))
      .mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", blog(25))));
    const { button } = mount(); await vi.advanceTimersByTimeAsync(30_000); button.focus();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(button.hidden).toBe(false); expect(button.textContent).toBe("3 new updates"); expect(document.activeElement).toBe(button);
  });
  it("does not poll ended coverage or private previews", async () => {
    const fetch = vi.spyOn(window, "fetch"); mount(25, { ...blog(25), coverageState: "ended" });
    document.body.innerHTML = html(blog(25), true); installLiveBlogUpdates(document.querySelector("[data-live-blog]")!);
    await vi.advanceTimersByTimeAsync(60_000); expect(fetch).not.toHaveBeenCalled();
  });
  it("resumes visible polling after a Back/Forward cache restoration", async () => {
    const fetch = vi.spyOn(window, "fetch").mockResolvedValue(Response.json(liveBlogManifest("coverage", blog(25))));
    mount(); window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(60_000); expect(fetch).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pageshow")); await vi.advanceTimersByTimeAsync(30_000); expect(fetch).toHaveBeenCalledOnce();
  });
  it("stops checking when coverage ends without another entry, including after cached-page return", async () => {
    const fetch = vi.spyOn(window, "fetch").mockResolvedValue(Response.json(liveBlogManifest("coverage", { ...blog(25), coverageState: "ended" })));
    mount(); await vi.advanceTimersByTimeAsync(30_000);
    window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(1_800_000); expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps new key links and the archive label in fresh-render order", async () => {
    const next = blog(26); next.updates[25].keyUpdate = true;
    vi.spyOn(window, "fetch").mockResolvedValueOnce(Response.json(liveBlogManifest("coverage", next)))
      .mockResolvedValueOnce(new Response(html(next), { headers: { "content-type": "text/html" } }));
    const { root, button } = mount(); await vi.advanceTimersByTimeAsync(30_000); button.click(); await vi.advanceTimersByTimeAsync(0);
    const nav = root.querySelector(".live-blog__keys")!;
    expect(nav.nextElementSibling?.hasAttribute("data-live-blog-order")).toBe(true);
    expect(nav.nextElementSibling?.nextElementSibling?.className).toBe("live-blog__updates");
  });
});
