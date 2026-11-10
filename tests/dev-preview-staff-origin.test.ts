import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/src/dev-preview-staff-worker";

const origin = "https://dev-preview.example.org";
const admin = "https://dev-admin.example.org";
const queueId = "abcdefghijklmnopqrst";
const path = `/p/${queueId}/index.html`;
const makeEnv = (status = 204) => ({
  DEV_ACCESS_AUDIENCE: "fixture-preview-audience", CMS_DEV_ACCESS_ORIGIN: "https://access.example.org",
  DEV_STAFF_ACCESS: {
    getSiteEnvironment: async () => "development",
    validateAccess: async (token: string) => token === "dev-staff-token" ? status : 401,
    validatePreviewAccess: vi.fn(async (token: string) => token === "dev-staff-token" ? status : 401),
  },
  DEV_PREVIEW: { fetch: vi.fn(async () => new Response("saved snapshot", { headers: { "set-cookie": "origin=private" } })) },
}) as unknown as Parameters<typeof worker.fetch>[1];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("dev exact-preview staff gateway", () => {
  it.each(["p", "s"])("checks exact queue identity for /%s/ on every read", async prefix => {
    const env = makeEnv();
    const generic = vi.spyOn(env.DEV_STAFF_ACCESS, "validateAccess");
    for (const method of ["GET", "HEAD"]) {
      const result = await worker.fetch(new Request(`${origin}/${prefix}/${queueId}/index.html`, {
        method, headers: { cookie: "__Host-njpbs-staff=dev-staff-token", "cf-connecting-ip": "192.0.2.1" },
      }), env);
      expect(result.status).toBe(200);
      expect(env.DEV_STAFF_ACCESS.validatePreviewAccess).toHaveBeenLastCalledWith(
        "dev-staff-token", "192.0.2.1", { schemaVersion: 1, queueId, persistent: prefix === "s" },
      );
    }
    expect(env.DEV_STAFF_ACCESS.validatePreviewAccess).toHaveBeenCalledTimes(2);
    expect(generic).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("blocks generic staff when queue authorization refuses %s", async method => {
    const env = makeEnv();
    vi.mocked(env.DEV_STAFF_ACCESS.validatePreviewAccess).mockResolvedValue(404);
    const result = await worker.fetch(new Request(origin + path, {
      method, headers: { cookie: "__Host-njpbs-staff=dev-staff-token" },
    }), env);
    expect(result.status).toBe(404);
    expect(await result.text()).toBe(method === "HEAD" ? "" : "Preview not found");
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when preview authority is unavailable", async () => {
    const env = makeEnv();
    vi.mocked(env.DEV_STAFF_ACCESS.validatePreviewAccess).mockRejectedValue(new Error("offline"));
    expect((await worker.fetch(new Request(origin + path, {
      headers: { cookie: "__Host-njpbs-staff=dev-staff-token" },
    }), env)).status).toBe(503);
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it.each(["/abcdefghijklmnopqrst/index.html", "/p/short/index.html", "/p/abcdefghijklmnopqrst/private.exe"])(
    "refuses invalid artifact path %s before admission", async invalidPath => {
      const env = makeEnv();
      expect((await worker.fetch(new Request(origin + invalidPath, {
        headers: { cookie: "__Host-njpbs-staff=dev-staff-token" },
      }), env)).status).toBe(404);
      expect(env.DEV_STAFF_ACCESS.validatePreviewAccess).not.toHaveBeenCalled();
      expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "HEAD"])("admits %s using fresh dev staff authority and strips all credentials", async method => {
    const env = makeEnv();
    const network = vi.fn(() => { throw new Error("No public fetch allowed"); });
    vi.stubGlobal("fetch", network);
    const upstream = vi.spyOn(env.DEV_PREVIEW, "fetch");
    const result = await worker.fetch(new Request(origin + path, { method, headers: {
      cookie: "__Host-njpbs-staff=dev-staff-token; CF_Authorization=user-access",
      authorization: "Bearer dev-staff-token", "cf-access-client-id": "fixture-id",
      "cf-access-client-secret": "fixture-secret", "cf-access-jwt-assertion": "fixture-jwt",
      origin: admin, range: "bytes=0-10",
    } }), env);
    expect(result.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const sent = upstream.mock.calls[0][0] as Request;
    expect(sent.url).toBe(origin + path);
    expect(sent.method).toBe(method);
    expect([...sent.headers]).toEqual([["range", "bytes=0-10"]]);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("access-control-allow-origin")).toBe(admin);
    expect(await result.text()).toBe(method === "HEAD" ? "" : "saved snapshot");
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["", "__Host-njpbs-staff=production-token"])("refuses absent or wrong-project staff session %s", async cookie => {
    const env = makeEnv();
    const result = await worker.fetch(new Request(origin + path, { headers: { cookie } }), env);
    expect(result.status).toBe(401);
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it.each([403, 429, 503])("preserves fresh backend refusal %s", async status => {
    const env = makeEnv(status);
    const result = await worker.fetch(new Request(origin + path, { headers: { cookie: "__Host-njpbs-staff=dev-staff-token" } }), env);
    expect(result.status).toBe(status);
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it("does not admit a cryptographically valid publisher service JWT", async () => {
    const env = makeEnv();
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ type: "app", sub: "", common_name: "publisher123.access" })
      .setProtectedHeader({ alg: "RS256", kid: "preview-service" }).setIssuer("https://access.example.org")
      .setAudience("fixture-preview-audience").setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
    const network = vi.fn(async () => Response.json({ keys: [{ ...await exportJWK(publicKey), kid: "preview-service", alg: "RS256" }] }));
    vi.stubGlobal("fetch", network);
    const result = await worker.fetch(new Request(origin + path, { headers: { "cf-access-jwt-assertion": token } }), env);
    expect(result.status).toBe(401);
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["production", "unknown"])("refuses mismatched API environment %s", async mode => {
    const env = makeEnv();
    vi.spyOn(env.DEV_STAFF_ACCESS, "getSiteEnvironment").mockResolvedValue(mode);
    expect((await worker.fetch(new Request(origin + path, { headers: { cookie: "__Host-njpbs-staff=dev-staff-token" } }), env)).status).toBe(503);
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it.each(["https://preview.njpbs.org", "https://dev-public.example.org", "http://dev-preview.example.org", "https://dev-preview.example.org:444"])("refuses foreign host %s", async host => {
    const env = makeEnv();
    expect((await worker.fetch(new Request(host + path), env)).status).toBe(404);
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it("establishes a session only from dev Admin with fresh backend admission", async () => {
    const env = makeEnv();
    for (const from of ["https://admin.njpbs.org", "https://evil.example.test"]) {
      expect((await worker.fetch(new Request(origin + "/__cms-session", { method: "POST", headers: { origin: from, authorization: "Bearer dev-staff-token" } }), env)).status).toBe(403);
    }
    const admitted = await worker.fetch(new Request(origin + "/__cms-session", { method: "POST", headers: { origin: admin, authorization: "Bearer dev-staff-token" } }), env);
    expect(admitted.status).toBe(204);
    expect(admitted.headers.get("set-cookie")).toBe("__Host-njpbs-staff=dev-staff-token; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=3600");
    expect(env.DEV_PREVIEW.fetch).not.toHaveBeenCalled();
  });

  it.each([302, 401, 403])("withholds private origin challenge/redirect %s", async status => {
    const env = makeEnv();
    vi.spyOn(env.DEV_PREVIEW, "fetch").mockResolvedValue(new Response("private challenge", { status, headers: { location: "https://foreign.example.test/" } }));
    const result = await worker.fetch(new Request(origin + path, { headers: { cookie: "__Host-njpbs-staff=dev-staff-token" } }), env);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe("Site access unavailable");
    expect(result.headers.has("location")).toBe(false);
  });
});
