import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const candidate = require("../../functions/lib/public-worker-candidate.js");
const sha = "a".repeat(40);
const input = { schemaVersion: 1, buildBatchId: "page-release", generation: 5, commitSha: sha,
  workerName: "njpbs-production", workerVersionId: "11111111-1111-4111-8111-111111111111",
  workerVersionTag: `cms-g5-${"d".repeat(16)}`, versionCreatedOn: "2026-10-12T12:00:00.000Z",
  artifactDigest: "d".repeat(64), artifactReceiptDigest: "e".repeat(64), publicationReceiptDigest: "f".repeat(64),
  mediaManifestDigest: "c".repeat(64), artifactFileCount: 100, artifactBytes: 1000000, wranglerVersion: "4.123.0" };
const contract = { schemaVersion: 1, rendererSha: sha, enabled: true, authoritative: true };
function version() {
  const message = candidate.publicWorkerCandidateMessage(input);
  return { expected: { tag: input.workerVersionTag, message }, value: {
    id: input.workerVersionId, metadata: { source: "wrangler", created_on: input.versionCreatedOn },
    annotations: { "workers/tag": input.workerVersionTag, "workers/message": message, "workers/triggered_by": "version_upload" },
    resources: { script: { etag: "script-etag" },
      script_runtime: { assets: JSON.parse(readFileSync(new URL("../fixtures/cloudflare/dev-worker-version-assets.json", import.meta.url), "utf8")) },
      bindings: [{ name: "ASSETS", type: "assets" },
        { name: "CMS_API", type: "service", service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint" },
        { name: "NO_BUILD_POST_FAMILIES", type: "plain_text", text: "posts" },
        { name: "NO_BUILD_POST_RENDERER_SHA", type: "plain_text", text: sha },
        { name: "NO_BUILD_PAGE_RENDERER_SHA", type: "plain_text", text: sha }] },
  } };
}
describe("immutable Page candidate capabilities", () => {
  it("projects optional exact Page capability beside existing Post capability", () => {
    expect(candidate.projectPublicWorkerCandidateInput({ ...input, noBuildPage: contract })).toMatchObject({ noBuildPage: contract });
    const receipt = version();
    expect(candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected)).toMatchObject({ noBuildPage: contract });
  });
  it("does not infer Page capability from an older Post candidate", () => {
    const receipt = version();
    receipt.value.resources.bindings.pop();
    expect(candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected).noBuildPage).toBeUndefined();
  });
  it("refuses incomplete routing, duplicate SHA metadata and mixed source", () => {
    const receipt = version();
    receipt.value.resources.script_runtime.assets.raw_run_worker_first = ["/posts/*", "/contact/"];
    expect(() => candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected)).toThrow();
    const duplicate = version();
    duplicate.value.resources.bindings.push({ name: "NO_BUILD_PAGE_RENDERER_SHA", type: "plain_text", text: sha });
    expect(() => candidate.projectCloudflareWorkerVersion(duplicate.value, duplicate.expected)).toThrow();
    expect(() => candidate.projectPublicWorkerCandidateInput({ ...input,
      noBuildPage: { ...contract, rendererSha: "b".repeat(40) } })).toThrow();
  });
});

it("independently rejects Page routing that does not intercept every route", () => {
  const receipt = version();
  // This Page-only version reaches the Page guard without a Post-family gate.
  receipt.value.resources.bindings = receipt.value.resources.bindings.filter(binding => binding.name !== "NO_BUILD_POST_FAMILIES");
  receipt.value.resources.script_runtime.assets.raw_run_worker_first = ["/contact/"];
  expect(() => candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected))
    .toThrow("The Page candidate must intercept every retained Page route");
});

it("attests the exact Data Hub composition marker together with its publication gate", () => {
  const receipt = version();
  receipt.value.resources.bindings.push({ name: "DATA_HUB_PUBLIC", type: "plain_text", text: "1" },
    { name: "DATA_HUB_COMPOSITION_VERSION", type: "plain_text", text: "1" });
  expect(candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected).noBuildPage)
    .toMatchObject({ dataHubReportingVersion: 1, dataHubCompositionVersion: 1 });
  receipt.value.resources.bindings.at(-1).text = "2";
  expect(() => candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected)).toThrow(/composition metadata/);
  receipt.value.resources.bindings.at(-1).text = "1";
  receipt.value.resources.bindings.at(-2).text = "0";
  expect(() => candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected)).toThrow(/composition metadata/);
  receipt.value.resources.bindings.at(-1).text = "0";
  expect(candidate.projectCloudflareWorkerVersion(receipt.value, receipt.expected).noBuildPage)
    .not.toHaveProperty("dataHubCompositionVersion");
});
