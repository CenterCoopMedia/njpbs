// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderLivePlayerFrame } from "../src/lib/live-player-render";
import { pbsAppUrl, pbsLivestreamWatchUrl } from "../src/data/launch-fallback";

const subpage = readFileSync(
  new URL("../src/components/PublicSubpage.astro", import.meta.url),
  "utf8",
);
const servicePageStyles = readFileSync(
  new URL("../src/styles/service-page.css", import.meta.url),
  "utf8",
);

const playerSection = renderLivePlayerFrame();

describe("PBS Partner Player accessibility surface (issue #180)", () => {
  it("labels the player landmark with its visible heading", () => {
    expect(subpage).toContain("set:html={renderLivePlayerFrame()}");
    expect(playerSection).toContain('aria-labelledby="pbs-player-heading"');
    expect(playerSection).toMatch(
      /<h2 id="pbs-player-heading">\s*NJ PBS broadcast stream\s*<\/h2>/,
    );
    expect(playerSection).not.toMatch(
      /public-page__player-section"\s+aria-label=/,
    );
  });

  it("gives the iframe a title and useful nearby descriptions", () => {
    const iframe = playerSection.match(/<iframe[\s\S]*?<\/iframe>/)?.[0];
    expect(iframe).toBeDefined();
    expect(iframe).toContain('title="PBS livestream"');
    expect(iframe).toContain(
      'aria-describedby="pbs-player-description pbs-player-keyboard-help"',
    );
    expect(playerSection).toContain('id="pbs-player-description"');
    expect(playerSection).toContain("The player is hosted by PBS and may use location rules, account services, and device settings managed by PBS.");
    expect(playerSection).toContain('id="pbs-player-keyboard-help"');
    expect(playerSection).toMatch(
      /press Tab from this link to focus the player frame, then press\s+Tab again to enter it\./,
    );
  });

  it("places a keyboard bypass before the iframe and live alternatives after it", () => {
    const help = playerSection.indexOf('id="pbs-player-keyboard-help"');
    const iframe = playerSection.indexOf("<iframe", help);
    const alternatives = playerSection.indexOf('id="pbs-player-alternatives"');

    expect(help).toBeGreaterThan(-1);
    expect(iframe).toBeGreaterThan(help);
    expect(alternatives).toBeGreaterThan(iframe);
    expect(playerSection.replace(/\s+/g, " ")).toContain(
      'href="#pbs-player-alternative-app">Skip the PBS player and use alternate live options</a>, or press Tab from this link to focus the player frame, then press Tab again to enter it.',
    );
    expect(playerSection).toContain(`id="pbs-player-alternative-app" href="${pbsAppUrl}"`);
    expect(playerSection).toContain(`href="${pbsLivestreamWatchUrl}"`);

    const targetRule = servicePageStyles.match(
      /#pbs-player-alternative-app\s*\{[^}]*\}/,
    )?.[0];
    expect(targetRule).toContain("scroll-margin-top: 8rem");
  });

  it("draws explicit focus-visible indicators for the player frame and iframe", () => {
    expect(playerSection).toMatch(
      /class="public-page__player-frame"[\s\S]*?role="group"[\s\S]*?aria-label="PBS livestream player frame"[\s\S]*?aria-describedby="pbs-player-keyboard-help"[\s\S]*?tabindex="0"/,
    );
    const frameRule = servicePageStyles.match(
      /\.public-page__player-frame:focus-visible\s*\{[^}]*\}/,
    )?.[0];
    const iframeRule = servicePageStyles.match(
      /\.public-page__player-frame iframe:focus-visible\s*\{[^}]*\}/,
    )?.[0];
    for (const rule of [frameRule, iframeRule]) {
      expect(rule).toBeDefined();
      expect(rule).toContain("outline: var(--focus-outline)");
      expect(rule).toContain("outline-offset: var(--focus-offset)");
    }
  });
});
