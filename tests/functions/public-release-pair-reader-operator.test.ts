import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { refusedOperatorPrelaunch } from "../helpers/operator-prelaunch.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { publicSlotScenario } from "../helpers/private-public-release-slot-target.mjs";
import { compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { runPrivateReaderOperator } from "../../site/scripts/public-release-pair-reader-operator";
import { privatePairReaderInstallation } from "../../workers/src/private-pair-reader-installation";
import { privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
import { PRIVATE_PREFLIGHT_ATTEMPTS } from "../../scripts/lib/private-pair-preflight-caller.mjs";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import protocol from "../../functions/lib/public-release-pair.js";
const db = isolatedFirestore("public-release-pair-reader-operator.test.ts");
let source: Uint8Array;
beforeAll(async () => { source = await compilePrivateWorker(publicSlotScenario().config.main); });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});
async function scenario() {
  const f = publicSlotScenario(source);
  await Promise.all(Object.entries(f.records).map(([path, row]) => db.doc(path).create(row)));
  const identity = { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com",
    privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/reader-operator" };
  const packet = { schemaVersion: 1, kind: "private-pair-reader-operator", operatorCommitSha:
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), credentialIdentity: identity,
    providerCredentialRef: "pass://fixture/private-pair-install", pair: f.pair, installPlan: f.installPlan,
    rollout: f.rollout, preflightOperationId: "original-reader-command" };
  const authority = { session: 0, upload: 0, invoke: 0 };
  let worker: any, lostReply = false;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), path = url.pathname;
    const envelope = (result: unknown) => Response.json({ success: true, result });
    if (path.endsWith("/workers/subdomain")) return envelope({ subdomain: "fixture" });
    if (path.endsWith("/workers/subdomain/edge-preview")) {
      authority.session++; return envelope({ token: "synthetic-session-token" });
    }
    if (/\/workers\/scripts\/njpbs-private-preflight-[a-f0-9]{24}\/edge-preview$/.test(path)) {
      authority.upload++;
      const form = init.body as FormData;
      expect(JSON.parse(String(form.get("metadata"))).bindings).toEqual([{ name: "PAIR_PREFLIGHT", type: "service",
        service: f.pair.publicWorker.service, entrypoint: "PublicReleaseSlotEntrypoint" }]);
      worker = (await import(`data:text/javascript;base64,${Buffer.from(await (form.get("probe.mjs") as Blob).text()).toString("base64")}`)).default;
      if (lostReply) throw new Error("synthetic-boundary-error-do-not-print");
      return envelope({ preview_token: "synthetic-preview-token" });
    }
    if (url.hostname.endsWith(".fixture.workers.dev")) {
      authority.invoke++;
      return worker.fetch(new Request(input, init), { PAIR_PREFLIGHT: { readerInstallation: async (...args: unknown[]) => {
        expect(args).toEqual([]);
        return { seals: privatePairReaderInstallation(f.pair, f.installPlan.readerOrigins[0]),
          publisher: { pairDigest: protocol.publicReleaseDigest(f.pair), publisher: f.pair.publisher,
            readerContractDigest: f.pair.readerContractDigest, capabilities: privatePairReaderCapabilities(f.pair.commitSha) } };
      } } });
    }
    return f.fetchImpl(input, init);
  };
  const readToken = vi.fn(f.readToken), close = vi.fn(async () => {});
  const io = { fetchImpl, readToken, readServiceAccount: vi.fn(async () => JSON.stringify({ type: "service_account", project_id: identity.projectId,
    client_email: identity.clientEmail, private_key_id: identity.privateKeyId, private_key: "synthetic-test-key-that-never-reaches-cert" })),
    openDatabase: vi.fn(async () => ({ firestore: db, close })) };
  return { ...f, packet, authority, io, loseReply: () => { lostReply = true; } };
}
async function withPacket(f: Awaited<ReturnType<typeof scenario>>, run: (args: string[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "private-reader-operator-"));
  try {
    const bytes = JSON.stringify(f.packet), file = join(dir, "packet.json"); await writeFile(file, bytes);
    await run(["--packet", file, "--packet-digest", createHash("sha256").update(bytes).digest("hex")]);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
it("runs the actual source-pinned default CLI without credential, SDK or provider authority", async () => {
  const f = await scenario();
  await withPacket(f, async args => {
    const output = execFileSync(process.execPath, ["scripts/install-public-release-pair-reader.mjs", ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(output)).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0, runtimePreflight: "not-run" });
    expect(await runPrivateReaderOperator(args, f.io)).toMatchObject({ mode: "plan" });
    expect(f.io.readToken).not.toHaveBeenCalled(); expect(f.io.readServiceAccount).not.toHaveBeenCalled(); expect(f.io.openDatabase).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]); expect(f.authority).toEqual({ session: 0, upload: 0, invoke: 0 });
  });
});
it("binds the real GET-only target, generated shared RPC, seal transaction and historical recovery reader", async () => {
  const f = await scenario();
  await withPacket(f, async args => {
    expect(await runPrivateReaderOperator([...args, "--readback"], f.io)).toMatchObject({ preflight: null, readerInstall: null });
    expect(f.io.readToken).not.toHaveBeenCalled();
    const first = await runPrivateReaderOperator([...args, "--apply"], f.io);
    expect(first).toMatchObject({ mode: "apply", idempotent: false, pairId: f.pair.pairId });
    const recovered = await runPrivateReaderOperator([...args, "--readback"], f.io);
    expect(recovered).toMatchObject({ preflight: { state: "complete" }, readerInstall: { installDigest: first.installDigest } });
    const again = await runPrivateReaderOperator([...args, "--apply"], f.io);
    expect(again).toEqual({ ...first, idempotent: true });
    expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
    expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
    expect((await db.doc(readerSealPath(f.pair)).get()).exists).toBe(true);
  });
});
it("does not redispatch a lost original reply or turn historical readback into a target proof", async () => {
  const f = await scenario(); f.loseReply();
  await withPacket(f, async args => {
    await expect(runPrivateReaderOperator([...args, "--apply"], f.io)).rejects.toMatchObject({ uncertain: true });
    const tokenCalls = f.io.readToken.mock.calls.length;
    expect(await runPrivateReaderOperator([...args, "--readback"], f.io)).toMatchObject({ preflight: { state: "uncertain" }, readerInstall: null });
    expect(f.io.readToken.mock.calls).toHaveLength(tokenCalls);
    await expect(runPrivateReaderOperator([...args, "--apply"], f.io)).rejects.toMatchObject({ uncertain: true });
    expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 0 });
    expect((await db.doc(readerSealPath(f.pair)).get()).exists).toBe(false);
  });
});
it("refuses a tampered original receipt without provider authority or writes", async () => {
  const f = await scenario();
  await withPacket(f, async args => {
    await runPrivateReaderOperator([...args, "--apply"], f.io);
    const original = db.doc(`${PRIVATE_PREFLIGHT_ATTEMPTS}/${f.packet.preflightOperationId}`);
    await original.update({ requestDigest: "0".repeat(64) });
    const calls = f.io.readToken.mock.calls.length;
    await expect(runPrivateReaderOperator([...args, "--readback"], f.io)).rejects.toThrow();
    expect(f.io.readToken.mock.calls).toHaveLength(calls); expect(f.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  });
});
it("refuses wrong source, provider packet, digest and pre-cancel before credentials", async () => {
  const f = await scenario();
  await withPacket(f, async args => {
    await expect(runPrivateReaderOperator([...args.slice(0, 3), "0".repeat(64), "--apply"], f.io)).rejects.toThrow();
    await expect(runPrivateReaderOperator([...args, "--apply"], { ...f.io, signal: AbortSignal.abort() })).rejects.toThrow();
  });
  f.packet.operatorCommitSha = "0".repeat(40);
  await withPacket(f, async args => { await expect(runPrivateReaderOperator([...args, "--apply"], f.io)).rejects.toThrow(); });
  expect(f.io.readServiceAccount).not.toHaveBeenCalled(); expect(f.io.openDatabase).not.toHaveBeenCalled(); expect(f.io.readToken).not.toHaveBeenCalled();
});

it.each(["wrong-commit", "dirty-tree"])("checks %s before either ignored tsx or repository code can read credential FDs", async mode => {
  const result = await refusedOperatorPrelaunch({ filename: "install-public-release-pair-reader.mjs",
    businessPath: "site/scripts/public-release-pair-reader-operator.ts", reader: true, mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.evaluated).toBe(false);
});
