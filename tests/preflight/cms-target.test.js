import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { assertDevelopmentPagesConfig, assertDevelopmentWorkerConfig, cmsTarget, isDevelopmentHostname, isDevelopmentName } from "../../scripts/lib/cms-target.mjs";
import { configurationInputs, runtimeParameters } from "../../scripts/lib/functions-configuration.mjs";

const read = path => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
const devEnv = {
  CMS_TARGET: "development", CMS_DEV_ADMIN_ORIGIN: "https://dev-admin.njpbs.org", CMS_DEV_API_ORIGIN: "https://dev-cms-api.njpbs.org",
  CMS_DEV_PUBLIC_ORIGIN: "https://dev.njpbs.org", CMS_DEV_MEDIA_ORIGIN: "https://dev-media.njpbs.org",
  CMS_DEV_API_WORKER: "njpbs-dev-cms-api", CMS_DEV_PREVIEW_RENDERER: "njpbs-dev-cms-preview-renderer", CMS_DEV_ADMIN_PAGES: "njpbs-dev-admin",
};

describe("CMS deploy target", () => {
  it("keeps production names and selects only dev names for development", () => {
    expect(cmsTarget({})).toMatchObject({ environment: "production", projectId: "njpbs-site", cmsApiWorker: "njpbs-cms-api",
      adminPages: "njpbs-admin", mediaOrigin: "https://media.njpbs.org", firebaseConfig: "firebase.json", codebase: "default" });
    expect(cmsTarget(devEnv)).toMatchObject({ environment: "development", projectId: "njpbs-site-dev", cmsApiWorker: "njpbs-dev-cms-api",
      adminPages: "njpbs-dev-admin", mediaOrigin: "https://dev-media.njpbs.org", firebaseConfig: "firebase.dev.json", codebase: "dev",
      functionsOrigin: "https://us-central1-njpbs-site-dev.cloudfunctions.net" });
    expect(() => cmsTarget({ CMS_TARGET: "staging" })).toThrow(/production or development/);
  });

  it.each([
    ["CMS_DEV_API_WORKER", "njpbs-cms-api"], ["CMS_DEV_PREVIEW_RENDERER", "njpbs-cms-preview-renderer"], ["CMS_DEV_ADMIN_PAGES", "njpbs-admin"],
    ["CMS_DEV_API_WORKER", ""], ["CMS_DEV_ADMIN_ORIGIN", "https://admin.njpbs.org"], ["CMS_DEV_API_ORIGIN", "https://cms-api.njpbs.org"],
    ["CMS_DEV_MEDIA_ORIGIN", "https://media.njpbs.org"], ["CMS_DEV_PUBLIC_ORIGIN", "https://njpbs.org"], ["CMS_DEV_MEDIA_ORIGIN", "https://dev-media.njpbs.org/"],
  ])("refuses a development target whose %s names production (%j)", (name, value) => {
    expect(() => cmsTarget({ ...devEnv, [name]: value })).toThrow(name);
  });

  it("recognizes dev names and hostnames only", () => {
    for (const name of ["njpbs-dev-cms-api", "template-dev-cms-api", "njpbs-dev"]) expect(isDevelopmentName(name)).toBe(true);
    for (const name of ["njpbs-cms-api", "njpbs", "njpbs-devtools", "njpbs-media"]) expect(isDevelopmentName(name)).toBe(false);
    for (const host of ["dev.njpbs.org", "dev-media.njpbs.org", "dev-api.example.org"]) expect(isDevelopmentHostname(host)).toBe(true);
    for (const host of ["media.njpbs.org", "njpbs.org", "devmedia.njpbs.org", "cms-api.njpbs.org"]) expect(isDevelopmentHostname(host)).toBe(false);
  });
});

describe("development Cloudflare writes", () => {
  const api = { name: "template-dev-cms-api", hostnames: ["dev-api.example.org"] };
  it("admits the committed dev CMS API config and refuses the production one", () => {
    expect(() => assertDevelopmentWorkerConfig(read("cms-api/wrangler.dev.jsonc"), api)).not.toThrow();
    expect(() => assertDevelopmentWorkerConfig(read("cms-api/wrangler.jsonc"), api)).toThrow(/production resource/);
    expect(() => assertDevelopmentWorkerConfig(read("cms-api/wrangler.jsonc"), { name: "njpbs-cms-api", hostnames: ["api.example.org"] }))
      .toThrow(/production resource/);
  });

  it.each([
    ["a production route", config => ({ ...config, routes: [{ pattern: "cms-api.njpbs.org", custom_domain: true }] })],
    ["a production service binding", config => ({ ...config, services: [{ binding: "PREVIEW_RENDERER", service: "njpbs-cms-preview-renderer" }] })],
    ["a production bucket", config => ({ ...config, r2_buckets: [{ binding: "MEDIA", bucket_name: "njpbs" }] })],
    ["the production project", config => ({ ...config, vars: { ...config.vars, FIREBASE_PROJECT_ID: "njpbs-site" } })],
    ["a workers.dev route", config => ({ ...config, workers_dev: true })],
  ])("refuses a dev CMS API config with %s", (_label, change) => {
    expect(() => assertDevelopmentWorkerConfig(change(read("cms-api/wrangler.dev.jsonc")), api)).toThrow(/production resource/);
  });

  const pages = { adminPages: "template-dev-admin", cmsApiWorker: "template-dev-cms-api" };
  it("admits the committed dev Admin Pages config and refuses the production one", () => {
    const production = JSON.parse(readFileSync(new URL("../../admin/wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(production.services[0].service).toBe("njpbs-cms-api");
    expect(() => assertDevelopmentPagesConfig(read("admin/wrangler.dev.jsonc"), pages)).not.toThrow();
    expect(() => assertDevelopmentPagesConfig(production, pages)).toThrow(/production resource/);
    expect(() => assertDevelopmentPagesConfig(production, { adminPages: "njpbs-admin", cmsApiWorker: "njpbs-cms-api" })).toThrow(/production resource/);
  });

  it.each([
    ["the production CMS API", config => ({ ...config, services: [{ ...config.services[0], service: "njpbs-cms-api" }] })],
    ["a second service", config => ({ ...config, services: [...config.services, { binding: "OTHER", service: "njpbs-production", entrypoint: "default" }] })],
    ["no service", config => ({ ...config, services: [] })],
    ["the production guide bucket", config => ({ ...config, r2_buckets: [{ binding: "GUIDE_VIDEOS", bucket_name: "njpbs-admin-guide" }] })],
    ["a production database", config => ({ ...config, d1_databases: [{ binding: "DB", database_id: "production" }] })],
    ["production settings", config => ({ ...config, env: { production: { services: [{ binding: "STAFF_ACCESS", service: "njpbs-cms-api" }] } } })],
    ["the production project", config => ({ ...config, name: "njpbs-admin" })],
  ])("refuses a dev Admin Pages config with %s", (_label, change) => {
    expect(() => assertDevelopmentPagesConfig(change(read("admin/wrangler.dev.jsonc")), pages)).toThrow(/production resource/);
  });

  it("purges only dev media hostnames for a development target", async () => {
    const variables = JSON.stringify({ CMS_MEDIA_CLOUDFLARE_ZONE_ID: "a".repeat(32), CMS_ANALYTICS_CF_ZONE_ID: "b".repeat(32),
      CMS_MEDIA_R2_BUCKET: "njpbs", LIVE_PRODUCTION_ENABLED: "true", CMS_STAFF_EMAIL_FROM: "staff@njpbs.org" });
    const env = { ...devEnv, CMS_DEV_MEDIA_BUCKET: "njpbs-dev-media", CMS_DEPLOYMENT_VARIABLES_JSON: variables,
      CLOUDFLARE_ACCOUNT_ID: "c".repeat(32), CMS_PREVIEW_RENDERER_SHA: "d".repeat(40), CMS_ADMIN_BUILD_REVISION: "e".repeat(40),
      CMS_BUG_REPORT_TELEGRAM_CHAT_ID: "1", CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP: '{"1":"dev-placeholder"}', VITE_LIVE_PRODUCTION_ENABLED: "true" };
    const input = configurationInputs(env);
    // Repository variables hold production values; a dev run takes none of them silently.
    expect(input).toMatchObject({ CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_MEDIA_R2_BUCKET: "njpbs-dev-media",
      VITE_LIVE_PRODUCTION_ENABLED: "false", CMS_STAFF_EMAIL_FROM: "", CMS_STAFF_EMAIL_ADMIN_ORIGIN: "https://dev-admin.njpbs.org" });
    const discovery = Object.fromEntries(["CMS_MEDIA_PURGE_SWEEP_ENABLED", "CMS_MEDIA_PURGE_REAL_DELETES_ENABLED", "COST_LEDGER_GCP_PULL",
      "COST_LEDGER_CLOUDFLARE_PULL", "COST_LEDGER_AWS_PULL", "COST_LEDGER_GITHUB_PULL"].map(name => [name, "false"]).concat(["COST_LEDGER_GCP_PROJECT",
      "COST_LEDGER_GCP_BILLING_TABLE", "COST_LEDGER_CLOUDFLARE_ACCOUNT_ID", "COST_LEDGER_GITHUB_ACCOUNT", "COST_LEDGER_GITHUB_ACCOUNT_TYPE"].map(name => [name, ""])));
    const parameters = runtimeParameters(input, discovery, cmsTarget(env));
    expect(parameters.CMS_MEDIA_PUBLIC_ORIGIN).toBe("https://dev-media.njpbs.org");
    expect(() => configurationInputs({ ...env, CMS_DEV_MEDIA_BUCKET: "njpbs" })).toThrow("CMS_DEV_MEDIA_BUCKET");

    const require = createRequire(import.meta.url);
    const { createMediaCacheRetirement } = require("../../functions/lib/media-purge-cache.js");
    const requests = [];
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(url.startsWith("https://api.cloudflare.com/") ? JSON.stringify({ success: true }) : null,
        { status: url.startsWith("https://api.cloudflare.com/") ? 200 : 404 });
    });
    const retirement = createMediaCacheRetirement({ origin: parameters.CMS_MEDIA_PUBLIC_ORIGIN, zoneId: "a".repeat(32),
      token: "fixture-purge-token", fetchImpl });
    await retirement.retire([{ store: "public", key: "uploads/2026/11/example.jpg" }], Date.now() + 60_000);
    const named = requests.flatMap(({ url, body }) => [url, ...JSON.stringify(body ?? {}).match(/https?:\/\/[^"\\]+|[a-z0-9.-]+\.njpbs\.org[^"\\]*/g) ?? []])
      .filter(value => !value.startsWith("https://api.cloudflare.com/"));
    expect(named.length).toBeGreaterThan(0);
    for (const value of named) expect(new URL(value.startsWith("http") ? value : `https://${value}`).hostname).toBe("dev-media.njpbs.org");
  });
});
