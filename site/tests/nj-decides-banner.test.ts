import { afterEach, describe, expect, it, vi } from "vitest";
import { electionBannerExcluded, electionBannerWindow } from "../../packages/content-core/src/nj-decides-banner";
import { mountElectionBanner } from "../src/lib/nj-decides-banner-dom";
import { projectChrome } from "../src/lib/published-post-shadow";
import { renderNjDecidesBand } from "../../packages/content-core/src/nj-decides-render";

const start = "2026-11-03T23:00:00.000Z";
const end = "2026-11-04T04:00:00.000Z";
const scheduled = { enabled: true, njDecides: true, startsAt: start, endsAt: end };
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("election banner schedule and public context", () => {
  it("uses inclusive start and exclusive end without changing the enabled override", () => {
    expect(electionBannerWindow(scheduled, Date.parse(start) - 1)).toEqual({ visible: false, nextBoundary: Date.parse(start) });
    expect(electionBannerWindow(scheduled, Date.parse(start))).toEqual({ visible: true, nextBoundary: Date.parse(end) });
    expect(electionBannerWindow(scheduled, Date.parse(end))).toEqual({ visible: false, nextBoundary: undefined });
    for (const override of [{ enabled: false }, { njDecides: false }, { startsAt: "bad" }, { endsAt: start }]) {
      expect(electionBannerWindow({ ...scheduled, ...override }, Date.parse(start)).visible).toBe(false);
    }
    expect(electionBannerWindow({ enabled: true, njDecides: true }, Date.parse(start)).visible).toBe(true);
  });
  it("starts and ends an already-open cached page and rechecks a restored tab", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(start) - 1000);
    const element = document.createElement("aside");
    element.dataset.startsAt = start;
    element.dataset.endsAt = end;
    document.body.append(element);
    const stop = mountElectionBanner(element);
    expect(element.hidden).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(element.hidden).toBe(false);
    vi.advanceTimersByTime(Date.parse(end) - Date.parse(start));
    expect(element.hidden).toBe(true);
    vi.setSystemTime(Date.parse(start) + 1000);
    window.dispatchEvent(new Event("pageshow"));
    expect(element.hidden).toBe(false);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("carries the frozen election setting through shared Page and Post chrome", () => {
    const published = { schemaVersion: 2, sourceVersion: 2, publishedAt: "2026-10-26T17:00:00.000Z",
      values: { ...scheduled, message: "", liveLabel: "Results live", linkLabel: "Election hub", linkHref: "/election/" } };
    const content = projectChrome({ settings: [{ id: "public-homepage-banner", version: 3,
      values: { enabled: false, message: "Private working copy" }, published }], navigationPages: [] });
    expect(content.settings).toEqual([{ settingId: "public-homepage-banner", ...scheduled, message: "",
      liveLabel: "Results live", link: { label: "Election hub", href: "/election/" },
      sourceVersion: 2, publishedAt: published.publishedAt }]);
    const html = renderNjDecidesBand({ liveLabel: '<Live & "now">' });
    expect(html).toContain('&lt;Live &amp; &quot;now&quot;&gt;');
    expect(html).not.toContain('<Live');
  });
});

describe("#4362 canonical banner exclusion", () => {
  it.each(["/", "/election/", "/posts/election-guide/"])("excludes the selected canonical %s only", path => {
    expect(electionBannerExcluded([path], path)).toBe(true);
    expect(electionBannerExcluded([path], "/elsewhere/")).toBe(false);
    expect(electionBannerExcluded([path], path + "child/")).toBe(false);
    expect(electionBannerExcluded(undefined, path)).toBe(false);
  });
  it("keeps an unknown or removed path from affecting other pages or 404", () => {
    expect(electionBannerExcluded(["/removed/"], "/404/")).toBe(false);
    expect(electionBannerExcluded(["/election/"], "/election-updates/")).toBe(false);
  });
  it("carries published exclusions through the real shared renderer projection", () => {
    const content = projectChrome({ settings: [{ id: "public-homepage-banner", version: 2,
      published: { schemaVersion: 3, sourceVersion: 2, publishedAt: "2026-10-29T12:00:00.000Z",
        values: { enabled: true, njDecides: true, message: "Vote", excludedPaths: ["/", "/posts/election-guide/"] } } }], navigationPages: [] });
    expect(content.settings[0]).toMatchObject({ excludedPaths: ["/", "/posts/election-guide/"] });
  });
});

describe("two-link banner publication and output", () => {
  it.each([0, 1, 2])("projects and renders %s published links in order", count => {
    const values = { enabled: true, njDecides: true, message: "Election night",
      ...(count > 0 ? { linkLabel: "Results", linkHref: "/results/" } : {}),
      ...(count > 1 ? { secondLinkLabel: "Watch live", secondLinkHref: "https://live.njpbs.org/" } : {}),
    };
    const content = projectChrome({ settings: [{ id: "public-homepage-banner", version: 9,
      values: { ...values, secondLinkLabel: "PRIVATE", secondLinkHref: "/private/" },
      published: { schemaVersion: 4, sourceVersion: 8, publishedAt: "2026-11-03T19:00:00.000Z", values } }], navigationPages: [] });
    expect(content.settings).toEqual([{ settingId: "public-homepage-banner", enabled: true, njDecides: true, message: "Election night",
      ...(count > 0 ? { link: { label: "Results", href: "/results/" } } : {}),
      ...(count > 1 ? { secondLink: { label: "Watch live", href: "https://live.njpbs.org/" } } : {}),
      sourceVersion: 8, publishedAt: "2026-11-03T19:00:00.000Z" }]);
    const banner = content.settings[0] as { link?: { label: string; href: string }; secondLink?: { label: string; href: string } };
    document.body.innerHTML = renderNjDecidesBand({ copy: "Election night", links: banner.link ? [banner.link, ...(banner.secondLink ? [banner.secondLink] : [])] : [] });
    expect([...document.querySelectorAll("a")].map(a => [a.textContent, a.getAttribute("href")])).toEqual(
      count === 0 ? [] : count === 1 ? [["Results", "/results/"]] : [["Results", "/results/"], ["Watch live", "https://live.njpbs.org/"]]);
    expect(document.body.innerHTML).not.toContain("PRIVATE");
  });
  it("escapes labels and query separators in the second action", () => {
    document.body.innerHTML = renderNjDecidesBand({ links: [{ label: "Results", href: "/results/" }, { label: "Watch <live> & results", href: "/live/?a=1&b=2" }] });
    expect(document.querySelectorAll("a")[1].textContent).toBe("Watch <live> & results");
    expect(document.querySelectorAll("a")[1].getAttribute("href")).toBe("/live/?a=1&b=2");
    expect(document.querySelector("live")).toBeNull();
  });
});
