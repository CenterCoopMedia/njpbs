import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installElectionResults } from "../../packages/content-core/src/election-results-dom";
import { renderElectionResults } from "../../packages/content-core/src/election-results-render";
import hub from "./fixtures/election-results-hub.json";
import type { ElectionResultsData } from "../../packages/content-core/src/election-results";

const original = () => renderElectionResults(hub.id, hub.data as ElectionResultsData);
function changed() {
  const data = structuredClone(hub.data) as ElectionResultsData;
  data.races[0].asOf = "2026-11-04T02:15:00Z";
  return renderElectionResults(hub.id, data);
}
const reply = (html: string) => new Response(`<!doctype html><html><body>${html}</body></html>`, {
  headers: { "content-type": "text/html; charset=utf-8" },
});
function called() {
  const data = structuredClone(hub.data) as ElectionResultsData;
  const race = data.races[0];
  race.status = "called";
  race.calledCandidateId = race.candidates[0].id;
  race.apCallUrl = "https://apnews.com/hub/election-2026";
  race.candidates = race.candidates.map((candidate, index) => ({ ...candidate, votes: index === 0 ? 100 : 0, share: index === 0 ? 100 : 0 }));
  return renderElectionResults(hub.id, data);
}
let stop: (() => void) | undefined;
let fetchPage = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-04T02:16:00Z"));
  vi.stubGlobal("fetch", fetchPage = vi.fn().mockImplementation(async () => reply(original())));
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  document.body.innerHTML = `<p id="outside">Outside the block</p>${original()}`;
});
afterEach(() => { stop?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const tick = (ms = 60_000) => vi.advanceTimersByTimeAsync(ms);
function hidden(value: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("Published election result refresh", () => {
  it("keeps all results and native jump links available before JavaScript enables filters", () => {
    expect(document.querySelector<HTMLElement>("[data-election-filters]")?.hidden).toBe(true);
    expect(document.querySelectorAll("[data-election-race]:not([hidden])")).toHaveLength(13);
    expect(document.querySelectorAll("[data-election-jump]")).toHaveLength(13);
  });
  it("does no polling on pages without results", async () => {
    document.body.innerHTML = "No results";
    stop = installElectionResults(window);
    await tick(180_000);
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it("fetches only published same-origin HTML once per minute and leaves identical content intact", async () => {
    stop = installElectionResults(window);
    const content = document.querySelector("[data-election-results-content]")!;
    const race = content.firstElementChild;
    await tick(59_999);
    expect(fetchPage).not.toHaveBeenCalled();
    await tick(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    const [url, options] = fetchPage.mock.calls[0];
    expect(new URL(url).origin).toBe(window.location.origin);
    expect(new URL(url).search).toBe("");
    expect(options).toMatchObject({ credentials: "omit", cache: "no-cache", mode: "same-origin", redirect: "error" });
    expect(content.firstElementChild).toBe(race);
    expect(document.querySelector("[role=status]")?.textContent).toBe("");
  });
  it("replaces only results, keeps open tables and focus, and announces the station time once", async () => {
    fetchPage.mockImplementation(async () => reply(changed()));
    stop = installElectionResults(window);
    const outside = document.getElementById("outside");
    const summary = document.querySelector<HTMLElement>(".election-results__details summary")!;
    summary.parentElement!.setAttribute("open", "");
    summary.focus();
    await tick();
    expect(document.getElementById("outside")).toBe(outside);
    expect(document.activeElement).toBe(document.querySelector(".election-results__details summary"));
    expect(document.querySelector<HTMLDetailsElement>("details.election-results__details")?.open).toBe(true);
    expect(document.querySelector("[role=status]")?.textContent).toBe("Results updated 9:17 PM ET");
    const race = document.querySelector("[data-election-race]");
    await tick();
    expect(document.querySelector("[data-election-race]")).toBe(race);
  });
  it("pauses in hidden tabs and cannot create a burst through visibility changes", async () => {
    stop = installElectionResults(window);
    hidden(true);
    await tick(180_000);
    expect(fetchPage).not.toHaveBeenCalled();
    hidden(false);
    for (let i = 0; i < 5; i++) { hidden(true); hidden(false); }
    await tick(1_000);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    hidden(true); hidden(false);
    await tick(59_000);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
  it("backs off failures, retains the last results and resumes the minute interval after recovery", async () => {
    fetchPage.mockRejectedValueOnce(new Error("Network failure")).mockRejectedValueOnce(new Error("Network failure"));
    stop = installElectionResults(window);
    await tick();
    await tick(119_999);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await tick(240_000);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    await tick();
    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(document.querySelectorAll("[data-election-race]")).toHaveLength(13);
  });
  it.each(["x-njpbs-publication-refresh", "publication-refresh"])("rejects fallback responses marked by %s and missing result blocks", async header => {
    fetchPage.mockResolvedValueOnce(new Response(original(), { headers: {
      "content-type": "text/html", [header]: "pending",
    } })).mockResolvedValueOnce(reply("Sign in"));
    stop = installElectionResults(window);
    const first = document.querySelector("[data-election-race]");
    await tick();
    await tick(120_000);
    expect(document.querySelector("[data-election-race]")).toBe(first);
    expect(document.querySelector("[role=status]")?.textContent).toBe("");
  });
  it("aborts an outstanding request when hidden and never overlaps requests", async () => {
    fetchPage.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    stop = installElectionResults(window);
    await tick();
    hidden(true);
    expect(fetchPage.mock.calls[0][1].signal.aborted).toBe(true);
    await tick(300_000);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it("filters by office, district or candidate and hides matching jump links with a readable empty state", () => {
    stop = installElectionResults(window);
    const search = document.querySelector<HTMLInputElement>("[data-election-search-input]")!;
    const count = document.querySelector("[data-election-filter-count]")!;
    for (const query of ["U.S. Senate", "District 2", "  cory BOOKER "]) {
      search.value = query;
      search.dispatchEvent(new Event("input"));
      expect(count.textContent).toBe("1 of 13 races");
      expect(document.querySelectorAll("[data-election-jump]").length).toBe(13);
      expect(Array.from(document.querySelectorAll("[data-election-jump]")).filter(link => !(link.parentElement as HTMLElement).hidden)).toHaveLength(1);
    }
    search.value = "No matching candidate";
    search.dispatchEvent(new Event("input"));
    expect(count.textContent).toBe("0 of 13 races");
    expect(document.querySelector<HTMLElement>("[data-election-no-matches]")?.hidden).toBe(false);
  });
  it("keeps search text, status and filter focus across a fresh AP call", async () => {
    stop = installElectionResults(window);
    const search = document.querySelector<HTMLInputElement>("[data-election-search-input]")!;
    const status = document.querySelector<HTMLSelectElement>("[data-election-status-input]")!;
    search.value = "Cory Booker";
    search.dispatchEvent(new Event("input"));
    status.value = "called";
    status.dispatchEvent(new Event("change"));
    status.focus();
    expect(document.querySelector("[data-election-filter-count]")?.textContent).toBe("0 of 13 races");
    fetchPage.mockImplementation(async () => reply(called()));
    await tick();
    expect(status.value).toBe("called");
    expect(search.value).toBe("Cory Booker");
    expect(document.activeElement).toBe(status);
    expect(document.querySelector("[data-election-filter-count]")?.textContent).toBe("1 of 13 races");
    expect(document.querySelector<HTMLElement>('[data-election-race="us-senate"]')?.hidden).toBe(false);
    status.value = "awaiting";
    search.value = "";
    status.dispatchEvent(new Event("change"));
    expect(document.querySelector("[data-election-filter-count]")?.textContent).toBe("12 of 13 races");
  });
  it("keeps a focused race visible when an update changes its filter status, then applies the filter on focus exit", async () => {
    stop = installElectionResults(window);
    const status = document.querySelector<HTMLSelectElement>("[data-election-status-input]")!;
    status.value = "awaiting";
    status.dispatchEvent(new Event("change"));
    document.querySelector<HTMLElement>(".election-results__details summary")!.focus();
    fetchPage.mockImplementation(async () => reply(called()));
    await tick();
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    expect(document.querySelector<HTMLElement>('[data-election-race="us-senate"]')?.hidden).toBe(false);
    status.focus();
    await tick(0);
    expect(document.querySelector<HTMLElement>('[data-election-race="us-senate"]')?.hidden).toBe(true);
  });
  it("keeps the same table control when a newly published candidate link changes the focus order", async () => {
    stop = installElectionResults(window);
    const summary = document.querySelector<HTMLElement>(".election-results__details summary")!;
    summary.parentElement!.setAttribute("open", "");
    const scroller = document.querySelector<HTMLElement>(".election-results__table-scroll")!;
    scroller.scrollLeft = 70;
    summary.focus();
    const html = changed().replace('</p><div class="election-results__labels">', ' <a href="/candidate-profile/">Profile</a></p><div class="election-results__labels">');
    fetchPage.mockImplementation(async () => reply(html));
    await tick();
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    expect(document.activeElement?.getAttribute("data-election-focus")).toBe("us-senate-table-toggle");
    expect(document.querySelector<HTMLElement>(".election-results__table-scroll")?.scrollLeft).toBe(70);
    expect(document.querySelector('a[href="/candidate-profile/"]')).not.toBeNull();
  });
  it("does not hide a focus-retained race during the browser's blur-to-focus microtask gap", async () => {
    stop = installElectionResults(window);
    const status = document.querySelector<HTMLSelectElement>("[data-election-status-input]")!;
    status.value = "awaiting";
    status.dispatchEvent(new Event("change"));
    document.querySelector<HTMLElement>(".election-results__details summary")!.focus();
    fetchPage.mockImplementation(async () => reply(called()));
    await tick();
    const summary = document.querySelector<HTMLElement>(".election-results__details summary")!;
    const race = summary.closest<HTMLElement>("[data-election-race]")!;
    summary.blur();
    await Promise.resolve();
    expect(document.activeElement).toBe(document.body);
    expect(race.hidden).toBe(false);
    const scroller = race.querySelector<HTMLElement>(".election-results__table-scroll")!;
    scroller.focus();
    await tick(0);
    expect(document.activeElement).toBe(scroller);
    expect(race.hidden).toBe(false);
  });
  it("keeps a focused race jump visible when its race changes filter status", async () => {
    stop = installElectionResults(window);
    const status = document.querySelector<HTMLSelectElement>("[data-election-status-input]")!;
    status.value = "awaiting";
    status.dispatchEvent(new Event("change"));
    document.querySelector<HTMLElement>('[data-election-jump="us-senate"]')!.focus();
    fetchPage.mockImplementation(async () => reply(called()));
    await tick();
    const jump = document.querySelector<HTMLElement>('[data-election-jump="us-senate"]')!;
    expect(document.activeElement).toBe(jump);
    expect(jump.parentElement?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-election-race="us-senate"]')?.hidden).toBe(false);
    status.focus();
    await tick(0);
    expect(jump.parentElement?.hidden).toBe(true);
  });
  it("keeps horizontal jump-menu position and the focused district through an update", async () => {
    stop = installElectionResults(window);
    const jumps = document.querySelector<HTMLElement>(".election-results__jumps ul")!;
    document.querySelector<HTMLElement>('[data-election-jump="us-house-12"]')!.focus();
    jumps.scrollLeft = 450;
    fetchPage.mockImplementation(async () => reply(called()));
    await tick();
    expect(document.activeElement?.getAttribute("data-election-jump")).toBe("us-house-12");
    expect(document.querySelector<HTMLElement>(".election-results__jumps ul")?.scrollLeft).toBe(450);
  });
});
