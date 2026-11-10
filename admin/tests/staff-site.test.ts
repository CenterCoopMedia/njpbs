import { afterEach, describe, expect, it, vi } from "vitest";
import { clearStaffSiteSessions, preparePrivatePreviewSession, staffSiteDestination } from "../src/lib/staff-site";

describe("staff site handoff destination", () => {
  it("keeps the original path, query and fragment", () => {
    const target = "https://preview.njpbs.org/p/abcdefghijklmnopqrst/about/?a=1#section";
    expect(staffSiteDestination(target)?.href).toBe(target);
  });
  it("restores the fragment inherited by the Admin redirect", () => {
    expect(staffSiteDestination("https://preview.njpbs.org/about/", "#section")?.href)
      .toBe("https://preview.njpbs.org/about/#section");
    expect(staffSiteDestination("https://preview.njpbs.org/about/#original", "#other")?.hash)
      .toBe("#original");
  });
  it.each(["https://dev-public.example.org/", "https://evil.example/", "https://dev-public.example.org.evil.example/", "https://user:pass@dev-public.example.org/",
    "http://dev-public.example.org/", "https://dev-public.example.org:444/", "//dev-public.example.org/", "https://dev-public.example.org/__cms-session",
  ])("refuses credential forwarding to %s", (target) => {
    expect(staffSiteDestination(target)).toBeNull();
  });
});


describe("private preview session preparation", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "https://admin.njpbs.org.example.test",
    "http://admin.njpbs.org", "https://admin.njpbs.org:444",
  ])("makes no remote cleanup request on signed-out startup at %s", async (origin) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin } });
    await clearStaffSiteSessions({ signedOutStartup: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps signed-out startup cookie cleanup at the production Admin", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin: "https://admin.njpbs.org" } });
    await clearStaffSiteSessions({ signedOutStartup: true });
    expect(fetch.mock.calls.map(([url, options]) => [url, options.method, options.credentials])).toEqual([
      ["https://preview.njpbs.org/__cms-session", "DELETE", "include"],
    ]);
  });

  it("cancels a pending token during local startup without sending it or deleting remote sessions", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    let resolveToken!: (token: string) => void;
    const pending = preparePrivatePreviewSession(new Promise<string>(resolve => { resolveToken = resolve; }));
    await clearStaffSiteSessions({ signedOutStartup: true });
    resolveToken("private-test-token");
    await pending;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight preview POST during local startup without a remote DELETE", async () => {
    let postSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      if (options.method !== "POST") return Promise.resolve({ ok: true, status: 204 });
      postSignal = options.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        postSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
    const pending = preparePrivatePreviewSession(Promise.resolve("private-test-token"));
    await Promise.resolve();
    expect(postSignal?.aborted).toBe(false);
    await clearStaffSiteSessions({ signedOutStartup: true });
    await pending;
    expect(postSignal?.aborted).toBe(true);
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["POST"]);
  });

  it("posts credentials only to the fixed HTTPS endpoint with redirect and timeout controls", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await preparePrivatePreviewSession(Promise.resolve("private-test-token"));
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://preview.njpbs.org/__cms-session", {
      method: "POST", credentials: "include", redirect: "error",
      headers: { Authorization: "Bearer private-test-token" },
      signal: expect.any(AbortSignal),
    });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000);
  });

  it("does not establish a session when sign-out happens during token retrieval", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetch);
    let resolveToken!: (token: string) => void;
    const pending = preparePrivatePreviewSession(new Promise<string>(resolve => { resolveToken = resolve; }));
    await clearStaffSiteSessions();
    resolveToken("private-test-token");
    await pending;
    expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ["https://preview.njpbs.org/__cms-session", "DELETE"],
    ]);
  });

  it("aborts an in-flight session POST before deleting sessions at sign-out", async () => {
    let postSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, options: RequestInit) => {
      if (options.method === "POST") {
        postSignal = options.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          postSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      expect(postSignal?.aborted).toBe(true);
      return Promise.resolve({ ok: true, status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const pending = preparePrivatePreviewSession(Promise.resolve("private-test-token"));
    await Promise.resolve();
    expect(postSignal?.aborted).toBe(false);
    await clearStaffSiteSessions();
    await expect(pending).resolves.toBeUndefined();
    expect(postSignal?.aborted).toBe(true);
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual(["POST", "DELETE"]);
  });

  it.each(["denied", "network", "timeout"])("retains navigation fallback after %s", async (failure) => {
    const fetch = vi.fn();
    if (failure === "denied") fetch.mockResolvedValue({ ok: false, status: 403 });
    else fetch.mockRejectedValue(new DOMException("Request failed", failure === "timeout" ? "TimeoutError" : "NetworkError"));
    vi.stubGlobal("fetch", fetch);
    await expect(preparePrivatePreviewSession(Promise.resolve("private-test-token"))).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});


describe("development staff sites", () => {
  it("admits configured development origins only in a development build", async () => {
    vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", "development"); vi.resetModules();
    try {
      const dev = await import("../src/lib/staff-site");
      expect(dev.staffSiteDestination("https://dev-public.example.org/about/")?.hostname).toBe("dev-public.example.org");
      expect(dev.staffSiteDestination("https://dev-preview.example.org/p/abcdefghijklmnopqrst/")?.hostname).toBe("dev-preview.example.org");
      expect(dev.staffSiteDestination("https://preview.njpbs.org/")).toBeNull();
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });

  it("keeps signed-out startup cookie cleanup at the configured development Admin", async () => {
    vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", "development"); vi.resetModules();
    try {
      const dev = await import("../src/lib/staff-site");
      const fetch = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("window", { location: { origin: "https://dev-admin.example.org" } });
      await dev.clearStaffSiteSessions({ signedOutStartup: true });
      expect(fetch.mock.calls.map(([url, options]) => [url, options.method, options.credentials])).toEqual([
        ["https://dev-public.example.org/__cms-session", "DELETE", "include"],
        ["https://dev-preview.example.org/__cms-session", "DELETE", "include"],
      ]);
    } finally {
      vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules();
    }
  });
});
