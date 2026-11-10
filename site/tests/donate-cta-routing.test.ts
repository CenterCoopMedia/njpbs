// Reproduces viewer report njpbs-20260710-a3669c7e (tracking issue #452): the
// public "Donate" button lands on /give/, where the visitor must click a second
// "Donate through PBS" button to reach the PBS donation form. Two clicks, and the
// "Donate through PBS" wording read as confusing to real donors.
//
// The accepted fix sends the public Donate CTAs straight to the existing,
// configured PBS donation URL. The local /give/ page stays available, and the
// prototype keeps its local navigation, but neither is an extra step for donors
// on the public site.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { donateUrl, launchFallbackPages } from "../src/data/launch-fallback";
import { resolveSiteNavigation } from "../../packages/content-core/src/site-navigation";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const shell = readFileSync(join(srcDir, "layouts", "PublicSiteLayout.astro"), "utf8");
const home = readFileSync(join(srcDir, "components", "CinematicHomePage.astro"), "utf8");

const hero = readFileSync(join(srcDir, "components", "HomeHero.astro"), "utf8");

describe("donate CTA routing (report njpbs-20260710-a3669c7e / #452)", () => {
  it("keeps the local /give/ page's direct handoff available", () => {
    expect(launchFallbackPages.give.primaryAction).toEqual({
      label: "Donate through PBS",
      href: donateUrl,
      external: true,
    });
  });

  it("routes the support and donate page actions directly to PBS", () => {
    expect(launchFallbackPages.support.primaryAction).toEqual({
      label: "Donate",
      href: donateUrl,
      external: true,
    });
    expect(launchFallbackPages.donate.primaryAction).toEqual({
      label: "Donate",
      href: donateUrl,
      external: true,
    });
  });

  it("the public shell's header and footer Donate CTAs link directly to PBS", () => {
    expect(shell).toContain("const donateHref = donateUrl;");
    expect(shell).toMatch(/href=\{donateHref\}/);
    // The footer Donate link is a typed launch target in the navigation seed.
    const footerDonate = resolveSiteNavigation(undefined, { postsIndexEnabled: true })
      .footer.flatMap(({ links }) => links)
      .find(({ label }) => label === "Donate");
    expect(footerDonate).toMatchObject({ href: donateUrl, opensInNewTab: true });
  });

  it("marks the header Donate button with the PBS heart", () => {
    expect(shell).toMatch(
      /class="donate"[\s\S]*?<svg[\s\S]*?class="donate__heart"[\s\S]*?viewBox="0 0 22 18"[\s\S]*?aria-hidden="true"[\s\S]*?<path[\s\S]*?d="M21\.765 5\.812C21\.765 2\.596/,
    );
    expect(shell).toMatch(
      /\.donate\s*{[^}]*box-sizing:\s*border-box;[^}]*min-height:\s*var\(--target-comfortable\);/s,
    );
    expect(shell).toMatch(
      /\.donate__heart\s*{[^}]*flex:\s*none;[^}]*width:\s*1rem;[^}]*height:\s*auto;[^}]*color:\s*var\(--color-action\);/s,
    );
  });

  it("keeps the heart Donate button inside the narrowest header", () => {
    expect(shell).toMatch(
      /@media \(max-width: 360px\)\s*{[^}]*\.head-inner\s*{[^}]*padding-inline:\s*0\.75rem;[^}]*gap:\s*0\.5rem;/s,
    );
    expect(shell).toMatch(
      /@media \(max-width: 360px\)[\s\S]*?\.brand img\s*{[^}]*height:\s*32px;/,
    );
  });

  it("the public homepage hero Donate CTA links directly to PBS", () => {
    expect(home).toContain("const giveHref = donateUrl;");
    expect(home).toContain("giveHref={giveHref}");
    expect(home).toContain("externalActions={true}");
    expect(hero).toMatch(/class="btn btn--ghost"\s+href=\{giveHref\}/);
    expect(hero).toMatch(/externalActions \? \{ rel: "noopener", target: "_blank" \} : \{\}/);
    expect(hero).toContain('Donate{externalActions && <span class="sr-only"> (opens in new tab)</span>}');
  });

  it("keeps the Passport page's existing direct donation behavior intact", () => {
    expect(launchFallbackPages.passport.primaryAction).toEqual({
      label: "Donate through PBS",
      href: donateUrl,
      external: true,
    });
  });
});
