import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StaffSiteEntrypoint, validateStaffSiteAccess, type CmsApiEnv } from "../src/index";
import { leaveOneRateToken } from "./rate-budget-fixture";

let privateKey: CryptoKey;
let publicKey: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = { ...await exportJWK(pair.publicKey), kid: "preview-staff", alg: "RS256" };
});
afterEach(() => vi.unstubAllGlobals());
const target = { schemaVersion: 1 as const, queueId: "AbCdEfGhIjKlMnOpQrSt", persistent: false };
const environment = (): CmsApiEnv => ({ ...workerEnv, PREVIEW_RENDERER: undefined, CMS_EDGE_ORIGIN_SECRET: "fixture-edge",
  FIREBASE_PROJECT_ID: "demo-njpbs", FUNCTIONS_ORIGIN: "https://functions.example.test", ADMIN_ORIGIN: "https://admin.njpbs.org",
});
async function token() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ auth_time: now, email: "staff@example.test", email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "preview-staff" })
    .setIssuer("https://securetoken.google.com/demo-njpbs").setAudience("demo-njpbs")
    .setSubject(crypto.randomUUID()).setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
}
function setup(response: () => Response) {
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("https://www.googleapis.com/service_accounts/")) return Response.json({ keys: [publicKey] });
    expect(url).toBe("https://functions.example.test/cmsValidateSiteAccess");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe("fixture-edge");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.redirect).toBe("manual");
    expect(JSON.parse(init?.body as string)).toEqual({ preview: target });
    return response();
  });
  vi.stubGlobal("fetch", network);
  return { network, rpc: new StaffSiteEntrypoint(createExecutionContext(), environment()) };
}

describe("preview service RPC and Function HTTP boundary", () => {
  it.each([
    [204, "1", 204], [204, null, 503], [204, "2", 503],
    [401, null, 401], [404, null, 404], [403, null, 503], [302, null, 503], [500, null, 503],
  ])("requires a preview decision acknowledgment for %s %s", async (status, acknowledgment, expected) => {
    const h = setup(() => new Response(null, { status: status as number,
      headers: acknowledgment ? { "x-njpbs-preview-access": acknowledgment as string } : {} }));
    const bearer = await token();
    expect(await h.rpc.validatePreviewAccess(bearer, "203.0.113.9", target)).toBe(expected);
    const origin = h.network.mock.calls.find(([url]) => url.endsWith("/cmsValidateSiteAccess"))!;
    expect(new Headers(origin[1]?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
  });
  it("refuses absent or malformed identity before generic admission", async () => {
    const h = setup(() => new Response(null, { status: 204 }));
    expect(await h.rpc.validatePreviewAccess(await token(), "203.0.113.10", undefined as unknown as typeof target)).toBe(404);
    expect(await h.rpc.validatePreviewAccess(await token(), "203.0.113.10", { ...target, queueId: "invalid" })).toBe(404);
    expect(h.network).not.toHaveBeenCalled();
  });
  it("refuses an invalid token without calling the Function", async () => {
    const h = setup(() => new Response(null, { status: 204 }));
    expect(await h.rpc.validatePreviewAccess("bad/token", "203.0.113.10", target)).toBe(401);
    expect(h.network).not.toHaveBeenCalled();
  });
  it("does not convert an origin outage into admission", async () => {
    const h = setup(() => { throw new Error("offline"); });
    await expect(h.rpc.validatePreviewAccess(await token(), "203.0.113.11", target)).rejects.toThrow("offline");
  });
  it("shares the existing per-actor preview burst limit", async () => {
    const h = setup(() => new Response(null, { status: 204, headers: { "x-njpbs-preview-access": "1" } }));
    const bearer = await token();
    const deps = { now: () => Date.now(), fetchOrigin: h.network as typeof fetch };
    const instant = Date.now(); deps.now = () => instant;
    expect(await validateStaffSiteAccess(environment(), bearer, "203.0.113.12", deps, target)).toBe(204);
    await leaveOneRateToken("actor", "staffSite", decodeJwt(bearer).sub!, 239, instant);
    expect(await validateStaffSiteAccess(environment(), bearer, "203.0.113.12", deps, target)).toBe(204);
    expect(await validateStaffSiteAccess(environment(), bearer, "203.0.113.12", deps, target)).toBe(429);
    expect(h.network.mock.calls.filter(([url]) => url.endsWith("/cmsValidateSiteAccess"))).toHaveLength(2);
  });
});
