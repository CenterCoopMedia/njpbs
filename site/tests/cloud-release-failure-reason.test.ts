// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudReleaseFailureReason, type CloudReleaseFailureStage } from "../scripts/no-build-cloud-release";
import { PublicWorkerActivationOperatorError, requestCloudflareJson } from "../scripts/activate-public-worker-candidate";
const stages: CloudReleaseFailureStage[] = ["source check", "input read", "artifact restore", "release verification", "candidate upload", "context retention", "activation"];
describe("bounded cloud release failure reasons", () => {
  it.each(stages)("names %s while excluding arbitrary error text, URL/query, headers and provider body", stage => {
    const reason = cloudReleaseFailureReason(stage, Object.assign(new Error("PRIVATE Authorization Bearer fixture https://example.test/?token=fixture " + "body".repeat(1000)), { statusCode: 403 }));
    expect(reason.startsWith(`${stage}:`)).toBe(true); expect(reason).toContain("HTTP 403");
    expect(reason.length).toBeLessThanOrEqual(300); expect(reason).not.toMatch(/PRIVATE|Authorization|Bearer|https?:|token=|body/);
  });
  it("reads only the activation operator's exact existing status sentence and never a raw provider message", () => {
    expect(cloudReleaseFailureReason("activation", new PublicWorkerActivationOperatorError("The Cloudflare API returned HTTP 403"))).toContain("HTTP 403");
    expect(cloudReleaseFailureReason("activation", new PublicWorkerActivationOperatorError("The Cloudflare API returned HTTP 403 PRIVATE body"))).not.toContain("HTTP");
    expect(cloudReleaseFailureReason("activation", new Error("HTTP 403 PRIVATE body"))).not.toContain("HTTP");
  });
  it("refuses malformed statuses and does not invoke arbitrary error getters", () => {
    for (const status of ["403", NaN, Infinity, -1, 600, 10000, { token: "PRIVATE" }]) expect(cloudReleaseFailureReason("activation", { status })).not.toContain("HTTP");
    const error = Object.defineProperty({}, "status", { get: () => { throw new Error("PRIVATE getter"); } });
    expect(cloudReleaseFailureReason("activation", error)).toMatch(/^activation:/);
    expect(cloudReleaseFailureReason("__proto__" as CloudReleaseFailureStage, error)).not.toMatch(/PRIVATE|__proto__/);
  });
  it("keeps the storage SDK's HTTP status while discarding the rest of its metadata and error", () => {
    const reason = cloudReleaseFailureReason("input read", { message: "PRIVATE provider body", $metadata: { httpStatusCode: 403, requestId: "PRIVATE request" } });
    expect(reason).toContain("HTTP 403"); expect(reason).not.toMatch(/PRIVATE|requestId|provider body/);
  });
});

describe("the refused Cloudflare call", () => {
  afterEach(() => vi.unstubAllGlobals());
  const account = "a".repeat(32), zone = "b".repeat(32);
  const refused = (url: string, answer: () => Promise<Response>) => {
    vi.stubGlobal("fetch", answer);
    return requestCloudflareJson({ url, method: "GET", token: "PRIVATE-token" }).then(() => { throw new Error("Expected a refusal"); }, error => error);
  };
  const body = JSON.stringify({ success: false, errors: [{ code: 10000, message: "PRIVATE provider body" }], messages: ["PRIVATE"] });
  it("is named with its method, path, status and Cloudflare code", async () => {
    const error = await refused(`https://api.cloudflare.com/client/v4/zones/${zone}/workers/routes?account.id=${account}`,
      async () => new Response(body, { status: 403 }));
    expect(error).toBeInstanceOf(PublicWorkerActivationOperatorError);
    const reason = cloudReleaseFailureReason("activation", error);
    expect(reason).toContain("(HTTP 403; GET /zones/:id/workers/routes; Cloudflare code 10000)");
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).not.toMatch(/PRIVATE|https?:|account\.id|[a-f0-9]{32}/);
  });
  it("is named when the request does not complete, and without codes when the body is not JSON", async () => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`;
    expect(cloudReleaseFailureReason("activation", await refused(url, async () => { throw new TypeError("PRIVATE fetch failed"); })))
      .toBe("activation: The public Worker activation did not complete (GET /accounts/:id/workers/scripts).");
    expect(cloudReleaseFailureReason("activation", await refused(url, async () => new Response("PRIVATE <html>", { status: 502 }))))
      .toBe("activation: The public Worker activation did not complete (HTTP 502; GET /accounts/:id/workers/scripts).");
  });
});
