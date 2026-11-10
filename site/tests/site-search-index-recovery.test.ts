import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("/pagefind/pagefind.js");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("offers reload when the initial Pagefind bundle import fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  vi.doMock("/pagefind/pagefind.js", () => { throw new Error("Bundle fetch failed"); });
  const { mountSiteSearch } = await import("../src/lib/site-search");
  document.body.innerHTML = `
    <section>
      <form><input /><fieldset data-search-filters hidden></fieldset><p data-search-filter-status></p></form>
      <p class="search-status"></p><p data-meaning-status></p><ol></ol>
      <button data-search-more></button><p data-search-recovery hidden><a href="/search/">Reload search</a></p><p data-search-fallback></p>
    </section>`;
  const root = document.querySelector("section")!;
  mountSiteSearch(root);
  await vi.waitFor(() => {
    expect(root.querySelector("[data-search-filter-status]")?.textContent).toContain("Program filters could not load");
  });
  expect(root.querySelector<HTMLElement>("[data-search-recovery]")!.hidden).toBe(false);
  expect(root.querySelector("[data-search-recovery] a")!.getAttribute("href")).toBe("/search/");
  root.querySelector("input")!.value = "station";
  root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => {
    expect(root.querySelector(".search-status")?.textContent).toContain("Search could not load");
  });
  expect(root.querySelector<HTMLElement>("[data-search-recovery]")!.hidden).toBe(false);
});
