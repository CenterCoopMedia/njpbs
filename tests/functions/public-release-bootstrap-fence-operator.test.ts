import { beforeEach, expect, it, vi } from "vitest";
import { refusedOperatorPrelaunch } from "../helpers/operator-prelaunch.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import admission from "../../functions/lib/public-release-bootstrap-admission.js";
import { runBootstrapFenceOperator, readBootstrapFenceAttempt } from "../../scripts/lib/public-release-bootstrap-fence-operator.mjs";

const db = isolatedFirestore("public-release-bootstrap-fence-operator.test.ts");
const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: "a".repeat(40),
  activeDeploymentId: "fixture-release", lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-build", mediaLifecycleReady: true };
const identity = { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com",
  privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap-operator" };
const packet = () => ({ schemaVersion: 1, kind: "bootstrap-admission-close-operator", operatorCommitSha:
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: identity,
  attempt: { schemaVersion: 2, operationId: "original-bootstrap-close", environment: "development",
    legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) } });
async function withPacket(run: (args: string[], value: ReturnType<typeof packet>) => Promise<void>, change = (value: any) => value) {
  const dir = await mkdtemp(join(tmpdir(), "bootstrap-close-"));
  try {
    const value = change(packet()), bytes = JSON.stringify(value), file = join(dir, "packet.json");
    await writeFile(file, bytes);
    await run(["--packet", file, "--packet-digest", createHash("sha256").update(bytes).digest("hex")], value);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const account = () => JSON.stringify({ type: "service_account", project_id: identity.projectId, client_email: identity.clientEmail,
  private_key_id: identity.privateKeyId, private_key: "synthetic-test-key-that-never-reaches-cert" });
const boundary = () => ({ readServiceAccount: vi.fn(async () => account()),
  openDatabase: vi.fn(async () => ({ firestore: db, close: vi.fn(async () => {}) })) });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
  await db.doc("system/publicDeployment").set(pointer);
});
it("runs the actual source-pinned default plan process without credentials or SDK authority", async () => {
  await withPacket(async args => {
    const output = execFileSync(process.execPath, ["scripts/close-public-release-bootstrap-admission.mjs", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(output)).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0 });
    expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
    const io = boundary();
    expect(await runBootstrapFenceOperator(args, io)).toMatchObject({ mode: "plan" });
    expect(io.readServiceAccount).not.toHaveBeenCalled(); expect(io.openDatabase).not.toHaveBeenCalled();
  });
});
it("closes through the real transaction, recovers the original receipt and never changes the pointer", async () => {
  await withPacket(async (args, value) => {
    const io = boundary();
    expect(await runBootstrapFenceOperator([...args, "--readback"], io)).toMatchObject({ committed: false, ownsClosedFence: false });
    expect(await runBootstrapFenceOperator([...args, "--apply"], io)).toMatchObject({ mode: "apply", idempotent: false, fence: { status: "closed" } });
    const first = await runBootstrapFenceOperator([...args, "--readback"], io);
    expect(first).toMatchObject({ mode: "readback", committed: true, ownsClosedFence: true, current: { operationId: value.attempt.operationId } });
    expect(await runBootstrapFenceOperator([...args, "--apply"], io)).toMatchObject({ idempotent: true });
    expect(await runBootstrapFenceOperator([...args, "--readback"], io)).toEqual(first);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await db.doc("system/publicDeployment").get()).data()).toEqual(pointer);
    expect((await db.doc("system/publicReleaseChangeLog").get()).exists).toBe(false);
    expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(false);
    expect(io.openDatabase.mock.results.every(row => row.type === "return")).toBe(true);
    for (const result of io.openDatabase.mock.results) expect((await result.value).close).toHaveBeenCalledOnce();
  });
});
it.each(["reserved", "pending", "publishing"])("preserves the real %s queue refusal with zero close writes", async status => {
  await db.doc("cmsPublishQueue/racing").set({ status });
  await withPacket(async args => {
    await expect(runBootstrapFenceOperator([...args, "--apply"], boundary())).rejects.toThrow();
    expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
    expect((await db.collection("admin_logs").get()).empty).toBe(true);
  });
});
it("refuses changed authority and a conflicting historical receipt without repair", async () => {
  await withPacket(async (args, value) => {
    await db.doc("system/publicDeployment").update({ activeCommitSha: "c".repeat(40) });
    await expect(runBootstrapFenceOperator([...args, "--apply"], boundary())).rejects.toThrow();
    await db.doc(`${admission.BOOTSTRAP_ADMISSION_ATTEMPTS}/${value.attempt.operationId}`).set({ ...value.attempt, legacyPointerDigest: "d".repeat(64) });
    await expect(readBootstrapFenceAttempt({ firestore: db, packet: value })).rejects.toThrow();
    expect((await db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH).get()).exists).toBe(false);
  });
});
it("keeps historical completion separate from an opened or replaced current fence", async () => {
  await withPacket(async (args, value) => {
    await runBootstrapFenceOperator([...args, "--apply"], boundary());
    const ref = db.doc(admission.BOOTSTRAP_ADMISSION_FENCE_PATH), current = (await ref.get()).data()!;
    await ref.set({ ...current, status: "open", resumeReceiptDigest: "e".repeat(64) });
    expect(await readBootstrapFenceAttempt({ firestore: db, packet: value })).toMatchObject({ committed: true, ownsClosedFence: false, current: { status: "open" } });
    await ref.set({ ...current, operationId: "later-original-close", attemptDigest: "f".repeat(64) });
    expect(await readBootstrapFenceAttempt({ firestore: db, packet: value })).toMatchObject({ committed: true, ownsClosedFence: false, current: { operationId: "later-original-close" } });
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });
});
it("fails before credentials for unreviewed packets, wrong source, implicit apply or cancellation", async () => {
  const io = boundary();
  await withPacket(async args => {
    await expect(runBootstrapFenceOperator([...args, "--apply", "--apply"], io)).rejects.toThrow();
    await expect(runBootstrapFenceOperator([...args.slice(0, 3), "0".repeat(64), "--apply"], io)).rejects.toThrow();
    await expect(runBootstrapFenceOperator([...args, "--apply"], { ...io, signal: AbortSignal.abort() })).rejects.toThrow();
  });
  await withPacket(async args => { await expect(runBootstrapFenceOperator([...args, "--apply"], io)).rejects.toThrow(); },
    value => ({ ...value, operatorCommitSha: "0".repeat(40) }));
  expect(io.readServiceAccount).not.toHaveBeenCalled(); expect(io.openDatabase).not.toHaveBeenCalled();
});
it("pins the credential identity and scrubs CLI failure output", async () => {
  await withPacket(async args => {
    const io = boundary(); io.readServiceAccount.mockResolvedValue(account().replace(identity.privateKeyId, "0".repeat(40)));
    await expect(runBootstrapFenceOperator([...args, "--apply"], io)).rejects.toThrow();
    expect(io.openDatabase).not.toHaveBeenCalled();
    try {
      execFileSync(process.execPath, ["scripts/close-public-release-bootstrap-admission.mjs", ...args, "--apply"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      throw new Error("Expected missing-FD refusal");
    } catch (error: any) {
      expect(error.status).toBe(1); expect(error.stdout).toBe("");
      expect(error.stderr).toBe("Bootstrap admission close was not confirmed; preserve the packet and use --readback with the original attempt\n");
    }
  });
});

it.each(["wrong-commit", "dirty-tree"])("refuses %s before importing code that could read credential FDs", async mode => {
  const result = await refusedOperatorPrelaunch({ filename: "close-public-release-bootstrap-admission.mjs",
    businessPath: "scripts/lib/public-release-bootstrap-fence-operator.mjs", mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.evaluated).toBe(false);
});
