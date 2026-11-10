import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import devWorker from "../../workers/src/staff-site-dev-worker";
import { verifyFirebaseIdToken } from "../../cms-api/src/firebase-auth";
import { checkProductionSessionRefusal, productionProbeRequestAllowed } from "../../scripts/check-production-session-refusal.mjs";

const ADMIN = "https://admin.njpbs.org/";
const SIGN_IN = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-public-key";
const ROUTE = "https://dev-public.example.org/__cms-session";
const access = { "CF-Access-Client-Id": "fixture.access", "CF-Access-Client-Secret": "fake-access-secret" };
const credential = { email: "staff@example.org", password: "fake-password" };
const now = Date.now();
let privateKey, publicKey;
beforeAll(async () => { ({ privateKey, publicKey } = await generateKeyPair("RS256")); });
async function fixtureToken(project = "njpbs-site", expired = false) {
  const seconds = Math.floor(now / 1000);
  return new SignJWT({ auth_time: seconds }).setProtectedHeader({ alg: "RS256" })
    .setSubject("staff-fixture").setIssuer(`https://securetoken.google.com/${project}`)
    .setAudience(project).setIssuedAt(seconds).setExpirationTime(expired ? seconds - 1 : seconds + 3600).sign(privateKey);
}

// This fake browser models the form boundary and response only. The dev fetch
// below runs the real gateway and real JWT verifier with an ephemeral test key.
function fakeBrowser(token) {
  const events = [];
  const password = { fill: vi.fn(async value => events.push(value ? "password-typed" : "password-cleared")),
    evaluate: vi.fn(async () => true), dispose: vi.fn() };
  const field = { waitFor: vi.fn(), fill: vi.fn(), elementHandle: async () => password };
  const page = {
    setDefaultTimeout: vi.fn(), goto: vi.fn(), url: () => ADMIN,
    locator: selector => selector === "body" ? { ariaSnapshot: async () => events.push("snapshot") }
      : { getByRole: () => ({ click: async () => events.push("submitted") }) },
    getByLabel: () => field,
    waitForResponse: async predicate => {
      const reply = { url: () => SIGN_IN, request: () => ({ method: () => "POST" }),
        status: () => 200, json: async () => ({ idToken: token, localId: "staff-fixture" }) };
      expect(predicate(reply)).toBe(true);
      return reply;
    },
  };
  const context = { route: vi.fn(), newPage: async () => page };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => events.push("browser-closed")) };
  browser.version = () => "156.0.8078.73";
  browser.newBrowserCDPSession = async () => ({
    send: async () => ({ arguments: ["/opt/google/chrome/chrome", "--enable-automation"] }),
    detach: async () => {},
  });
  return { events, password, context, page, browser, chromium: { launch: vi.fn(async () => browser) } };
}
async function harness() {
  const token = await fixtureToken();
  const fake = fakeBrowser(token);
  const readCredential = vi.fn(async () => { fake.events.push("credential-read"); return credential; });
  const readAccess = vi.fn(async () => { fake.events.push("access-read"); return access; });
  return { ...fake, token, readCredential, readAccess, now: () => now };
}

describe("production-session refusal method", () => {
  it.each(["old-version", "sandbox-disabled"])("refuses unsafe Chrome (%s) before credential intake or CMS requests", async (kind) => {
    const h = await harness();
    if (kind === "old-version") h.browser.version = () => "156.0.8078.72";
    else h.browser.newBrowserCDPSession = async () => ({
      send: async () => ({ arguments: ["/opt/google/chrome/chrome", "--no-sandbox"] }),
      detach: async () => {},
    });
    const fetchImpl = vi.fn();
    expect(await checkProductionSessionRefusal({ ...h, fetchImpl }))
      .toEqual({ status: null, route: ROUTE, refused: false, audienceMismatch: "unproven" });
    expect(h.readCredential).not.toHaveBeenCalled();
    expect(h.browser.newContext).not.toHaveBeenCalled();
    expect(h.browser.close).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks CMS writes, profile registration, Firestore and every other auth action", () => {
    expect(productionProbeRequestAllowed(ADMIN, "GET")).toBe(true);
    expect(productionProbeRequestAllowed(`${ADMIN}assets/login.js`, "GET")).toBe(true);
    expect(productionProbeRequestAllowed(SIGN_IN, "POST")).toBe(true);
    for (const [url, method] of [
      [ADMIN, "POST"], ["https://api.njpbs.org/registerStaffProfile", "POST"],
      ["https://firestore.googleapis.com/v1/projects/njpbs-site/databases/(default)/documents:commit", "POST"],
      ["https://identitytoolkit.googleapis.com/v1/accounts:update?key=fixture", "POST"],
      ["https://evil.invalid/", "GET"], ["https://user:password@admin.njpbs.org/", "GET"],
      ["https://admin.njpbs.org.evil.invalid/", "GET"], ["http://admin.njpbs.org/", "GET"],
    ]) expect(productionProbeRequestAllowed(url, method)).toBe(false);
  });

  it("presents the fresh production token at the dev gateway's real admission boundary with all networking faked", async () => {
    const h = await harness();
    const content = vi.fn();
    const validateAccess = vi.fn(async token => {
      try {
        await verifyFirebaseIdToken(token, "njpbs-site-dev", { keySet: async () => publicKey });
        return 204;
      } catch { return 401; }
    });
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(ROUTE);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(init.headers).toEqual({ ...access, origin: "https://dev-admin.example.org", authorization: `Bearer ${h.token}` });
      expect(init.body).toBeUndefined();
      return devWorker.fetch(new Request(url, init), {
        DEV_ACCESS_AUDIENCE: "fixture-access-audience",
        DEV_STAFF_ACCESS: { getSiteEnvironment: async () => "development", validateAccess },
        DEV_PUBLIC: { fetch: content },
      });
    });
    const result = await checkProductionSessionRefusal({ ...h, fetchImpl });
    expect(result).toEqual({ status: 401, route: ROUTE, refused: true, audienceMismatch: "production_token_refused_by_dev" });
    expect(validateAccess).toHaveBeenCalledWith(h.token, "missing");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(content).not.toHaveBeenCalled();
    expect(h.events).toEqual(["snapshot", "credential-read", "password-typed", "submitted", "password-cleared", "browser-closed", "access-read"]);
    expect(h.chromium.launch.mock.calls[0][0].chromiumSandbox).toBe(true);
    expect(h.browser.newContext).toHaveBeenCalledWith({ serviceWorkers: "block", acceptDownloads: false });
    const route = h.context.route.mock.calls[0][1];
    const blocked = { request: () => ({ url: () => "https://api.njpbs.org/registerStaffProfile", method: () => "POST" }), abort: vi.fn(), continue: vi.fn() };
    await route(blocked);
    expect(blocked.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(blocked.continue).not.toHaveBeenCalled();
    for (const secret of [h.token, credential.password, access["CF-Access-Client-Secret"]]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([200, 204, 302, 403, 429, 503, 401])("does not pass an unverified response (%i), export its body or follow its redirect", async status => {
    const h = await harness();
    const response = new Response(null, { status, headers: { location: `https://evil.invalid/${h.token}` } });
    const text = vi.spyOn(response, "text");
    const fetchImpl = vi.fn(async () => response);
    const result = await checkProductionSessionRefusal({ ...h, fetchImpl });
    expect(result).toEqual({ status, route: ROUTE, refused: false, audienceMismatch: "unproven" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(h.token);
  });

  it.each(["wrong-project", "expired", "malformed"])("does not send an invalid production session (%s) to dev", async kind => {
    const h = await harness();
    h.chromium = fakeBrowser(kind === "malformed" ? "bad" : await fixtureToken(kind === "wrong-project" ? "njpbs-site-dev" : "njpbs-site", kind === "expired")).chromium;
    const fetchImpl = vi.fn();
    expect((await checkProductionSessionRefusal({ ...h, fetchImpl })).refused).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.readAccess).not.toHaveBeenCalled();
  });

  it.each(["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "cache-control"])("does not pass a 401 with an invalid %s contract", async header => {
    const h = await harness();
    const headers = new Headers({ "access-control-allow-origin": "https://dev-admin.example.org",
      "access-control-allow-credentials": "true", "cache-control": "private, no-store" });
    if (header === "set-cookie") headers.set(header, `__Host-njpbs-staff=${h.token}`);
    else headers.delete(header);
    const result = await checkProductionSessionRefusal({ ...h, fetchImpl: async () => new Response(null, { status: 401, headers }) });
    expect(result.refused).toBe(false);
    expect(result.audienceMismatch).toBe("unproven");
    expect(JSON.stringify(result)).not.toContain(h.token);
  });

  it.each([false, true])("ignores only the Access cookie and still detects staff-cookie issuance (staff=%s)", async staff => {
    const h = await harness();
    const headers = new Headers({ "access-control-allow-origin": "https://dev-admin.example.org",
      "access-control-allow-credentials": "true", "cache-control": "private, no-store" });
    headers.append("set-cookie", "CF_Authorization=fake-access-cookie; Path=/; Secure; HttpOnly");
    if (staff) headers.append("set-cookie", `__Host-njpbs-staff=${h.token}; Path=/; Secure; HttpOnly`);
    const result = await checkProductionSessionRefusal({ ...h, fetchImpl: async () => new Response(null, { status: 401, headers }) });
    expect(result.refused).toBe(!staff);
    expect(result.audienceMismatch).toBe(staff ? "unproven" : "production_token_refused_by_dev");
    expect(JSON.stringify(result)).not.toContain("fake-access-cookie");
    expect(JSON.stringify(result)).not.toContain(h.token);
  });

  it("closes on cleanup failure and returns fixed fields when a dependency throws a secret", async () => {
    const h = await harness();
    h.password.fill.mockImplementation(async value => { if (value === "") throw new Error(h.token); });
    const fetchImpl = vi.fn();
    expect(await checkProductionSessionRefusal({ ...h, fetchImpl })).toEqual({ status: null, route: ROUTE, refused: false, audienceMismatch: "unproven" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(h.browser.close).toHaveBeenCalled();
  });
});
