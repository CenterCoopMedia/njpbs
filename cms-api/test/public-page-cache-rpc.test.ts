import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { PublicContentEntrypoint, type CmsApiEnv } from "../src/index";

const rendererSha = "a".repeat(40);
const environment: CmsApiEnv = { ...workerEnv, PREVIEW_RENDERER: undefined,
  CMS_EDGE_ORIGIN_SECRET: "synthetic-edge", CMS_DEPLOYMENT_ENVIRONMENT: "production",
  FIREBASE_PROJECT_ID: "njpbs-site", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" };
const entrypoint = () => new PublicContentEntrypoint(createExecutionContext(), environment);
const reply = (pageId = "contact") => ({ kind: "context-page", contextReceipt: { rendererSha }, renderContext: { pageId } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("carries only a fresh origin lease and caps it at 60 seconds", async () => {
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(reply(), {
    headers: { "x-njpbs-public-decision-valid-until": String(now + 62_000) } })));
  expect((await entrypoint().getNoBuildPage("/contact/", rendererSha, "GET", true)).decisionCacheUntil).toBe(now + 60_000);
});
it.each([undefined, "invalid", "1", "999999999999999999999"])("ignores missing or unusable origin lifetime %s", async value => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...reply(), decisionCacheUntil: Date.now() + 60_000 }, {
    headers: value === undefined ? {} : { "x-njpbs-public-decision-valid-until": value } })));
  expect((await entrypoint().getNoBuildPage("/contact/", rendererSha, "GET", true)).decisionCacheUntil).toBeUndefined();
});
it.each(["schedule", "live"])("never grants a %s cache lease", async pageId => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(reply(pageId), {
    headers: { "x-njpbs-public-decision-valid-until": String(Date.now() + 60_000) } })));
  expect((await entrypoint().getNoBuildPage(`/${pageId}/`, rendererSha, "GET", true)).decisionCacheUntil).toBeUndefined();
});

it("leaves the reply shape unchanged for an older Worker that does not request a lease", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(reply(), {
    headers: { "x-njpbs-public-decision-valid-until": String(Date.now() + 60_000) } })));
  expect(await entrypoint().getNoBuildPage("/contact/", rendererSha)).toEqual(reply());
});
