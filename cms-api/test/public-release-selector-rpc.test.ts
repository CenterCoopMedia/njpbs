import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { PublicContentEntrypoint, type CmsApiEnv } from "../src/index";
import { releaseSelector } from "../../tests/helpers/private-public-release-pair.js";
const environment = (): CmsApiEnv => ({ ...workerEnv, PREVIEW_RENDERER: undefined, PUBLIC_RELEASE_READERS_ENABLED: "true", PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "true", CMS_EDGE_ORIGIN_SECRET: "fixture-edge",
  CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net",
  ADMIN_ORIGIN: "https://dev-admin.example.org" });
const entry = (changes = {}) => new PublicContentEntrypoint(createExecutionContext(), { ...environment(), ...changes });
afterEach(() => vi.unstubAllGlobals());
it("uses the fixed private selector mode with a bounded authority timeout", async () => {
  vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
    expect(url).toBe(environment().FUNCTIONS_ORIGIN + "/cmsGetPublicPage");
    expect(options.redirect).toBe("manual"); expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(options.body))).toEqual({ mode: "release-selector-v2" });
    return Response.json({ environment: "development", selector: releaseSelector(), readStartedAt: Date.now() });
  });
  expect((await entry().getReleaseSelector(900)).selector).toEqual(releaseSelector());
});
it.each([{ PUBLIC_RELEASE_READERS_ENABLED: "false" }, { FIREBASE_PROJECT_ID: "foreign" }, { FUNCTIONS_ORIGIN: "https://foreign.invalid" }])(
  "refuses disabled or mixed identities before I/O %j", async changes => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(entry(changes).getReleaseSelector()).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
it("refuses over-budget calls and malformed authority", async () => {
  await expect(entry().getReleaseSelector(3001)).rejects.toThrow();
  vi.stubGlobal("fetch", async () => Response.json({ environment: "development", selector: {}, readStartedAt: Date.now() }));
  await expect(entry().getReleaseSelector()).rejects.toThrow();
});
it("uses the private pair decision mode and refuses mixed or disabled readers before I/O", async () => {
  const pair = (await import("../../tests/helpers/private-public-release-pair.js")).releasePair();
  const selection = { environment: "development" as const, selector: releaseSelector(), readStartedAt: Date.now() };
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    expect(JSON.parse(String(options.body))).toEqual({ mode: "release-decision-v2", selection, pair, path: "/contact/" });
    return Response.json({ kind: "reselect" });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await entry().getReleaseDecision(selection, pair, "/contact/", 100)).toEqual({ kind: "reselect" });
  for (const changes of [{ PUBLIC_RELEASE_READERS_ENABLED: "false" }, { FIREBASE_PROJECT_ID: "foreign" }]) {
    await expect(entry(changes).getReleaseDecision(selection, pair, "/contact/")).rejects.toThrow();
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("routes the private isolated measurement RPC only for enabled development identities", async () => {
  const measurementId = "00000000-0000-4000-8000-000000000001";
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    expect(JSON.parse(String(options.body))).toEqual({ mode: "release-routing-measurement-v2", measurementId });
    return Response.json({ environment: "development", selector: releaseSelector(), readStartedAt: Date.now() });
  });
  vi.stubGlobal("fetch", fetcher);
  expect((await entry({ PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED: "true" }).getRoutingMeasurementSelector(measurementId)).selector).toEqual(releaseSelector());
  for (const changes of [{}, { PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED: "false" },
    { PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED: "true", FIREBASE_PROJECT_ID: "njpbs-site" }]) {
    await expect(entry(changes).getRoutingMeasurementSelector(measurementId)).rejects.toThrow();
  }
  await expect(entry({ PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED: "true" }).getRoutingMeasurementSelector("../publicDeployment")).rejects.toThrow();
  await expect(entry({ PUBLIC_RELEASE_ROUTING_MEASUREMENT_ENABLED: "true" }).getRoutingMeasurementSelector(measurementId, 3001)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
