// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cloudReleaseFailureReason, type CloudReleaseFailureStage } from "../scripts/no-build-cloud-release";
import { PublicWorkerActivationOperatorError } from "../scripts/activate-public-worker-candidate";
import { createRequire } from "node:module";
const load = createRequire(import.meta.url);
const { PublicDeploymentStateError } = load("../../functions/lib/public-deployment-pointer.js");
const { operatorRefusal } = load("../../functions/lib/operator-refusal.js");
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
  // Dev release 2026-11-26: four activation attempts recorded only "(HTTP 409)".
  it("keeps the fixed sentence of a marked project refusal and never an unmarked error", () => {
    const owner = operatorRefusal(Object.assign(new Error("This Post cannot use instant publication."), { status: 409, code: "post_publication_unavailable" }));
    expect(cloudReleaseFailureReason("activation", owner))
      .toBe("activation: The public Worker activation did not complete (HTTP 409): This Post cannot use instant publication.");
    expect(cloudReleaseFailureReason("activation", operatorRefusal(new PublicDeploymentStateError("The public Worker candidate is invalid"))))
      .toContain("(HTTP 409): The public Worker candidate is invalid.");
    // The class accepts any text, so only a literal call site carries the mark.
    expect(cloudReleaseFailureReason("activation", new PublicDeploymentStateError("PRIVATE caller text"))).not.toContain("PRIVATE");
    for (const error of [
      Object.assign(new Error("PRIVATE provider body"), { status: 409 }),
      Object.assign(new Error("PRIVATE provider body"), { status: 409, headers: {} }),
      { status: 409, message: "PRIVATE plain object", [Symbol.for("njpbs.operator-refusal")]: "yes" },
      operatorRefusal(Object.assign(new Error("Conflict at https://example.test/?token=PRIVATE"), { status: 409 })),
      operatorRefusal(Object.assign(new Error("PRIVATE\nmultiline body"), { status: 409 })),
    ]) expect(cloudReleaseFailureReason("activation", error)).not.toMatch(/PRIVATE|https?:/);
  });
  it("keeps a marked refusal whose Post id contains a credential word or is long", () => {
    const id = `token-${"a".repeat(122)}`;
    const reason = cloudReleaseFailureReason("activation", operatorRefusal(Object.assign(
      new Error(`Instant Post ${id} has no Post record. Restore the Post or retire its publication owner.`), { status: 409 })));
    expect(reason).toContain(`Instant Post ${id} has no Post record`);
    expect(reason.length).toBeLessThanOrEqual(300);
  });
  it("keeps the exhaustion notice whole when a refusal fills the reason", () => {
    const reason = cloudReleaseFailureReason("activation", operatorRefusal(new PublicDeploymentStateError("x".repeat(200))), true);
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason.endsWith("Automatic retry attempts exhausted; original release ownership is retained.")).toBe(true);
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
