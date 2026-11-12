import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, chmod, readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { Timestamp } from "firebase-admin/firestore";
import { CONTRACT_SETTINGS, CmsPublicContractError, assertUnchangedPlan, devMutationSelection, contractTarget,
  encodeContractValue, decodeContractValue, writePrivateCapsule, readPrivateCapsule, boundedContractProof,
  contractDigest, contractSummary, recheckContractSummary } from "../../scripts/lib/cms-public-contract.mjs";
import { devCompletedBaseline, prepareDependencies, prepareContractRuntime, refusalLine, replayDockerArguments, replayRefusal, restoreRendererArchive, retainRendererArchive } from "../../scripts/check-cms-public-contract.mjs";
import { createCmsPublicationCloudStorage } from "../../site/scripts/cms-publication-cloud-storage.ts";
import { repositoryFixture } from "../helpers/repository-identity.mjs";

const execute = promisify(execFile);
const sha = "a".repeat(40), digest = "b".repeat(64);
const unchanged = { abort: false, releaseReason: "unchanged", functionsMutated: false, previewPaused: false,
  configurationRequiresRelease: false, apiMutated: false, rulesMutated: false, indexesMutated: false, rendererMutated: false, functionDeployTargets: "" };
let directory;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "cms-contract-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("singleton admission and development mutation selection", () => {
  it("admits only an explicit unchanged plan and selects only Admin in development", () => {
    expect(assertUnchangedPlan(unchanged)).toEqual(unchanged);
    expect(devMutationSelection({ plan: unchanged, proved: true, publishingEnabled: "true" }))
      .toEqual({ independent: true, admin: true, backend: false, requireHold: false });
  });
  it.each(["force_firebase", "trusted_source_changed", "missing_functions_receipt", "renderer_inputs_changed", "function_graph_unavailable"])("refuses a full %s plan even with equal fingerprints", reason => {
    expect(() => assertUnchangedPlan({ ...unchanged, releaseReason: reason })).toThrow(CmsPublicContractError);
  });
  it.each(["functionsMutated", "previewPaused", "configurationRequiresRelease", "apiMutated", "rulesMutated", "indexesMutated", "rendererMutated"])("refuses an independent %s mutation", key => {
    expect(() => assertUnchangedPlan({ ...unchanged, [key]: true })).toThrow(CmsPublicContractError);
  });
  it("keeps the full development path behind its existing publication hold", () => {
    expect(devMutationSelection({ plan: { releaseReason: "changed" }, proved: false, publishingEnabled: "false" }))
      .toEqual({ independent: false, admin: true, backend: true, requireHold: true });
    expect(() => devMutationSelection({ plan: null, publishingEnabled: "true" })).toThrow(CmsPublicContractError);
  });
  it.each(["rendererOnly", "rendererRelease", "readerInstall"])("refuses independent use with %s", key => {
    expect(() => devMutationSelection({ plan: unchanged, proved: true, publishingEnabled: "true", [key]: true })).toThrow(CmsPublicContractError);
  });
  it("refuses mixed targets and inherited emulator routing before capture", () => {
    expect(contractTarget("development", { FIREBASE_PROJECT_ID: "njpbs-site-dev" }).projectId).toBe("njpbs-site-dev");
    expect(() => contractTarget("production", { FIREBASE_PROJECT_ID: "njpbs-site-dev" })).toThrow(CmsPublicContractError);
    expect(() => contractTarget("production", { FIRESTORE_EMULATOR_HOST: "127.0.0.1:18464" })).toThrow(CmsPublicContractError);
    expect(() => contractTarget("production", { FUNCTIONS_EMULATOR: "false" })).toThrow(CmsPublicContractError);
  });
});

describe("configured development prepare", () => {
  async function fixture(run) {
    const source = await mkdtemp(join(tmpdir(), "cms-prepare-source-"));
    const calls = [];
    try {
      await mkdir(join(source, "functions/lib"), { recursive: true });
      await writeFile(join(source, "package.json"), '{"type":"commonjs"}');
      const template = await readFile(resolve("functions/lib/publication-target.js"), "utf8");
      expect(template).toContain("https://dev-public.example.org");
      await writeFile(join(source, "functions/lib/publication-target.js"),
        template.replace("https://dev-public.example.org", "https://configured-public.example.org"));
      // npm is the process boundary; this case checks target selection without installing packages.
      await mkdir(join(source, "bin"));
      await writeFile(join(source, "bin/npm"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      vi.stubEnv("PATH", `${join(source, "bin")}:${process.env.PATH}`);
      vi.stubEnv("FIREBASE_PROJECT_ID", "njpbs-site-dev");
      vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
      vi.stubEnv("CMS_DEV_ADMIN_ORIGIN", "https://configured-admin.example.org");
      vi.stubEnv("CMS_DEV_ACCESS_CLIENT_ID", "synthetic-client");
      vi.stubEnv("CMS_DEV_ACCESS_CLIENT_SECRET", "synthetic-secret");
      vi.stubGlobal("fetch", async url => {
        calls.push(url);
        return new Response(JSON.stringify({ commitSha: sha, build: { revision: sha } }));
      });
      await run({ source, calls, prepare: () => prepareDependencies({ directory: join(source, "state"), cwd: source,
        environment: "development", candidateSha: sha }) });
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(source, { recursive: true, force: true }); }
  }
  it("looks up the configured source publication and Admin metadata instead of the trusted template", async () => {
    await fixture(async ({ prepare, calls }) => {
      await prepare();
      expect(calls).toEqual(["https://configured-public.example.org/_publication.json", "https://configured-admin.example.org/admin-status.json"]);
    });
  });
  it.each(["project", "environment", "missing-publication", "missing-admin"])("refuses %s before metadata access", async failure => {
    await fixture(async ({ source, prepare, calls }) => {
      if (failure === "project") vi.stubEnv("FIREBASE_PROJECT_ID", "another-project");
      if (failure === "environment") vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "production");
      if (failure === "missing-publication") await rm(join(source, "functions/lib/publication-target.js"));
      if (failure === "missing-admin") vi.stubEnv("CMS_DEV_ADMIN_ORIGIN", "");
      await expect(prepare()).rejects.toThrow();
      expect(calls).toEqual([]);
    });
  });
});

describe("private capture and bounded recapture", () => {
  it("round-trips native Firestore timestamps and retains array/map identity", () => {
    const value = { when: new Timestamp(123, 456), array: ["map", ["timestamp", 1, 2]], nested: { public: true } };
    const restored = decodeContractValue(encodeContractValue(value), { Timestamp });
    expect(restored.when.isEqual(value.when)).toBe(true);
    expect(restored.array).toEqual(value.array);
    expect(restored.nested).toEqual({ public: true });
  });
  it("keeps capsules private and refuses credential fields or a readable copy", async () => {
    const file = join(directory, "capsule.json");
    await writePrivateCapsule(file, { native: "private fixture" });
    expect(await readPrivateCapsule(file)).toEqual({ native: "private fixture" });
    await chmod(file, 0o644);
    await expect(readPrivateCapsule(file)).rejects.toMatchObject({ code: "capture-private-file" });
    expect(() => encodeContractValue({ nested: { idToken: "synthetic-emulator-only" } })).toThrow(CmsPublicContractError);
  });
  it("recaptures moving inputs only twice", async () => {
    let attempts = 0;
    await expect(boundedContractProof(async () => { attempts += 1; throw new CmsPublicContractError("capture-moved"); }, { now: () => 1000 }))
      .rejects.toMatchObject({ code: "capture-budget" });
    expect(attempts).toBe(2);
  });
  it("restores the archive on retry when the first Functions comparison moves", async () => {
    const file = join(directory, "retained-renderer");
    let comparisons = 0;
    const restoredAfter = [];
    // Only the external Functions/storage boundary is injected. This case
    // checks retry ordering; the emulator corpus proves native replay.
    const compareAndRestore = retainRendererArchive(async () => {
      restoredAfter.push(comparisons);
      await writeFile(file, "renderer archive fixture", { flag: "wx", mode: 0o600 });
    }, async () => {
      comparisons += 1;
      if (comparisons === 1) throw new CmsPublicContractError("capture-moved");
    });
    const attempt = await boundedContractProof(async ({ attempt }) => {
      await compareAndRestore({ state: {} });
      expect(await readFile(file, "utf8")).toBe("renderer archive fixture");
      return attempt;
    });
    expect(attempt).toBe(2);
    expect(restoredAfter).toEqual([2]);
    await compareAndRestore({ state: {} });
    expect(comparisons).toBe(3);
    expect(restoredAfter).toEqual([2]);
  });
  it("includes replay duration in the four-minute budget and leaves settlement unconfirmed", async () => {
    let instant = 1000;
    await expect(boundedContractProof(async () => { instant += 240_001; return true; }, { now: () => instant, boundary: "settlement" }))
      .rejects.toMatchObject({ code: "settlement-unconfirmed" });
  });
});

describe("fresh summary binding", () => {
  const identity = { priorAdminSha: "c".repeat(40), environment: "development", projectId: "njpbs-site-dev", databaseId: "(default)",
    publicReader: { versionId: "native-bound-version" }, backend: { inventory: "native-bound-inventory" } };
  const result = { schemaVersion: 1, capsuleDigest: digest, candidateSha: sha, identityDigest: contractDigest(identity), apiPassThroughDigest: digest,
    cases: [...[["postChrome", "C1"], ["postChrome", "C0-after-C1"], ["capabilities", "C1"], ["previewRequest", "C1"],
      ["previewRequest", "C0-after-C1"], ["adminSession", "C0"], ["adminSession", "C1"]].map(([feature, writer]) => ({ feature, writer,
      passed: true, nativeDigest: digest, renderedDigest: digest })),
    ...CONTRACT_SETTINGS.flatMap(settingId => ["C1", "C0-after-C1"].map(writer => ({ settingId, writer, feature: "settings", passed: true,
      nativeDigest: digest, renderedDigest: digest })))] };
  // This fixture tests summary validation only. The emulator corpus supplies replay evidence.
  const make = (now = 2000) => contractSummary({ candidateSha: sha, identity, capsuleDigest: digest, replay: result, capturedAt: 1000, now });
  it("refuses a stale capture and an incomplete replay", () => {
    expect(() => make(241_000)).toThrow(CmsPublicContractError);
    expect(() => contractSummary({ candidateSha: sha, identity, capsuleDigest: digest, capturedAt: 1000, now: 2000,
      replay: { ...result, cases: result.cases.filter(row => row.feature !== "adminSession") } })).toThrow(CmsPublicContractError);
  });
  it("allows fresh content recapture but refuses a public/backend contract change before settlement", () => {
    const previous = make(), current = { ...make(3000), capsuleDigest: "d".repeat(64) };
    expect(recheckContractSummary(previous, current, { candidateSha: sha, now: 4000 })).toBe(current);
    expect(() => recheckContractSummary(previous, { ...current, publicReaderDigest: "e".repeat(64) },
      { candidateSha: sha, settlement: true, now: 4000 })).toThrowError(CmsPublicContractError);
  });
});

describe("isolated replay refusal", () => {
  const diagnostic = { schemaVersion: 1, result: "refused", code: "sdk-replay-refused", failedTests: [digest], counts: [16, 15, 1, 0], failureKind: "test" };
  it("keeps the sanitized corpus diagnostic and drops private stderr", () => {
    const error = replayRefusal(["private candidate log: secret-looking value", JSON.stringify(diagnostic), "{not json"].join("\n"));
    expect(error).toMatchObject({ code: "sdk-replay-refused" });
    expect(JSON.parse(refusalLine(error))).toEqual({ schemaVersion: 1, result: "refused", code: "sdk-replay-refused",
      failedTests: [digest], counts: [16, 15, 1, 0], failureKind: "test" });
    expect(refusalLine(error)).not.toContain("private candidate log");
  });
  it("refuses an unknown or malformed diagnostic to the plain replay code", () => {
    for (const line of [{ ...diagnostic, code: "other-refused" }, { ...diagnostic, failedTests: ["private name"] },
      { ...diagnostic, failureKind: "private text" }, { ...diagnostic, counts: [1, 2] }]) {
      const error = replayRefusal(JSON.stringify(line));
      expect(JSON.parse(refusalLine(error))).toEqual({ schemaVersion: 1, result: "refused", code: "replay-refused" });
    }
    expect(JSON.parse(refusalLine(new Error("private provider text")))).toEqual({ schemaVersion: 1, result: "refused", code: "proof-refused" });
  });
});

describe("renderer archive restoration", () => {
  it("restores into a new private archive directory through the real storage owner", async () => {
    // R2 is the boundary: the retained checkpoint manifest is absent, so only a reachable restore can report it.
    const send = async () => { throw { $metadata: { httpStatusCode: 404 } }; };
    const { restoreArtifact } = createCmsPublicationCloudStorage({ client: { send }, includeRenderer: true,
      target: createRequire(import.meta.url)("../../functions/lib/publication-target.js").publicationTarget("development") });
    const state = await mkdtemp(join(tmpdir(), "cms-contract-archive-"));
    try {
      await chmod(state, 0o700);
      const error = await restoreRendererArchive({ restoreArtifact, archive: join(state, "verified-renderer"), checkpointDigest: digest,
        reference: { queueId: "a".repeat(20), commitSha: sha, buildBatchId: `cms-${"a".repeat(20)}`, inputSha256: digest } }).catch(caught => caught);
      expect(error).toMatchObject({ code: "checkpoint-unavailable" });
    } finally { await rm(state, { recursive: true, force: true }); }
  });
});

describe("development baseline run", () => {
  // A dispatch with deploy_ref deploys that ref; the run's head_sha is the workflow revision.
  const deployed = "c".repeat(40), workflow = "d".repeat(40);
  const run = { id: 7, head_sha: workflow, event: "workflow_dispatch", conclusion: "success", actor: { login: "deploy-owner" },
    run_started_at: "2026-11-08T10:00:00Z", updated_at: "2026-11-08T10:20:00Z" };
  const functions = [{ updateTime: "2026-11-08T10:10:00Z", serviceConfig: { environmentVariables: { CMS_ADMIN_BUILD_REVISION: deployed } } }];
  const baseline = async (runs, rows = functions) => {
    for (const [name, value] of Object.entries(repositoryFixture)) vi.stubEnv(name, value);
    vi.stubEnv("GITHUB_REPOSITORY", repositoryFixture.CANONICAL_GITHUB_REPOSITORY);
    vi.stubEnv("GITHUB_REPOSITORY_ID", repositoryFixture.CANONICAL_GITHUB_REPOSITORY_ID);
    vi.stubEnv("CMS_DEPLOY_OWNER", "deploy-owner"); vi.stubEnv("GITHUB_TOKEN", "fixture-token");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ workflow_runs: runs })));
    try { return await devCompletedBaseline(deployed, rows, AbortSignal.timeout(5000)); } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  };
  it("binds the run that deployed the recorded revision, not the run's workflow revision", async () => {
    await expect(baseline([run])).resolves.toEqual({ runId: "7", sourceSha: deployed, completedAt: run.updated_at });
  });
  it("refuses a backend that no successful dispatch window or recorded revision explains", async () => {
    await expect(baseline([{ ...run, updated_at: "2026-11-08T10:05:00Z" }])).rejects.toThrow(CmsPublicContractError);
    await expect(baseline([{ ...run, actor: { login: "someone-else" } }])).rejects.toThrow(CmsPublicContractError);
    await expect(baseline([run], [{ ...functions[0], serviceConfig: { environmentVariables: { CMS_ADMIN_BUILD_REVISION: workflow } } }])).rejects.toThrow(CmsPublicContractError);
    await expect(baseline([run], [])).rejects.toThrow(CmsPublicContractError);
  });
});

describe("Docker isolation at the process boundary", () => {
  let image, inputs;
  beforeAll(async () => {
    image = await prepareContractRuntime(join(directory, "runtime"));
    inputs = join(directory, "inputs");
    await mkdir(join(inputs, "trusted/scripts/lib"), { recursive: true });
    await cp(resolve("scripts"), join(inputs, "trusted/scripts"), { recursive: true });
    await cp(resolve("functions/lib"), join(inputs, "trusted/functions/lib"), { recursive: true });
    await cp(resolve("config"), join(inputs, "trusted/config"), { recursive: true });
    await mkdir(join(inputs, "trusted/agents/vmix"), { recursive: true });
    await cp(resolve("agents/vmix/configuration.mjs"), join(inputs, "trusted/agents/vmix/configuration.mjs"));
    await mkdir(join(inputs, "trusted/node_modules"), { recursive: true });
    await mkdir(join(inputs, "trusted/site/node_modules"), { recursive: true });
    await mkdir(join(inputs, "trusted"), { recursive: true });
    await cp(resolve("package.json"), join(inputs, "trusted/package.json"));
    for (const source of ["C0", "C1", "R-source"]) {
      await mkdir(join(inputs, source, "site/node_modules"), { recursive: true });
      await mkdir(join(inputs, source, "node_modules"), { recursive: true });
    }
    await mkdir(join(inputs, "R-artifact/renderer/node_modules"), { recursive: true });
    await mkdir(join(inputs, "R-artifact/node_modules"), { recursive: true });
  }, 120_000);
  it("actually denies host credentials, root writes and network interfaces", async () => {
    const name = `cms-contract-${crypto.randomUUID()}`;
    const args = replayDockerArguments({ image, sealedDirectory: inputs, dependencies: resolve("node_modules"), siteDependencies: resolve("site/node_modules"), name });
    args.splice(args.length - 1, 0, "--entrypoint", "node");
    args.push("--input-type=module", "-e", `
      import {assertReplayIsolation} from '/inputs/trusted/scripts/check-cms-public-contract.mjs';
      import {writeFile} from 'node:fs/promises';
      await assertReplayIsolation();
      if (process.env.CMS_SYNTHETIC_HOST_SECRET !== undefined) process.exit(2);
      try { await writeFile('/root-write-probe','test'); process.exit(3); } catch (error) { if (error.code !== 'EROFS' && error.code !== 'EACCES') throw error; }
      console.log('isolated');
    `);
    const { stdout } = await execute("docker", args, { env: { ...process.env, CMS_SYNTHETIC_HOST_SECRET: "synthetic-emulator-only" }, timeout: 10_000 });
    expect(stdout.trim()).toBe("isolated");
  });
});
