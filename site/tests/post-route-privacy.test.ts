// @vitest-environment node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { LEAD_KINDS } from "./fixtures/post-lead-media";

beforeAll(() => {
  // Compile only five redirect fixtures, with no credentials or loaders.
  execFileSync(process.execPath, ["node_modules/astro/bin/astro.mjs", "build", "--config", "astro.post-privacy.config.mjs"], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York",
      PUBLIC_GA4_MEASUREMENT_ID: "G-TEST123", CMS_DEPLOYMENT_ENVIRONMENT: "production" },
    stdio: "pipe",
  });
}, 20_000);

describe("retired Post slug analytics", () => {
  it("emits newsletter vendor markers only on an eligible adult page", () => {
    const eligible = readFileSync(".astro/post-route-privacy/dist/exclusions/adult/index.html", "utf8");
    expect(eligible).toContain("data-activecampaign-enabled");
    expect(eligible).toContain('id="wisepopsjs"');
    for (const route of ["kids/games", "canonical-alias", "child-template", "renamed-kids", "preview", "no-analytics", "noindex", "redirect", "video"]) {
      const html = readFileSync(`.astro/post-route-privacy/dist/exclusions/${route}/index.html`, "utf8");
      expect(html, route).not.toContain("data-activecampaign-enabled");
      expect(html, route).not.toContain("diffuser-cdn.app-us1.com");
      expect(html, route).not.toContain('id="wisepopsjs"');
      if (!["noindex", "redirect"].includes(route)) {
        expect(html, route).not.toContain("data-analytics-consent");
        expect(html, route).not.toContain('id="mcjs"');
      }
    }
  });
  it.each([...LEAD_KINDS, "body-video"])("keeps the %s privacy policy on its redirect stub", kind => {
    const html = readFileSync(`.astro/post-route-privacy/dist/privacy/${kind}/index.html`, "utf8");
    expect(html).toContain("This page has moved");
    expect(html).toMatch(/content="0;\s*url=\/posts\/lead-standard-[^/]+\/"/);
    expect(html).not.toContain("data-post-lead-player");
    if (kind === "image") {
      expect(html).toContain("data-analytics-consent");
      expect(html).toContain('id="analytics-consent-default"');
    } else {
      expect(html).not.toContain("data-analytics-consent");
      expect(html).not.toContain('id="analytics-consent-default"');
      expect(html).not.toContain('id="wisepopsjs"');
    }
  });
});
