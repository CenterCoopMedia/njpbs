import { afterEach, describe, expect, it } from "vitest";
import { renderLiveBlog } from "../../packages/content-core/src/live-blog-render";
import type { LiveBlogData } from "../../packages/content-core/src/live-blog";
import { installLiveBlogPagination } from "../src/lib/live-blog-pagination";
import { LIVE_BLOG_SPECIMEN } from "./fixtures/live-blog";

function mount(size = 53) {
  const value: LiveBlogData = { ...structuredClone(LIVE_BLOG_SPECIMEN), updates: Array.from({ length: size }, (_, index) => ({
    ...structuredClone(LIVE_BLOG_SPECIMEN.updates[0]), id: `entry-${String(index).padStart(3, "0")}`, headline: `Report ${index + 1}`, keyUpdate: index === 40,
    publishedAt: LIVE_BLOG_SPECIMEN.updatedAt, updatedAt: LIVE_BLOG_SPECIMEN.updatedAt, correction: undefined,
  })) };
  document.body.innerHTML = renderLiveBlog(value, { id: "coverage", asOf: value.updatedAt });
  const root = document.querySelector<HTMLElement>("[data-live-blog]")!;
  const entries = Array.from(root.querySelectorAll<HTMLLIElement>(".live-blog__updates > li"));
  return { root, entries, shown: () => entries.filter(entry => !entry.hidden).length };
}
afterEach(() => { document.body.innerHTML = ""; history.replaceState({}, "", location.pathname); });
describe("paging the immutable live-blog archive", () => {
  it("keeps the full no-script archive and reveals older batches with useful focus", () => {
    const { root, entries, shown } = mount();
    expect(shown()).toBe(53); expect(root.querySelector("[aria-live]")?.textContent).toBe("");
    installLiveBlogPagination(root);
    expect(shown()).toBe(20);
    const older = root.querySelector<HTMLButtonElement>("[data-live-blog-older]")!;
    older.focus(); older.click();
    expect(shown()).toBe(40); expect(document.activeElement).toBe(entries[20].querySelector("article"));
    expect(root.querySelector("[data-live-blog-count]")?.textContent).toBe("20 older updates shown. Showing 40 of 53 updates.");
    older.click(); expect(shown()).toBe(53); expect(older.hidden).toBe(true);
    expect(document.activeElement).toBe(entries[40].querySelector("article"));
    expect(root.querySelector("[data-live-blog-count]")?.textContent).toContain("13 older updates shown.");
  });
  it("reveals a key update before native fragment navigation and preserves its stable link", () => {
    const { root, entries, shown } = mount(); installLiveBlogPagination(root);
    const link = root.querySelector<HTMLAnchorElement>(".live-blog__keys a")!;
    const destination = link.getAttribute("href"); link.click();
    expect(shown()).toBe(53); expect(entries[40].hidden).toBe(false);
    expect(destination).toBe(`#${entries[40].querySelector("article")!.id}`);
  });
  it("includes an incoming older-entry permalink in the initial page", () => {
    const mounted = mount(); const target = mounted.entries[40].querySelector("article")!;
    history.replaceState({}, "", `#${target.id}`); installLiveBlogPagination(mounted.root);
    expect(mounted.entries[40].hidden).toBe(false); expect(mounted.shown()).toBe(53);
  });
  it("leaves a short or empty archive alone", () => {
    for (const size of [0, 1, 20]) {
      const { root, shown } = mount(size); installLiveBlogPagination(root);
      expect(shown()).toBe(size); expect(root.querySelector<HTMLElement>("[data-live-blog-pagination]")!.hidden).toBe(true);
    }
  });
});
