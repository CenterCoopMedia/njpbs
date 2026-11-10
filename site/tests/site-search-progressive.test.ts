import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  keyword: vi.fn(),
  filters: vi.fn(),
  meaning: vi.fn(),
  analytics: vi.fn(),
  ready: true,
  onReady: () => {},
}));
vi.mock("/pagefind/pagefind.js", () => ({ search: mocks.keyword, filters: mocks.filters }));
vi.mock("../src/lib/analytics-consent", () => ({
  recordSiteSearch: mocks.analytics,
}));
vi.mock("../src/lib/meaning-search", () => ({
  createPageMeaningSearch: (_scope: string, _onStatus: (message: string) => void, onReady: () => void) => {
    mocks.onReady = onReady;
    return {
      get ready() {
        return mocks.ready;
      },
      search: mocks.meaning,
      dispose: vi.fn(),
    };
  },
}));
import { mountSiteSearch } from "../src/lib/site-search";
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
function mount() {
  document.body.innerHTML =
    '<section><form><input /><fieldset data-search-filters hidden><select data-search-filter="show" disabled><option value="">All programs</option></select><select data-search-filter="genre" disabled><option value="">All genres</option></select></fieldset><p data-search-filter-status></p></form><p class="search-status"></p><p data-meaning-status></p><ol></ol><button data-search-more></button><p data-search-recovery hidden></p><div data-search-fallback></div></section>';
  const root = document.querySelector("section")!;
  mountSiteSearch(root);
  return {
    root,
    input: root.querySelector("input")!,
    form: root.querySelector("form")!,
    program: root.querySelector<HTMLSelectElement>('[data-search-filter="show"]')!,
    genre: root.querySelector<HTMLSelectElement>('[data-search-filter="genre"]')!,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ready = true;
  mocks.filters.mockResolvedValue({
    show: { "News: NJ, today": 1, "Arts NJ": 1 },
    genre: { News: 1, Arts: 1 },
  });
  mocks.keyword.mockImplementation(async (term) => ({
    results: [
      {
        data: async () => ({
          url: "/keyword/",
          meta: { title: `Keyword ${term}` },
          excerpt: "Exact result",
        }),
      },
    ],
  }));
});
afterEach(() => {
  document.body.innerHTML = "";
});
describe("progressive public search", () => {
  it("shows keyword results without waiting for meaning inference and rejects stale completion", async () => {
    let resolve!: (value: unknown[]) => void;
    mocks.meaning.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { root, input, form } = mount();
    input.value = "first";
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(root.querySelector("ol")?.textContent).toContain("Keyword first");
    expect(mocks.meaning).toHaveBeenCalledWith("first");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    resolve([
      {
        id: "old",
        url: "/old/",
        title: "Old semantic result",
        text: "Outdated",
      },
    ]);
    await settle();
    expect(root.querySelector("ol")?.textContent).toBe("");
  });
  it("keeps meaning fallback when keyword lookup fails", async () => {
    mocks.keyword.mockRejectedValue(new Error("unavailable"));
    mocks.meaning.mockResolvedValue([
      {
        id: "semantic",
        url: "/related/",
        title: "Related result",
        text: "Related text",
      },
    ]);
    const { root, input, form } = mount();
    input.value = "topic";
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await settle();
    expect(root.querySelector("ol")?.textContent).toContain("Related result");
    expect(root.querySelector(".search-status")?.textContent).toContain(
      "Keyword search is unavailable",
    );
  });
  it("records a submitted zero-result keyword query once, but not live typing", async () => {
    mocks.keyword.mockResolvedValue({ results: [] });
    mocks.meaning.mockResolvedValue([]);
    const { input, form } = mount();
    input.value = "missing topic";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 230));
    expect(mocks.analytics).not.toHaveBeenCalled();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(mocks.analytics).toHaveBeenCalledOnce();
    expect(mocks.analytics).toHaveBeenCalledWith("missing topic", 0);
  });
  it("does not record a stale keyword lookup", async () => {
    let resolve!: (value: { results: unknown[] }) => void;
    mocks.keyword.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { input, form } = mount();
    input.value = "first";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    input.value = "second";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    resolve({ results: [] });
    await settle();
    expect(mocks.analytics).not.toHaveBeenCalled();
    // Cancel this case's pending typeahead before the next case starts.
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  it("records the keyword count before the meaning model becomes ready", async () => {
    mocks.keyword.mockResolvedValue({ results: [] });
    mocks.ready = false;
    const { input, form } = mount();
    input.value = "topic";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(mocks.analytics).toHaveBeenCalledOnce();
    expect(mocks.analytics).toHaveBeenCalledWith("topic", 0);
  });
  it("keeps a submitted event when the meaning model becomes ready during Pagefind", async () => {
    let resolve!: (value: { results: unknown[] }) => void;
    mocks.keyword.mockImplementation(() => new Promise((done) => { resolve = done; }));
    mocks.ready = false;
    mocks.meaning.mockResolvedValue([]);
    const { input, form } = mount();
    input.value = "topic";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    mocks.ready = true;
    mocks.onReady();
    expect(mocks.keyword).toHaveBeenCalledOnce();
    resolve({ results: [] });
    await settle();
    expect(mocks.analytics).toHaveBeenCalledOnce();
    expect(mocks.analytics).toHaveBeenCalledWith("topic", 0);
  });
  it("does not call a failed keyword search a zero-result query", async () => {
    mocks.keyword.mockRejectedValue(new Error("index unavailable"));
    mocks.meaning.mockResolvedValue([]);
    const { input, form } = mount();
    input.value = "topic";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(mocks.analytics).not.toHaveBeenCalled();
  });

  it("browses programs without search words and combines program and genre filters", async () => {
    mocks.keyword.mockImplementation(async (_term, options) => ({
      results: options?.filters?.show === "News: NJ, today" && options?.filters?.genre !== "Arts"
        ? [{ data: async () => ({ url: "/programs/news/", meta: { title: "News: NJ, today" }, excerpt: "Local reporting" }) }]
        : [],
    }));
    mocks.meaning.mockResolvedValue([{ url: "/unrelated/", title: "Unrelated", text: "Outside filter" }]);
    const { root, program, genre } = mount();
    await settle();
    expect(program.disabled).toBe(false);
    expect([...program.options].map(option => option.value)).toEqual(["", "Arts NJ", "News: NJ, today"]);
    program.value = "News: NJ, today";
    program.dispatchEvent(new Event("change"));
    await settle();
    expect(root.querySelector("ol")?.textContent).toContain("News: NJ, today");
    expect(mocks.keyword).toHaveBeenLastCalledWith(null, { filters: { show: "News: NJ, today" } });
    genre.value = "Arts";
    genre.dispatchEvent(new Event("change"));
    await settle();
    expect(root.querySelector("ol")?.textContent).toBe("");
    expect(root.querySelector(".search-status")?.textContent).toContain("No results for the selected filters");
    expect(root.querySelector<HTMLElement>("[data-meaning-status]")!.hidden).toBe(true);
  });

  it("rejects late meaning matches after a facet change and resets both filters", async () => {
    let resolveMeaning!: (value: unknown[]) => void;
    mocks.meaning.mockImplementation(() => new Promise(done => { resolveMeaning = done; }));
    const { root, input, form, program, genre } = mount();
    await settle();
    input.value = "news";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    program.value = "News: NJ, today";
    genre.value = "News";
    program.dispatchEvent(new Event("change"));
    await settle();
    resolveMeaning([{ url: "/outside/#section", title: "Outside the program", text: "Unrelated meaning hit" }]);
    await settle();
    expect(root.querySelector("ol")?.textContent).toContain("Keyword news");
    expect(root.querySelector("ol")?.textContent).not.toContain("Outside the program");
    form.dispatchEvent(new Event("reset", { cancelable: true }));
    expect([input.value, program.value, genre.value]).toEqual(["", "", ""]);
    expect(root.querySelector("ol")?.textContent).toBe("");
    expect(document.activeElement).toBe(input);
    expect(root.querySelector<HTMLElement>("[data-meaning-status]")!.hidden).toBe(false);
  });

  it("shows a filtered keyword failure without admitting unfiltered meaning results", async () => {
    mocks.keyword.mockRejectedValue(new Error("index unavailable"));
    mocks.meaning.mockResolvedValue([{ url: "/outside/", title: "Outside", text: "Unrelated" }]);
    const { root, program } = mount();
    await settle();
    program.value = "News: NJ, today";
    program.dispatchEvent(new Event("change"));
    await settle();
    expect(root.querySelector("ol")?.textContent).toBe("");
    expect(root.querySelector(".search-status")?.textContent).toContain("Search could not load");
    expect(root.querySelector<HTMLElement>("[data-search-recovery]")!.hidden).toBe(false);
  });

  it("does not record filtered submissions as unfiltered keyword gaps", async () => {
    mocks.keyword.mockResolvedValue({ results: [] });
    const { input, form, program } = mount();
    await settle();
    program.value = "Arts NJ";
    input.value = "weather";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(mocks.analytics).not.toHaveBeenCalled();
  });

  it("keeps keyword search available when filter options fail to load", async () => {
    mocks.filters.mockRejectedValue(new Error("filters unavailable"));
    mocks.meaning.mockResolvedValue([]);
    const { root, input, form } = mount();
    await settle();
    expect(root.querySelector("[data-search-filter-status]")?.textContent).toContain("Program filters could not load");
    input.value = "support";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(root.querySelector("ol")?.textContent).toContain("Keyword support");
    expect(root.querySelector<HTMLElement>("[data-search-recovery]")!.hidden).toBe(false);
  });
});
