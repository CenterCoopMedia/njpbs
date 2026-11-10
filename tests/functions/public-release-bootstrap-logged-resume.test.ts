import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { initialPublicReleaseControlsFixture } from "../helpers/initial-public-release-controls";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { deferInstalledConsumerProvider } from "../../scripts/development-public-release-adoption.mjs";
import { createInstalledConsumerProvider } from "../../site/scripts/public-release-installed-consumer-provider";

// The actual installed-consumer WeakMap, source/receipt binding, SDK enrollment,
// OLD controls and initial CAS run here. Qualification and full HTTP readiness
// are explicit seams; their actual H/G/router proof has a separate suite.
const seams = vi.hoisted(() => ({ proofs: [] as any[], qualificationChanged: false, readinessChanged: false,
  forbidReadsAfterVerification: false, duringVerify: undefined as (() => void) | undefined,
  duringReadiness: undefined as (() => void) | undefined }));
vi.mock("../../site/scripts/bootstrap-public-release-selector", () => ({ prepareBootstrapQualificationGuard: async () => ({
  begin: (original: any) => {
    let verified = false;
    const transaction = new Proxy(original, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if ((key === "get" || key === "getAll") && typeof value === "function") return (...args: unknown[]) => {
        if (verified && seams.forbidReadsAfterVerification) throw new Error("Source guard has spent its remaining read budget");
        return value.apply(target, args);
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
    return { transaction, verify: async () => {
      if (seams.qualificationChanged) throw new Error("Qualification source changed");
      verified = true; seams.duringVerify?.(); return seams.proofs;
    }, finish() {} };
  },
}) }));
vi.mock("../../site/scripts/public-release-bootstrap-ingress-proof", () => ({
  prepareBootstrapIngressProof: async () => {
    seams.duringReadiness?.();
    return Object.freeze({ kind: "fenced-bootstrap-readiness", rosterDigest: "d".repeat(64) });
  },
  assertPreparedBootstrapIngress: () => { if (seams.readinessChanged) throw new Error("Readiness expired"); return { roots: [], roster: [] }; },
}));
import { parseBootstrapResumeAttempt, prepareBootstrapLoggedResume, resumePreparedBootstrap, readBootstrapResumeReceipt } from "../../site/scripts/public-release-bootstrap-logged-resume";
import { readInitialBootstrapReceipt } from "../../site/scripts/public-release-bootstrap-readback";
import { parseInitialBootstrapOperatorArgs } from "../../site/scripts/bootstrap-public-release-initial";

let app: ReturnType<typeof initializeApp>, firestore: Firestore;
let f: Awaited<ReturnType<typeof initialPublicReleaseControlsFixture>>, attempt: ReturnType<typeof parseBootstrapResumeAttempt>;
const fencePath = "system/publicReleaseAdmissions/controls/bootstrapFence", receiptPath = "system/publicReleaseAdmissions/bootstrapResumes/resume-once";
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || process.env.GCLOUD_PROJECT !== "demo-njpbs") throw new Error("Use the loopback demo emulator");
  app = initializeApp({ projectId: "njpbs-site-dev" }, "bootstrap-logged-resume"); firestore = getFirestore(app);
});
afterAll(async () => { if (app) await deleteApp(app); });
beforeEach(async () => {
  for (const collection of ["system", "cmsDeploymentReceipts", "cmsReaderCompatibilityReceipts", "cmsPublishQueue", "admin_logs"])
    await firestore.recursiveDelete(firestore.collection(collection));
  f = await initialPublicReleaseControlsFixture(firestore); await f.convert();
  const head = (await firestore.doc("system/publicReleaseChanges").get()).data()!;
  const cursor = { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest };
  seams.proofs = await Promise.all([f.pair, f.recoveryPair].map(async pair => {
    const content = (await firestore.doc(`${work.publicReleasePairPath(pair.pairId)}/heads/current`).get()).data()!.contentHead;
    return { receipt: { pairDigest: p.publicReleaseDigest(pair), witnessDigest: content.viewId },
      witness: { contentViewDigest: content.manifestDigest, headCursor: cursor } };
  }));
  seams.qualificationChanged = false; seams.readinessChanged = false;
  seams.forbidReadsAfterVerification = false; seams.duringVerify = undefined;
  seams.duringReadiness = undefined;
  attempt = parseBootstrapResumeAttempt({ schemaVersion: 2, operationId: "resume-once", bootstrap: f.attempt, qualifications: f.attempt.qualifications });
});
const store = { get: async () => { throw new Error("Qualification seam must not read bytes"); }, put: async () => { throw new Error("Read only"); } };
const prepare = (signal?: AbortSignal) => prepareBootstrapLoggedResume({ firestore, attempt, store, evidence: f.options, signal });
async function unchanged(writerPresent = true) {
  expect((await firestore.doc(receiptPath).get()).exists).toBe(false);
  expect((await firestore.doc(fencePath).get()).data()!.status).toBe("closed");
  expect((await firestore.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(writerPresent);
  expect((await firestore.doc("system/publicReleaseAdmissions/controls/adoption").get()).data()!.enabled).toBe(false);
  expect((await firestore.doc("system/publicReleaseChangeLog").get()).data()!.enabled).toBe(false);
}
it("defaults to a zero-write dry run, then opens only logged producers in one original SDK transaction", async () => {
  const proof = await prepare(), root = (await firestore.doc("system/publicDeployment").get()).data();
  const controls = (await firestore.doc("system/cmsPublicationRuntime").get()).data();
  expect((await resumePreparedBootstrap({ firestore, proof })).dryRun).toBe(true); await unchanged();
  const result = await resumePreparedBootstrap({ firestore, proof, dryRun: false });
  expect(result.idempotent).toBe(false); expect(result.receipt.kind).toBe("public-release-bootstrap-resume");
  expect((await firestore.doc("system/publicDeployment").get()).data()).toEqual(root);
  expect((await firestore.doc("system/cmsPublicationRuntime").get()).data()).toEqual(controls);
  expect((await firestore.doc(fencePath).get()).data()).toMatchObject({ status: "open", resumeReceiptDigest: p.publicReleaseDigest(result.receipt) });
  expect((await firestore.doc("system/publicDeployment/releaseWriter/fence").get()).exists).toBe(false);
  expect((await firestore.doc("system/publicReleaseChangeLog").get()).data()!.enabled).toBe(true);
  expect((await firestore.doc("system/publicReleaseAdmissions/controls/adoption").get()).data()!.enabled).toBe(true);
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.bootstrap-resume").get()).size).toBe(1);
});
it("resumes after canonical OLD readiness takes over 30 seconds within the native 120-second budget", async () => {
  // Advance only AbortSignal's clock: SDK I/O and the qualification measurement
  // continue on real timers. Native timeout() otherwise ignores fake timers.
  let elapsed = 0;
  const deadlines: { at: number; controller: AbortController }[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController(); deadlines.push({ at: elapsed + ms, controller }); return controller.signal;
  });
  const createProvider = vi.fn(() => {
    const native = createInstalledConsumerProvider({ environment: "development", readGoogleToken: async () => "fixture-only",
      request: async () => Response.json({ functions: f.inventory }) });
    return { ...native, readProbe: f.provider.readProbe };
  });
  try {
    const provider = deferInstalledConsumerProvider(createProvider);
    seams.duringReadiness = () => {
      expect(createProvider).not.toHaveBeenCalled();
      elapsed = 30_001;
      for (const { at, controller } of deadlines) if (at <= elapsed) controller.abort();
    };
    const proof = await prepareBootstrapLoggedResume({ firestore, attempt, store, evidence: { ...f.options, provider } });
    expect(elapsed).toBeGreaterThan(30_000); expect(elapsed).toBeLessThan(120_000);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect((await resumePreparedBootstrap({ firestore, proof, dryRun: false })).idempotent).toBe(false);
    expect((await firestore.doc(fencePath).get()).data()!.status).toBe("open");
  } finally { timeout.mockRestore(); seams.duringReadiness = undefined; }
});
it("recovers the original receipt after a lost response and repeats without a second audit", async () => {
  const proof = await prepare(), first = await resumePreparedBootstrap({ firestore, proof, dryRun: false });
  expect(await readBootstrapResumeReceipt({ firestore, attempt })).toEqual(first.receipt);
  expect(await resumePreparedBootstrap({ firestore, proof, dryRun: false })).toMatchObject({ idempotent: true, receipt: first.receipt });
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.bootstrap-resume").get()).size).toBe(1);
});
it("returns the same immutable outcome to concurrent resumes", async () => {
  const a = await prepare(), b = await prepare();
  const results = await Promise.all([resumePreparedBootstrap({ firestore, proof: a, dryRun: false }), resumePreparedBootstrap({ firestore, proof: b, dryRun: false })]);
  expect(results[0].receipt).toEqual(results[1].receipt); expect(results.filter(value => value.idempotent)).toHaveLength(1);
  expect((await firestore.collection("admin_logs").where("action", "==", "public-release.bootstrap-resume").get()).size).toBe(1);
});
it("finishes without another SDK read after the source guard spends the remaining read budget", async () => {
  seams.forbidReadsAfterVerification = true;
  const proof = await prepare();
  expect((await resumePreparedBootstrap({ firestore, proof, dryRun: false })).idempotent).toBe(false);
});
it("refuses installed-consumer evidence that expires during the final source verification", async () => {
  const proof = await prepare(); seams.duringVerify = () => f.advance(60_001);
  await expect(resumePreparedBootstrap({ firestore, proof, dryRun: false })).rejects.toThrow(); await unchanged();
});
it.each(["root", "head", "writer", "receipt", "enrollment", "pins", "deployment", "media", "pair", "queue", "qualification", "readiness", "expired", "abort"])(
  "refuses late %s drift with no resume writes", async fault => {
    const controller = new AbortController(), proof = await prepare(controller.signal);
    if (fault === "root") await firestore.doc("system/publicDeployment").update({ activeDeploymentId: "changed" });
    if (fault === "head") await firestore.doc("system/publicReleaseChanges").update({ sequence: 1 });
    if (fault === "writer") await firestore.doc("system/publicDeployment/releaseWriter/fence").delete();
    if (fault === "receipt") await firestore.doc(`system/publicDeployment/bootstrapSelectors/${f.attempt.operationId}`).delete();
    if (fault === "enrollment") await firestore.doc("system/publicReleaseChanges/enrollment/initial").delete();
    if (fault === "pins") await firestore.doc("system/cmsPublicationRuntime").update({ phase: "paused" });
    if (fault === "deployment") await firestore.doc("cmsDeploymentReceipts/functions").delete();
    if (fault === "media") await firestore.doc("system/publicDeployment/pairMedia/current").delete();
    if (fault === "pair") await firestore.doc(`${work.publicReleasePairPath(f.recoveryPair.pairId)}/controls/runtime`).update({ status: "retired" });
    if (fault === "queue") await firestore.doc("cmsPublishQueue/late").set({ status: "pending" });
    if (fault === "qualification") seams.qualificationChanged = true;
    if (fault === "readiness") seams.readinessChanged = true;
    if (fault === "expired") f.advance(60_001);
    if (fault === "abort") controller.abort();
    await expect(resumePreparedBootstrap({ firestore, proof, dryRun: false })).rejects.toThrow(); await unchanged(fault !== "writer");
  });
it("refuses a cloned process-local proof and changed request reuse", async () => {
  const proof = await prepare(); await expect(resumePreparedBootstrap({ firestore, proof: { ...proof }, dryRun: false })).rejects.toThrow(); await unchanged();
  await resumePreparedBootstrap({ firestore, proof, dryRun: false });
  await expect(readBootstrapResumeReceipt({ firestore, attempt: { ...attempt, qualifications: [...attempt.qualifications].reverse() } })).rejects.toThrow();
});
it("reads the original initial selector outcome without repeating qualification or byte I/O", async () => {
  const receipt = await readInitialBootstrapReceipt({ firestore, attempt: f.attempt });
  expect(receipt?.kind).toBe("public-release-bootstrap");
  await firestore.doc("system/publicDeployment").update({ epoch: 2 });
  expect(await readInitialBootstrapReceipt({ firestore, attempt: f.attempt })).toEqual(receipt);
});
it.each(["initial-authority", "installed-guard", "after-authority"])("bounds a stalled %s preparation boundary by caller abort", async phase => {
  const controller = new AbortController(); let markStarted!: () => void, transactions = 0;
  const entered = new Promise<void>(resolve => { markStarted = resolve; });
  const stalled = () => { markStarted(); return new Promise<never>(() => {}); };
  const database = new Proxy(firestore, { get(target, key) {
    if (key === "runTransaction") return (...args: any[]) => {
      transactions++;
      if (phase === "initial-authority" && transactions === 1 || phase === "after-authority" && transactions === 2) return stalled();
      return (target.runTransaction as any)(...args);
    };
    if (key === "doc") return (path: string) => {
      const reference = target.doc(path);
      if (phase !== "installed-guard" || path !== `system/publicReleaseAdmissions/bootstrapControls/${f.attempt.operationId}`) return reference;
      return new Proxy(reference, { get(original, member) {
        if (member === "get") return stalled;
        const value = Reflect.get(original, member, original); return typeof value === "function" ? value.bind(original) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const result = prepareBootstrapLoggedResume({ firestore: database, attempt, store, evidence: f.options, signal: controller.signal });
  await entered; const abortedAt = performance.now(); controller.abort();
  await expect(result).rejects.toThrow("Private pair read deadline");
  expect(performance.now() - abortedAt).toBeLessThan(1_000); await unchanged();
});
it("parses separate explicit readback, resume readback and dry-run/apply modes", () => {
  expect(parseInitialBootstrapOperatorArgs(["--readback-attempt", "a.json"])).toEqual({ initialReadbackFile: "a.json", dryRun: true });
  expect(parseInitialBootstrapOperatorArgs(["--resume-readback", "r.json"])).toEqual({ resumeReadbackFile: "r.json", dryRun: true });
  expect(parseInitialBootstrapOperatorArgs(["--resume-attempt", "r.json"])).toEqual({ resumeFile: "r.json", dryRun: true });
  expect(parseInitialBootstrapOperatorArgs(["--resume-attempt", "r.json", "--apply"])).toEqual({ resumeFile: "r.json", dryRun: false });
  expect(() => parseInitialBootstrapOperatorArgs(["--resume-readback", "r.json", "--apply"])).toThrow();
});
it("queries original initial and resumed outcomes through the actual Node22+tsx launcher without fd3", async () => {
  const proof = await prepare(), resumed = await resumePreparedBootstrap({ firestore, proof, dryRun: false });
  const directory = await mkdtemp(path.join(tmpdir(), "bootstrap-outcome-"));
  try {
    for (const [flag, value, expected] of [["--readback-attempt", f.attempt, await readInitialBootstrapReceipt({ firestore, attempt: f.attempt })],
      ["--resume-readback", attempt, resumed.receipt]] as const) {
      const file = path.join(directory, flag.slice(2) + ".json"); await writeFile(file, JSON.stringify(value));
      const child = spawn(process.execPath, ["--import", path.resolve("site/node_modules/tsx/dist/loader.mjs"),
        "scripts/bootstrap-public-release-initial.mjs", flag, file], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", error = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      expect({ code, error }).toEqual({ code: 0, error: "" }); expect(JSON.parse(output).receipt).toEqual(JSON.parse(JSON.stringify(expected)));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
