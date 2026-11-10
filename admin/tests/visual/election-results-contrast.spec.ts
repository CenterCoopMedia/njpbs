import { readFileSync } from "node:fs";
import { test as base, expect } from "./fixtures";
import { renderElectionResults } from "../../../packages/content-core/src/election-results-render";
import { electionRace } from "../../../tests/fixtures/election-results";
import { contrastRatio } from "../../../site/src/lib/contrast";

const css = readFileSync(new URL("../../../packages/content-core/src/election-results.css", import.meta.url), "utf8");
const prose = readFileSync(new URL("../../../packages/content-core/src/component-blocks.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../../site/src/styles/design-tokens.css", import.meta.url), "utf8");
const ordinary = electionRace({ candidates: electionRace().candidates.map((candidate, index) => ({ ...candidate,
  party: index === 0 ? "Democratic" : "Republican",
  photo: { assetId: `portrait-${candidate.id}`, alt: "Synthetic fixture portrait", caption: "Synthetic fixture credit" },
})) });
const states = {
  leading: ordinary,
  "three-way": electionRace({ candidates: [
    { id: "ellis", name: "Alexandria Dominique Ellis with a long ballot display name", party: "Democratic", votes: 128000, share: 51.2 },
    { id: "rivera", name: "Morgan Rivera", party: "Republican", votes: 117000, share: 46.8 },
    { id: "chen", name: "Casey Chen", party: "Independent", votes: 5000, share: 2 },
  ] }),
  won: electionRace({ candidates: ordinary.candidates, status: "called", sourceKind: "ap", sourceLabel: "The Associated Press",
    sourceUrl: "https://apnews.com/", apCallUrl: "https://apnews.com/hub/election-2026", calledCandidateId: "ellis" }),
  "no-votes": electionRace({ reportingShare: 0, candidates: ordinary.candidates.map(candidate => ({ ...candidate, votes: 0, share: 0 })) }),
  awaiting: electionRace({ status: "awaiting", reportingShare: null,
    candidates: ordinary.candidates.map(candidate => ({ ...candidate, votes: null, share: null })) }),
};
// This spec belongs to the existing browser job, never the Site unit runner.
const test = base.extend({
  browser: [async ({ playwright }, use) => {
    const cdp = process.env.NJPBS_CONTRAST_CDP;
    if (cdp && !/^http:\/\/127\.0\.0\.1:\d+$/.test(cdp)) throw new Error("Use a loopback contrast browser");
    const browser = cdp ? await playwright.chromium.connectOverCDP(cdp)
      : await playwright.chromium.launch({ channel: "chrome", chromiumSandbox: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: "worker" }],
});

for (const theme of ["public kit", "shared fallback"]) {
  test.describe(`rendered election results: ${theme}`, () => {
    for (const [state, race] of Object.entries(states)) {
      for (const width of [390, 1280, 1920]) {
        test(`${state} at ${width} px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 1000 });
          await page.setContent(`<style>${theme === "public kit" ? tokens : ""}\n${css}\n${prose}</style><div class="cms-page__blocks"><div class="cms-block cms-block--election_results">${renderElectionResults(state, { races: [race] })}</div></div>`);
          await page.locator(".election-results__explainer summary").click();
          await page.locator(".election-results__details summary").click();
          expect(await page.locator(".election-results__candidates").evaluate(element => getComputedStyle(element).paddingLeft)).toBe("0px");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          const layout = await page.locator(".election-results__race").evaluate(root => ({
            status: root.querySelector(".election-results__panel")!.getBoundingClientRect().toJSON(),
            rows: root.querySelector(".election-results__standings")!.getBoundingClientRect().toJSON(),
          }));
          if (width === 390) expect(layout.status.bottom).toBeLessThanOrEqual(layout.rows.top);
          else expect(layout.status.left).toBeGreaterThanOrEqual(layout.rows.right);
          const bars = await page.locator(".election-results__bar > span").evaluateAll(elements => elements.map(element => ({
            ink: getComputedStyle(element).backgroundColor, paper: getComputedStyle(element.parentElement!).backgroundColor,
          })));
          const rgbHex = (value: string) => `#${value.match(/\d+/g)!.slice(0, 3).map(channel => Number(channel).toString(16).padStart(2, "0")).join("")}`;
          for (const bar of bars) expect(contrastRatio(rgbHex(bar.ink), rgbHex(bar.paper))).toBeGreaterThanOrEqual(3);
          await page.keyboard.press("Tab");
          await page.keyboard.press("Shift+Tab");
          await expect(page.locator(".election-results__details summary")).toBeFocused();
          const focus = await page.locator(".election-results__details summary").evaluate(element => ({
            ink: getComputedStyle(element).outlineColor, width: getComputedStyle(element).outlineWidth,
            paper: getComputedStyle(element.closest(".election-results")!).backgroundColor,
          }));
          expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(rgbHex(focus.ink), rgbHex(focus.paper))).toBeGreaterThanOrEqual(3);
          const pairs = await page.locator(".election-results").evaluate(root => {
            const rgb = (value: string) => value.match(/[\d.]+/g)!.map(Number);
            const backdrop = (element: Element): number[] => {
              const parent = element.parentElement ? backdrop(element.parentElement) : [255, 255, 255];
              const channels = rgb(getComputedStyle(element).backgroundColor);
              const alpha = channels[3] ?? 1;
              return parent.map((channel, index) => channels[index] * alpha + channel * (1 - alpha));
            };
            const hex = (channels: number[]) => `#${channels.slice(0, 3).map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            const result: { text: string; foreground: string; background: string; minimum: number }[] = [];
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (!node.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              if (![...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
              const element = node.parentElement!;
              const style = getComputedStyle(element);
              const size = parseFloat(style.fontSize);
              result.push({ text: node.textContent.trim(), foreground: hex(rgb(style.color)), background: hex(backdrop(element)),
                minimum: size >= 24 || (size >= 18.666 && Number(style.fontWeight) >= 700) ? 3 : 4.5 });
            }
            return result;
          });
          expect(pairs.some(pair => pair.text === race.candidates[0].name)).toBe(true);
          expect(pairs.some(pair => pair.text === "View results as a table")).toBe(true);
          expect(pairs.some(pair => pair.text.startsWith("AP calls a race"))).toBe(true);
          for (const pair of pairs) {
            expect(contrastRatio(pair.foreground, pair.background), `${theme}/${state}: ${pair.text} (${pair.foreground} on ${pair.background})`)
              .toBeGreaterThanOrEqual(pair.minimum);
          }
        });
      }
    }
  });
}
