import { describe, expect, it } from "vitest";
import {
  coverageEntriesFromRichText,
  inspectCoverageProse,
  parseCoverageDate,
  renderCoverageList,
} from "../../packages/content-core/src/coverage-list";
import {
  COVERAGE_LIST_LIMITS,
  type RichTextDoc,
  type RichTextNode,
} from "../../packages/content-core/src/content-model";

const doc = (content: RichTextNode[]): RichTextDoc => ({ type: "doc", content });
const text = (value: string, marks?: RichTextNode["marks"]): RichTextNode => ({
  type: "text",
  text: value,
  marks,
});
const para = (...content: RichTextNode[]): RichTextNode => ({ type: "paragraph", content });
const heading = (value: string, level = 2): RichTextNode => ({
  type: "heading",
  attrs: { level },
  content: [text(value)],
});
const link = (value: string, href: string): RichTextNode =>
  text(value, [{ type: "link", attrs: { href } }]);

const villageTitle = "Maplewood’s Rob Nelson Named Anchor of New NJ PBS Daily Newscast";
const villageUrl =
  "https://villagegreennj.com/towns/maplewood/maplewoods-rob-nelson-named-anchor-of-new-nj-pbs-daily-newscast/";

describe("parseCoverageDate", () => {
  it("keeps a calendar day and reads AP and numeric dates", () => {
    expect(parseCoverageDate("2026-09-17")).toBe("2026-09-17");
    expect(parseCoverageDate("September 17, 2026")).toBe("2026-09-17");
    expect(parseCoverageDate("Sept. 17, 2026")).toBe("2026-09-17");
    expect(parseCoverageDate("9/17/2026")).toBe("2026-09-17");
    expect(parseCoverageDate("not a date")).toBe("");
  });
});

describe("coverageEntriesFromRichText", () => {
  it("reads a linked title with outlet and date on the same line", () => {
    const entries = coverageEntriesFromRichText(doc([
      heading("2026"),
      para(
        link(villageTitle, villageUrl),
        text(" — The Village Green — September 17, 2026"),
      ),
    ]));
    expect(entries).toEqual([{
      title: villageTitle,
      outlet: "The Village Green",
      date: "2026-09-17",
      url: villageUrl,
    }]);
  });

  it("reads outlet and date from the next paragraph", () => {
    const entries = coverageEntriesFromRichText(doc([
      para(link(villageTitle, villageUrl)),
      para(text("The Village Green, September 17, 2026")),
    ]));
    expect(entries).toEqual([{
      title: villageTitle,
      outlet: "The Village Green",
      date: "2026-09-17",
      url: villageUrl,
    }]);
  });

  it("keeps list order across years and reports leftover introduction text", () => {
    const inspection = inspectCoverageProse(doc([
      para(text("NJ PBS in the news.")),
      heading("2026"),
      para(link("Newer story", "https://example.com/new"), text(" — Outlet — Jan. 2, 2026")),
      heading("2025"),
      para(link("Older story", "https://example.com/old"), text(" — Outlet — Dec. 1, 2025")),
    ]));
    expect(inspection.leftover).toBe(true);
    expect(inspection.convertible).toBe(true);
    expect(inspection.overflow).toBe(false);
    expect(inspection.lostYearHeadings).toBe(false);
    expect(inspection.entries.map((entry) => entry.title)).toEqual([
      "Newer story",
      "Older story",
    ]);
  });

  it("does not treat ordinary linked sentences as coverage", () => {
    const inspection = inspectCoverageProse(doc([
      para(text("Watch "), link("NJ PBS", "https://watch.njpbs.org/"), text(" tonight.")),
    ]));
    expect(inspection.entries).toEqual([]);
    expect(inspection.leftover).toBe(true);
    expect(inspection.convertible).toBe(false);
  });

  it("does not offer conversion for a single title-only link", () => {
    const inspection = inspectCoverageProse(doc([
      para(link("About the station", "/about/")),
    ]));
    expect(inspection.entries).toEqual([{
      title: "About the station",
      outlet: "",
      date: "",
      url: "/about/",
    }]);
    expect(inspection.convertible).toBe(false);
    expect(inspection.overflow).toBe(false);
    expect(inspection.lostYearHeadings).toBe(false);
  });

  it("does not convert year headings when entries have no full calendar date", () => {
    const inspection = inspectCoverageProse(doc([
      heading("2026"),
      para(link("Newer story", "https://example.com/new"), text(" — The Village Green")),
      heading("2025"),
      para(link("Older story", "https://example.com/old"), text(" — Outlet")),
    ]));
    expect(inspection.entries).toEqual([
      {
        title: "Newer story",
        outlet: "The Village Green",
        date: "",
        url: "https://example.com/new",
      },
      {
        title: "Older story",
        outlet: "Outlet",
        date: "",
        url: "https://example.com/old",
      },
    ]);
    expect(inspection.leftover).toBe(false);
    expect(inspection.overflow).toBe(false);
    expect(inspection.lostYearHeadings).toBe(true);
    expect(inspection.convertible).toBe(false);
  });

  it("keeps conversion when year headings match stored calendar dates", () => {
    const inspection = inspectCoverageProse(doc([
      heading("2026"),
      para(link("Newer story", "https://example.com/new"), text(" — Outlet — Jan. 2, 2026")),
      heading("2025"),
      para(link("Older story", "https://example.com/old"), text(" — Outlet — Dec. 1, 2025")),
    ]));
    expect(inspection.lostYearHeadings).toBe(false);
    expect(inspection.overflow).toBe(false);
    expect(inspection.convertible).toBe(true);
    expect(inspection.entries.map((entry) => entry.date)).toEqual([
      "2026-01-02",
      "2025-12-01",
    ]);
  });

  it("does not convert when a year heading has a mix of dated and undated entries", () => {
    const inspection = inspectCoverageProse(doc([
      heading("2026"),
      para(link("Dated story", "https://example.com/dated"), text(" — Outlet — Jan. 2, 2026")),
      para(link("Undated story", "https://example.com/undated"), text(" — Outlet")),
    ]));
    expect(inspection.entries).toHaveLength(2);
    expect(inspection.lostYearHeadings).toBe(true);
    expect(inspection.convertible).toBe(false);
  });

  it("does not silently drop coverage entries beyond the stored list limit", () => {
    const nodes = Array.from({ length: COVERAGE_LIST_LIMITS.entries + 1 }, (_, index) => para(
      link(`Story ${index + 1}`, `https://example.com/${index + 1}`),
      text(" — Outlet — Jan. 2, 2026"),
    ));
    const inspection = inspectCoverageProse(doc(nodes));
    expect(inspection.entries).toHaveLength(COVERAGE_LIST_LIMITS.entries + 1);
    expect(inspection.overflow).toBe(true);
    expect(inspection.lostYearHeadings).toBe(false);
    expect(inspection.convertible).toBe(false);
    expect(coverageEntriesFromRichText(doc(nodes))).toHaveLength(
      COVERAGE_LIST_LIMITS.entries + 1,
    );
  });

  it("still converts a list that fills the stored entry limit", () => {
    const nodes = Array.from({ length: COVERAGE_LIST_LIMITS.entries }, (_, index) => para(
      link(`Story ${index + 1}`, `https://example.com/${index + 1}`),
      text(" — Outlet — Jan. 2, 2026"),
    ));
    const inspection = inspectCoverageProse(doc(nodes));
    expect(inspection.entries).toHaveLength(COVERAGE_LIST_LIMITS.entries);
    expect(inspection.overflow).toBe(false);
    expect(inspection.overLimit).toBe(false);
    expect(inspection.convertible).toBe(true);
  });

  it("does not convert when a title, outlet, or URL is over its stored length", () => {
    const longTitle = "A".repeat(COVERAGE_LIST_LIMITS.title + 1);
    const longOutlet = "B".repeat(COVERAGE_LIST_LIMITS.outlet + 1);
    const longUrl = `https://example.com/${"c".repeat(COVERAGE_LIST_LIMITS.url)}`;
    const titleInspection = inspectCoverageProse(doc([
      para(link(longTitle, "https://example.com/story"), text(" — Outlet — Jan. 2, 2026")),
    ]));
    expect(titleInspection.entries[0]?.title).toBe(longTitle);
    expect(titleInspection.overLimit).toBe(true);
    expect(titleInspection.convertible).toBe(false);

    const outletInspection = inspectCoverageProse(doc([
      para(link("Story", "https://example.com/story"), text(` — ${longOutlet} — Jan. 2, 2026`)),
    ]));
    expect(outletInspection.entries[0]?.outlet).toBe(longOutlet);
    expect(outletInspection.overLimit).toBe(true);
    expect(outletInspection.convertible).toBe(false);

    const urlInspection = inspectCoverageProse(doc([
      para(link("Story", longUrl), text(" — Outlet — Jan. 2, 2026")),
    ]));
    expect(urlInspection.entries[0]?.url).toBe(longUrl);
    expect(urlInspection.overLimit).toBe(true);
    expect(urlInspection.convertible).toBe(false);
  });
});

describe("renderCoverageList", () => {
  it("groups dated items by year and renders descriptive article cards", () => {
    const html = renderCoverageList({
      entries: [
        {
          title: villageTitle,
          outlet: "The Village Green",
          date: "2026-09-17",
          url: villageUrl,
        },
        {
          title: "Older story",
          outlet: "Outlet",
          date: "2025-12-01",
          url: "https://example.com/old",
        },
      ],
    }, 2);
    expect(html).toContain("<h2>2026</h2>");
    expect(html).toContain("<h2>2025</h2>");
    expect(html).toContain(`<a class="link-card__link" href="${villageUrl}">`);
    expect(html).toContain(`<h3 class="link-card__title">${villageTitle}</h3>`);
    expect(html).toContain('<time class="link-card__date" datetime="2026-09-17">Sept. 17, 2026</time>');
    expect(html).toContain("data-coverage-list");
    expect(html).toContain("data-coverage-controls hidden");
    expect(html).toContain("Search articles");
    expect(html).toContain("Newest first");
    expect(html).toContain("2 articles");
    expect(html).not.toContain("target=\"_blank\"");
    expect(html).toContain("The Village Green");
  });

  it("keeps the saved order when years are not consecutive", () => {
    const html = renderCoverageList({
      entries: [
        { title: "New story", outlet: "Outlet", date: "2026-02-01", url: "https://example.com/new" },
        { title: "Old story", outlet: "Outlet", date: "2025-02-01", url: "https://example.com/old" },
        { title: "Another new story", outlet: "Outlet", date: "2026-01-01", url: "https://example.com/another" },
      ],
    }, 2);

    expect(html.indexOf("New story")).toBeLessThan(html.indexOf("Old story"));
    expect(html.indexOf("Old story")).toBeLessThan(html.indexOf("Another new story"));
  });

  it("drops an unsafe link and an untitled row", () => {
    expect(renderCoverageList({
      entries: [
        { title: "", outlet: "", date: "", url: "https://example.com/x" },
        { title: "Unsafe", outlet: "", date: "", url: "javascript:alert(1)" },
      ],
    }, 2)).toBe("");
  });
});
