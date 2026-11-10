import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { assertDevInventoryArguments, projectDevReleaseDocument, collectDevReleaseInventory }
  from "../scripts/inspect-dev-public-release.mjs";
import { releasePair, releaseSelector } from "./helpers/private-public-release-pair.js";
import pairWork from "../functions/lib/public-release-pair-work.js";
import pointer from "../functions/lib/public-deployment-pointer.js";

it.each(["njpbs-site", "demo-dev", "different-dev"])("rejects target %s", project => {
  expect(() => assertDevInventoryArguments(["--project", project, "--read-only"], {}, false)).toThrow();
});

it.each(["FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST", "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG"])(
  "rejects even an empty ambient %s", name => {
    expect(() => assertDevInventoryArguments(["--project", "njpbs-site-dev", "--read-only"], { [name]: "" }, false)).toThrow();
  });

it("requires the exact read-only flags and a nonterminal credential stream", () => {
  const args = ["--project", "njpbs-site-dev", "--read-only"];
  expect(() => assertDevInventoryArguments(args, {}, false)).not.toThrow();
  expect(() => assertDevInventoryArguments(args, {}, true)).toThrow();
  expect(() => assertDevInventoryArguments([...args, "--apply"], {}, false)).toThrow();
});

it("separates absent, legacy and schema-two roots without adopting them", () => {
  const path = "system/publicDeployment";
  expect(projectDevReleaseDocument(path, undefined)).toEqual({ path, status: "absent" });
  expect(projectDevReleaseDocument(path, pointer.initialPublicDeploymentPointer())).toMatchObject({ status: "valid-legacy", activeGeneration: 0 });
  expect(projectDevReleaseDocument(path, releaseSelector())).toMatchObject({ status: "valid-schema-two", selector: { epoch: 1 } });
  expect(projectDevReleaseDocument(path, { ...releaseSelector(), secret: "must-not-leak" })).toEqual({ path, status: "invalid-or-other-schema" });
});

it("only exposes parsed development pairs at the owner's physical key", () => {
  const pair = releasePair(), path = pairWork.publicReleasePairPath(pair.pairId);
  expect(projectDevReleaseDocument(path, pair)).toMatchObject({ status: "parsed", pair });
  expect(projectDevReleaseDocument(path, { ...pair, environment: "production" })).toEqual({ path, status: "invalid-or-other-schema" });
  expect(projectDevReleaseDocument(path + "wrong", pair)).toEqual({ path: path + "wrong", status: "invalid-or-other-schema" });
});

it("does not expose unchecked control strings, nested bodies or unknown fields", () => {
  expect(projectDevReleaseDocument("system/billing", { disabled: false, schemaVersion: 1,
    phase: "private-value", token: "private-value", nested: { password: "private-value" } })).toEqual({
    path: "system/billing", status: "present-unvalidated", fields: { schemaVersion: 1, disabled: false } });
});

it("projects a lifecycle child separately from its parent pair record", () => {
  const path = pairWork.publicReleasePairPath(releasePair().pairId) + "/controls/runtime";
  expect(projectDevReleaseDocument(path, { schemaVersion: 2, status: "candidate", pairId: "hidden" })).toEqual({
    path, status: "present-unvalidated", fields: { schemaVersion: 2, status: "candidate" } });
});

it("shows validated reconciliation identity and times without the lease token", () => {
  const at = { toMillis: () => 0 };
  const value = { ...pointer.initialPublicDeploymentPointer(), state: "reconciling", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "cms-12345678901234567890", candidateGeneration: 1,
    candidateBuildBatchId: "cms-12345678901234567890", candidateCommitSha: "a".repeat(40),
    predecessorGeneration: 0, predecessorDeploymentId: null, predecessorCommitSha: null,
    leaseToken: "sentinel-private-value", leaseAcquiredAt: at, reconcilingAt: at, cloudflareEvidenceDigest: "b".repeat(64) };
  const result = projectDevReleaseDocument("system/publicDeployment", value);
  expect(result).toMatchObject({ status: "valid-legacy", candidateGeneration: 1, leaseAcquiredAt: "1970-01-01T00:00:00.000Z" });
  expect(JSON.stringify(result)).not.toContain("sentinel-private-value");
  expect(result).not.toHaveProperty("leaseToken");
});

it("never emits queue errors, lease credentials or arbitrary batch strings", () => {
  const path = "system/publicDeployment/buildBatches/cms-12345678901234567890";
  expect(projectDevReleaseDocument(path, { status: "reconciling", generation: 1, commitSha: "a".repeat(40),
    leaseToken: "hidden", error: "hidden", workerVersionId: "hidden" })).toEqual({ path, status: "present-unvalidated",
    fields: { status: "reconciling", generation: 1, commitSha: "a".repeat(40) } });
});

it.each(["pending", "publishing", "runtime_confirmed", "public_unconfirmed", "superseded"])(
  "retains the owner's %s status and queue timestamps", status => {
    const at = { toMillis: () => 0 }, path = "cmsPublishQueue/12345678901234567890";
    expect(projectDevReleaseDocument(path, { status, triggeredAt: at, completedAt: at })).toEqual({
      path, status: "present-unvalidated", fields: { status, triggeredAt: "1970-01-01T00:00:00.000Z", completedAt: "1970-01-01T00:00:00.000Z" } });
  });

it("refuses a wrong SDK project before any read", async () => {
  await expect(collectDevReleaseInventory({ projectId: "njpbs-site" })).rejects.toThrow("dev_inventory_wrong_database");
});

it("refuses malformed credential input with no raw value on either output stream", () => {
  const result = spawnSync(process.execPath, ["scripts/inspect-dev-public-release.mjs", "--project", "njpbs-site-dev", "--read-only"], {
    encoding: "utf8", input: '{"private_key":"sentinel-private-value"}', env: { PATH: process.env.PATH }, timeout: 5000 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("dev_inventory_refused\n");
});

it("records a safe target refusal without echoing the supplied project", () => {
  const result = spawnSync(process.execPath, ["scripts/inspect-dev-public-release.mjs", "--project", "sentinel-private-value", "--read-only"], {
    encoding: "utf8", input: "", env: { PATH: process.env.PATH }, timeout: 5000 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("dev_inventory_target_required\n");
});
