import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import devWorker from "../workers/src/staff-site-dev-worker";
import { serveDevStaffSite, serveStaffSite } from "../workers/src/staff-site-worker";
import { servePreviewRequest } from "../workers/src/preview-worker";

const token = "header.payload.signature";
function harness(status = 204) {
  return {
    validateAccess: vi.fn(async () => status),
    validatePreviewAccess: vi.fn(async () => status),
    serve: vi.fn(async () => new Response("private page", {
      headers: { "set-cookie": "bad=value", "cache-control": "public, max-age=9999" },
    })),
  };
}
function request(path = "/about/", headers = {}, method = "GET") {
  return new Request(`https://dev-public.example.org${path}`, { method, headers });
}

describe("staff site admission", () => {
  it("returns unauthenticated guide navigation to the CMS with the exact destination", async () => {
    const deps = harness();
    const result = await serveStaffSite(request("/admin/docs/?x=1", { "sec-fetch-dest": "document" }), deps);
    expect(result.status).toBe(302);
    expect(new URL(result.headers.get("location")!).searchParams.get("staffSite")).toBe("https://dev-public.example.org/admin/docs/?x=1");
    expect(deps.serve).not.toHaveBeenCalled();
  });
  it("requires authentication for guide assets and HEAD requests", async () => {
    for (const method of ["GET", "HEAD"]) {
      const deps = harness();
      expect((await serveStaffSite(request("/images/admin-guide/home.webp", {}, method), deps)).status).toBe(401);
      expect(deps.serve).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["/admin/docs/", "GET"],
    ["/images/admin-guide/home.webp", "GET"],
    ["/images/admin-guide/home.webp", "HEAD"],
  ])("refuses a signed-in account without CMS admission for %s %s", async (path, method) => {
    const deps = harness(403);
    const result = await serveStaffSite(request(path, {
      cookie: `__Host-njpbs-staff=${token}`,
    }, method), deps);
    expect(result.status).toBe(403);
    expect(deps.serve).not.toHaveBeenCalled();
  });
  it.each([
    ["/admin/docs/", "GET"],
    ["/images/admin-guide/home.webp", "GET"],
    ["/images/admin-guide/home.webp", "HEAD"],
  ])("serves %s %s to an admitted CMS account", async (path, method) => {
    const deps = harness();
    const result = await serveStaffSite(request(path, {
      cookie: `__Host-njpbs-staff=${token}`,
    }, method), deps);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(method === "HEAD" ? "" : "private page");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("x-robots-tag")).toBe(
      "noindex, nofollow, noarchive",
    );
    expect(deps.serve).toHaveBeenCalledOnce();
  });
  it("exchanges only an Admin-origin bearer token for a host-only cookie", async () => {
    const deps = harness();
    const result = await serveStaffSite(request("/__cms-session", {
      origin: "https://admin.njpbs.org", authorization: `Bearer ${token}`,
    }, "POST"), deps);
    expect(result.status).toBe(204);
    expect(deps.validateAccess).toHaveBeenCalledWith(token);
    expect(result.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Strict");
    expect(result.headers.get("set-cookie")).not.toContain("Domain=");
    expect(result.headers.get("location")).toBeNull();
    expect(deps.serve).not.toHaveBeenCalled();
  });
  it("refuses cross-origin login and logout", async () => {
    for (const method of ["POST", "DELETE"]) {
      const deps = harness();
      expect((await serveStaffSite(request("/__cms-session", {
        origin: "https://evil.example", authorization: `Bearer ${token}`,
      }, method), deps)).status).toBe(403);
      expect(deps.validateAccess).not.toHaveBeenCalled();
    }
  });
  it("clears the cookie on CMS logout", async () => {
    const result = await serveStaffSite(request("/__cms-session", { origin: "https://admin.njpbs.org" }, "DELETE"), harness());
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("checks every request and strips credentials in both directions", async () => {
    const deps = harness();
    for (const host of ["dev-public.example.org", "preview.njpbs.org"]) {
      const path = host === "preview.njpbs.org" ? "/p/AbCdEfGhIjKlMnOpQrSt/contact/" : "/";
      const result = await serveStaffSite(new Request(`https://${host}${path}`, {
        headers: { cookie: `__Host-njpbs-staff=${token}`, authorization: "Bearer attacker", range: "bytes=0-99" },
      }), deps);
      expect(await result.text()).toBe("private page");
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("set-cookie")).toBeNull();
      const sent = deps.serve.mock.calls.at(-1)![0];
      expect(sent.headers.get("cookie")).toBeNull();
      expect(sent.headers.get("authorization")).toBeNull();
      expect(sent.headers.get("range")).toBe("bytes=0-99");
    }
    expect(deps.validateAccess).toHaveBeenCalledTimes(1);
    expect(deps.validatePreviewAccess).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 503])("fails closed for admission status %s", async (status) => {
    const deps = harness(status);
    expect((await serveStaffSite(request("/", { cookie: `__Host-njpbs-staff=${token}` }), deps)).status).toBe(status);
    expect(deps.serve).not.toHaveBeenCalled();
  });
  it("fails closed on service outages and duplicate cookies", async () => {
    const deps = harness();
    deps.validateAccess.mockRejectedValue(new Error("offline"));
    expect((await serveStaffSite(request("/", { cookie: `__Host-njpbs-staff=${token}` }), deps)).status).toBe(503);
    expect((await serveStaffSite(request("/", { cookie: `__Host-njpbs-staff=${token}; __Host-njpbs-staff=other` }), deps)).status).toBe(401);
    expect(deps.serve).not.toHaveBeenCalled();
  });
});

describe("dev cutover at the Worker boundary", () => {
  const audience = "dev-app-audience";
  const team = "https://access.example.org";
  const certs = `${team}/cdn-cgi/access/certs`;
  const now = new Date("2026-10-09T17:00:00Z");
  let signer: CryptoKey;
  let key: Record<string, unknown>;
  let worker: typeof import("../workers/src/staff-site-worker").default;
  let network: ReturnType<typeof vi.fn>;
  let env: Parameters<typeof worker.fetch>[1];

  beforeAll(async () => {
    const { generateKeyPair, exportJWK } = await import("jose");
    const pair = await generateKeyPair("RS256", { extractable: true });
    signer = pair.privateKey;
    key = { ...await exportJWK(pair.publicKey), kid: "first", alg: "RS256", use: "sig" };
  });
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    worker = (await import("../workers/src/staff-site-worker")).default;
    network = vi.fn(async (input: Request | string) => {
      if (String(input) === certs) return Response.json({ keys: [key] });
      const request = input as Request;
      expect(new URL(request.url).hostname).toBe("dev-public.example.org");
      for (const name of ["cookie", "authorization", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret"]) {
        expect(request.headers.has(name)).toBe(false);
      }
      return new Response("dev bytes", { headers: { "access-control-allow-origin": "https://admin.njpbs.org" } });
    });
    vi.stubGlobal("fetch", network);
    // Service bindings are process/RPC boundaries. Each accepts only its own fixture session.
    env = {
      DEV_STAFF_SITE_MODE: "development", DEV_ACCESS_AUDIENCE: audience, CMS_DEV_ACCESS_ORIGIN: team,
      STAFF_ACCESS: {
        validateAccess: async (token: string) => token === "prod-token" ? 204 : 401,
        validatePreviewAccess: async (token: string) => token === "prod-token" ? 204 : 401,
      },
      DEV_STAFF_ACCESS: {
        getSiteEnvironment: async () => "development",
        validateAccess: async (token: string) => token === "dev-token" ? 204 : 401,
      },
      PREVIEW: { fetch: async () => new Response("preview bytes") },
    } as typeof env;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  async function jwt(claims: Record<string, unknown> = {}, kid = "first", signingKey = signer) {
    const { SignJWT } = await import("jose");
    return new SignJWT({
      type: "app", iss: team, aud: [audience], sub: "", common_name: "publisher123.access",
      iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 3600, ...claims,
    }).setProtectedHeader({ alg: "RS256", kid }).sign(signingKey);
  }
  it.each([undefined, "", "http://access.example.org"])("refuses machine admission without a valid configured issuer %s", async origin => {
    env.CMS_DEV_ACCESS_ORIGIN = origin;
    const result = await worker.fetch(new Request("https://dev-public.example.org/", { headers: { "cf-access-jwt-assertion": await jwt() } }), env);
    expect(result.status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });

  function read(host = "dev-public.example.org", headers: Record<string, string> = {}, method = "GET") {
    const path = host === "preview.njpbs.org" ? "/p/AbCdEfGhIjKlMnOpQrSt/contact/" : "/_publication.json";
    return worker.fetch(new Request(`https://${host}${path}`, { headers, method }), env);
  }

  it.each([undefined, "production"])("keeps dev on production by default (%s)", async (mode) => {
    env.DEV_STAFF_SITE_MODE = mode;
    expect((await read(undefined, { cookie: "__Host-njpbs-staff=prod-token" })).status).toBe(200);
    expect((await read(undefined, { cookie: "__Host-njpbs-staff=dev-token" })).status).toBe(401);
    expect((await read(undefined, { "cf-access-jwt-assertion": await jwt() })).status).toBe(401);
  });
  it.each([
    ["dev-public.example.org", "production", "https://admin.njpbs.org", "prod-token", 204],
    ["dev-public.example.org", "production", "https://dev-admin.example.org", "prod-token", 403],
    ["dev-public.example.org", "development", "https://dev-admin.example.org", "dev-token", 204],
    ["dev-public.example.org", "development", "https://admin.njpbs.org", "dev-token", 403],
    ["dev-public.example.org", "development", "https://dev-admin.example.org", "prod-token", 401],
    ["preview.njpbs.org", "development", "https://admin.njpbs.org", "prod-token", 204],
    ["preview.njpbs.org", "development", "https://dev-admin.example.org", "dev-token", 403],
    ["dev-public.example.org", "development", "https://dev-admin.example.org.evil.test", "dev-token", 403],
  ])("enforces host/origin matrix %s %s %s", async (host, mode, origin, token, status) => {
    env.DEV_STAFF_SITE_MODE = mode;
    const result = await worker.fetch(new Request(`https://${host}/__cms-session`, {
      method: "POST", headers: { origin, authorization: `Bearer ${token}` },
    }), env);
    expect(result.status).toBe(status);
    if (status === 204) {
      expect(result.headers.get("access-control-allow-origin")).toBe(origin);
      expect(result.headers.get("set-cookie")).toContain(`__Host-njpbs-staff=${token};`);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["bad mode", "missing binding", "production binding", "missing audience", "binding outage"])("fails closed on %s", async (failure) => {
    if (failure === "bad mode") env.DEV_STAFF_SITE_MODE = "true";
    if (failure === "missing binding") delete (env as Partial<typeof env>).DEV_STAFF_ACCESS;
    if (failure === "production binding") env.DEV_STAFF_ACCESS.getSiteEnvironment = async () => "production";
    if (failure === "missing audience") env.DEV_ACCESS_AUDIENCE = "";
    if (failure === "binding outage") env.DEV_STAFF_ACCESS.getSiteEnvironment = async () => { throw new Error("offline"); };
    expect((await read(undefined, { "cf-access-jwt-assertion": await jwt() })).status).toBe(503);
    expect(network).not.toHaveBeenCalled();
    expect(await (await read("preview.njpbs.org", { cookie: "__Host-njpbs-staff=prod-token" })).text()).toBe("preview bytes");
  });
  it("restricts preflight and logout to dev Admin after cutover", async () => {
    for (const method of ["OPTIONS", "DELETE"]) {
      for (const origin of ["https://dev-admin.example.org", "https://admin.njpbs.org"]) {
        const result = await worker.fetch(new Request("https://dev-public.example.org/__cms-session", { method, headers: { origin } }), env);
        expect(result.status).toBe(origin === "https://dev-admin.example.org" ? 204 : 403);
        if (result.status === 204) expect(result.headers.get("access-control-allow-credentials")).toBe("true");
        if (method === "DELETE" && result.status === 204) expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
      }
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("keeps preview response bytes and headers identical across cutover", async () => {
    const before = await read("preview.njpbs.org", { cookie: "__Host-njpbs-staff=prod-token" });
    env.DEV_STAFF_SITE_MODE = "production";
    const after = await read("preview.njpbs.org", { cookie: "__Host-njpbs-staff=prod-token" });
    expect(after.status).toBe(before.status);
    expect([...after.headers]).toEqual([...before.headers]);
    expect(await after.text()).toBe(await before.text());
  });
  it("rejects wrong hosts, unsafe methods and HMAC assertions", async () => {
    const { SignJWT } = await import("jose");
    const assertion = await new SignJWT({ iss: team, aud: audience, exp: now.getTime() / 1000 + 3600 })
      .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("fixture-key-that-is-at-least-32-bytes"));
    expect((await read(undefined, { "cf-access-jwt-assertion": assertion })).status).toBe(401);
    expect((await read("njpbs.org", { cookie: "__Host-njpbs-staff=prod-token" })).status).toBe(404);
    expect((await read(undefined, { "cf-access-jwt-assertion": await jwt() }, "POST")).status).toBe(405);
    expect(network).not.toHaveBeenCalled();
  });
  it("admits signed machine GET and HEAD without forwarding credentials", async () => {
    for (const method of ["GET", "HEAD"]) {
      const result = await read(undefined, { "cf-access-jwt-assertion": await jwt(),
        "cf-access-client-id": "fixture", "cf-access-client-secret": "fixture", authorization: "Bearer fixture", cookie: "other=fixture" }, method);
      expect(result.status).toBe(200);
      expect(await result.text()).toBe(method === "HEAD" ? "" : "dev bytes");
    }
    expect(network.mock.calls.filter(([url]) => url === certs)).toHaveLength(1);
  });
  it.each([
    { aud: ["wrong-app"] }, { iss: "https://other.cloudflareaccess.com" },
    { exp: now.getTime() / 1000 }, { exp: undefined }, { iat: now.getTime() / 1000 + 60 },
    { nbf: now.getTime() / 1000 + 60 }, { sub: "human-user" }, { email: "staff@example.test" },
    { email: "" }, { common_name: undefined }, { common_name: "" }, { type: "org" },
  ])("rejects invalid machine claims %j", async (claims) => {
    expect((await read(undefined, { "cf-access-jwt-assertion": await jwt(claims) })).status).toBe(401);
    expect(network.mock.calls.every(([url]) => url === certs)).toBe(true);
  });
  it("rejects anonymous, raw client credentials, malformed and forged tokens", async () => {
    const { generateKeyPair } = await import("jose");
    const forged = await jwt({}, "first", (await generateKeyPair("RS256")).privateKey);
    for (const headers of [{}, { "cf-access-client-id": "fixture", "cf-access-client-secret": "fixture" },
      { "cf-access-jwt-assertion": "bad.jwt" }, { "cf-access-jwt-assertion": forged }]) {
      expect((await read(undefined, headers)).status).toBe(401);
    }
    expect(network.mock.calls.every(([url]) => url === certs)).toBe(true);
  });
  it("requires dev staff cookies for Access email identities and strips the JWT", async () => {
    const assertion = await jwt({ sub: "human", email: "staff@example.test", common_name: undefined });
    expect((await read(undefined, { "cf-access-jwt-assertion": assertion })).status).toBe(401);
    const result = await read(undefined, { "cf-access-jwt-assertion": assertion,
      cookie: "__Host-njpbs-staff=dev-token", origin: "https://dev-admin.example.org" });
    expect(result.status).toBe(200);
    expect(result.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
    expect(result.headers.get("access-control-allow-credentials")).toBe("true");
  });
  it.each([403, 429, 503, "outage"])("exposes dev error %s only to the dev Admin origin", async (status) => {
    env.DEV_STAFF_ACCESS.validateAccess = async () => {
      if (status === "outage") throw new Error("unavailable");
      return status as number;
    };
    for (const origin of ["https://dev-admin.example.org", "https://admin.njpbs.org", "https://evil.example"]) {
      const result = await read(undefined, { cookie: "__Host-njpbs-staff=dev-token", origin });
      expect(result.status).toBe(status === "outage" ? 503 : status);
      expect(result.headers.get("access-control-allow-origin")).toBe(origin === "https://dev-admin.example.org" ? origin : null);
      expect(result.headers.get("access-control-allow-credentials")).toBe(origin === "https://dev-admin.example.org" ? "true" : null);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("exposes dev binding outages without changing production error headers", async () => {
    env.DEV_STAFF_ACCESS.getSiteEnvironment = async () => { throw new Error("offline"); };
    const dev = await read(undefined, { origin: "https://dev-admin.example.org" });
    expect(dev.status).toBe(503);
    expect(dev.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
    env.STAFF_ACCESS.validateAccess = async () => 503;
    env.STAFF_ACCESS.validatePreviewAccess = async () => 503;
    const production = await read("preview.njpbs.org", { origin: "https://admin.njpbs.org", cookie: "__Host-njpbs-staff=prod-token" });
    expect(production.status).toBe(503);
    expect(production.headers.has("access-control-allow-origin")).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });
  it("redirects dev navigation to dev Admin and exposes a credentialed 401 for receipt renewal", async () => {
    const result = await read(undefined, { origin: "https://dev-admin.example.org" });
    expect(result.status).toBe(401);
    expect(result.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
    const nav = await read(undefined, { "sec-fetch-dest": "document" });
    expect(new URL(nav.headers.get("location")!).origin).toBe("https://dev-admin.example.org");
  });
  it("does not admit machine tokens on preview", async () => {
    expect((await read("preview.njpbs.org", { "cf-access-jwt-assertion": await jwt() })).status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["offline", "redirect", "invalid JSON"])("fails closed when certs are %s", async (failure) => {
    network.mockImplementation(async () => {
      if (failure === "offline") throw new Error("offline");
      return new Response("invalid", { status: failure === "redirect" ? 302 : 200 });
    });
    expect((await read(undefined, { "cf-access-jwt-assertion": await jwt() })).status).toBe(401);
  });
  it("expires the cert cache and refuses stale keys during an outage", async () => {
    const assertion = await jwt();
    expect((await read(undefined, { "cf-access-jwt-assertion": assertion })).status).toBe(200);
    vi.setSystemTime(new Date(now.getTime() + 5 * 60_000));
    network.mockRejectedValue(new Error("certs unavailable"));
    expect((await read(undefined, { "cf-access-jwt-assertion": assertion })).status).toBe(401);
  });
  it("refreshes rotated keys after cooldown and limits unknown-key refreshes", async () => {
    const { generateKeyPair, exportJWK } = await import("jose");
    await read(undefined, { "cf-access-jwt-assertion": await jwt() });
    const pair = await generateKeyPair("RS256", { extractable: true });
    const assertion = await jwt({}, "rotated", pair.privateKey);
    expect((await read(undefined, { "cf-access-jwt-assertion": assertion })).status).toBe(401);
    expect(network.mock.calls.filter(([url]) => url === certs)).toHaveLength(1);
    vi.setSystemTime(new Date(now.getTime() + 30_001));
    network.mockImplementationOnce(async () => Response.json({ keys: [{ ...await exportJWK(pair.publicKey), kid: "rotated" }] }));
    expect((await read(undefined, { "cf-access-jwt-assertion": assertion })).status).toBe(200);
    expect(network.mock.calls.filter(([url]) => url === certs)).toHaveLength(2);
  });
});


describe("isolated dev gateway", () => {
  function env() {
    return {
      DEV_ACCESS_AUDIENCE: "dev-app-audience",
      DEV_PUBLIC: { fetch: (request: Request) => fetch(request) },
      DEV_STAFF_ACCESS: {
        getSiteEnvironment: async () => "development",
        validateAccess: async (token: string) => token === "dev-token" ? 204 : 401,
      },
    } as Parameters<typeof devWorker.fetch>[1];
  }
  afterEach(() => vi.unstubAllGlobals());

  it("ships only the dev route and dev service bindings", () => {
    const config = JSON.parse(readFileSync("workers/wrangler.staff-sites.dev.jsonc", "utf8"));
    expect(config.name).toBe("njpbs-dev-staff-sites");
    expect(config.main).toBe("src/staff-site-dev-worker.ts");
    expect(config.routes).toEqual([{ pattern: "dev-public.example.org/*", zone_name: "njpbs.org" }]);
    expect(config.services).toEqual([
      { binding: "DEV_STAFF_ACCESS", service: "template-dev-cms-api", entrypoint: "StaffSiteEntrypoint" },
      { binding: "DEV_PUBLIC", service: "template-dev-public" },
    ]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    const shared = JSON.parse(readFileSync("workers/wrangler.staff-sites.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
    expect(shared.routes).toEqual([
      { pattern: "preview.njpbs.org/*", zone_name: "njpbs.org" },
    ]);
  });
  it.each(["https://preview.njpbs.org", "https://njpbs.org", "https://dev-public.example.org.evil.test", "http://dev-public.example.org"])("refuses another origin %s", async (origin) => {
    const result = await devWorker.fetch(new Request(`${origin}/`, { headers: { cookie: "__Host-njpbs-staff=dev-token" } }), env());
    expect(result.status).toBe(404);
  });
  it.each(["missing audience", "missing binding", "production binding"])("fails closed with %s", async (failure) => {
    const config = env();
    if (failure === "missing audience") config.DEV_ACCESS_AUDIENCE = "";
    if (failure === "missing binding") delete (config as Partial<typeof config>).DEV_STAFF_ACCESS;
    if (failure === "production binding") config.DEV_STAFF_ACCESS.getSiteEnvironment = async () => "production";
    const result = await devWorker.fetch(request("/_publication.json", { origin: "https://dev-admin.example.org" }), config);
    expect(result.status).toBe(503);
    expect(result.headers.get("access-control-allow-origin")).toBe("https://dev-admin.example.org");
  });
  it("admits dev sessions without any production bindings", async () => {
    vi.stubGlobal("fetch", async (request: Request) => {
      expect(request.url).toBe("https://dev-public.example.org/posts/dev-proof/");
      expect(request.headers.has("cookie")).toBe(false);
      expect(request.headers.has("CF-Access-Client-Id")).toBe(false);
      expect(request.headers.has("CF-Access-Client-Secret")).toBe(false);
      expect(request.redirect).toBe("manual");
      return new Response("published dev page");
    });
    const result = await devWorker.fetch(request("/posts/dev-proof/", { cookie: "__Host-njpbs-staff=dev-token" }), env());
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("published dev page");
    expect((await devWorker.fetch(request("/", { cookie: "__Host-njpbs-staff=prod-token" }), env())).status).toBe(401);
  });
  it("uses only the dev Admin session origin", async () => {
    for (const origin of ["https://dev-admin.example.org", "https://admin.njpbs.org"]) {
      const result = await devWorker.fetch(request("/__cms-session", { origin, authorization: "Bearer dev-token" }, "POST"), env());
      expect(result.status).toBe(origin === "https://dev-admin.example.org" ? 204 : 403);
    }
  });
});


describe("fresh dev staff admission", () => {
  const now = Date.parse("2026-10-10T16:00:00Z");
  function jwt(exp = now / 1000 + 3600, sub = "staff") {
    return `e30.${btoa(JSON.stringify({ exp, sub })).replace(/=+$/, "")}.fixture`;
  }
  function setup() {
    let status = 204;
    const validateAccess = vi.fn(async (_token: string, _ip: string) => status);
    const config = {
      DEV_ACCESS_AUDIENCE: "dev-audience",
      DEV_STAFF_ACCESS: { getSiteEnvironment: async () => "development", validateAccess },
    } as Parameters<typeof serveDevStaffSite>[1];
    const origin = vi.fn(async () => new Response("private page"));
    const read = (path = "/", bearer = jwt(), ip = "203.0.113.1", method = "GET") =>
      serveDevStaffSite(request(path, {
        cookie: `__Host-njpbs-staff=${bearer}`, "cf-connecting-ip": ip,
      }, method), config, origin);
    const exchange = (bearer = jwt()) => serveDevStaffSite(request("/__cms-session", {
      authorization: `Bearer ${bearer}`, origin: "https://dev-admin.example.org", "cf-connecting-ip": "203.0.113.1",
    }, "POST"), config, origin);
    return { config, validateAccess, origin, read, exchange, deny: (value: number) => { status = value; } };
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it("checks every HTML and asset request and keeps timing without public caching", async () => {
    const h = setup();
    for (const path of ["/", "/_astro/site.css", "/_astro/site.js", "/brand/logo.svg", "/brand/font.woff2", "/posts/story/"]) {
      const result = await h.read(path);
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      expect(result.headers.get("server-timing")).toBe("staff-access;dur=0, staff-admission;dur=0, staff-origin;dur=0");
    }
    expect(h.validateAccess).toHaveBeenCalledTimes(6);
    expect((await h.read("/brand/logo.svg", jwt(), "203.0.113.1", "HEAD")).status).toBe(200);
    expect(h.validateAccess).toHaveBeenCalledTimes(7);
  });

  it.each([401, 403, 429, 503])("honors fresh role, token and rate-limit refusal %s immediately after admission", async status => {
    const h = setup();
    expect((await h.read()).status).toBe(200);
    h.deny(status);
    expect((await h.read("/_astro/site.js")).status).toBe(status);
    expect((await h.read()).status).toBe(status);
    expect((await h.read("/_astro/site.js")).status).toBe(status);
    expect(h.validateAccess).toHaveBeenCalledTimes(4);
    expect(h.origin).toHaveBeenCalledTimes(1);
  });

  it("honors backend token expiry", async () => {
    const h = setup();
    const bearer = jwt(now / 1000 + 1);
    expect((await h.read("/", bearer)).status).toBe(200);
    h.deny(401);
    vi.setSystemTime(now + 1000);
    expect((await h.read("/", bearer)).status).toBe(401);
  });

  it("rechecks authorization after slow validation", async () => {
    const h = setup();
    h.validateAccess.mockImplementationOnce(async () => { vi.setSystemTime(now + 5000); return 204; });
    expect((await h.read()).status).toBe(200);
    h.deny(403);
    expect((await h.read()).status).toBe(403);
  });

  it("does not share admission across tokens, IPs, audiences or bindings", async () => {
    const h = setup();
    expect((await h.read()).status).toBe(200);
    h.deny(403);
    expect((await h.read("/", jwt(undefined, "another-staff"))).status).toBe(403);
    expect((await h.read("/", jwt(), "203.0.113.2")).status).toBe(403);
    h.config.DEV_ACCESS_AUDIENCE = "another-audience";
    expect((await h.read()).status).toBe(403);
    const other = setup(); other.deny(403);
    expect((await other.read()).status).toBe(403);
  });

  it("checks the development binding even with warm admission", async () => {
    const h = setup();
    expect((await h.read()).status).toBe(200);
    h.config.DEV_STAFF_ACCESS.getSiteEnvironment = async () => "production";
    expect((await h.read()).status).toBe(503);
    expect(h.origin).toHaveBeenCalledTimes(1);
  });

  it("validates session exchanges and subsequent reads independently", async () => {
    const h = setup();
    expect((await h.exchange()).status).toBe(204);
    expect((await h.read()).status).toBe(200);
    expect(h.validateAccess).toHaveBeenCalledTimes(2);
    h.deny(401);
    expect((await h.exchange()).status).toBe(401);
    expect((await h.read()).status).toBe(401);
  });

  it("never serves a stale success during a validation outage", async () => {
    const h = setup();
    expect((await h.read()).status).toBe(200);
    h.validateAccess.mockRejectedValue(new Error("unavailable"));
    expect((await h.read()).status).toBe(503);
    expect((await h.read()).status).toBe(503);
    expect(h.origin).toHaveBeenCalledTimes(1);
  });

  it.each(["opaque-token", "e30.e30.signature", `e30.${btoa('{"exp":"9999999999"}').replace(/=+$/, "")}.signature`])("does not cache tokens without numeric expiry: %s", async bearer => {
    const h = setup();
    expect((await h.read("/", bearer)).status).toBe(200);
    h.deny(401);
    expect((await h.read("/", bearer)).status).toBe(401);
  });

  it("keeps authorization fresh after a large admitted burst", async () => {
    const h = setup();
    for (let i = 0; i < 257; i++) expect((await h.read("/", jwt(undefined, `staff-${i}`))).status).toBe(200);
    h.deny(403);
    expect((await h.read("/", jwt(undefined, "staff-0"))).status).toBe(403);
  });
});


describe("private preview gateway and artifact boundary", () => {
  const queueId = "AbCdEfGhIjKlMnOpQrSt";
  const now = Date.parse("2026-10-12T12:00:00Z");
  const read = (path = `/p/${queueId}/contact/`, method = "GET", headers = {}) =>
    new Request(`https://preview.njpbs.org${path}`, { method,
      headers: { cookie: `__Host-njpbs-staff=${token}`, ...headers } });

  it.each(["p", "s"])("binds %s HTML and shared resources, including HEAD, to the same queue", async kind => {
    const deps = harness();
    for (const path of ["contact/", "_astro/shared.css", "_astro/shared.js", "brand/logo.svg", "fonts/shared.woff2"]) {
      for (const method of ["GET", "HEAD"]) {
        const result = await serveStaffSite(read(`/${kind}/${queueId}/${path}`, method), deps);
        expect(result.status).toBe(200);
        if (method === "HEAD") expect(await result.text()).toBe("");
        expect(deps.validatePreviewAccess).toHaveBeenLastCalledWith(token, { schemaVersion: 1, queueId, persistent: kind === "s" });
      }
    }
    expect(deps.validateAccess).not.toHaveBeenCalled();
    expect(deps.validatePreviewAccess).toHaveBeenCalledTimes(10);
  });
  it.each(["/_astro/shared.css", "/brand/logo.svg", "/p/invalid/contact/", `/p/${queueId}/data.txt`,
    `/p/${queueId}/%2fcontact/`, `/p/${queueId}//contact/`])("refuses an unbound path %s", async path => {
    const deps = harness();
    for (const method of ["GET", "HEAD"]) {
      const result = await serveStaffSite(read(path, method), deps);
      expect(result.status).toBe(404);
      expect(await result.text()).toBe(method === "HEAD" ? "" : "Preview not found");
    }
    expect(deps.serve).not.toHaveBeenCalled();
    expect(deps.validatePreviewAccess).not.toHaveBeenCalled();
  });
  it.each([404, 429, 503])("does not read artifact bytes after preview refusal %s", async status => {
    const deps = harness(status);
    for (const method of ["GET", "HEAD"]) {
      const result = await serveStaffSite(read(undefined, method), deps);
      expect(result.status).toBe(status);
      expect(result.headers.get("cache-control")).toBe("private, no-store");
      if (method === "HEAD") expect(await result.text()).toBe("");
    }
    expect(deps.serve).not.toHaveBeenCalled();
  });
  it("checks every request after admission, including stale sessions and record changes", async () => {
    const deps = harness();
    expect((await serveStaffSite(read(), deps)).status).toBe(200);
    deps.validatePreviewAccess.mockResolvedValueOnce(404);
    expect((await serveStaffSite(read(`/p/${queueId}/_astro/shared.js`), deps)).status).toBe(404);
    deps.validatePreviewAccess.mockResolvedValueOnce(401);
    expect((await serveStaffSite(read(), deps)).status).toBe(401);
    deps.validatePreviewAccess.mockRejectedValueOnce(new Error("offline"));
    expect((await serveStaffSite(read(undefined, "HEAD"), deps)).status).toBe(503);
    expect(deps.serve).toHaveBeenCalledOnce();
  });
  it("fails closed with an older service binding", async () => {
    const { validatePreviewAccess: _unused, ...deps } = harness();
    expect((await serveStaffSite(read(), deps)).status).toBe(503);
    expect(deps.serve).not.toHaveBeenCalled();
  });
  it.each(["GET", "HEAD"])("returns identical missing-object and denied-record responses for %s", async method => {
    const denied = await serveStaffSite(read(undefined, method), harness(404));
    const deps = harness();
    deps.serve.mockResolvedValueOnce(new Response("object missing", { status: 404,
      headers: { "x-origin-only": "private", "content-type": "text/plain", "x-frame-options": "DENY" } }));
    const missing = await serveStaffSite(read(undefined, method), deps);
    expect(missing.status).toBe(denied.status);
    expect([...missing.headers]).toEqual([...denied.headers]);
    expect(await missing.text()).toBe(await denied.text());
  });
  it("ignores browser identity claims and strips all credentials before object access", async () => {
    const deps = harness();
    expect((await serveStaffSite(read(undefined, "GET", {
      authorization: "Bearer attacker", "x-njpbs-preview-access": "1", "x-record-owner": "attacker",
      "cf-access-jwt-assertion": "forged", "cf-access-client-secret": "fixture", range: "bytes=0-99",
    }), deps)).status).toBe(200);
    expect(deps.validatePreviewAccess).toHaveBeenCalledWith(token, { schemaVersion: 1, queueId, persistent: false });
    expect([...deps.serve.mock.calls[0][0].headers]).toEqual([["range", "bytes=0-99"]]);
  });
  it("refuses expired retained artifacts after active staff admission", async () => {
    const metadata = { httpEtag: '"fixture"', uploaded: new Date(now), customMetadata: {
      schema: "njpbs-preview-v1", queueid: queueId, expiresatms: String(now - 1), contentkey: "a".repeat(64),
    } };
    const bucket = {
      get: vi.fn(async () => ({ ...metadata, body: new Response("old retained draft").body! })),
      head: vi.fn(async () => metadata),
    };
    const deps = { ...harness(), serve: (request: Request) => servePreviewRequest(request, { bucket, now: () => now }) };
    expect((await serveStaffSite(read(`/s/${queueId}/contact/`), deps)).status).toBe(410);
    deps.validatePreviewAccess.mockResolvedValueOnce(404);
    expect((await serveStaffSite(read(`/s/${queueId}/_astro/shared.css`), deps)).status).toBe(404);
    expect(bucket.get).toHaveBeenCalledTimes(1);
  });
});
