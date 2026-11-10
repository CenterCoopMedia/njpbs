import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installElectionResults } from "../../packages/content-core/src/election-results-dom";
import { renderElectionResults } from "../../packages/content-core/src/election-results-render";
import { electionRace } from "../../tests/fixtures/election-results";
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => { stop?.(); document.body.innerHTML = ""; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps an open static explanation and its focus while fresh counts replace race content", async () => {
  const race = electionRace();
  document.body.innerHTML = renderElectionResults("results", { races: [race] });
  const panel = document.querySelector<HTMLDetailsElement>(".election-results__explainer")!;
  const summary = panel.querySelector("summary")!;
  panel.open = true;
  summary.focus();
  const changed = { ...race, asOf: "2026-11-04T02:16:00Z" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(renderElectionResults("results", { races: [changed] }), {
    headers: { "content-type": "text/html" },
  })));
  stop = installElectionResults(window);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(document.querySelector(".election-results__explainer")).toBe(panel);
  expect(panel.open).toBe(true);
  expect(document.activeElement).toBe(summary);
  expect(panel.textContent).toContain("A call is not official certification.");
  expect(document.querySelector("time")?.dateTime).toBe(changed.asOf);
});

it("retains the same candidate campaign focus when a publication changes candidate order", async () => {
  const race = electionRace({ id: "us-senate", office: "U.S. Senate", district: "New Jersey", candidates: [
    { id: "us-senate-cory-booker", name: "Cory Booker", votes: 60, share: 60 },
    { id: "us-senate-justin-murphy", name: "Justin Murphy", votes: 40, share: 40 },
  ] });
  document.body.innerHTML = renderElectionResults("results", { races: [race] });
  const key = `${race.id}-us-senate-cory-booker-card-campaign`;
  document.querySelector<HTMLElement>(`[data-election-focus="${key}"]`)!.focus();
  const changed = structuredClone(race);
  changed.candidates.reverse();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(renderElectionResults("results", { races: [changed] }), { headers: { "content-type": "text/html" } })));
  stop = installElectionResults(window);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(document.activeElement?.getAttribute("data-election-focus")).toBe(key);
  expect(document.activeElement?.getAttribute("href")).toBe("https://corybooker.com/");
  expect(document.querySelectorAll('[data-election-focus$="profile"]')).toHaveLength(4);
});
