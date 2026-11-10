import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { pairOwnerWriteRpc } from "./pair-owner-write-rpc";
import { releasePair, releaseSelector, pairReference } from "../tests/helpers/private-public-release-pair.js";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";
import { writePublicReleasePairView } from "../site/scripts/public-release-pair-view-storage";
import { writePublicReleasePairReplaySelection, readPublicReleasePairReplaySelection } from "../site/scripts/public-release-pair-replay-selection-storage";
import { ownerReplayPageEvidencePath, parseOwnerReplayPageEvidence } from "./pair-owner-page-evidence";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("accepts a verified 20-entry page-end cursor and 160 distinct staged references without a transaction read cap", async () => {
  const pair = releasePair(), pairDigest = protocol.publicReleaseDigest(pair), base = work.publicReleasePairPath(pair.pairId);
  const baselineDigest = "1".repeat(64), operationId = "W".repeat(20), snapshotDigest = "a".repeat(64);
  const rows = new Map<string, any>(), objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  let writes = 0, reads = 0, batches = 0;
  const bucket = {
    async get(key: string) {
      const row = objects.get(key);
      return row ? { size: row.bytes.length, customMetadata: row.customMetadata, body: new Response(row.bytes).body! } : null;
    },
    async put(key: string, bytes: Uint8Array, options: any) {
      writes++;
      if (objects.has(key) && options.onlyIf?.etagDoesNotMatch === "*") return null;
      objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata }); return { key };
    },
  };
  let previousDigest = baselineDigest, pageCursor: any;
  for (let sequence = 1; sequence <= 21; sequence++) {
    const core = { schemaVersion: 2, sequence, previousDigest, operationId: sequence === 21 ? operationId : `log-${sequence}`,
      pair: pairReference(pair), contextRevision: sequence,
      changes: [{ kind: "post", id: "story", action: "publish", sourceVersion: sequence, snapshotDigest }] };
    const entry = { ...core, entryDigest: protocol.publicReleaseDigest(core) };
    rows.set(`system/publicReleaseChanges/entries/${String(sequence).padStart(16, "0")}`, entry);
    previousDigest = entry.entryDigest;
    if (sequence === 20) pageCursor = { baselineDigest, sequence, lastDigest: entry.entryDigest };
  }
  const head = { schemaVersion: 2, baselineDigest, sequence: 21, lastDigest: previousDigest };
  const selector = releaseSelector(), accepted = { schemaVersion: 2, operationId, pair: pairReference(pair), pairDigest,
    epoch: selector.epoch, changeSequence: 21, contextRevision: 21, admissionSequence: 1,
    admittedContractDigest: selector.admittedContractDigest,
    source: { kind: "post", id: "story", family: "posts", action: "publish", sourceVersion: 21, snapshotDigest, requiredFeatures: [] } };
  rows.set(base, pair);
  rows.set(`${base}/controls/runtime`, { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  rows.set("system/billing", { disabled: false });
  rows.set("system/publicDeployment", selector);
  rows.set("system/publicReleaseChanges", head);
  rows.set("system/publicReleaseAdmissions/controls/adoption", { schemaVersion: 2, enabled: true });
  rows.set(`system/publicReleaseAdmissions/operations/${operationId}`, accepted);
  rows.set(`system/publicReleaseAdmissions/pending/${operationId}`, { schemaVersion: 2, operationId,
    admissionDigest: protocol.publicReleaseDigest(accepted) });
  rows.set(`cmsPublishQueue/${operationId}`, { schemaVersion: 2, transport: "release-pair-publication-v2", operationId,
    admissionDigest: protocol.publicReleaseDigest(accepted), pair: accepted.pair, status: "pending", execution: null });
  // Unit evidence rows isolate transport pagination/read accounting. The
  // emulator integration separately creates these records through actual SDK
  // capture, claim, completion, staging and canonical settlement owners.
  const view = async (id: string, path: string, sequence = 0) => {
    const scope = { kind: sequence ? "accepted" as const : "qualification" as const, sourceOperationId: id,
      sourceVersion: sequence || 1, snapshotDigest, contextSequence: sequence };
    const identity = { schemaVersion: 2 as const, pair: pairReference(pair), ...scope, inputManifestDigest: "b".repeat(64) };
    const claimDigest = protocol.publicReleaseDigest({ id }), taskId = protocol.publicReleaseDigest(identity);
    const bytes = new TextEncoder().encode(`<main>${id}</main>`);
    const rendered = await writePublicReleasePairView({ store: bucket, pair, identity, claimDigest,
      cursor: sequence ? { baselineDigest, sequence, lastDigest: previousDigest } : { baselineDigest, sequence: 0, lastDigest: baselineDigest },
      outputs: (async function* () { yield { path, status: 200 as const, bytes,
        headers: { "content-type": "text/html", "cache-control": "no-store" } }; })() });
    const receipt = { schemaVersion: 2, taskId, identity, claimDigest, manifestDigest: rendered.manifestDigest };
    rows.set(`${base}/receipts/${taskId}`, receipt);
    rows.set(`${base}/work/${taskId}`, { status: "complete", identity, receiptDigest: protocol.publicReleaseDigest(receipt) });
    rows.set(`${base}/views/${rendered.manifestDigest}`, { ...receipt, status: "staged", pairDigest,
      manifestBytes: rendered.manifestBytes, readbackDigest: protocol.publicReleaseDigest({ fixtureReadback: rendered.manifestDigest }) });
    if (sequence) rows.set(`${base}/sourceInputs/${protocol.publicReleaseDigest({ kind: scope.kind, sourceOperationId: id })}`,
      { schemaVersion: 2, pairDigest, scope, inputManifestDigest: identity.inputManifestDigest });
    return { path, bodyDigest: hash(bytes), view: { identity, claimDigest,
      manifestDigest: rendered.manifestDigest, manifestBytes: rendered.manifestBytes } };
  };
  await view(operationId, "/target/", 21);
  const members = [];
  for (let index = 0; index < 160; index++) members.push(await view(`baseline-${index}`, `/baseline-${String(index).padStart(3, "0")}/`));
  const statuses: number[] = [], charged: number[] = [];
  const transport = { get: bucket.get, async put(key: string, bytes: Uint8Array, options: any) {
    reads = 0;
    const response = await pairOwnerWriteRpc(new Request(`http://pair-owner-write.internal/${key}`, { method: "PUT", body: bytes,
      headers: { "content-length": String(bytes.length), "if-none-match": "*", "x-owner-operation": operationId,
        "x-pair-metadata": JSON.stringify(options.customMetadata) } }), bucket as any,
    { pair, read: async path => { reads++; return rows.get(path) ?? null; },
      readMany: async paths => { batches++; reads += paths.length; return paths.map(path => rows.get(path) ?? null); },
      createPageEvidence: async raw => {
        const receipt = parseOwnerReplayPageEvidence(raw, pair), path = ownerReplayPageEvidencePath(pair, receipt.pageDigest);
        if (rows.has(path)) expect(rows.get(path)).toEqual(receipt); else rows.set(path, receipt);
      } });
    statuses.push(response.status); charged.push(reads);
    if (![201, 412].includes(response.status)) throw new Error("Private unit transport refused");
  } };
  const selected = await writePublicReleasePairReplaySelection({ store: transport, pair, kind: "content", cursor: pageCursor, members });
  expect(statuses).toEqual([201, 201]);
  expect(charged[0]).toBeGreaterThan(500);
  expect(charged[1]).toBeLessThan(100);
  expect(batches).toBe(2);
  const result = [];
  for await (const member of readPublicReleasePairReplaySelection({ store: transport, pair, kind: "content", cursor: pageCursor, digest: selected.digest })) result.push(member);
  expect(result).toEqual(members);
  const before = writes;
  await expect(writePublicReleasePairReplaySelection({ store: transport, pair, kind: "content",
    cursor: { ...pageCursor, lastDigest: "f".repeat(64) }, members })).rejects.toThrow("refused");
  expect(writes).toBe(before);
  const receiptPath = ownerReplayPageEvidencePath(pair, selected.root.pages[0].digest), saved = rows.get(receiptPath);
  for (const bad of [null, { ...saved, pairDigest: "f".repeat(64) }, { ...saved, pageDigest: "f".repeat(64) },
    { ...saved, cursor: { ...saved.cursor, lastDigest: "f".repeat(64) } }, { ...saved, evidenceDigest: "not-proof" }]) {
    if (bad === null) rows.delete(receiptPath); else rows.set(receiptPath, bad);
    const count = writes;
    // Existing stored pages alone cannot manufacture a validation receipt.
    await expect(transport.put(`release-pair-replay/v2/${pairDigest}/selections/${selected.digest}.json`,
      objects.get(`release-pair-replay/v2/${pairDigest}/selections/${selected.digest}.json`)!.bytes,
      { customMetadata: { schemaversion: "2", pairdigest: pairDigest, bodydigest: selected.digest } })).rejects.toThrow();
    expect(writes).toBe(count);
  }
  rows.set(receiptPath, saved);
});
