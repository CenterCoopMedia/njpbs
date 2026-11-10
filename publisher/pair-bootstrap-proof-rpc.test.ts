import { expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { pairTerminalRpc } from "./pair-terminal-rpc";
import p from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import { releasePair, releaseSelector } from "../tests/helpers/private-public-release-pair.js";

const digest = "a".repeat(64), operationId = "bootstrap-original";
function fixture() {
  const pair = releasePair(), root = { ...releaseSelector(), switchOperationId: operationId };
  const contract = { schemaVersion: 2, families: ["posts"], features: [] };
  root.admittedContractDigest = p.publicReleaseDigest(contract);
  const rows = new Map<string, any>(), hash = p.publicReleaseDigest;
  const legacy = { schemaVersion: 1, ...Object.fromEntries(["mediaLifecycleReady", "state", "activeGeneration", "activeDeploymentId",
    "activeCommitSha", "lastReservedGeneration", "newestEligibleGeneration", "newestEligibleBuildBatchId"].map(key => [key, (root as any)[key]])) };
  const attempt = { schemaVersion: 2, operationId, environment: pair.environment, legacyPointerDigest: hash(legacy) };
  root.priorSelectorDigest = hash(legacy);
  rows.set("system/publicDeployment", root);
  rows.set("system/publicReleaseAdmissions/controls/bootstrapFence", { schemaVersion: 2, operationId, attemptDigest: hash(attempt), status: "closed", resumeReceiptDigest: null });
  rows.set("system/publicDeployment/releaseWriter/fence", { schemaVersion: 2, operationId, attemptDigest: hash(attempt) });
  rows.set(`system/publicReleaseAdmissions/bootstrapFences/${operationId}`, attempt);
  const media = { schemaVersion: 2, epoch: 1, activeGeneration: root.activeGeneration, lastReservedGeneration: root.activeGeneration,
    newestEligibleGeneration: root.activeGeneration, references: [{ pairId: root.selectedPair.pairId, manifestDigest: root.contentHead.manifestDigest },
      { pairId: root.recoveryPair.pairId, manifestDigest: "8".repeat(64) }] };
  rows.set("system/publicDeployment/pairMedia/current", media);
  rows.set(`system/publicDeployment/bootstrapSelectors/${operationId}`, { schemaVersion: 2, kind: "public-release-bootstrap", operationId,
    attemptDigest: "f".repeat(64), sourceDigest: hash(legacy), selectorDigest: hash(root), storedSelectorDigest: hash(root), mediaDigest: hash(media), selector: structuredClone(root) });
  const head = { schemaVersion: 2, baselineDigest: "1".repeat(64), sequence: 0, lastDigest: "1".repeat(64) };
  const enrollment = { kind: "initial-public-release-change-enrollment", initialHead: head };
  rows.set("system/publicReleaseChanges/enrollment/initial", enrollment); rows.set("system/publicReleaseChanges", head);
  const deployment = { state: "complete", mutation: { sourceSha: pair.commitSha } }, reader = { state: "complete" };
  rows.set("cmsDeploymentReceipts/functions", deployment); rows.set("cmsReaderCompatibilityReceipts/functions", reader);
  rows.set("system/billing", { disabled: false });
  const base = work.publicReleasePairPath(pair.pairId);
  rows.set(base, pair); rows.set(`${base}/controls/runtime`, { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  rows.set(`${base}/heads/current`, { schemaVersion: 2, pairDigest: hash(pair), contentHead: root.contentHead });
  rows.set(`system/publicReleaseAdmissionContracts/entries/${root.admittedContractDigest}`, contract);
  const paths = ["system/cmsPublicationRuntime", "system/noBuildPostAdmission", "system/publicDeployment/noBuildPosts/capability",
    "system/publicDeployment/noBuildPages/capability", "system/publicDeployment/noBuildRecords/capability",
    "system/publicDeployment/noBuildRecordFamilies/current", "system/publicReleaseChangeLog", "system/publicReleaseAdmissions/controls/adoption", "system/publicReleaseAdmissions"];
  const pins = { schemaVersion: 1, phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher",
    cloud: { phase: "ready", commitSha: pair.commitSha, serializerId: "cloudflare-dev-publisher" } };
  const capability = { servingEnabled: true, rendererSha: pair.commitSha, generation: root.activeGeneration };
  const controls = [pins, {}, capability, capability, capability, {}, { enabled: false }, { schemaVersion: 2, enabled: false },
    { schemaVersion: 2, sequence: 0, pendingCount: 0, pendingDigest: "0".repeat(64) }];
  paths.forEach((path, index) => rows.set(path, controls[index]));
  const controlAttempt = { operationId, pair, admittedContractDigest: root.admittedContractDigest };
  rows.set(`system/publicReleaseAdmissions/bootstrapControls/${operationId}`, { schemaVersion: 2, kind: "public-release-bootstrap-controls",
    attempt: controlAttempt, attemptDigest: hash(controlAttempt), enrollmentReceiptDigest: hash(enrollment), before: [], after: controls,
    installed: { sourceSha: pair.commitSha, deploymentReceiptDigest: hash(deployment), readerReceiptDigest: hash(reader), contractDigest: root.admittedContractDigest } });
  const read = vi.fn(async (path: string) => {
    const raw = rows.get(path), copy = structuredClone(raw ?? null);
    if (raw?.updatedAt instanceof Timestamp) {
      const millis = raw.updatedAt.toMillis(); copy.updatedAt = { toMillis: () => millis };
    }
    return copy;
  }), get = vi.fn();
  const ingress = { prove: vi.fn(async () => new Response("actual ingress bytes", { headers: { "x-proof": "existing-literal-binding" } })) };
  const authority = { pair, read };
  const call = (options: { bootstrapProof?: true } | undefined = { bootstrapProof: true }, path = `/bootstrap-prove?path=%2F&digest=${digest}&status=200`, init?: RequestInit) =>
    pairTerminalRpc(new Request(`http://pair-terminal.internal${path}`, init), { get } as any, authority, ingress, options);
  return { rows, root, pair, paths, controls, authority, get, ingress, read, call };
}
it("uses only the literal trusted ingress proof and no object transport while admission stays closed", async () => {
  const f = fixture(), result = await f.call();
  expect(result.status).toBe(200); expect(await result.text()).toBe("actual ingress bytes");
  expect(f.ingress.prove).toHaveBeenCalledTimes(1); expect(f.get).not.toHaveBeenCalled();
  const [request, seenDigest, expected] = f.ingress.prove.mock.calls[0] as any;
  expect(request.url).toBe("https://dev-public.example.org/"); expect(seenDigest).toBe(digest); expect(expected).toEqual({ status: 200 });
  expect(f.rows.get("system/publicReleaseAdmissions/controls/bootstrapFence").status).toBe("closed");
});
it("accepts the actual SDK receipt with a REST-decoded root timestamp", async () => {
  const f = fixture(), timestamp = new Timestamp(1_700_000_000, 123_456_789);
  f.rows.get("system/publicDeployment").updatedAt = timestamp;
  f.rows.get(`system/publicDeployment/bootstrapSelectors/${operationId}`).storedSelectorDigest = p.publicReleaseDigest(f.rows.get("system/publicDeployment"));
  expect((await f.call()).status).toBe(200); expect(f.ingress.prove).toHaveBeenCalledTimes(1);
});
it("refuses a timestamp-only root change during proof and cancels the body", async () => {
  const f = fixture(), cancel = vi.fn();
  f.rows.get("system/publicDeployment").updatedAt = new Timestamp(1_700_000_000, 0);
  f.rows.get(`system/publicDeployment/bootstrapSelectors/${operationId}`).storedSelectorDigest = p.publicReleaseDigest(f.rows.get("system/publicDeployment"));
  f.ingress.prove.mockImplementation(async () => {
    f.rows.get("system/publicDeployment").updatedAt = new Timestamp(1_700_000_001, 0);
    return new Response(new ReadableStream({ cancel }));
  });
  expect((await f.call()).status).toBe(403); expect(cancel).toHaveBeenCalledTimes(1);
});
it.each(["off", "open-fence", "missing-writer", "missing-receipt", "epoch", "other-old", "foreign-pair", "pins", "controls", "source", "contract"])(
  "refuses %s before any ingress or object call", async fault => {
    const f = fixture();
    if (fault === "open-fence") f.rows.get("system/publicReleaseAdmissions/controls/bootstrapFence").status = "open";
    if (fault === "missing-writer") f.rows.delete("system/publicDeployment/releaseWriter/fence");
    if (fault === "missing-receipt") f.rows.delete(`system/publicDeployment/bootstrapSelectors/${operationId}`);
    if (fault === "epoch") f.rows.get("system/publicDeployment").epoch = 2;
    if (fault === "other-old") f.rows.get("system/publicDeployment").selectedPair = f.root.recoveryPair;
    if (fault === "foreign-pair") f.authority.pair = releasePair("c", "c".repeat(40));
    if (fault === "pins") f.rows.get("system/cmsPublicationRuntime").phase = "paused";
    if (fault === "controls") f.rows.delete(`system/publicReleaseAdmissions/bootstrapControls/${operationId}`);
    if (fault === "source") f.rows.get("cmsDeploymentReceipts/functions").state = "in_progress";
    if (fault === "contract") f.rows.delete(`system/publicReleaseAdmissionContracts/entries/${f.root.admittedContractDigest}`);
    expect((await f.call(fault === "off" ? {} : { bootstrapProof: true })).status).toBe(403);
    expect(f.ingress.prove).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
it.each([`/bootstrap-prove?path=%2F&digest=${digest}&status=0200`, `/bootstrap-prove?path=%2F&digest=${digest}&status=201`,
  `/bootstrap-prove?path=%2F&digest=${digest}&status=200&bootstrapProof=true`, `/bootstrap-prove?path=%2F_pair-private&digest=${digest}&status=200`,
  `/bootstrap-prove?path=%2F&path=%2F&digest=${digest}&status=200`, "/bootstrap-prove?path=%2F&digest=bad&status=200"])("refuses malformed proof input %s", async path => {
  const f = fixture(); expect((await f.call({ bootstrapProof: true }, path)).status).toBe(403);
  expect(f.ingress.prove).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
});
it.each(["system/publicDeployment", "system/publicReleaseAdmissions/controls/bootstrapFence", `system/publicDeployment/bootstrapSelectors/${operationId}`])(
  "refuses authority changing at %s during the actual proof and cancels the body", async path => {
    const f = fixture(), cancel = vi.fn();
    f.ingress.prove.mockImplementation(async () => {
      f.rows.delete(path); return new Response(new ReadableStream({ cancel }));
    });
    expect((await f.call()).status).toBe(403); expect(cancel).toHaveBeenCalledTimes(1); expect(f.get).not.toHaveBeenCalled();
  });
