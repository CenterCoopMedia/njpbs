// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { renderCoverageList } from "../../packages/content-core/src/coverage-list";
import { renderLinkCardDirectory } from "../../packages/content-core/src/link-card-directory-groups";
import { setupCoverageListDirectory } from "../src/lib/coverage-list-directory";

const coverageHtml = () => renderCoverageList({
  entries: [
    {
      title: "Newest station story",
      outlet: "The Village Green",
      date: "2026-09-17",
      url: "https://example.com/newest",
    },
    {
      title: "Earlier station story",
      outlet: "Current",
      date: "2026-07-02",
      url: "https://example.com/earlier",
    },
    {
      title: "Transition story",
      outlet: "New Jersey Monitor",
      date: "2025-09-23",
      url: "https://example.com/transition",
    },
  ],
}, 2);

function root(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-coverage-list]");
  if (!element) throw new Error("Coverage fixture did not render.");
  return element;
}

function visibleTitles(element: HTMLElement): string[] {
  return [...element.querySelectorAll<HTMLElement>("[data-coverage-entry]")]
    .filter((entry) => !entry.hidden)
    .map((entry) => entry.querySelector(".link-card__title")?.textContent ?? "");
}

describe("coverage list directory", () => {
  beforeEach(() => {
    document.body.innerHTML = coverageHtml();
  });

  it("keeps every article visible until the progressive enhancement starts", () => {
    const element = root();
    expect(element.querySelector<HTMLElement>("[data-coverage-controls]")?.hidden).toBe(true);
    expect(visibleTitles(element)).toHaveLength(3);
  });

  it("keeps search active when undated link cards have no sort control", () => {
    document.body.innerHTML = renderLinkCardDirectory([
      { block: { id: "one", type: "link_card", order: 0, visible: true, data: { title: "First link", url: "/first" } }, html: "" },
      { block: { id: "two", type: "link_card", order: 1, visible: true, data: { title: "Second link", url: "/second" } }, html: "" },
    ]);
    const element = root();
    expect(element.querySelector("[data-coverage-sort]")).toBeNull();
    setupCoverageListDirectory(element);
    expect(element.querySelector<HTMLElement>("[data-coverage-controls]")?.hidden).toBe(false);
    const search = element.querySelector<HTMLInputElement>("[data-coverage-search-input]")!;
    search.value = "second";
    search.dispatchEvent(new Event("input"));
    expect(visibleTitles(element)).toEqual(["Second link"]);
  });

  it("searches titles and outlets and reports an empty result", () => {
    const element = root();
    setupCoverageListDirectory(element);
    const controls = element.querySelector<HTMLElement>("[data-coverage-controls]");
    const search = element.querySelector<HTMLInputElement>("[data-coverage-search-input]");
    const status = element.querySelector<HTMLElement>("[data-coverage-status]");
    const empty = element.querySelector<HTMLElement>("[data-coverage-empty]");
    if (!search || !status || !empty) throw new Error("Coverage controls did not render.");

    expect(controls?.hidden).toBe(false);
    search.value = "Village Green";
    search.dispatchEvent(new Event("input"));
    expect(visibleTitles(element)).toEqual(["Newest station story"]);
    expect(status.textContent).toBe("1 of 3 articles");
    expect(empty.hidden).toBe(true);

    search.value = "missing outlet";
    search.dispatchEvent(new Event("input"));
    expect(visibleTitles(element)).toEqual([]);
    expect(status.textContent).toBe("0 of 3 articles");
    expect(empty.hidden).toBe(false);
  });

  it("sorts years and article dates in either direction", () => {
    const element = root();
    setupCoverageListDirectory(element);
    const sort = element.querySelector<HTMLSelectElement>("[data-coverage-sort]");
    if (!sort) throw new Error("Coverage sort did not render.");

    expect(visibleTitles(element)).toEqual([
      "Newest station story",
      "Earlier station story",
      "Transition story",
    ]);

    sort.value = "oldest";
    sort.dispatchEvent(new Event("change"));
    expect(visibleTitles(element)).toEqual([
      "Transition story",
      "Earlier station story",
      "Newest station story",
    ]);
  });

  it("sorts repeated year runs without changing the no-JavaScript order", () => {
    document.body.innerHTML = renderCoverageList({
      entries: [
        { title: "September 2026", outlet: "A", date: "2026-09-17", url: "/a" },
        { title: "September 2025", outlet: "B", date: "2025-09-23", url: "/b" },
        { title: "June 2026", outlet: "C", date: "2026-06-01", url: "/c" },
        { title: "December 2026", outlet: "D", date: "2026-12-01", url: "/d" },
      ],
    }, 2);
    const element = root();
    expect(visibleTitles(element)).toEqual([
      "September 2026",
      "September 2025",
      "June 2026",
      "December 2026",
    ]);

    setupCoverageListDirectory(element);
    expect(visibleTitles(element)).toEqual([
      "December 2026",
      "September 2026",
      "June 2026",
      "September 2025",
    ]);

    const sort = element.querySelector<HTMLSelectElement>("[data-coverage-sort]");
    if (!sort) throw new Error("Coverage sort did not render.");
    sort.value = "oldest";
    sort.dispatchEvent(new Event("change"));
    expect(visibleTitles(element)).toEqual([
      "September 2025",
      "June 2026",
      "September 2026",
      "December 2026",
    ]);
  });
});
