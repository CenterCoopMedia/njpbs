// @vitest-environment node
import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it.each(["production", "development"])("seals %s media policy without a Node process global", async environment => {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", environment);
  vi.stubEnv("PUBLIC_GA4_MEASUREMENT_ID", "G-TEST123");
  vi.stubEnv("PUBLIC_REPORT_ENDPOINT", "https://report.example.test/");
  vi.stubEnv("PUBLIC_TURNSTILE_SITEKEY", "public-test-sitekey");
  vi.resetModules();
  const { default: config } = await import("../astro.public-post.config.mjs");
  const code = buildSync({ entryPoints: ["src/lib/published-resource-check.ts"], bundle: true,
    write: false, platform: "browser", format: "iife", globalName: "resources", define: config.vite.define }).outputFiles[0].text;
  const html = '<img src="https://dev-media.example.org/cms-media/art.webp"><video><source src="https://dev-media.example.org/cms-media/video.mp4"></video>';
  const result = runInNewContext(`${code}; ({ processType: typeof process, issues: resources.publishedResourceIssues(html, '/', origin) })`,
    { URL, html, origin: environment === "development" ? "https://dev-public.example.org" : "https://njpbs.org" });
  expect(result.processType).toBe("undefined");
  // Approved development media from media-origin.ts stays local to that target.
  expect([...result.issues].sort()).toEqual(environment === "development" ? [] : [
    "Unreviewed img resource host: dev-media.example.org",
    "Unreviewed source resource host: dev-media.example.org",
  ]);
});
