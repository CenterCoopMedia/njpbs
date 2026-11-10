import { beforeAll, beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { publicSlotScenario, slotActions } from "../helpers/private-public-release-slot-target.mjs";
import { compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { installPublicReleasePairReaderWithPreflight } from "../../site/scripts/install-public-release-pair-reader-with-preflight";
import { privatePairReaderInstallation } from "../../workers/src/private-pair-reader-installation";
import { privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { PRIVATE_PREFLIGHT_ATTEMPTS } from "../../scripts/lib/private-pair-preflight-caller.mjs";
import protocol from "../../functions/lib/public-release-pair.js";

let db: ReturnType<typeof isolatedFirestore>, source: Uint8Array;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-reader-with-preflight.test.ts");
  source = await compilePrivateWorker(publicSlotScenario().config.main);
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

async function scenario() {
  const f = publicSlotScenario(source);
  await Promise.all(Object.entries(f.records).map(([path, row]) => db.doc(path).create(row)));
  const authority = { session: 0, upload: 0, invoke: 0 };
  let worker: { fetch(request: Request, env: unknown): Promise<Response> };
  let duringRpc: (() => Promise<void>) | undefined;
  let lostUploadReply = false, malformedResult = false;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)), path = url.pathname;
    const envelope = (result: unknown) => Response.json({ success: true, result });
    if (path.endsWith("/workers/subdomain")) return envelope({ subdomain: "fixture" });
    if (path.endsWith("/workers/subdomain/edge-preview")) {
      authority.session++; return envelope({ token: "synthetic-session-token" });
    }
    if (/\/workers\/scripts\/njpbs-private-preflight-[a-f0-9]{24}\/edge-preview$/.test(path)) {
      authority.upload++;
      expect(init.method).toBe("POST");
      const form = init.body as FormData;
      expect(JSON.parse(String(form.get("metadata"))).bindings).toEqual([{ name: "PAIR_PREFLIGHT", type: "service",
        service: f.pair.publicWorker.service, entrypoint: "PublicReleaseSlotEntrypoint" }]);
      worker = (await import(`data:text/javascript;base64,${Buffer.from(await (form.get("probe.mjs") as Blob).text()).toString("base64")}`)).default;
      if (lostUploadReply) throw new Error("synthetic-sensitive-upload-error");
      return envelope({ preview_token: "synthetic-preview-token" });
    }
    if (url.hostname.endsWith(".fixture.workers.dev")) {
      authority.invoke++;
      return worker.fetch(new Request(input, init), { PAIR_PREFLIGHT: { readerInstallation: async (...args: unknown[]) => {
        expect(args).toEqual([]);
        await duringRpc?.();
        const capabilities = privatePairReaderCapabilities(f.pair.commitSha);
        return { seals: privatePairReaderInstallation(f.pair, f.installPlan.readerOrigins[0]),
          publisher: { pairDigest: protocol.publicReleaseDigest(f.pair), publisher: f.pair.publisher,
            readerContractDigest: f.pair.readerContractDigest, capabilities }, ...(malformedResult ? { extra: true } : {}) };
      } } });
    }
    return f.fetchImpl(input, init);
  };
  return { ...f, authority, setDuringRpc: (run: () => Promise<void>) => { duringRpc = run; },
    loseUploadReply: () => { lostUploadReply = true; }, malformed: () => { malformedResult = true; },
    input: { firestore: db, pair: f.pair, installPlan: f.installPlan, rollout: f.rollout,
      preflightOperationId: "original-reader-proof", authorized: true, readToken: f.readToken, fetchImpl,
      clock: () => Date.parse("2026-10-28T22:00:00Z") } };
}

it("joins real SDK transactions, generated readerInstallation RPC and the create-only seal writer", async () => {
  const f = await scenario();
  const first = await installPublicReleasePairReaderWithPreflight(f.input);
  expect(first.idempotent).toBe(false);
  expect((await db.doc(readerSealPath(f.pair)).get()).data()).toEqual(privatePairReaderInstallation(f.pair, f.installPlan.readerOrigins[0]));
  expect((await db.doc(`${f.base}/readerInstalls/${first.installDigest}`).get()).data()).toEqual(first.receipt);
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  const again = await installPublicReleasePairReaderWithPreflight(f.input);
  expect(again).toEqual({ ...first, idempotent: true });
  await db.doc(`${f.base}/controls/runtime`).update({ status: "retained" });
  expect(await installPublicReleasePairReaderWithPreflight(f.input)).toEqual({ ...first, idempotent: true });
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  const attempt = (await db.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc(f.input.preflightOperationId).get()).data();
  expect(attempt?.state).toBe("complete");
  expect(JSON.stringify(attempt)).not.toContain("synthetic-slot-api");
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

it("requires explicit authorization and valid original identity before any provider I/O", async () => {
  const f = await scenario();
  for (const input of [{ ...f.input, authorized: false }, { ...f.input, signal: AbortSignal.abort() },
    { ...f.input, pair: { ...f.pair, capabilityDigest: "f".repeat(64) } },
    { ...f.input, rollout: { ...f.rollout, imageDigest: `sha256:${"f".repeat(64)}` } }]) {
    await expect(installPublicReleasePairReaderWithPreflight(input)).rejects.toThrow("Private reader installation was refused");
  }
  expect(f.calls).toEqual([]);
  expect(f.authority).toEqual({ session: 0, upload: 0, invoke: 0 });
});

it.each(["missing-seal", "existing-seal"])("refuses fresh caller authority for a retained pair with %s", async mode => {
  const f = await scenario();
  if (mode === "existing-seal") await installPublicReleasePairReaderWithPreflight(f.input);
  await db.doc(`${f.base}/controls/runtime`).update({ status: "retained" });
  const before = { ...f.authority };
  await expect(installPublicReleasePairReaderWithPreflight({ ...f.input, preflightOperationId: "new-retained-proof" })).rejects.toMatchObject({
    stage: "target", code: "reader-install-target-refused", uncertain: false,
  });
  expect(f.authority).toEqual(before);
  expect((await db.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc("new-retained-proof").get()).exists).toBe(false);
});

it.each(["bytes", "configuration", "deployment", "plan", "owner", "create", "upload", "private-subdomain", "deploy", "registry", "rollout", "billing", "retired"])("refuses %s readback mismatch without reserving ephemeral authority", async mode => {
  const f = await scenario();
  if (mode === "bytes") f.state.source = new TextEncoder().encode("different bytes");
  if (mode === "configuration") f.state.version.resources.bindings[0].text = "different config";
  if (mode === "deployment") f.state.deployment.id = "ffffffff-3333-4333-8333-333333333333";
  const path = mode === "plan" ? Object.keys(f.records).find(key => key.includes("/plans/"))
    : mode === "owner" ? Object.keys(f.records).find(key => key.includes("/workers/"))
    : slotActions.includes(mode) ? Object.keys(f.records).find(key => key.includes("/readbacks/") && key.endsWith(`-${mode}`))
    : mode === "registry" ? "system/publicReleasePairs" : mode === "rollout" ? `${f.base}/rollouts/publisher` : undefined;
  if (path) await db.doc(path).delete();
  if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
  if (mode === "retired") await db.doc(`${f.base}/controls/runtime`).update({ status: "retired" });
  await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toThrow();
  expect(f.authority).toEqual({ session: 0, upload: 0, invoke: 0 });
  expect((await db.doc(readerSealPath(f.pair)).get()).exists).toBe(false);
  expect((await db.collection(PRIVATE_PREFLIGHT_ATTEMPTS).get()).empty).toBe(true);
});

it.each(["retire", "billing", "provider-version", "wrong-rpc"])("rechecks %s after RPC before creating a seal", async mode => {
  const f = await scenario();
  if (mode === "wrong-rpc") f.malformed();
  else f.setDuringRpc(async () => {
    if (mode === "retire") await db.doc(`${f.base}/controls/runtime`).update({ status: "retired" });
    if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
    if (mode === "provider-version") f.state.deployment.versions[0].percentage = 99;
  });
  await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toThrow();
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  expect((await db.doc(readerSealPath(f.pair)).get()).exists).toBe(false);
});

it("never resends a lost original upload or leaks its boundary error", async () => {
  const f = await scenario(); f.loseUploadReply();
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toMatchObject({ stage: "caller", uncertain: true,
      message: expect.not.stringContaining("synthetic-sensitive-upload-error") });
  }
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 0 });
  expect((await db.doc(readerSealPath(f.pair)).get()).exists).toBe(false);
});

it("preserves an expired original caller receipt's safe refusal code", async () => {
  const f = await scenario();
  await installPublicReleasePairReaderWithPreflight(f.input);
  await expect(installPublicReleasePairReaderWithPreflight({ ...f.input,
    clock: () => Date.parse("2026-10-28T22:05:01Z") })).rejects.toMatchObject({
    stage: "caller", code: "preflight-receipt-expired", uncertain: false,
  });
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
});

it.each(["billing", "retired", "provider-drift"])("keeps the original upload uncertain when %s refuses a later target check", async mode => {
  const f = await scenario(); f.loseUploadReply();
  await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toMatchObject({ stage: "caller", uncertain: true });
  if (mode === "billing") await db.doc("system/billing").set({ disabled: true });
  if (mode === "retired") await db.doc(`${f.base}/controls/runtime`).update({ status: "retired" });
  if (mode === "provider-drift") f.state.deployment.versions[0].percentage = 99;
  await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toMatchObject({
    stage: "target", code: "reader-install-target-refused", uncertain: true,
    message: expect.stringContaining("check the original attempt receipt"),
  });
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 0 });
  expect((await db.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc(f.input.preflightOperationId).get()).data()?.state).toBe("uncertain");
});

it("keeps an unresolved original uncertain when its caller request digest conflicts", async () => {
  const f = await scenario(); f.loseUploadReply();
  await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toMatchObject({ stage: "caller", uncertain: true });
  const original = db.collection(PRIVATE_PREFLIGHT_ATTEMPTS).doc(f.input.preflightOperationId);
  // Model an original operation bound to other caller bytes. A malformed or
  // stale request must refuse without declaring its unresolved upload settled.
  await original.update({ requestDigest: "0".repeat(64) });
  await expect(installPublicReleasePairReaderWithPreflight(f.input)).rejects.toMatchObject({
    stage: "caller", code: "preflight-attempt-conflict", uncertain: true,
    message: expect.stringContaining("check the original attempt receipt"),
  });
  expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 0 });
  expect((await original.get()).data()?.state).toBe("uncertain");
});
