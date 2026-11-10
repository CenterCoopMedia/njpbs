// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cloudReleaseFailureReason, type CloudReleaseFailureStage } from "../scripts/no-build-cloud-release";
import { PublicWorkerActivationOperatorError } from "../scripts/activate-public-worker-candidate";
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
  it.each(stages)("makes exhausted %s attempts explicit without copying the provider failure", stage => {
    const reason = cloudReleaseFailureReason(stage, { status: 503, message: "PRIVATE provider body" }, true);
    expect(reason).toContain(`${stage}:`);
    expect(reason).toContain("HTTP 503");
    expect(reason).toContain("Automatic retry attempts exhausted");
    expect(reason).toContain("original release ownership is retained");
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).not.toMatch(/PRIVATE|provider body/);
  });
});
