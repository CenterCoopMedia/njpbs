import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectReportDiagnostics,
  recordReportRequest,
} from "../src/lib/report-diagnostics";

vi.mock("../src/lib/firebase", () => ({
  firebaseConfig: { projectId: "demo-njpbs" },
  getRequiredAppCheckToken: vi.fn(async () => "app-check-token"),
}));

const MAX_SESSION_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_MEMORY_BYTES = 2 ** 40;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("problem report diagnostics", () => {
  it("bounds browser data and keeps only the last same-origin request paths", () => {
    const origin = window.location.origin;
    const sameOriginResources = Array.from({ length: 21 }, (_, index) => ({
      name: `${origin}/assets/item-${index}.js?token=private#fragment`,
      duration: index === 20 ? MAX_SESSION_MS * 2 : index + 0.5,
      responseStatus: 200,
      initiatorType: index === 20 ? "script-that-is-longer-than-32-chars" : "script",
    }));
    const getEntriesByType = vi.fn((type: string) => {
      if (type === "navigation") {
        return [{
          name: window.location.href,
          startTime: 50,
          type: "reload",
          responseStart: 200,
          domContentLoadedEventEnd: 700,
          loadEventEnd: 1_200,
        }];
      }
      if (type === "resource") {
        return [
          {
            name: "https://analytics.example.net/collect?token=private",
            duration: 10,
            responseStatus: 204,
            initiatorType: "fetch",
          },
          {
            name: `${origin}/opaque-cache-entry?token=private`,
            duration: 10,
            responseStatus: 0,
            initiatorType: "fetch",
          },
          ...sameOriginResources,
        ];
      }
      return [];
    });
    vi.stubGlobal("navigator", {
      userAgent: "u".repeat(600),
      language: "l".repeat(80),
      hardwareConcurrency: 5_000,
      deviceMemory: 2_048,
    });
    vi.stubGlobal("screen", {
      width: 20_000,
      height: 0,
      colorDepth: 128,
    });
    vi.stubGlobal("devicePixelRatio", 20);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    vi.stubGlobal("performance", {
      now: () => MAX_SESSION_MS * 2,
      getEntriesByType,
      memory: {
        usedJSHeapSize: -10,
        totalJSHeapSize: MAX_MEMORY_BYTES * 2,
        jsHeapSizeLimit: MAX_MEMORY_BYTES - 1,
      },
    });

    const diagnostics = collectReportDiagnostics();

    expect(Array.from(diagnostics.userAgent)).toHaveLength(512);
    expect(Array.from(diagnostics.language)).toHaveLength(64);
    expect(diagnostics.screen).toEqual({
      width: 10_000,
      height: 1,
      colorDepth: 64,
      pixelRatio: 10,
    });
    expect(diagnostics).toMatchObject({
      sessionAgeMs: MAX_SESSION_MS,
      visibilityState: "visible",
      reducedMotion: true,
      hardwareConcurrency: 1_024,
      deviceMemoryGB: 1_024,
      navigation: {
        type: "reload",
        ttfbMs: 150,
        domContentLoadedMs: 650,
        loadMs: 1_150,
      },
      memory: {
        usedJSHeapSize: 0,
        totalJSHeapSize: MAX_MEMORY_BYTES,
        jsHeapSizeLimit: MAX_MEMORY_BYTES - 1,
      },
    });
    expect(diagnostics.recentRequests).toHaveLength(20);
    expect(diagnostics.recentRequests[0].path).toBe("/assets/item-1.js");
    expect(diagnostics.recentRequests.at(-1)).toEqual({
      path: "/assets/item-20.js",
      status: 200,
      durationMs: MAX_SESSION_MS,
      initiatorType: "script-that-is-longer-than-32-ch",
    });
    expect(diagnostics.recentRequests.every(({ path }) =>
      !path.includes("?") && !path.includes("#") && !path.includes("analytics"),
    )).toBe(true);
  });

  it("omits optional diagnostics when browser APIs do not provide them", () => {
    vi.stubGlobal("navigator", { userAgent: "Test browser", language: "en-US" });
    vi.stubGlobal("screen", { width: 1_280, height: 720, colorDepth: 24 });
    vi.stubGlobal("devicePixelRatio", 2);
    vi.stubGlobal("performance", { now: () => 125 });

    expect(collectReportDiagnostics()).toEqual({
      userAgent: "Test browser",
      language: "en-US",
      screen: { width: 1_280, height: 720, colorDepth: 24, pixelRatio: 2 },
      sessionAgeMs: 125,
      visibilityState: "visible",
      reducedMotion: false,
      recentRequests: [],
    });
  });

  it("keeps the last 20 sanitized CMS calls ahead of resource entries", () => {
    const origin = window.location.origin;
    vi.stubGlobal("performance", {
      now: () => 125,
      getEntriesByType: (type: string) => type === "resource"
        ? [
            {
              name: `${origin}/cmsCall0?from=resource`,
              duration: 5,
              responseStatus: 200,
              initiatorType: "fetch",
            },
            {
              name: `${origin}/assets/app.js?cache=private`,
              duration: 10,
              responseStatus: 200,
              initiatorType: "script",
            },
          ]
        : [],
    });

    recordReportRequest(
      "https://api.example.org/cmsCall0?authorization=Bearer-private#fragment",
      0,
      -10,
    );
    recordReportRequest("cmsCall1?token=private", 503, MAX_SESSION_MS * 2);

    expect(collectReportDiagnostics().recentRequests).toEqual([
      {
        path: "/assets/app.js",
        status: 200,
        durationMs: 10,
        initiatorType: "script",
      },
      { path: "/cmsCall0", status: 0, durationMs: 0, initiatorType: "fetch" },
      {
        path: "/cmsCall1",
        status: 503,
        durationMs: MAX_SESSION_MS,
        initiatorType: "fetch",
      },
    ]);

    for (let index = 2; index < 25; index += 1) {
      recordReportRequest(`cmsCall${index}?token=private#fragment`, 200, index);
    }
    const recentRequests = collectReportDiagnostics().recentRequests;
    expect(recentRequests).toHaveLength(20);
    expect(recentRequests[0].path).toBe("/cmsCall5");
    expect(recentRequests.at(-1)?.path).toBe("/cmsCall24");
    expect(JSON.stringify(recentRequests)).not.toContain("private");
  });

  it("records production CMS responses and network failures through the request wrapper", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_USE_EMULATORS", "");
    vi.stubEnv("VITE_FUNCTIONS_BASE_URL", "https://api.example.org");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ success: true }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service unavailable",
        headers: { get: () => null },
        json: async () => ({ error: "Service unavailable" }),
      } as unknown as Response)
      .mockRejectedValueOnce(new TypeError("Network unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const { cmsGetNewsroomBanner } = await import("../src/lib/functions");
    await cmsGetNewsroomBanner("id-token");
    await expect(cmsGetNewsroomBanner("id-token")).rejects.toMatchObject({ status: 503 });
    await expect(cmsGetNewsroomBanner("id-token")).rejects.toThrow("Network unavailable");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.example.org/cmsGetNewsroomBanner",
      "https://api.example.org/cmsGetNewsroomBanner",
      "https://api.example.org/cmsGetNewsroomBanner",
    ]);
    expect(collectReportDiagnostics().recentRequests.slice(-3)).toEqual([
      expect.objectContaining({ path: "/cmsGetNewsroomBanner", status: 200 }),
      expect.objectContaining({ path: "/cmsGetNewsroomBanner", status: 503 }),
      expect.objectContaining({ path: "/cmsGetNewsroomBanner", status: 0 }),
    ]);
  });
});
