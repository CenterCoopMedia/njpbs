import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { assertNoFunctionDeletions, functionDeployManifest, loadFunctionDeployManifest, readFunctionsDeployInventory } from "../../scripts/lib/functions-deploy-inventory.mjs";
import { deployBatch } from "../../scripts/deploy-cms-function-batches.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fingerprintInputs } from "../../scripts/lib/cms-component-receipt.mjs";
import { fingerprintTrustedSource } from "../../scripts/lib/cms-release-plan.mjs";

const require = createRequire(import.meta.url);
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentWritten, onDocumentWrittenWithAuthContext } = require("firebase-functions/v2/firestore");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { endpointMatchesFilter, parseFunctionSelector } = require("firebase-tools/lib/deploy/functions/functionsDeployHelper");

const live = (id, projectId = "njpbs-site-dev", region = "us-central1", codebase = "dev") => ({
  name: `projects/${projectId}/locations/${region}/functions/${id}`,
  labels: { "firebase-functions-codebase": codebase },
  platform: "gcfv2", environment: "GEN_2",
});
const manifest = names => names.map(name => ({ name, region: "us-central1", platform: "gcfv2" }));
const check = (names, functions, target) => assertNoFunctionDeletions(manifest(names), functions, target);

describe("forced Functions deployment inventory", () => {
  it.each([["njpbs-site-dev", "dev"], ["njpbs-site", "default"]])("refuses a missing or renamed live function in %s", (projectId, codebase) => {
    const functions = [live("health", projectId, "us-central1", codebase), live("cmsPreview", projectId, "us-central1", codebase)];
    expect(() => check(["health", "cmsPreview", "onNoBuildPostConfirmation"], functions, { projectId, codebase })).not.toThrow();
    for (const names of [["health"], ["health", "cmsRenamedPreview"]]) {
      expect(() => check(names, functions, { projectId, codebase })).toThrow("delete or rename");
    }
    expect(() => check(["health"], [live("health", projectId, "europe-west1", codebase)], { projectId, codebase })).toThrow("delete or rename");
    expect(() => check(["health"], [{ ...live("health", projectId, "us-central1", codebase), platform: "gcfv1" }], { projectId, codebase })).toThrow("delete or rename");
  });

  it("recognizes legacy default labels and scopes other codebases without accepting another project", () => {
    const projectId = "njpbs-site", codebase = "default";
    expect(() => check(["health"], [{ name: live("health", projectId).name, platform: "gcfv2" }, live("other", projectId, "us-central1", "unrelated")], { projectId, codebase })).not.toThrow();
    expect(() => check(["health"], [{ name: live("cmsPreview", projectId).name, platform: "gcfv2" }], { projectId, codebase })).toThrow("delete or rename");
    expect(() => check(["health"], [live("health")], { projectId, codebase })).toThrow("identity");
    expect(() => check(["health"], [], { projectId, codebase: "dev" })).toThrow("manifest");
  });

  it("reads every page of both all-location API inventories", async () => {
    const calls = [];
    const functions = await readFunctionsDeployInventory("njpbs-site-dev", async (url, token) => {
      calls.push([url, token]);
      if (url.includes("/v1/")) return token ? { functions: [live("cmsPreview")] } : { functions: [live("health")], nextPageToken: "next" };
      return { functions: [live("onNoBuildPostConfirmation")] };
    });
    expect(functions).toHaveLength(3);
    expect(calls.map(([url, token]) => [url.split("/")[3], token])).toEqual([["v1", undefined], ["v1", "next"], ["v2", undefined]]);
    expect(calls.every(([url]) => url.endsWith("/projects/njpbs-site-dev/locations/-/functions"))).toBe(true);
    expect(() => check(["health", "onNoBuildPostConfirmation"], functions, { projectId: "njpbs-site-dev", codebase: "dev" })).toThrow("delete or rename");
  });

  it.each([{ unreachable: ["us-central1"] }, { unreachable: "unknown" }, { functions: {} }, { nextPageToken: 1 }, { error: { code: 403 } }, { unexpected: [] }, null])("refuses partial or malformed provider inventory", async page => {
    await expect(readFunctionsDeployInventory("njpbs-site-dev", async () => page)).rejects.toThrow("incomplete");
  });

  it("refuses repeated pagination and failed network reads", async () => {
    await expect(readFunctionsDeployInventory("njpbs-site-dev", async () => ({ nextPageToken: "same" }))).rejects.toThrow("Repeated");
    await expect(readFunctionsDeployInventory("njpbs-site-dev", async () => { throw new Error("provider unavailable"); })).rejects.toThrow("unavailable");
  });

  it("uses real Firebase source endpoint regions and refuses a source/manifest mismatch", () => {
    const source = { health: onRequest(() => {}), cmsPreview: onRequest({ region: ["us-central1", "europe-west1"] }, () => {}) };
    expect(functionDeployManifest(["health", "cmsPreview"], source)).toEqual([
      { name: "health", region: "us-central1", platform: "gcfv2" },
      { name: "cmsPreview", region: "us-central1", platform: "gcfv2" },
      { name: "cmsPreview", region: "europe-west1", platform: "gcfv2" },
    ]);
    expect(() => functionDeployManifest(["health"], source)).toThrow("exact manifest");
    const target = { projectId: "njpbs-site-dev", codebase: "dev" };
    const moved = functionDeployManifest(["health"], { health: onRequest({ region: "europe-west1" }, () => {}) });
    expect(() => assertNoFunctionDeletions(moved, [live("health")], target)).toThrow("delete or rename");
  });

  it("stops before launching a forced production batch when a selected live region would be removed", async () => {
    let launched = false;
    await expect(deployBatch(["health"], () => { launched = true; }, "njpbs-site", {
      manifest: manifest(["health"]),
      request: async url => url.includes("/v1/") ? {} : { functions: [live("health", "njpbs-site", "us-central1", "default"), live("health", "njpbs-site", "europe-west1", "default")] },
    })).rejects.toThrow("delete or rename");
    expect(launched).toBe(false);
  });

  it("preserves production subset-then-explicit-retirement without approving deletions inside the filter", async () => {
    const projectId = "njpbs-site", codebase = "default", only = ["health"];
    const functions = [live("health", projectId, "us-central1", codebase), live("retiredHandler", projectId, "us-central1", codebase)];
    expect(() => assertNoFunctionDeletions(manifest(only), functions, { projectId, codebase, only })).not.toThrow();
    for (const name of ["health-child", "healthier", "retiredHandler"]) {
      const selected = endpointMatchesFilter({ id: name, codebase }, { idChunks: only, codebase });
      const check = () => assertNoFunctionDeletions(manifest(only), [...functions, live(name, projectId, "us-central1", codebase)], { projectId, codebase, only });
      if (selected) expect(check).toThrow("delete or rename");
      else expect(check).not.toThrow();
    }
    let launched = false;
    const launch = () => {
      launched = true;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from("Deploy complete!")); child.emit("close", 0); });
      return child;
    };
    await expect(deployBatch(only, launch, projectId, { manifest: manifest(only), request: async url => url.includes("/v1/") ? {} : { functions } })).resolves.toBeUndefined();
    expect(launched).toBe(true);
  });

  it("checks the whole codebase filter and refuses an unparseable selector", () => {
    const projectId = "njpbs-site", codebase = "default";
    const functions = [live("health", projectId, "us-central1", codebase), live("cmsPreview", projectId, "us-central1", codebase)];
    expect(parseFunctionSelector("default", [{ codebase }])).toEqual([{ codebase }]);
    expect(() => assertNoFunctionDeletions(manifest(["health"]), functions, { projectId, codebase, only: ["default"] })).toThrow("delete or rename");
    expect(() => assertNoFunctionDeletions(manifest(["health", "cmsPreview"]), functions, { projectId, codebase, only: ["default"] })).not.toThrow();
    for (const only of [["health*"], ["default:health"], [], [null]]) {
      expect(() => assertNoFunctionDeletions(manifest(["health"]), functions, { projectId, codebase, only })).toThrow("filter");
    }
  });

  it("binds production source discovery before reading an enabled generated wake manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "functions-project-manifest-"));
    const prior = { GCLOUD_PROJECT: process.env.GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT };
    try {
      mkdirSync(join(root, "functions"));
      writeFileSync(join(root, "firebase.json"), JSON.stringify({ functions: { source: "functions", codebase: "default" } }));
      writeFileSync(join(root, "functions/package.json"), JSON.stringify({ main: "index.js" }));
      const generated = join(root, "functions/cloud-publication-wake.generated.json");
      writeFileSync(generated, JSON.stringify({ schemaVersion: 1, environment: "production", enabled: true }));
      const reader = fileURLToPath(new URL("../../functions/lib/cloud-publication-wake-deployment.js", import.meta.url));
      const sdk = createRequire(import.meta.url).resolve("firebase-functions/v2/https");
      writeFileSync(join(root, "functions/index.js"), `
        const {onRequest}=require(${JSON.stringify(sdk)});
        const {readCloudPublicationWakeDeployment}=require(${JSON.stringify(reader)});
        exports.health=onRequest(()=>{});
        if(readCloudPublicationWakeDeployment({path:${JSON.stringify(generated)}}).enabled) {
          for(const name of ['onNoBuildCloudState','onNoBuildCloudCandidate','onNoBuildCloudRelease']) exports[name]=onRequest(()=>{});
        }
      `);
      delete process.env.GCLOUD_PROJECT; delete process.env.GOOGLE_CLOUD_PROJECT;
      const names = ["health", "onNoBuildCloudState", "onNoBuildCloudCandidate", "onNoBuildCloudRelease"];
      expect(loadFunctionDeployManifest(names, "njpbs-site", pathToFileURL(`${root}/`))).toHaveLength(4);
      expect(process.env.GCLOUD_PROJECT).toBe("njpbs-site");
      expect(process.env.GOOGLE_CLOUD_PROJECT).toBe("njpbs-site");
      writeFileSync(join(root, "functions/package.json"), JSON.stringify({ main: "dev-index.js" }));
      expect(() => loadFunctionDeployManifest(names, "njpbs-site", pathToFileURL(`${root}/`))).toThrow("entry point or codebase");
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an auth-context migration before allowing the retry confirmation", async () => {
    const existing = onDocumentWritten("cmsPublishQueue/{queueId}", () => {});
    const changed = onDocumentWrittenWithAuthContext("cmsPublishQueue/{queueId}", () => {});
    const oldType = existing.__endpoint.eventTrigger.eventType;
    const newType = changed.__endpoint.eventTrigger.eventType;
    expect(newType).not.toBe(oldType);
    const functions = await readFunctionsDeployInventory("njpbs-site-dev", async url => url.includes("/v1/") ? {} : {
      functions: [{ ...live("confirmation"), eventTrigger: { eventType: oldType, triggerRegion: "nam5",
        pubsubTopic: "projects/njpbs-site-dev/topics/eventarc-nam5-transport", eventFilters: [
        { attribute: "database", value: "(default)" }, { attribute: "namespace", value: "(default)" },
        { attribute: "document", value: "cmsPublishQueue/{queueId}", operator: "match-path-pattern" },
      ] } }],
    });
    const target = { projectId: "njpbs-site-dev", codebase: "dev" };
    expect(() => assertNoFunctionDeletions(functionDeployManifest(["confirmation"], { confirmation: existing }), functions, target)).not.toThrow();
    expect(() => assertNoFunctionDeletions(functionDeployManifest(["confirmation"], { confirmation: changed }), functions, target)).toThrow("change a live trigger type");
  });

  it("refuses a same-type topic replacement that Firebase would delete and recreate", async () => {
    const target = { projectId: "njpbs-site-dev", codebase: "dev" };
    const functions = await readFunctionsDeployInventory(target.projectId, async url => url.includes("/v1/") ? {} : {
      functions: [{ ...live("handler"), eventTrigger: { eventType: "google.cloud.pubsub.topic.v1.messagePublished", pubsubTopic: "projects/njpbs-site-dev/topics/existing" } }],
    });
    expect(() => assertNoFunctionDeletions(functionDeployManifest(["handler"], { handler: onMessagePublished("existing", () => {}) }), functions, target)).not.toThrow();
    expect(() => assertNoFunctionDeletions(functionDeployManifest(["handler"], { handler: onMessagePublished("replacement", () => {}) }), functions, target)).toThrow("trigger routing");
  });

  it("changes both release fingerprints when only the force guard changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "functions-guard-fingerprint-"));
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init"); git("config", "user.name", "Fixture Author"); git("config", "user.email", "fixture-author@example.org");
      mkdirSync(join(root, "scripts/lib"), { recursive: true });
      const path = "scripts/lib/functions-deploy-inventory.mjs";
      writeFileSync(join(root, path), "export const revision = 1;\n");
      git("add", path); git("commit", "-m", "First guard version"); const before = git("rev-parse", "HEAD");
      writeFileSync(join(root, path), "export const revision = 2;\n");
      git("add", path); git("commit", "-m", "Changed guard version"); const after = git("rev-parse", "HEAD");
      const deps = { listTree: async (sha, paths) => git("ls-tree", "-r", sha, "--", ...paths) };
      expect(await fingerprintInputs(before, "functions", deps)).not.toBe(await fingerprintInputs(after, "functions", deps));
      expect(await fingerprintTrustedSource(before, deps)).not.toBe(await fingerprintTrustedSource(after, deps));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
