// @vitest-environment node
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const origin = "https://dev-public.example.org";
const identity = { schemaVersion: 1, buildBatchId: "dev-one", generation: 1, commitSha: "a".repeat(40) };
const schedule = { schemaVersion: 1, publication: identity, source: "pbs-tvss", checkedAt: "2026-10-09T12:00:00Z",
  timeZone: "America/New_York", days: [] };
const contactKey = createHash("sha256").update("cmsPages/contact").digest("hex");
let contactRoute: Record<string, unknown>;
let admitted: boolean;
let sessionStatus: number;
let refreshResponse: (() => Promise<Response>) | undefined;
let requests: { url: string; options: RequestInit }[];
let firebase: typeof import("../src/lib/firebase") | undefined;
function idToken() {
  const now = Math.floor(Date.now() / 1000);
  return [ { alg: "RS256" }, { sub: "dev-staff", iat: now, exp: now + 3600, auth_time: now } ]
    .map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".") + ".fixture";
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", "development");
  vi.stubEnv("VITE_USE_EMULATORS", "false");
  vi.stubEnv("VITE_FIREBASE_API_KEY", "fixture-key");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "njpbs-site-dev");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "njpbs-site-dev.firebaseapp.com");
  vi.stubEnv("VITE_FIREBASE_APP_ID", "synthetic-dev-app-id");
  vi.stubEnv("VITE_FIREBASE_EXPECTED_DEV_APP_ID", "synthetic-dev-app-id");
  vi.stubGlobal("window", { location: { origin: "https://dev-admin.example.org" } });
  contactRoute = { path: "/contact/", source: "site" };
  admitted = false;
  sessionStatus = 204;
  refreshResponse = undefined;
  requests = [];
  vi.stubGlobal("fetch", async (input: string, options: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, options });
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken")) {
      return Response.json({ idToken: idToken(), refreshToken: "fixture-refresh", expiresIn: "3600", localId: "dev-staff" });
    }
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:lookup")) {
      return Response.json({ users: [{ localId: "dev-staff", email: "staff@example.test", emailVerified: true }] });
    }
    if (url.includes("securetoken.googleapis.com/v1/token")) {
      if (refreshResponse) return refreshResponse();
      return Response.json({ access_token: idToken(), refresh_token: "fixture-refresh", expires_in: "3600", user_id: "dev-staff" });
    }
    if (url === `${origin}/__cms-session`) {
      expect(options).toMatchObject({ method: "POST", credentials: "include", redirect: "error" });
      expect(new Headers(options.headers).get("authorization")).toMatch(/^Bearer /);
      admitted = sessionStatus === 204;
      return new Response(null, { status: sessionStatus });
    }
    expect(new URL(url).origin).toBe(origin);
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    if (!admitted) return new Response(null, { status: 401 });
    const path = new URL(url).pathname;
    if (path === "/_publication.json") return Response.json(identity);
    if (path === "/_content-status.json") return Response.json({ ...identity, collections: ["cmsPages", "cmsPosts"], routes: [{ path: "/", source: "site" }, contactRoute] });
    if (path === "/_schedule-sources.json") return Response.json(schedule);
    if (path === "/contact/") return new Response("<html>Contact</html>", { headers: { "content-type": "text/html" } });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
});
afterEach(async () => {
  if (firebase) {
    const { signOut } = await import("firebase/auth");
    const { deleteApp } = await import("firebase/app");
    await signOut(firebase.auth);
    await deleteApp(firebase.app);
    firebase = undefined;
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function signIn() {
  firebase = await import("../src/lib/firebase");
  const { signInWithCustomToken } = await import("firebase/auth");
  await signInWithCustomToken(firebase.auth, "fixture-custom-token");
}
const signal = () => new AbortController().signal;
const siteReads = () => requests.filter(({ url }) => url.startsWith(origin) && !url.endsWith("/__cms-session"));
const exchanges = () => requests.filter(({ url }) => url.endsWith("/__cms-session"));

describe("dev receipt reads over HTTP", () => {
  it("opens one session for parallel inventory reads and retries with cookies", async () => {
    await signIn();
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    const result = await loadPublicContentStatus(signal());
    expect(result.routes).toEqual([{ path: "/", source: "site" }, { path: "/contact/", source: "site" }]);
    expect(exchanges()).toHaveLength(1);
    expect(siteReads()).toHaveLength(4);
    for (const { options } of siteReads()) expect(options).toMatchObject({ credentials: "include", cache: "no-store", redirect: "error" });
  });
  it("opens the schedule session and retains the code-context publication query", async () => {
    await signIn();
    const { loadScheduleSourceSnapshot } = await import("../src/lib/schedule-source-snapshot");
    const result = await loadScheduleSourceSnapshot(signal());
    expect(result.days).toEqual([]);
    expect(exchanges()).toHaveLength(1);
    expect(siteReads().filter(({ url }) => url.includes("_publication.json")).every(({ url }) => url.includes("cms-context=code"))).toBe(true);
  });
  it("reuses a valid cookie without fetching an ID token or opening a session", async () => {
    admitted = true;
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    const result = await loadPublicContentStatus(signal());
    expect(result.routes).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(exchanges()).toHaveLength(0);
  });
  it("reads a published Contact route from the Pages inventory without a runtime read", async () => {
    await signIn();
    contactRoute = { path: "/contact/", source: "cms", sourceVersion: 7, contentKey: contactKey };
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    expect((await loadPublicContentStatus(signal())).routes).toContainEqual({
      path: "/contact/", source: "cms", sourceVersion: 7, contentKey: contactKey,
    });
    expect(exchanges()).toHaveLength(1);
    expect(siteReads()).toHaveLength(4);
    expect(siteReads().every(({ url, options }) =>
      ["/_publication.json", "/_content-status.json"].includes(new URL(url).pathname) &&
      options.credentials === "include",
    )).toBe(true);
  });
  it("rejects an aborted caller while token renewal continues for another reader", async () => {
    await signIn();
    let finishRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    refreshResponse = () => {
      refreshStarted();
      return new Promise<Response>(resolve => { finishRefresh = resolve; });
    };
    const { fetchStaffSiteRead } = await import("../src/lib/staff-site-read");
    const controller = new AbortController();
    const aborted = fetchStaffSiteRead(`${origin}/_publication.json`, { signal: controller.signal });
    const outcome = aborted.then(() => "resolved", error => error);
    const continuing = fetchStaffSiteRead(`${origin}/_publication.json`, { signal: signal() });
    await started;
    controller.abort();
    try {
      // An event-loop turn proves rejection before the stalled network reply is released.
      expect(await Promise.race([outcome, setImmediate("still pending")])).toMatchObject({ name: "AbortError" });
      expect(exchanges()).toHaveLength(0);
    } finally {
      finishRefresh(Response.json({ access_token: idToken(), refresh_token: "fixture-refresh", expires_in: "3600", user_id: "dev-staff" }));
      await continuing;
    }
    expect(await (await continuing).json()).toEqual(identity);
    expect(exchanges()).toHaveLength(1);
    expect(siteReads()).toHaveLength(3);
  });
  it.each([401, 403, 503])("does not read receipts after failed session exchange %s", async (status) => {
    await signIn();
    sessionStatus = status;
    const { loadScheduleSourceSnapshot } = await import("../src/lib/schedule-source-snapshot");
    await expect(loadScheduleSourceSnapshot(signal())).rejects.toThrow("could not be opened");
    expect(siteReads()).toHaveLength(2);
  });
  it("refuses renewal when signed out", async () => {
    firebase = await import("../src/lib/firebase");
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    await expect(loadPublicContentStatus(signal())).rejects.toThrow("Sign in");
    expect(exchanges()).toHaveLength(0);
  });
  it("does not send a token from an unexpected Admin origin", async () => {
    vi.stubGlobal("window", { location: { origin: "https://admin.njpbs.org" } });
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    await expect(loadPublicContentStatus(signal())).rejects.toThrow("origin was refused");
    expect(requests).toHaveLength(0);
  });
  it("does not retry a second 401", async () => {
    await signIn();
    const nativeFixture = fetch;
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      const response = await nativeFixture(url, options);
      if (url.endsWith("/__cms-session")) admitted = false;
      return response;
    });
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    await expect(loadPublicContentStatus(signal())).rejects.toThrow("unavailable");
    expect(exchanges()).toHaveLength(1);
    expect(siteReads()).toHaveLength(4);
  });
  it("cancels renewal on sign-out before the refreshed token reaches the site", async () => {
    await signIn();
    const fixtureFetch = fetch;
    let finishRefresh!: (response: Response) => void;
    let refreshStarted!: () => void;
    const started = new Promise<void>(resolve => { refreshStarted = resolve; });
    refreshResponse = () => {
      refreshStarted();
      return new Promise<Response>(resolve => { finishRefresh = resolve; });
    };
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    const { clearStaffSiteSessions } = await import("../src/lib/staff-site");
    const read = loadPublicContentStatus(signal());
    const outcome = read.then(() => null, error => error);
    await started;
    // The logout HTTP requests are a network boundary; no origin state is needed.
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      return fixtureFetch(url, options);
    });
    await clearStaffSiteSessions();
    finishRefresh(Response.json({ access_token: idToken(), refresh_token: "fixture-refresh", expires_in: "3600", user_id: "dev-staff" }));
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(exchanges()).toHaveLength(0);
    expect(siteReads()).toHaveLength(2);
  });
  it("stops an aborted read before opening a session", async () => {
    const { fetchStaffSiteRead } = await import("../src/lib/staff-site-read");
    const controller = new AbortController();
    controller.abort();
    await expect(fetchStaffSiteRead(`${origin}/_publication.json`, { signal: controller.signal })).rejects.toThrow();
    expect(exchanges()).toHaveLength(0);
  });
  it("preserves production URLs, request options and response data", async () => {
    vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", "production");
    vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      expect(new URL(url).origin).toBe("https://njpbs.org");
      expect(options).toEqual({ signal: expect.any(AbortSignal), credentials: "omit", cache: "no-store" });
      return Response.json(url.includes("_schedule-sources.json") ? schedule : url.includes("_content-status.json")
        ? { ...identity, collections: ["cmsPages", "cmsPosts"], routes: [] } : identity);
    });
    const { loadPublicContentStatus } = await import("../src/lib/public-content-status");
    const { loadScheduleSourceSnapshot } = await import("../src/lib/schedule-source-snapshot");
    expect((await loadPublicContentStatus(signal())).identity.buildBatchId).toBe("dev-one");
    expect((await loadScheduleSourceSnapshot(signal())).days).toEqual([]);
    expect(requests).toHaveLength(4);
    expect(exchanges()).toHaveLength(0);
  });
});
