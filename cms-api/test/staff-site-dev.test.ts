import { createExecutionContext, env as workerEnv } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StaffSiteEntrypoint, type CmsApiEnv } from "../src/index";

let privateKey: CryptoKey;
let publicKey: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = { ...await exportJWK(pair.publicKey), kid: "dev-staff", alg: "RS256" };
});
afterEach(() => vi.unstubAllGlobals());

function environment(): CmsApiEnv {
  return { ...workerEnv, PREVIEW_RENDERER: undefined, CMS_EDGE_ORIGIN_SECRET: "fixture-edge", ALLOW_LOCAL_ORIGINS: "false",
    CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net", ADMIN_ORIGIN: "https://dev-admin.example.org",
  };
}
async function token(project = "njpbs-site-dev") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ auth_time: now, email: "staff@example.test", email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "dev-staff" })
    .setIssuer(`https://securetoken.google.com/${project}`).setAudience(project)
    .setSubject(crypto.randomUUID()).setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
}

describe("dev staff-site RPC and Function HTTP contract", () => {
  it.each([204, 401, 403, 500])("uses dev admission and preserves Function status %s", async (status) => {
    const bearer = await token();
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://www.googleapis.com/service_accounts/")) return Response.json({ keys: [publicKey] });
      expect(url).toBe("https://us-central1-njpbs-site-dev.cloudfunctions.net/cmsValidateSiteAccess");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${bearer}`);
      expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe("fixture-edge");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status });
    });
    vi.stubGlobal("fetch", network);
    const entrypoint = new StaffSiteEntrypoint(createExecutionContext(), environment());
    expect(await entrypoint.getSiteEnvironment()).toBe("development");
    expect(await entrypoint.validateAccess(bearer, "203.0.113.6")).toBe(status === 500 ? 503 : status);
    expect(network.mock.calls.some(([url]) => url.endsWith("/cmsValidateSiteAccess"))).toBe(true);
  });
  it("refuses a production Firebase token without calling dev admission", async () => {
    const network = vi.fn(async (url: string) => {
      expect(url.startsWith("https://www.googleapis.com/service_accounts/")).toBe(true);
      return Response.json({ keys: [publicKey] });
    });
    vi.stubGlobal("fetch", network);
    const entrypoint = new StaffSiteEntrypoint(createExecutionContext(), environment());
    expect(await entrypoint.validateAccess(await token("njpbs-site"), "203.0.113.7")).toBe(401);
  });
  it.each([
    { FIREBASE_PROJECT_ID: "njpbs-site" }, { CMS_DEPLOYMENT_ENVIRONMENT: "production" },
    { FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" }, { ADMIN_ORIGIN: "https://admin.njpbs.org" },
  ])("refuses mixed dev configuration %j", async (mixed) => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const entrypoint = new StaffSiteEntrypoint(createExecutionContext(), { ...environment(), ...mixed });
    expect(await entrypoint.getSiteEnvironment()).toBeNull();
    expect(await entrypoint.validateAccess(await token(), "203.0.113.8")).toBe(503);
    expect(network).not.toHaveBeenCalled();
  });
});
