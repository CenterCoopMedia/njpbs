import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { publicationFromPrepared } from "../../site/src/lib/public-publication-receipt";
import { prepareContentBaseline, seedContentBaseline } from "../../site/scripts/public-content-baseline-artifact";
import { baselineObjectKey } from "../../packages/content-core/src/public-content-baseline";
import { publicationTarget } from "../../functions/lib/publication-target";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { publicReleaseBaselineCodeFixture } from "../helpers/public-release-baseline-code";
import enrollment from "../../functions/lib/public-release-change-enrollment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import pause from "../../functions/lib/dev-public-release-pause.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import log from "../../functions/lib/public-release-change-log.js";
import protocol from "../../functions/lib/public-release-pair.js";
import deployment from "../../functions/lib/public-deployment.js";
import context from "../../functions/lib/public-context-revision.js";
import sourceBody from "../../functions/lib/public-release-source-body.js";
import historicalCode from "../../functions/lib/public-release-historical-code.js";
import { createRequire } from "node:module";
const scheduleReader = createRequire(import.meta.url)("../../functions/lib/no-build-page-schedule-reader.js");
import { parseEnrollmentOperatorArgs } from "../../scripts/enroll-public-release-change-log.mjs";
const run = promisify(execFile), sha = "a".repeat(40), root = log.PUBLIC_RELEASE_CHANGES_PATH;
const story = JSON.parse(readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
let db: ReturnType<typeof isolatedFirestore>, code: ReturnType<typeof publicReleaseBaselineCodeFixture>, request: any;
beforeAll(() => { db = isolatedFirestore("initial-release-change-enrollment"); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), mediaLifecycleReady: true, activeGeneration: 1,
    activeDeploymentId: "original-release", activeCommitSha: sha, lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "original-release" });
  await db.doc(context.PUBLIC_CONTEXT_PATH).set({ schemaVersion: 1, revision: 1 });
  await db.doc("cmsPosts/story").set({ ...story, id: "story", version: 9, title: "PRIVATE WORKING TITLE" });
  code = publicReleaseBaselineCodeFixture(db, sha);
  const environment = code.firestore.projectId === "njpbs-site-dev" ? "development" : "production";
  const oldRuntime = { schemaVersion: 1, phase: environment === "production" ? "ready" : "paused", commitSha: sha,
    serializerId: environment === "production" ? "cloudflare-publisher" : "cloudflare-dev-publisher" };
  await db.doc("system/cmsPublicationRuntime").set(oldRuntime);
  if (environment === "production") await pause.pausePublicRelease({ firestore: code.firestore, attempt: {
    schemaVersion: 1, operationId: "bootstrap-original", environment, projectId: code.firestore.projectId, oldRuntime,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest((await db.doc("system/publicDeployment").get()).data()),
  } });
  else await adoption.closePublicReleaseBootstrapAdmission({ firestore: code.firestore, attempt: {
    schemaVersion: 2, operationId: "bootstrap-original", environment,
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest((await db.doc("system/publicDeployment").get()).data()),
  } });
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: code.firestore });
  request = { schemaVersion: 1, operationId: "bootstrap-original", logEpoch: "bootstrap-epoch", baselineDigest: "f".repeat(64), expected: observed.expected };
});
const apply = (options = {}) => enrollment.enrollPublicReleaseChangeLog({ firestore: code.firestore, request, currentCodeRequest: code.request, dryRun: false, ...options });
const readBaseline = (digest: string) => db.runTransaction(transaction => baseline.assertReadPublicReleaseChangeBaselineInTransaction({ firestore: db, transaction, logBaselineDigest: digest }), { readOnly: true });
async function absent() {
  expect((await db.doc(root).get()).exists).toBe(false);
  expect((await db.doc(enrollment.ENROLLMENT_PATH).get()).exists).toBe(false);
  expect((await db.collection(`${root}/baselines`).get()).empty).toBe(true);
  expect((await db.doc("system/publicReleaseChangeLog").get()).exists).toBe(false);
}
it("dry-run validates the original CODE and source without any private or public writes", async () => {
  const result = await enrollment.enrollPublicReleaseChangeLog({ firestore: code.firestore, request, currentCodeRequest: code.request });
  expect(result.status).toBe("dry-run"); await absent();
  for (const collection of ["bodies", "censusPages", "baselineCensuses", "codeChunks"]) expect((await db.collection(`${root}/${collection}`).get()).empty).toBe(true);
});
it("retains original CODE bytes when the fresh manifest has a different field order", async () => {
  let reads = 0;
  const currentCodeRequest = async (input: any, init: any) => {
    const wire = await (await code.request(input, init)).json();
    if (++reads === 2) wire.reference.manifest = Object.fromEntries(Object.entries(wire.reference.manifest).reverse());
    return new Response(JSON.stringify(wire), { headers: { "content-type": "application/json" } });
  };
  const expectedBytes = Buffer.from(JSON.stringify({ publicContext: code.qualified.publicContext,
    publication: code.qualified.publication, reference: code.qualified.reference }));
  const result = await apply({ currentCodeRequest });
  expect(result.status).toBe("enrolled");
  const captured = await readBaseline(result.receipt.baseline.logBaselineDigest);
  const member = captured.sourceMembers.find(value => value.id === "publicReleaseHistoricalCode")!;
  const body = await db.runTransaction(transaction => sourceBody.readPublicReleaseSourceBody({
    firestore: db, transaction, contentDigest: member.contentDigest }), { readOnly: true });
  const descriptor = body.snapshot;
  const chunks = await Promise.all(descriptor.chunks.map((digest: string) => db.doc(`${historicalCode.CHUNKS}/${digest}`).get()));
  const retainedBytes = Buffer.concat(chunks.map(row => Buffer.from(row.data()!.base64, "base64")));
  expect(retainedBytes).toEqual(expectedBytes);
  expect(descriptor.qualifiedCodeDigest).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
});
it("refuses a changed CODE reference value on the freshness read", async () => {
  let reads = 0;
  await expect(enrollment.enrollPublicReleaseChangeLog({ firestore: code.firestore, request,
    currentCodeRequest: async (input: any, init: any) => {
      const wire = await (await code.request(input, init)).json();
      if (++reads === 2) wire.reference.publication.artifactDigest = "e".repeat(64);
      return new Response(JSON.stringify(wire), { headers: { "content-type": "application/json" } });
    } })).rejects.toMatchObject({ name: "PublicReleaseProtocolError", status: 409 });
  await absent();
  for (const collection of ["bodies", "censusPages", "baselineCensuses", "codeChunks"]) expect((await db.collection(`${root}/${collection}`).get()).empty).toBe(true);
});
it("atomically creates first head, retained global baseline and immutable original receipt", async () => {
  const result = await apply();
  expect(result.status).toBe("enrolled"); expect(result.idempotent).toBe(false);
  expect((await db.doc(root).get()).data()).toEqual(log.initialPublicReleaseChangeHead(request.baselineDigest));
  const receipt = enrollment.parsePublicReleaseChangeEnrollmentReceipt((await db.doc(enrollment.ENROLLMENT_PATH).get()).data());
  expect(receipt).toEqual(result.receipt); expect(result.receiptDigest).toBe(protocol.publicReleaseDigest(receipt));
  const original = await readBaseline(receipt.baseline.logBaselineDigest);
  expect(original.receipt).toEqual(receipt.baseline.receipt);
  expect(original.sourceMembers.some(member => member.id === "story")).toBe(true);
  const bodies = (await db.collection(`${root}/bodies`).get()).docs.map(row => row.data().json).join("");
  expect(bodies).not.toContain("PRIVATE WORKING TITLE");
  expect((await db.doc("system/publicReleaseChangeLog").get()).exists).toBe(false);
});
it("returns the original exact receipt after an ambiguous result without reading mutable CODE or source bodies", async () => {
  const one = await apply();
  await db.doc("cmsPosts/story").delete(); await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  const repeated = await apply({ currentCodeRequest: async () => { throw new Error("No latest CODE"); } });
  expect(repeated.idempotent).toBe(true); expect(repeated.receipt).toEqual(one.receipt); expect(repeated.receiptDigest).toBe(one.receiptDigest);
  expect((await db.collection(`${root}/baselines`).get()).size).toBe(1);
});
it.each(["operation", "epoch", "anchor", "context", "project"])("refuses a changed %s enrollment request", async mode => {
  await apply(); const changed = structuredClone(request);
  if (mode === "operation") changed.operationId = "another-operation";
  if (mode === "epoch") changed.logEpoch = "another-epoch";
  if (mode === "anchor") changed.baselineDigest = "0".repeat(64);
  if (mode === "context") Object.assign(changed.expected, { contextRevision: 2, contextDigest: context.publicContextDigest(2) });
  if (mode === "project") changed.expected.projectId = "another-project";
  await expect(apply({ request: changed })).rejects.toThrow();
});
it.each([0, 3])("never reseeds an existing head at sequence %s without its original receipt", async sequence => {
  await db.doc(root).set({ ...log.initialPublicReleaseChangeHead("e".repeat(64)), sequence, lastDigest: sequence ? "d".repeat(64) : "e".repeat(64) });
  await expect(apply()).rejects.toMatchObject({ code: "enrollment-head-exists" });
  expect((await db.collection(`${root}/baselines`).get()).empty).toBe(true);
});
it.each(["runtime", "primary", "producer", "disabled-producer", "pointer", "context", "source"])("refuses %s drift before private preparation", async mode => {
  if (mode === "runtime") await db.doc("system/cmsPublicationRuntime").update({ phase: "ready" });
  if (mode === "primary") await db.doc("system/cmsPublicationRuntime").update({ phase: "ready", cloud: { phase: "paused", commitSha: sha, serializerId: "cloudflare-dev-publisher" } });
  if (mode === "producer" || mode === "disabled-producer") await db.doc("system/publicReleaseChangeLog").set({ enabled: mode === "producer" });
  if (mode === "pointer") await db.doc("system/publicDeployment").update({ activeCommitSha: "b".repeat(40) });
  if (mode === "context") await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 });
  if (mode === "source") await db.doc("cmsPosts/story").update({ "published.metadata.title": "Unlogged public drift" });
  await expect(apply()).rejects.toThrow();
  expect((await db.doc(root).get()).exists).toBe(false);
  expect((await db.doc(enrollment.ENROLLMENT_PATH).get()).exists).toBe(false);
  expect((await db.collection(`${root}/bodies`).get()).empty).toBe(true);
});
it("refuses a cutoff race after private preparation, and preserves that original identity for a forward retry", async () => {
  let reads = 0;
  await expect(apply({ currentCodeRequest: async (input: any, init: any) => {
    const response = await code.request(input, init); if (++reads === 1) await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 2 }); return response;
  } })).rejects.toThrow();
  await absent(); expect((await db.collection(`${root}/bodies`).get()).empty).toBe(false);
  await expect(apply()).rejects.toThrow();
  await db.doc(context.PUBLIC_CONTEXT_PATH).update({ revision: 1 });
  const restored = await apply(); expect(restored.receipt.request).toEqual(request);
});
it("leaves no partial head or baseline when the atomic commit is interrupted, then retries the same request", async () => {
  const firestore = new Proxy(code.firestore, { get(target, key) {
    if (key === "runTransaction") return (callback: any, options: any) => target.runTransaction((transaction: any) => callback(new Proxy(transaction, { get(tx, method) {
      if (method === "create") return (ref: any, data: any) => { tx.create(ref, data); if (ref.path === enrollment.ENROLLMENT_PATH) throw new Error("Injected pre-commit stop"); return tx; };
      const value = Reflect.get(tx, method); return typeof value === "function" ? value.bind(tx) : value;
    } })), options);
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(apply({ firestore })).rejects.toThrow("Injected pre-commit stop"); await absent();
  expect((await db.collection(`${root}/bodies`).get()).empty).toBe(false);
  expect((await apply()).idempotent).toBe(false); expect((await apply()).idempotent).toBe(true);
});
it("refuses receipt-only and baseline-only partial states", async () => {
  const one = await apply(); await db.doc(root).delete();
  await expect(apply()).rejects.toMatchObject({ code: "enrollment-partial-state" });
  await db.doc(enrollment.ENROLLMENT_PATH).delete();
  await expect(apply()).rejects.toMatchObject({ code: "enrollment-partial-state" });
  expect((await db.doc(`${root}/baselines/${request.logEpoch}`).get()).data()).toEqual(one.receipt.baseline.receipt);
});
it("serializes concurrent identical requests into one original global baseline", async () => {
  const results = await Promise.all([apply(), apply()]);
  expect(results.map(result => result.receiptDigest)[0]).toBe(results[1].receiptDigest);
  expect(results.filter(result => result.idempotent)).toHaveLength(1);
  expect((await db.collection(`${root}/baselines`).get()).size).toBe(1);
});
it("runs the actual read-only CLI inspection against the isolated emulator", async () => {
  const output = await run(process.execPath, ["scripts/enroll-public-release-change-log.mjs", "inspect", "--project", db.projectId], { cwd: process.cwd(), env: process.env });
  const observed = JSON.parse(output.stdout); expect(observed.expected.projectId).toBe(db.projectId);
  expect(observed.expected.contextRevision).toBe(1); await absent();
});
it("runs actual CLI readback of the original atomic receipt without mutable CODE access", async () => {
  const observed = await enrollment.inspectPublicReleaseChangeEnrollment({ firestore: db });
  const localRequest = { ...request, expected: observed.expected };
  // Supply only the initial CODE transport boundary in this demo namespace.
  // The separate CLI readback process has no transport fixture or preload.
  const reader = vi.spyOn(scheduleReader, "createPageCurrentCodeContextReader").mockReturnValue(async () => code.qualified);
  let applied;
  try { applied = await apply({ firestore: db, request: localRequest }); } finally { reader.mockRestore(); }
  const directory = await mkdtemp(path.join(os.tmpdir(), "enrollment-readback-"));
  try {
    const file = path.join(directory, "request.json"); await writeFile(file, JSON.stringify(localRequest));
    const output = await run(process.execPath, ["scripts/enroll-public-release-change-log.mjs", "readback", "--project", db.projectId, "--request", file], { cwd: process.cwd(), env: process.env });
    expect(JSON.parse(output.stdout).receiptDigest).toBe(applied.receiptDigest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("refuses a mismatched CLI target before SDK access and keeps output bounded", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "initial-enrollment-cli-"));
  try {
    const file = path.join(directory, "request.json"); await writeFile(file, JSON.stringify(request));
    const result = await run(process.execPath, ["scripts/enroll-public-release-change-log.mjs", "apply", "--project", "another-project", "--request", file],
      { cwd: process.cwd(), env: { PATH: process.env.PATH } }).catch(error => error);
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr)).toEqual({ status: "refused", code: "enrollment-project-mismatch" });
    await absent();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it.each([[], ["apply"], ["inspect", "--project", "demo-njpbs", "--request", "unused"], ["dry-run", "--project", "demo-njpbs", "--request", "x", "--apply", "yes"]])
  ("refuses malformed operator arguments %s", args => { expect(() => parseEnrollmentOperatorArgs(args)).toThrow(); });

it("preserves an already-enrolled frozen baseline and exact manifest while additively retaining its publication blob", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "static-enrolled-baseline-"));
  try {
    const distDirectory = path.join(directory, "dist"); await mkdir(distDirectory);
    await writeFile(path.join(distDirectory, "index.html"), "<html>Original frozen baseline</html>");
    await writeFile(path.join(distDirectory, "_content-status.json"), JSON.stringify({ schemaVersion: 1,
      collections: ["cmsPages", "cmsPosts"], buildBatchId: code.qualified.publication.buildBatchId, generation: 1, commitSha: sha, routes: [] }));
    const prepared = await preparePublicWorkerArtifact({ artifactReceipt: code.qualified.publicContext.receipt, distDirectory, outputPath: path.join(directory, "prepared.json") });
    Object.assign(code.qualified.publication, publicationFromPrepared(prepared));
    const plan = await prepareContentBaseline({ target: publicationTarget("development"), distDirectory, preparedArtifact: prepared });
    const objects = new Map<string, Buffer>();
    // Existing seed grammar: public files and the original manifest, without
    // the independently sealed publication blob added by this change.
    for (const file of plan.baseline.files) objects.set(baselineObjectKey(plan.target, file.digest), await readFile(path.join(distDirectory, file.path)));
    objects.set(plan.manifestKey, Buffer.from(plan.manifestBytes));
    const originalManifest = Buffer.from(objects.get(plan.manifestKey)!);
    const enrolled = await apply(), original = await readBaseline(enrolled.receipt.baseline.logBaselineDigest);
    const digest = protocol.publicReleaseDigest(original.receipt);
    expect(objects.has(baselineObjectKey(plan.target, prepared.publicationReceiptDigest))).toBe(false);
    await seedContentBaseline(plan, { writeAndVerify: async (key, bytes) => {
      if (objects.has(key)) expect(objects.get(key)).toEqual(bytes); else objects.set(key, Buffer.from(bytes));
    } });
    expect(objects.get(plan.manifestKey)).toEqual(originalManifest);
    expect(objects.get(baselineObjectKey(plan.target, prepared.publicationReceiptDigest))).toEqual(await readFile(path.join(distDirectory, "_publication.json")));
    const reopened = await readBaseline(enrolled.receipt.baseline.logBaselineDigest);
    expect(reopened.receipt).toEqual(original.receipt); expect(protocol.publicReleaseDigest(reopened.receipt)).toBe(digest);
    const repeated = await apply({ currentCodeRequest: async () => { throw new Error("Existing enrollment cannot reread latest CODE"); } });
    expect(repeated.receipt).toEqual(enrolled.receipt); expect(repeated.receiptDigest).toBe(enrolled.receiptDigest);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each(['operator', 'deployed'])('preserves %s CODE secret resolution through enrollment and baseline with a fake HTTP boundary', async mode => {
  const ambient = 'synthetic-deployed-edge', operator = 'synthetic-inherited-edge';
  vi.stubEnv('CMS_EDGE_ORIGIN_SECRET', ambient);
  let calls = 0;
  try {
    const result = await enrollment.enrollPublicReleaseChangeLog({firestore: code.firestore, request,
      ...(mode === 'operator' ? {readSecret: () => operator} : {}),
      currentCodeRequest: async (url, init) => {
        calls++;
        expect(String(url)).toBe(code.firestore.projectId === 'njpbs-site-dev'
          ? 'https://dev-api.example.org/_internal/record-code' : 'https://api.example.org/_internal/record-code');
        expect(new Headers(init?.headers).get('x-njpbs-cms-edge')).toBe(mode === 'operator' ? operator : ambient);
        return code.request(url, init);
      }});
    expect(result.status).toBe('dry-run'); expect(calls).toBeGreaterThan(0); await absent();
  } finally { vi.unstubAllEnvs(); }
});
