import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import writer from "../../functions/lib/public-release-writer-fence.js";
import { createHash } from "node:crypto";
import { developmentInputFixture } from "../helpers/development-inputs.mjs";
import { renderDevelopmentConfig } from "../../scripts/render-development-config.mjs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Isolated emulator required");
const app = initializeApp({ projectId: "njpbs-site-dev" }, "dev-renderer-bootstrap-sdk");
const db = getFirestore(app);
afterAll(() => deleteApp(app));
let owner: any, bootstrapDevPreview: any, restoreDevPreviewBootstrap: any, immutableDevRendererImage: any;
let configuredSource: string;
beforeAll(async () => {
  // Exercise the same configured source that deployment imports, with synthetic suppliers.
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  if (execFileSync("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repository, encoding: "utf8" }).trim()) {
    throw new Error("Commit source changes before testing the configured renderer.");
  }
  const source = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  configuredSource = await mkdtemp(path.join(tmpdir(), "dev-bootstrap-source-"));
  execFileSync("/usr/bin/git", ["clone", "--quiet", "--shared", "--no-checkout", repository, configuredSource]);
  execFileSync("/usr/bin/git", ["checkout", "--quiet", "--detach", source], { cwd: configuredSource });
  for (const [name, value] of Object.entries({ ...developmentInputFixture,
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CMS_DEV_ACCESS_ORIGIN: "https://access.example.org" })) vi.stubEnv(name, value);
  renderDevelopmentConfig(configuredSource, process.env);
  await symlink(path.join(repository, "node_modules"), path.join(configuredSource, "node_modules"));
  await symlink(path.join(repository, "site/node_modules"), path.join(configuredSource, "site/node_modules"));
  owner = createRequire(import.meta.url)(path.join(configuredSource, "functions/lib/dev-preview-renderer-bootstrap.js"));
  ({ bootstrapDevPreview, restoreDevPreviewBootstrap, immutableDevRendererImage } = await import(pathToFileURL(path.join(configuredSource, "preview-renderer/bootstrap-dev.mjs")).href));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (configuredSource) await rm(configuredSource, { recursive: true, force: true });
});
const target = "a".repeat(40), priorSource = "b".repeat(40), operator = "c".repeat(40);
const rendererWorker = developmentInputFixture.CMS_DEV_PREVIEW_RENDERER;
const imageRoot = `registry.cloudflare.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${rendererWorker}@sha256:`;
// Existing development image format observed read-only on November1, 2026.
const priorImage = imageRoot + "1111111111111111111111111111111111111111111111111111111111111111";
const nextImage = imageRoot + "e".repeat(64);
const priorPreview = { schemaVersion: 1, phase: "paused", rendererSha: priorSource, serializerId: "cloudflare-preview", checkedAt: "2026-10-11T12:00:00.000Z" };
const oldProvider = { worker: rendererWorker, workerDeploymentId: "11111111-1111-4111-8111-111111111111",
  workerVersionId: "22222222-2222-4222-8222-222222222222", applicationId: "33333333-3333-4333-8333-333333333333",
  rendererSha: priorSource, serializerId: "cloudflare-preview", imageFingerprint: "f".repeat(64) };
const component = { schemaVersion: 1, environment: "development", projectId: "njpbs-site-dev", state: "complete", sourceSha: priorSource,
  releaseStartedAt: "2026-10-11T12:00:00.000Z", verifiedAt: "2026-10-11T12:01:00.000Z", provider: oldProvider };
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: target,
  activeDeploymentId: "original-old", lastReservedGeneration: 1, newestEligibleGeneration: 1,
  newestEligibleBuildBatchId: "original-build", mediaLifecycleReady: true };
const runtime = { schemaVersion: 1, phase: "ready", commitSha: target, serializerId: "original-primary",
  cloud: { phase: "ready", commitSha: target, serializerId: "cloudflare-dev-publisher" } };
const pauseAttempt = { schemaVersion: 1, operationId: "original-dev-pause", environment: "development", projectId: "njpbs-site-dev",
  oldRuntime: runtime, legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) };
const provider = (operationId = "dev-renderer-7", restored = false) => ({ ...oldProvider,
  workerVersionId: "44444444-4444-4444-8444-444444444444", rendererSha: restored ? priorSource : target,
  enabled: false, image: restored ? priorImage : nextImage,
  imageFingerprint: createHash("sha256").update(JSON.stringify({ image: restored ? priorImage : nextImage, digest: null })).digest("hex"),
  imageState: "configured", operationId, rolloutId: null });

async function seed(source = target, previewSource = priorSource, providerIdentity = oldProvider) {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/njpbs-site-dev/databases/(default)/documents`, { method: "DELETE" }, db);
  const actualPointer = { ...pointer, activeCommitSha: source };
  const actualRuntime = { ...runtime, commitSha: source, cloud: { ...runtime.cloud, commitSha: source } };
  await db.doc("system/publicDeployment").set(actualPointer);
  await db.doc("system/cmsPublicationRuntime").set(actualRuntime);
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  await db.doc(owner.PREVIEW).set({ ...priorPreview, rendererSha: previewSource });
  await db.doc(owner.COMPONENT).set({ ...component, sourceSha: previewSource, provider: providerIdentity });
  const result = await pause.pauseDevPublicRelease({ firestore: db, attempt: { ...pauseAttempt, oldRuntime: actualRuntime,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest(actualPointer) } });
  expect(result.drainCommitted).toBe(true);
}
beforeEach(() => seed());

async function attempt(operationId = "dev-renderer-7") {
  const observed = await owner.inspectDevPreviewBootstrap({ firestore: db, rendererSha: target });
  return { schemaVersion: 1, operationId, rendererSha: target, operatorCommitSha: operator,
    provenance: { schemaVersion: 1, rendererSha: target, operatorCommitSha: operator, rendererTree: "d".repeat(40), workerSourceDigest: "e".repeat(64) },
    bootstrapOperationId: observed.bootstrapOperationId, publicDigest: observed.publicDigest,
    startedAt: "2026-11-01T12:00:00.000Z", prior: { provider: oldProvider, image: priorImage, preview: observed.preview, component: observed.component } };
}
async function publicRows() {
  return Promise.all(["system/publicDeployment", "system/cmsPublicationRuntime", "system/publicReleaseAdmissions/controls/bootstrapFence",
    writer.RELEASE_WRITER_FENCE_PATH].map(async path => (await db.doc(path).get()).data()));
}

it("atomically installs only paused preview identity and preserves public source, runtime and original fences", async () => {
  const before = await publicRows(); const request = await attempt();
  const claim = await owner.claimDevPreviewBootstrap({ firestore: db, attempt: request });
  const result = await owner.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claim.attemptDigest, provider: provider() });
  expect(result.status).toBe("committed-paused");
  expect((await db.doc(owner.PREVIEW).get()).data()).toEqual({ schemaVersion: 1, phase: "paused", rendererSha: target, serializerId: "cloudflare-preview" });
  expect((await db.doc(owner.COMPONENT).get()).data()).toMatchObject({ state: "bootstrap-paused", verificationMode: "provider-and-paused-control", sourceSha: target });
  expect(await publicRows()).toEqual(before);
  expect((await db.doc("system/publicReleaseChanges").get()).exists).toBe(false);
  expect(await owner.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claim.attemptDigest, provider: provider() })).toEqual(result);
  await expect(owner.claimDevPreviewBootstrap({ firestore: db, attempt: { ...request, operationId: "dev-renderer-8" } })).rejects.toThrow();
});

it("restores the bound original image and complete paused control without restoring stale provider UUIDs or opening public fences", async () => {
  const before = await publicRows(); const request = await attempt();
  const claim = await owner.claimDevPreviewBootstrap({ firestore: db, attempt: request });
  await owner.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claim.attemptDigest, provider: provider() });
  await expect(owner.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claim.attemptDigest,
    provider: { ...provider("dev-renderer-7", true), image: nextImage }, restore: true })).rejects.toThrow();
  const restored = await owner.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claim.attemptDigest, provider: provider("dev-renderer-7", true), restore: true });
  expect(restored.status).toBe("restored-paused");
  expect(restored.receipt.provider.workerVersionId).toBe("44444444-4444-4444-8444-444444444444");
  expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(priorPreview);
  expect(await publicRows()).toEqual(before);
});

it.each(["preview-ready", "foreign-writer", "enrolled", "producer", "source-moved", "context-moved", "drain-missing"])("refuses %s drift before claiming or changing preview", async drift => {
  const request = await attempt();
  if (drift === "preview-ready") await db.doc(owner.PREVIEW).update({ phase: "ready" });
  if (drift === "foreign-writer") await db.doc(writer.RELEASE_WRITER_FENCE_PATH).set({ schemaVersion: 2, operationId: "another", attemptDigest: "e".repeat(64) });
  if (drift === "enrolled") await db.doc("system/publicReleaseChanges").set({ schemaVersion: 1 });
  if (drift === "producer") await db.doc("system/publicReleaseChangeLog").set({ enabled: true });
  if (drift === "source-moved") await db.doc("system/publicDeployment").update({ activeCommitSha: priorSource });
  if (drift === "context-moved") await db.doc("system/publicDeployment/contexts/public").update({ revision: 2 });
  if (drift === "drain-missing") await db.doc(`system/devPublicReleasePause/drains/${pauseAttempt.operationId}`).delete();
  const before = (await db.doc(owner.PREVIEW).get()).data();
  await expect(owner.claimDevPreviewBootstrap({ firestore: db, attempt: request })).rejects.toThrow();
  expect((await db.doc(owner.ROOT).get()).exists).toBe(false);
  expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(before);
});

it("allows one original claim under concurrent hosted attempts", async () => {
  const first = await attempt();
  const results = await Promise.allSettled([first, { ...first, operationId: "dev-renderer-8" }]
    .map(request => owner.claimDevPreviewBootstrap({ firestore: db, attempt: request })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(priorPreview);
});

it("seals one partial provider outcome under the original failed attempt before restoration", async () => {
  const request = await attempt(), before = await publicRows();
  const claim = await owner.claimDevPreviewBootstrap({ firestore: db, attempt: request });
  await owner.failDevPreviewBootstrap({ firestore: db, attemptDigest: claim.attemptDigest, phase: "provider-readback" });
  await expect(owner.bindDevPreviewBootstrapRecovery({ firestore: db, attemptDigest: claim.attemptDigest,
    provider: provider("dev-renderer-8") })).rejects.toThrow();
  const bound = await owner.bindDevPreviewBootstrapRecovery({ firestore: db, attemptDigest: claim.attemptDigest, provider: provider() });
  expect(bound.status).toBe("failed");
  expect(bound.recoveryProvider.image).toBe(nextImage);
  expect(await owner.bindDevPreviewBootstrapRecovery({ firestore: db, attemptDigest: claim.attemptDigest, provider: provider() })).toEqual(bound);
  await expect(owner.bindDevPreviewBootstrapRecovery({ firestore: db, attemptDigest: claim.attemptDigest,
    provider: { ...provider(), workerVersionId: oldProvider.workerVersionId } })).rejects.toThrow();
  expect(await publicRows()).toEqual(before);
  expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(priorPreview);
  await db.doc(owner.ROOT).update({ recoveryProviderDigest: "f".repeat(64) });
  await expect(owner.guardDevPreviewBootstrap({ firestore: db })).rejects.toThrow();
});

it("refuses another project before opening a database transaction", async () => {
  await expect(owner.inspectDevPreviewBootstrap({ firestore: { projectId: "njpbs-site" }, rendererSha: target })).rejects.toThrow();
});

// Only the Cloudflare network and Wrangler/NPM process boundaries are fake.
// Source preparation, Git, filesystem and all Firestore transactions are real.
async function controllerFixture({ failImage = false, outsider = false, loseRestoreReply = false,
  failPostInstallReadback = false, preflightFailure = false }: {
    failImage?: boolean; outsider?: boolean; loseRestoreReply?: false | "worker-only" | "image";
    failPostInstallReadback?: boolean; preflightFailure?: false | "source-preparation" | "provider-preflight";
  } = {}) {
  const source = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const identity = { ...oldProvider, rendererSha: source,
    imageFingerprint: createHash("sha256").update(JSON.stringify({ image: priorImage, digest: null })).digest("hex") };
  await seed(source, source, identity);
  const before = await publicRows(), originalPreview = (await db.doc(owner.PREVIEW).get()).data();
  const npmDirectory = await mkdtemp(path.join(tmpdir(), "dev-bootstrap-process-"));
  await writeFile(path.join(npmDirectory, "npm"), '#!/bin/sh\nfixture_dir=${0%/*}\nif [ -f "$fixture_dir/fail-preparation" ]; then\npwd -P >> "$fixture_dir/failed-preparation-cwd"\nexit 7\nfi\nexit 0\n', { mode: 0o700 });
  if (preflightFailure === "source-preparation") await writeFile(path.join(npmDirectory, "fail-preparation"), "Fixture process refusal\n");
  const previousPath = process.env.PATH;
  process.env.PATH = `${npmDirectory}:${previousPath}`;
  let stage = 0, image = priorImage, enabled = true, message = "previous-release";
  let workerId = identity.workerVersionId, deploymentId = identity.workerDeploymentId;
  let app: any = { id: identity.applicationId, name: identity.worker, version: 1,
    configuration: { image: priorImage }, created_at: "2026-10-11T12:00:30.000Z" };
  let rollouts: any[] = [];
  let failedReadback = false;
  let initialDeploymentReads = 0;
  const commands: string[][] = [];
  const request = async (url: string) => {
    const suffix = new URL(url).pathname.split("/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")[1];
    if (stage === 0 && suffix?.endsWith("/deployments")) {
      initialDeploymentReads += 1;
      if (preflightFailure === "provider-preflight" && initialDeploymentReads === 2) return new Response("", { status: 503 });
    }
    if (failPostInstallReadback && !failedReadback && stage === 2 && suffix?.endsWith("/deployments")) {
      failedReadback = true; return new Response("", { status: 503 });
    }
    let result: any;
    if (suffix === "containers/applications") result = [app];
    else if (suffix === `containers/applications/${app.id}`) result = app;
    else if (suffix === `containers/applications/${app.id}/rollouts`) result = rollouts;
    else if (suffix === `containers/applications/${app.id}/instances`) result = { instances: [] };
    else if (suffix === `workers/scripts/${identity.worker}/deployments`) result = { deployments: [{ id: deploymentId, versions: [{ version_id: workerId, percentage: 100 }] }] };
    else if (suffix === `workers/scripts/${identity.worker}/versions/${workerId}`) result = { id: workerId,
      annotations: { "workers/tag": source, "workers/message": message }, resources: { bindings: [
        ...Object.entries({ PREVIEW_RENDERER_SHA: source, PREVIEW_RENDERER_ENABLED: String(enabled), PREVIEW_SERIALIZER_ID: "cloudflare-preview",
          CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev" }).map(([name, text]) => ({ name, text, type: "plain_text" })),
        ...["FIREBASE_SERVICE_ACCOUNT", "R2_PREVIEW_CREDENTIAL", "CMS_DEV_ACCESS_CLIENT_ID", "CMS_DEV_ACCESS_CLIENT_SECRET"].map(name => ({ name, type: "secret_text" })),
      ] } };
    else if (suffix === `workers/scripts/${identity.worker}/schedules`) result = [{ cron: "* * * * *" }];
    else throw new Error("Unexpected provider fixture route");
    return new Response(JSON.stringify({ success: true, result }));
  };
  const spawnProcess = (_command: string, args: string[]) => {
    const child: any = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(async () => {
      try {
        commands.push(args.slice(1)); stage += 1;
        const config = JSON.parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
        expect(config.vars.PREVIEW_RENDERER_ENABLED).toBe("false");
        expect(config.vars.FIREBASE_PROJECT_ID).toBe("njpbs-site-dev");
        expect(args).not.toContain("secret");
        enabled = false; message = args[args.indexOf("--message") + 1];
        workerId = `${stage + 3}`.repeat(8) + "-4444-4444-8444-444444444444";
        deploymentId = `${stage + 3}`.repeat(8) + "-5555-4555-8555-555555555555";
        if (stage === 2 && failImage) {
          if (outsider) message = "another-operator";
          child.emit("exit", 1); return;
        }
        if (stage === 3 && failPostInstallReadback) {
          expect((await db.doc(owner.ROOT).get()).data()?.recoveryProvider.image).toBe(nextImage);
        }
        if (stage === 3 && loseRestoreReply === "worker-only") { child.emit("exit", 1); return; }
        if (!args.includes("--containers-rollout=none")) {
          const next = config.containers[0].image.startsWith("registry.") ? config.containers[0].image : nextImage;
          if (rollouts.length) app = { ...app, version: rollouts[0].target_version, configuration: rollouts[0].target_configuration };
          const rolloutId = `${stage + 3}`.repeat(8) + "-6666-4666-8666-666666666666";
          const version = app.version + 1;
          rollouts = [{ id: rolloutId, created_at: new Date().toISOString(), status: "pending", current_version: app.version,
            current_configuration: { image }, target_version: version, target_configuration: { image: next } }];
          app = { ...app, active_rollout_id: rolloutId }; image = next;
        }
        child.emit("exit", stage === 3 && loseRestoreReply === "image" ? 1 : 0);
      } catch (error) { child.emit("error", error); }
    });
    return child;
  };
  const inputs = { rendererSha: source, token: "synthetic-boundary-token" };
  const environment = { GITHUB_SHA: source, GITHUB_RUN_ID: "7" };
  const provenance = { schemaVersion: 1, operatorCommitSha: source, rendererSha: source,
    rendererTree: execFileSync("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(), workerSourceDigest: "e".repeat(64) };
  const seedInstalled = async () => {
    const snapshot = await owner.inspectDevPreviewBootstrap({ firestore: db, rendererSha: source });
    const attempt = { schemaVersion: 1, operationId: "dev-renderer-7", rendererSha: source, operatorCommitSha: source, provenance,
      bootstrapOperationId: snapshot.bootstrapOperationId, publicDigest: snapshot.publicDigest, startedAt: new Date().toISOString(),
      prior: { provider: identity, image: priorImage, component: snapshot.component, preview: snapshot.preview } };
    const claimed = await owner.claimDevPreviewBootstrap({ firestore: db, attempt });
    // Seed the provider's installed stage at the HTTP boundary. The original
    // journal and completed paused control still use real owner transactions.
    stage = 2; enabled = false; message = attempt.operationId;
    workerId = "55555555-4444-4444-8444-444444444444";
    deploymentId = "55555555-5555-4555-8555-555555555555";
    const rolloutId = "55555555-6666-4666-8666-666666666666";
    rollouts = [{ id: rolloutId, created_at: new Date().toISOString(), status: "pending", current_version: 1,
      current_configuration: { image: priorImage }, target_version: 2, target_configuration: { image: nextImage } }];
    app = { ...app, active_rollout_id: rolloutId }; image = nextImage;
    await owner.finishDevPreviewBootstrap({ firestore: db, attemptDigest: claimed.attemptDigest, provider: {
      ...identity, workerVersionId: workerId, workerDeploymentId: deploymentId, enabled: false, image: nextImage,
      imageFingerprint: createHash("sha256").update(JSON.stringify({ image: nextImage, digest: null })).digest("hex"),
      imageState: "configured", rolloutId, operationId: attempt.operationId,
    } });
  };
  return { inputs, environment, provenance, request, spawnProcess, commands, before, originalPreview,
    seedInstalled,
    permitPreparation: () => rm(path.join(npmDirectory, "fail-preparation"), { force: true }),
    cleanup: async () => {
      process.env.PATH = previousPath;
      const failed = await readFile(path.join(npmDirectory, "failed-preparation-cwd"), "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error; return "";
      });
      for (const cwd of failed.trim().split("\n").filter(Boolean)) {
        const owned = path.resolve(cwd, "../..");
        if (path.dirname(owned) !== tmpdir() || !/^njpbs-preview-renderer-build-[A-Za-z0-9]+$/.test(path.basename(owned)) ||
            path.basename(cwd) !== "preview-renderer") throw new Error("Refuse unknown preparation cleanup path");
        await rm(owned, { recursive: true, force: true });
      }
      await rm(npmDirectory, { recursive: true, force: true });
    } };
}

it("installs the configured image while preview and all original public fences stay paused", async () => {
  const fixture = await controllerFixture();
  try {
    const installed = await bootstrapDevPreview({ firestore: db, ...fixture });
    expect(installed.status).toBe("committed-paused");
    expect(installed.receipt.provider.image).toBe(nextImage);
    expect((await db.doc(owner.PREVIEW).get()).data()?.phase).toBe("paused");
    expect(await publicRows()).toEqual(fixture.before);
    expect(fixture.commands).toHaveLength(2);
  } finally { await fixture.cleanup(); }
});

it("restores the original immutable image and paused control with fresh provider identity", async () => {
  const fixture = await controllerFixture();
  try {
    await fixture.seedInstalled();
    const restored = await restoreDevPreviewBootstrap({ firestore: db, ...fixture });
    expect(restored.status).toBe("restored-paused");
    expect(restored.receipt.provider.image).toBe(priorImage);
    expect(restored.receipt.provider.workerVersionId).not.toBe(oldProvider.workerVersionId);
    expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(fixture.originalPreview);
    expect(await publicRows()).toEqual(fixture.before);
    expect(await restoreDevPreviewBootstrap({ firestore: db, ...fixture })).toEqual(restored);
    expect(fixture.commands).toHaveLength(1);
  } finally { await fixture.cleanup(); }
});

it.each([false, true])("handles process failure without overwriting an outsider: %s", async outsider => {
  const fixture = await controllerFixture({ failImage: true, outsider });
  try {
    await expect(bootstrapDevPreview({ firestore: db, ...fixture })).rejects.toMatchObject({
      bootstrapPhase: "install-configured-image", restoreStatus: outsider ? "refused" : "restored-paused",
      bootstrapReceipt: { status: outsider ? "failed" : "restored-paused" } });
    expect((await db.doc(owner.ROOT).get()).data()?.status).toBe(outsider ? "failed" : "restored-paused");
    // Same-source fixture still has the original image, so no restore deploy
    // is needed after the image process fails before a container effect.
    expect(fixture.commands).toHaveLength(2);
    expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(fixture.originalPreview);
    expect(await publicRows()).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
});

it("recovers the original committed outcome after a lost SDK commit acknowledgement without another provider write", async () => {
  const fixture = await controllerFixture(); let dropAcknowledgement = true;
  const firestore = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const result = await (target.runTransaction as any)(...args);
      if (dropAcknowledgement && result?.status === "committed-paused") { dropAcknowledgement = false; throw new Error("Synthetic lost network acknowledgement"); }
      return result;
    };
    const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    expect((await bootstrapDevPreview({ firestore, ...fixture })).status).toBe("committed-paused");
    expect(fixture.commands).toHaveLength(2);
    expect(await publicRows()).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
});

it.each(["worker-only", "image"] as const)("reconciles a partial explicit restore after %s without repeating a completed provider write", async point => {
  const fixture = await controllerFixture({ loseRestoreReply: point });
  try {
    await fixture.seedInstalled();
    await expect(restoreDevPreviewBootstrap({ firestore: db, ...fixture })).rejects.toThrow();
    expect((await db.doc(owner.ROOT).get()).data()?.status).toBe("committed-paused");
    const restored = await restoreDevPreviewBootstrap({ firestore: db, ...fixture });
    expect(restored.status).toBe("restored-paused");
    expect(restored.receipt.provider.image).toBe(priorImage);
    expect(fixture.commands).toHaveLength(point === "image" ? 1 : 2);
    expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(fixture.originalPreview);
    expect(await publicRows()).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
});

it.each(["worker-only", "image"] as const)("seals recovery before a failed bootstrap's automatic restore stops after %s", async point => {
  const fixture = await controllerFixture({ loseRestoreReply: point, failPostInstallReadback: true });
  try {
    await expect(bootstrapDevPreview({ firestore: db, ...fixture })).rejects.toMatchObject({
      bootstrapPhase: "provider-readback", restoreStatus: "refused" });
    const failed = (await db.doc(owner.ROOT).get()).data()!;
    expect(failed.status).toBe("failed");
    expect(failed.recoveryProvider.image).toBe(nextImage);
    const restored = await restoreDevPreviewBootstrap({ firestore: db, ...fixture });
    expect(restored.status).toBe("restored-paused");
    expect(restored.receipt.provider.image).toBe(priorImage);
    expect(restored.recoveryProvider).toEqual(failed.recoveryProvider);
    expect(fixture.commands).toHaveLength(point === "image" ? 3 : 4);
    expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(fixture.originalPreview);
    expect(await publicRows()).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
});

it.each(["source-preparation", "provider-preflight"] as const)("allocates no claim or provider effect after %s fails", async phase => {
  const fixture = await controllerFixture({ preflightFailure: phase });
  try {
    await expect(bootstrapDevPreview({ firestore: db, ...fixture })).rejects.toMatchObject({ bootstrapPhase: phase, restoreStatus: "not-needed" });
    expect((await db.doc(owner.ROOT).get()).exists).toBe(false);
    expect(fixture.commands).toHaveLength(0);
    expect((await db.doc(owner.COMPONENT).get()).data()?.state).toBe("complete");
    expect((await db.doc(owner.PREVIEW).get()).data()).toEqual(fixture.originalPreview);
    expect(await publicRows()).toEqual(fixture.before);
    await fixture.permitPreparation();
    const result = await bootstrapDevPreview({ firestore: db, ...fixture, environment: { ...fixture.environment, GITHUB_RUN_ID: "8" } });
    expect(result.status).toBe("committed-paused");
    expect(result.attempt.operationId).toBe("dev-renderer-8");
    expect(fixture.commands).toHaveLength(2);
    expect(await publicRows()).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
});

it("preserves an unknown claim outcome and stops before any provider effect", async () => {
  const fixture = await controllerFixture();
  const firestore = new Proxy(db, { get(target, key) {
    if (key === "runTransaction") return async (...args: any[]) => {
      const result = await (target.runTransaction as any)(...args);
      if (result?.status === "claimed") throw new Error("Synthetic lost claim acknowledgement");
      return result;
    };
    const value = (target as any)[key]; return typeof value === "function" ? value.bind(target) : value;
  } });
  try {
    await expect(bootstrapDevPreview({ firestore, ...fixture })).rejects.toMatchObject({ bootstrapPhase: "claim", restoreStatus: "not-needed" });
    const original = (await db.doc(owner.ROOT).get()).data()!;
    expect(original.status).toBe("claimed");
    expect(fixture.commands).toHaveLength(0);
    await expect(bootstrapDevPreview({ firestore: db, ...fixture, environment: { ...fixture.environment, GITHUB_RUN_ID: "8" } })).rejects.toThrow();
    expect((await db.doc(owner.ROOT).get()).data()).toEqual(original);
    expect(await publicRows()).toEqual(fixture.before);
  } finally { await fixture.cleanup(); }
});

it("accepts only the immutable development image namespace and consistent digest", () => {
  expect(immutableDevRendererImage({ image: priorImage, image_digest: null })).toBe(priorImage);
  for (const config of [{ image: priorImage.replace(/\/[^/@]+@/, "/unrelated-renderer@") }, { image: priorImage.split("@")[0] + ":latest" },
    { image: priorImage, image_digest: "sha256:" + "f".repeat(64) }]) expect(() => immutableDevRendererImage(config)).toThrow();
});
