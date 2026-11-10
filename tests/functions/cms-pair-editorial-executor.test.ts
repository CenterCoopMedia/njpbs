import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { capturedPairInput } from "../helpers/captured-public-release-pair-input.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import deployment from "../../functions/lib/public-deployment.js";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { readPublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import type { PairPreviewContextOutput } from "../../site/scripts/public-release-pair-preview-context";

// This tests the real executor/input/output/settlement path. Only the child
// renderer transport is a fixture; native SSR parity has its existing suite.
const child = vi.hoisted(() => ({ directory: "", body: new Uint8Array() }));
vi.mock("../../site/scripts/public-release-pair-renderer-release.mjs", () => ({ verifyPublicReleasePairRenderer: async () => {} }));
vi.mock("../../site/scripts/process-cms-preview", () => ({ privatePreviewSandbox: async (_env: unknown, directory: string) => {
  child.directory = directory; return { args: ["fixture"] };
} }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    const process = new EventEmitter();
    void mkdir(child.directory, { recursive: true }).then(() => writeFile(path.join(child.directory, "0.body"), child.body))
      .then(() => process.emit("close", 0), error => { process.emit("error", error); process.emit("close", 1); });
    return process;
  } }));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let sequence = 0;
it.each(["reject", "pending", "missing-census"])("real executor completes and stages while optional output is %s", async outcome => {
  const firestore = isolatedFirestore(`editorial-executor-${++sequence}`), pair = releasePair("b"), base = work.publicReleasePairPath(pair.pairId);
  await firestore.doc("system/publicDeployment").set(deployment.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore, pair });
  const objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const store: PairViewStore = { async put(key, bytes, options) {
    if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata });
  }, async get(key) { const object = objects.get(key); return object ? { size: object.bytes.length,
    customMetadata: object.customMetadata, body: new Response(new Uint8Array(object.bytes)).body! } : null; } };
  const captured = capturedPairInput(pair), home = { schemaVersion: 2, fixture: "actual child Home bytes" };
  child.body = encode(home);
  const files = [{ name: "home-request.json", bytes: encode({ schemaVersion: 1, read: home }), dependencies: [] as string[] },
    { name: "snapshot.json", bytes: captured.files[1].bytes, dependencies: [] as string[] }];
  if (outcome !== "missing-census") files.push({ name: "source-census.json", bytes: encode({ fixture: true }), dependencies: [] });
  const plan = { schemaVersion: 1, pairDigest: protocol.publicReleaseDigest(pair), snapshotDigest: captured.scope.snapshotDigest,
    renderedAt: "2026-10-28T04:00:00.000Z", routes: [{ path: "/_home-sources.json", method: "GET", renderer: "json", inputFile: "home-request.json",
      dependencies: files.map(file => ({ name: file.name, digest: sha(file.bytes) })).sort((a, b) => a.name.localeCompare(b.name)) }],
    expectedOutputs: [{ path: "/_home-sources.json", status: 200, contentType: "application/json; charset=utf-8" }] };
  files.push({ name: "render-plan.json", bytes: encode(plan), dependencies: files.map(file => file.name).sort() });
  files.sort((a, b) => a.name.localeCompare(b.name));
  const root = { ...captured.root, entryFiles: ["render-plan.json", "snapshot.json"], files: files.map(file => ({ name: file.name,
    digest: sha(file.bytes), bytes: file.bytes.length, objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${sha(file.bytes)}.json`, dependencies: file.dependencies })) };
  async function* stream() { yield* files; }
  const input = await capturePublicReleasePairInput({ firestore, store, pair, plan: root, expectedSource: root.source, expectedCursor: root.cursor, files: stream() });
  const { taskId } = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...captured.scope, kind: "qualification", inputManifestDigest: input.receipt.inputManifestDigest } }));
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const output = vi.fn(async (_input: PairPreviewContextOutput) => {
    if (outcome === "reject") throw new Error("private exception body must never be logged");
    await pending;
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const operations = createPublicReleasePairExecutor({ firestore, store, pair, previewContextOutput: output });
    expect(await runPublicReleasePairWorkOnce({ firestore, pair, ...operations })).toBe("complete");
    const receipt = (await firestore.doc(`${base}/receipts/${taskId}`).get()).data()!;
    expect(receipt.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await firestore.doc(`${base}/views/${receipt.manifestDigest}`).get()).exists).toBe(true);
    if (outcome === "missing-census") expect(output).not.toHaveBeenCalled();
    else {
      await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
      const retained = output.mock.calls[0][0];
      expect(retained.root).toEqual(root); expect(retained.viewManifestDigest).toBe(receipt.manifestDigest);
      expect(retained.identity).toEqual(receipt.identity); expect(retained.homeSourceBytes).toEqual(child.body);
      // The task sandbox has already been removed. This is the separately
      // reopened H handle, not a temp file or an expired execution signal.
      expect(await retained.readFrozenFile("snapshot.json")).toEqual(captured.files[1].bytes);
      if (outcome === "reject") await vi.waitFor(() => expect(warning).toHaveBeenCalledWith("pair-preview-context-retention-failed"));
    }
    const outputs = [];
    for await (const row of readPublicReleasePairView({ store, pair, identity: receipt.identity, claimDigest: receipt.claimDigest,
      manifestDigest: receipt.manifestDigest, manifestBytes: (await firestore.doc(`${base}/views/${receipt.manifestDigest}`).get()).data()!.manifestBytes })) outputs.push(row);
    expect(outputs.map(row => JSON.parse(new TextDecoder().decode(row.body)))).toEqual([home]);
    expect((await firestore.collection(`${base}/staging`).get()).empty).toBe(true);
  } finally { release(); warning.mockRestore(); }
}, 30_000);
