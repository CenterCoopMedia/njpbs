import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import replayHistory from "../../functions/lib/public-release-pair-replay-history.js";
import replayCapsules from "../../functions/lib/public-release-pair-replay-capsule.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import input from "../../functions/lib/public-release-pair-input.js";
import legacy from "../../functions/lib/public-deployment.js";
import producer from "../../functions/lib/public-release-producer.js";
import sourceBodies from "../../functions/lib/public-release-source-body.js";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import {
  writePublicReleasePairView,
  readPublicReleasePairView,
} from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import {
  readPublicReleasePairReplaySelection,
  writePublicReleasePairReplaySelection,
  stagePublicReleasePairReplaySelection,
} from "../../site/scripts/public-release-pair-replay-selection-storage";
import { stageReplayOutputInventory } from "../../site/scripts/public-release-pair-replay-inventory";
import inventory from "../../functions/lib/public-release-pair-replay-inventory.js";
import { reconcilePublicReleasePairReplay } from "../../site/scripts/public-release-pair-replay-runner";
import { replayBaselineFixture } from "../helpers/public-release-pair-replay-baseline";
import {
  replayMixedBaselineFixture,
  stageReplayMixedChange,
} from "../helpers/public-release-pair-replay-mixed";
import {
  writeReplayTargetFixture,
  stageReplayTargetFixture,
} from "../helpers/public-release-pair-log-targets";
import { stageReplayCodePackFixture } from "../helpers/public-release-pair-replay-pack";
import {
  verifyPublicReleasePairReplayEntry,
  verifyPublicReleasePairReplayCodePack,
  replayPublicReleasePairToHead,
} from "../../site/scripts/public-release-pair-log-replay";

const pair = releasePair(),
  baselineDigest = "b".repeat(64),
  operationId = "replay-operation";
const base = work.publicReleasePairPath(pair.pairId);
const source = JSON.parse(
  readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8"),
);
const canonical = (value: unknown) => producer.publicReleaseSnapshotJson(value);
const encode = (value: unknown) => new TextEncoder().encode(canonical(value));
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let db: ReturnType<typeof isolatedFirestore>, runtime: Miniflare, store: R2Bucket;
beforeAll(async () => {
  db = isolatedFirestore("public-release-pair-log-replay.test.ts");
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "pair-replay",
          type: "worker",
          compatibilityDate: "2026-07-09",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response(null,{status:404})}}",
              },
            },
          },
          env: { CONTENT: { type: "r2", name: "pair-replay-bytes" } },
        },
      },
    ],
  });
  store = await runtime.getR2Bucket("CONTENT");
});
beforeEach(async () => {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" },
    db,
  );
  const objects = await store.list();
  if (objects.objects.length) await store.delete(objects.objects.map((object) => object.key));
  await db.doc("system/publicDeployment").set(legacy.initialPublicDeploymentPointer());
  await work.registerPublicReleasePair({ firestore: db, pair });
});
afterAll(async () => {
  await runtime?.dispose();
});

const mixedCleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of mixedCleanups.splice(0)) await close();
});
async function mixedBaseline() {
  const fixture = await replayMixedBaselineFixture(db, store);
  mixedCleanups.push(fixture.close);
  return fixture;
}

async function prepared(
  mode = "complete",
  targetPair = pair,
  options: { operationId?: string; versionDelta?: number } = {},
) {
  const originalPair = pair,
    renderPair = targetPair;
  const operationId = options.operationId ?? "replay-operation",
    delta = options.versionDelta ?? 0;
  const published = {
    ...source.document.published,
    sourceVersion: 4 + delta,
    metadata: { ...source.document.published.metadata, slug: "story" },
  };
  const headRow = await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).get();
  if (!headRow.exists)
    await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(log.initialPublicReleaseChangeHead(baselineDigest));
  const head = log.parsePublicReleaseChangeHead((await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).get()).data());
  const withdrawn = {
    ...published,
    metadata: { ...published.metadata, slug: "removed" },
  };
  const changes = [
    {
      kind: "post" as const,
      id: "published",
      action: "publish" as const,
      sourceVersion: 4 + delta,
      snapshotDigest: sha(encode(published)),
    },
    {
      kind: "post" as const,
      id: "removed",
      action: "withdraw" as const,
      sourceVersion: 5 + delta,
      snapshotDigest: sha(encode(withdrawn)),
    },
  ];
  const core = {
    schemaVersion: 2 as const,
    sequence: head.sequence + 1,
    previousDigest: head.lastDigest,
    operationId,
    pair: protocol.publicReleasePairReference(originalPair),
    contextRevision: 900 + head.sequence,
    changes,
  };
  const entry = log.parsePublicReleaseChange({
    ...core,
    entryDigest: protocol.publicReleaseDigest(core),
  });
  const cursor = {
    baselineDigest,
    sequence: entry.sequence,
    lastDigest: entry.entryDigest,
  };
  const bodyValues = [published, withdrawn].map((snapshot, index) =>
    sourceBodies.makePublicReleaseSourceBody({ ...changes[index], snapshot }),
  );
  await db.runTransaction(async (transaction) => {
    const writeBodies = await sourceBodies.preparePublicReleaseSourceBodies({
      firestore: db,
      transaction,
      values: bodyValues,
    });
    const appended = await log.appendPublicReleaseChangeInTransaction({
      firestore: db,
      transaction,
      input: {
        operationId,
        pair: entry.pair,
        contextRevision: entry.contextRevision,
        changes,
      },
    });
    expect(appended.entry).toEqual(entry);
    writeBodies();
    for (const value of bodyValues) {
      const body = JSON.parse(value.json);
      for (const document of body.documents) transaction.set(db.doc(document.path), document.data);
    }
    for (const [index, change] of changes.entries())
      transaction.create(db.doc(producer.publicReleaseMemberPath(operationId, change.kind, change.id)), {
        schemaVersion: 2,
        operationId,
        sequence: entry.sequence,
        entryDigest: entry.entryDigest,
        change,
        json: canonical([published, withdrawn][index]),
        contentDigest: bodyValues[index].contentDigest,
      });
  });
  const members = [
    { change: changes[0], paths: ["/posts/story/"], withdrawnPaths: [] },
    {
      change: changes[1],
      paths: ["/posts/removed-old/", "/posts/removed/"],
      withdrawnPaths: ["/posts/removed-old/", "/posts/removed/"],
    },
  ];
  if (mode === "missing-member") members.pop();
  if (mode === "missing-alias") members[1].paths = ["/posts/removed/"];
  const authority = {
    schemaVersion: 2,
    entry,
    cursor,
    readerSource: originalPair.commitSha,
    contextRevision: entry.contextRevision,
    codeAssetManifestDigest: renderPair.codeAssetManifestDigest,
    members,
  };
  const files = new Map<string, { bytes: Uint8Array; dependencies: string[] }>([
    [
      "snapshot.json",
      {
        bytes: encode([
          { change: changes[0], snapshot: published },
          { change: changes[1], snapshot: withdrawn },
        ]),
        dependencies: [],
      },
    ],
    ["authority.json", { bytes: encode(authority), dependencies: [] }],
    [
      "request.json",
      {
        bytes: encode({ read: { kind: "withdrawn", path: "/posts/removed/" } }),
        dependencies: ["authority.json", "snapshot.json"],
      },
    ],
  ]);
  for (const value of bodyValues)
    files.set(`source-bodies/${value.contentDigest}.json`, {
      bytes: new TextEncoder().encode(value.json),
      dependencies: [],
    });
  const paths = ["/posts/removed-old/", "/posts/removed/", "/posts/story/"];
  if (mode === "shared-aggregate") {
    members[1].paths.push("/programs/");
    paths.push("/programs/");
    paths.sort();
    files.set("authority.json", { bytes: encode(authority), dependencies: [] });
  }
  const provenance = {
    schemaVersion: 1,
    pair: originalPair,
    rendererSha: originalPair.commitSha,
    readerContractDigest: originalPair.readerContractDigest,
    readerReceiptDigest: originalPair.readerReceiptDigest,
  };
  files.set("reader-provenance.json", {
    bytes: encode(provenance),
    dependencies: [],
  });
  const requestFiles = new Map<string, string>();
  for (const path of paths) {
    const read =
      path === "/posts/story/"
        ? {
            kind: source.kind,
            document: {
              id: "published",
              status: "published",
              publishAt: published.publishedAt,
              publiclyVisible: true,
              published,
            },
            assets: [],
          }
        : path === "/programs/"
          ? {
              kind: "published-record-family",
              family: "programs",
              complete: true,
              documents: [],
              assets: [],
              sourceSeal: {
                rendererSha: originalPair.commitSha,
                contextRevision: entry.contextRevision,
                contextDigest: sha(
                  new TextEncoder().encode(`njpbs-public-context-v1:${entry.contextRevision}`),
                ),
              },
            }
          : { kind: "withdrawn", path };
    const name = `routes/${path.replace(/\//g, "_")}.json`;
    files.set(name, {
      bytes: encode({
        schemaVersion: 1,
        read,
        homeSourcesFile: null,
        resources: [],
      }),
      dependencies: ["reader-provenance.json"],
    });
    requestFiles.set(path, name);
  }
  const dependencies = [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, file]) => ({ name, digest: sha(file.bytes) }));
  const snapshotDigest = sha(files.get("snapshot.json")!.bytes);
  const routes = paths.map((path) => ({
    path,
    method: "GET",
    renderer: path === "/programs/" ? "record" : path === "/posts/story/" ? "post" : "withdrawal",
    inputFile: requestFiles.get(path)!,
    dependencies,
  }));
  const plan = {
    schemaVersion: 1,
    pairDigest: protocol.publicReleaseDigest(renderPair),
    snapshotDigest,
    renderedAt: "2026-10-28T04:00:00.000Z",
    routes,
    expectedOutputs: paths.map((path) => ({
      path,
      status: path === "/posts/story/" || path === "/programs/" ? 200 : 410,
      contentType: "text/html; charset=utf-8",
    })),
  };
  files.set("render-plan.json", {
    bytes: encode(plan),
    dependencies: dependencies.map((file) => file.name),
  });
  const scope = {
    kind: "qualification" as const,
    sourceOperationId: operationId,
    sourceVersion: 5 + delta,
    snapshotDigest,
    contextSequence: entry.sequence,
  };
  const root = input.parsePublicReleasePairInputRoot(
    {
      schemaVersion: 2,
      kind: "pair-render-input",
      pairDigest: protocol.publicReleaseDigest(renderPair),
      source: { kind: "inventory", id: operationId },
      scope,
      cursor,
      snapshotFile: "snapshot.json",
      entryFiles: ["render-plan.json", "snapshot.json"],
      files: [...files]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, file]) => ({
          name,
          digest: sha(file.bytes),
          bytes: file.bytes.byteLength,
          objectKey: input.publicReleasePairInputObjectKey(renderPair, sha(file.bytes)),
          dependencies: file.dependencies,
        })),
    },
    renderPair,
  );
  async function* sourceFiles() {
    for (const [name, file] of files) yield { name, bytes: file.bytes };
  }
  const captured = await capturePublicReleasePairInput({
    firestore: db,
    store,
    pair: renderPair,
    plan: root,
    expectedSource: root.source,
    expectedCursor: cursor,
    files: sourceFiles(),
  });
  const taskInput = {
    ...scope,
    inputManifestDigest: captured.receipt.inputManifestDigest,
  };
  const { taskId } = await db.runTransaction((transaction) =>
    work.enqueuePublicReleasePairWorkInTransaction({
      firestore: db,
      transaction,
      pair: renderPair,
      input: taskInput,
    }),
  );
  const claim = await work.claimPublicReleasePairWork({
    firestore: db,
    pair: renderPair,
    taskId,
    now: Date.now(),
  });
  const claimDigest = protocol.publicReleaseDigest(claim!.token);
  const bodies = new Map<string, Uint8Array>();
  async function* outputs() {
    for (const path of paths) {
      if (mode === "missing-output" && path === "/posts/removed-old/") continue;
      const status = path === "/posts/story/" || path === "/programs/" ? (200 as const) : (410 as const);
      const bytes = new TextEncoder().encode(
        status === 200
          ? "<!doctype html><html>Published story</html>"
          : mode === "nonempty-withdrawal"
            ? "gone"
            : "",
      );
      bodies.set(path, bytes);
      yield {
        path,
        status,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-njpbs-renderer-sha": renderPair.commitSha,
        },
        bytes,
      };
    }
  }
  const written = await writePublicReleasePairView({
    store,
    pair: renderPair,
    identity: claim!.identity,
    claimDigest,
    cursor,
    outputs: outputs(),
  });
  const targetOwner = {
    firestore: db,
    store,
    pair: renderPair,
    claim: claim!,
    claimDigest,
    manifestDigest: written.manifestDigest,
    manifestBytes: written.manifestBytes,
  };
  await writeReplayTargetFixture({ ...targetOwner, bodies });
  await work.settlePublicReleasePairWork({
    firestore: db,
    pair: renderPair,
    taskId,
    token: claim!.token,
    manifestDigest: written.manifestDigest,
    now: Date.now(),
  });
  await stagePublicReleasePairView({
    firestore: db,
    store,
    pair: renderPair,
    identity: claim!.identity,
    claimDigest,
    manifestDigest: written.manifestDigest,
  });
  if (mode !== "missing-output") await stageReplayTargetFixture(targetOwner);
  const reference = {
    identity: claim!.identity,
    claimDigest,
    manifestDigest: written.manifestDigest,
    manifestBytes: written.manifestBytes,
  };
  return { entry, cursor, reference, files, taskId, bodyValues };
}
const verify = (value: Awaited<ReturnType<typeof prepared>>) =>
  verifyPublicReleasePairReplayEntry({ firestore: db, store, pair, ...value });

it("proves both members and both withdrawn paths from full immutable inputs and completed outputs", async () => {
  const value = await prepared(),
    before = (await db.doc("system/publicDeployment").get()).data();
  const result = await verify(value);
  expect(result.outputs.map((output) => [output.path, output.status])).toEqual([
    ["/posts/removed-old/", 410],
    ["/posts/removed/", 410],
    ["/posts/story/", 200],
  ]);
  expect(result.coverage.memberContentDigests).toEqual(value.bodyValues.map((body) => body.contentDigest));
  expect(result.coverage.membersDigest).toBe(
    protocol.publicReleaseDigest(
      value.entry.changes.map((change, index) => ({
        change,
        contentDigest: value.bodyValues[index].contentDigest,
      })),
    ),
  );
  expect(result.coverage.reference.identity.snapshotDigest).not.toBe(
    value.reference.identity.inputManifestDigest,
  );
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.collection(`${base}/work`).get()).size).toBe(1);
});
it.each(["missing-member", "missing-alias", "missing-output", "nonempty-withdrawal"])(
  "refuses %s before granting replay coverage",
  async (mode) => {
    const value = await prepared(mode);
    await expect(verify(value)).rejects.toThrow();
    expect((await db.doc(replay.checkpointPath(pair)).get()).exists).toBe(false);
  },
);
it("refuses a missing historical dependency with no latest-source read or repair", async () => {
  const value = await prepared();
  const key = input.publicReleasePairInputObjectKey(pair, sha(value.files.get("authority.json")!.bytes));
  await store.delete(key);
  await expect(verify(value)).rejects.toThrow();
  expect(await store.get(key)).toBeNull();
});
it.each(["retired", "disabled", "claim-changed"])("refuses %s original ownership", async (mode) => {
  const value = await prepared();
  if (mode === "retired") await db.doc(`${base}/controls/runtime`).update({ status: "retired" });
  if (mode === "disabled") await db.doc("system/billing").set({ disabled: true });
  if (mode === "claim-changed")
    await db.doc(`${base}/receipts/${value.taskId}`).update({ claimDigest: "a".repeat(64) });
  await expect(verify(value)).rejects.toThrow();
});
it("requires exact cursor and all contiguous page entries", async () => {
  const value = await prepared();
  await expect(
    verifyPublicReleasePairReplayEntry({
      firestore: db,
      store,
      pair,
      ...value,
      cursor: { ...value.cursor, sequence: 2 },
    }),
  ).rejects.toThrow();
  const verified = await verify(value);
  const page = {
    schemaVersion: 2,
    pairDigest: protocol.publicReleaseDigest(pair),
    fromCursor: { baselineDigest, sequence: 0, lastDigest: baselineDigest },
    headCursor: value.cursor,
    entries: [value.entry],
    coverage: [verified.coverage],
  };
  expect(replay.parseReplayPage(page, pair).headCursor).toEqual(value.cursor);
  expect(() => replay.parseReplayPage({ ...page, entries: [] }, pair)).toThrow();
  expect(() => replay.parseReplayPage({ ...page, coverage: [] }, pair)).toThrow();
  expect(() =>
    replay.parseReplayPage({ ...page, fromCursor: { ...page.fromCursor, sequence: 1 } }, pair),
  ).toThrow();
});

it("requires tombstones only for withdrawn paths while a shared aggregate stays 200", async () => {
  const result = await verify(await prepared("shared-aggregate"));
  expect(result.outputs.map((output) => [output.path, output.status])).toEqual([
    ["/posts/removed-old/", 410],
    ["/posts/removed/", 410],
    ["/posts/story/", 200],
    ["/programs/", 200],
  ]);
});
it("retains a complete selection readback receipt and refuses a changed durable receipt", async () => {
  const value = await prepared(),
    verified = await verify(value);
  const selected = await writePublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor: value.cursor,
    members: verified.outputs.map((output) => ({
      path: output.path,
      view: value.reference,
      bodyDigest: output.bodyDigest,
    })),
  });
  const args = {
    firestore: db,
    store,
    pair,
    kind: "content" as const,
    cursor: value.cursor,
    digest: selected.digest,
  };
  const first = await stagePublicReleasePairReplaySelection(args);
  expect(await stagePublicReleasePairReplaySelection(args)).toEqual(first);
  expect(first.root.count).toBe(3);
  await db.doc(`${base}/replaySelections/${selected.digest}`).update({ readbackDigest: "1".repeat(64) });
  await expect(stagePublicReleasePairReplaySelection(args)).rejects.toThrow();
});
it("does not stage a selection after a page disappears", async () => {
  const value = await prepared(),
    verified = await verify(value);
  const selected = await writePublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor: value.cursor,
    members: verified.outputs.map((output) => ({
      path: output.path,
      view: value.reference,
      bodyDigest: output.bodyDigest,
    })),
  });
  const listing = await store.list();
  const key = listing.objects.find((object) =>
    object.key.includes(`/pages/${selected.root.pages[0].digest}.json`),
  )!.key;
  await store.delete(key);
  await expect(
    stagePublicReleasePairReplaySelection({
      firestore: db,
      store,
      pair,
      kind: "content",
      cursor: value.cursor,
      digest: selected.digest,
    }),
  ).rejects.toThrow();
  expect((await db.doc(`${base}/replaySelections/${selected.digest}`).get()).exists).toBe(false);
});

it("proves every baseline code-pack family by actual immutable bytes", async () => {
  const cursor = { baselineDigest, sequence: 0, lastDigest: baselineDigest };
  const pack = await stageReplayCodePackFixture(db, store, cursor);
  const verified = await verifyPublicReleasePairReplayCodePack({
    firestore: db,
    store,
    pair: pack.pair,
    reference: pack.reference,
    cursor,
  });
  expect(verified.manifest.members).toHaveLength(19);
  expect(new Set(verified.manifest.members.map((member) => member.family)).size).toBe(12);
  expect(verified.manifest.codeAssetManifestDigest).toBe(pack.pair.codeAssetManifestDigest);
});
it("refuses code-pack qualification when even one retained output is absent", async () => {
  const cursor = { baselineDigest, sequence: 0, lastDigest: baselineDigest };
  const pack = await stageReplayCodePackFixture(db, store, cursor, "/wiki/index.html");
  await expect(
    verifyPublicReleasePairReplayCodePack({
      firestore: db,
      store,
      pair: pack.pair,
      reference: pack.reference,
      cursor,
    }),
  ).rejects.toThrow();
});

it("creates one immutable pair baseline and an idempotent empty-log witness", async () => {
  const baseline = await replayBaselineFixture(db, store);
  const first = await baseline.initialize(),
    retry = await baseline.initialize();
  expect(first.idempotent).toBe(false);
  expect(retry).toEqual({ ...first, idempotent: true });
  const sealed = await replay.sealPublicReleasePairReplayWitness({
    firestore: db,
    pair: baseline.pair,
    completedAt: 1000,
  });
  const repeated = await replay.sealPublicReleasePairReplayWitness({
    firestore: db,
    pair: baseline.pair,
    completedAt: 2000,
  });
  expect(repeated).toEqual({ ...sealed, idempotent: true });
  expect(sealed.witness.logBaselineDigest).not.toBe(sealed.witness.fromCursor.baselineDigest);
  expect(sealed.witness.pageCount).toBe(0);
  expect(sealed.witness.codePackView).toEqual(baseline.codePack.reference);
  expect(
    await db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: baseline.cursor,
          witnessDigest: sealed.witnessDigest,
        }),
      { readOnly: true },
    ),
  ).toEqual(sealed.witness);
  const opened = await replay.openPublicReleasePairReplayWitnessProof({
    firestore: db,
    pair: baseline.pair,
    headCursor: baseline.cursor,
    witnessDigest: sealed.witnessDigest,
  });
  expect(opened.headView).toEqual(baseline.reference);
  await expect(
    db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessProofInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: baseline.cursor,
          witnessDigest: sealed.witnessDigest,
          namespaces: opened.namespaces,
          headView: baseline.codePack.reference,
        }),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: "replay-head-view-mismatch" });
  expect(opened.namespaces.map((value) => value.namespace)).toEqual(["/api/v1/content/", "/pagefind/"]);
  const feed = opened.namespaces[0];
  if (feed.namespace !== "/api/v1/content/") throw new Error("Expected content feed proof");
  expect(feed.index.pageCount).toBe(1);
  expect(feed.index.view).toEqual(baseline.codePack.reference);
  expect(feed.index.cursor).toEqual(baseline.cursor);
  expect(
    (
      await db.runTransaction(
        (transaction) =>
          replay.assertReadReplayWitnessProofInTransaction({
            firestore: db,
            transaction,
            pair: baseline.pair,
            headCursor: baseline.cursor,
            witnessDigest: sealed.witnessDigest,
            namespaces: opened.namespaces,
            headView: opened.headView,
            selectedViews: [baseline.reference, baseline.codePack.reference, baseline.reference],
          }),
        { readOnly: true },
      )
    ).namespaces,
  ).toEqual(opened.namespaces);
  await expect(
    db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessProofInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: baseline.cursor,
          witnessDigest: sealed.witnessDigest,
          namespaces: opened.namespaces.slice(1),
        }),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: "replay-namespace-readback-required" });
});
it("refuses an incomplete baseline source census before creating a cursor", async () => {
  const baseline = await replayBaselineFixture(db, store, true);
  await expect(baseline.initialize()).rejects.toThrow();
  expect((await db.doc(replay.checkpointPath(baseline.pair)).get()).exists).toBe(false);
});
it("refuses a prior global receipt after the enrollment epoch changes", async () => {
  const baseline = await replayBaselineFixture(db, store);
  await baseline.initialize();
  await db.doc("system/publicReleaseChangeLog").update({ logEpoch: "another-epoch" });
  await expect(
    replay.sealPublicReleasePairReplayWitness({
      firestore: db,
      pair: baseline.pair,
    }),
  ).rejects.toThrow();
});

it("catches up after missed wakes, waits for every member, and repeats no accepted operation", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const first = await stageReplayMixedChange(baseline);
  const second = await stageReplayMixedChange(baseline, {
    operationId: "replay-operation-two",
    versionDelta: 2,
  });
  const options = {
    firestore: db,
    store,
    pair: baseline.pair,
    completedAt: 1000,
    resolveView: async (entry: typeof first.entry) =>
      entry.operationId === first.entry.operationId ? first.reference : null,
  };
  const before = (await db.doc("system/publicDeployment").get()).data();
  const pending = await replayPublicReleasePairToHead(options);
  expect(pending).toEqual({
    status: "pending",
    cursor: baseline.cursor,
    operationId: second.entry.operationId,
  });
  expect((await db.doc(replay.checkpointPath(baseline.pair)).get()).data()!.cursor).toEqual(baseline.cursor);
  const resolve = async (entry: typeof first.entry) =>
    entry.operationId === first.entry.operationId ? first.reference : second.reference;
  // Draft-only edits and later source state cannot fill or change frozen packs.
  await db.doc("cmsPosts/story").update({ version: 999, draft: { title: "A later draft" } });
  const completed = await replayPublicReleasePairToHead({
    ...options,
    resolveView: resolve,
  });
  expect(completed.status).toBe("complete");
  if (completed.status !== "complete") throw new Error("Expected a completed replay");
  expect(completed.witness.headCursor).toEqual(second.cursor);
  expect(completed.witness.pageCount).toBe(1);
  const selected = [];
  for await (const member of readPublicReleasePairReplaySelection({
    store,
    pair: baseline.pair,
    kind: "content",
    cursor: second.cursor,
    digest: completed.witness.contentViewDigest,
  }))
    selected.push(member);
  // The accepted page registry and fixed Program/Post fixture define this roster,
  // independently of the replay selection under test.
  const expectedPaths = [
    ...PUBLIC_PAGES.flatMap((page) => [page.path, ...("aliases" in page ? page.aliases : [])]),
    "/posts/removed-old/",
    "/posts/removed/",
    "/posts/shadow-fixture/",
    "/posts/story/",
    "/programs/",
    "/programs/one/",
    "/shows/",
    "/shows/one/",
  ].sort();
  expect(selected.map((member) => member.path)).toEqual(expectedPaths);
  expect(
    selected.every((member) => member.view.identity.sourceOperationId === second.entry.operationId),
  ).toBe(true);
  const repeated = await replayPublicReleasePairToHead({
    ...options,
    resolveView: resolve,
    completedAt: 2000,
  });
  expect(repeated).toEqual({ ...completed, idempotent: true });
  const tasks = await db.collection(`${work.publicReleasePairPath(baseline.pair.pairId)}/work`).get();
  expect(tasks.size).toBe(4);
  expect(
    tasks.docs.every((row) => row.data().identity.kind === "qualification" && row.data().attempts === 1),
  ).toBe(true);
  expect((await db.collection(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations`).get()).size).toBe(2);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
}, 120_000);
it("recovers a lost immutable storage response without advancing a partial page or re-rendering", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const event = await stageReplayMixedChange(baseline);
  let interrupted = false,
    retainedKey = "";
  const interruptedStore = {
    get: (key: string) => store.get(key),
    put: async (...args: Parameters<typeof store.put>) => {
      const result = await store.put(...args);
      if (!interrupted && args[0].includes("/selections/")) {
        const root = JSON.parse(new TextDecoder().decode(args[1] as Uint8Array));
        if (root.cursor.sequence === event.cursor.sequence) {
          interrupted = true;
          retainedKey = args[0];
          throw new Error("Simulated lost storage response");
        }
      }
      return result;
    },
  };
  const options = {
    firestore: db,
    pair: baseline.pair,
    resolveView: async () => event.reference,
    completedAt: 1000,
  };
  await expect(replayPublicReleasePairToHead({ ...options, store: interruptedStore })).rejects.toThrow(
    "Simulated lost storage response",
  );
  expect(interrupted).toBe(true);
  expect(await store.get(retainedKey)).not.toBeNull();
  expect((await db.doc(replay.checkpointPath(baseline.pair)).get()).data()!.cursor).toEqual(baseline.cursor);
  const result = await replayPublicReleasePairToHead({ ...options, store });
  expect(result.status).toBe("complete");
  if (result.status !== "complete") throw new Error("Expected a completed replay");
  expect(retainedKey).toContain(result.witness.contentViewDigest);
  expect((await db.collection(`${work.publicReleasePairPath(baseline.pair.pairId)}/work`).get()).size).toBe(
    3,
  );
}, 120_000);
it("refuses a largest surviving event id when an earlier log entry is missing", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const first = await stageReplayMixedChange(baseline);
  const second = await stageReplayMixedChange(baseline, {
    operationId: "replay-operation-two",
    versionDelta: 2,
  });
  await db.doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/0000000000000001`).delete();
  await expect(
    replayPublicReleasePairToHead({
      firestore: db,
      store,
      pair: baseline.pair,
      resolveView: async (entry) =>
        entry.operationId === first.entry.operationId ? first.reference : second.reference,
    }),
  ).rejects.toThrow();
  expect((await db.doc(replay.checkpointPath(baseline.pair)).get()).data()!.cursor).toEqual(baseline.cursor);
  expect(
    (await db.collection(`${work.publicReleasePairPath(baseline.pair.pairId)}/replayWitnesses`).get()).empty,
  ).toBe(true);
}, 120_000);
it("full outside-transaction audit refuses a missing retained withdrawal body", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const event = await stageReplayMixedChange(baseline);
  const completed = await replayPublicReleasePairToHead({
    firestore: db,
    store,
    pair: baseline.pair,
    resolveView: async () => event.reference,
  });
  if (completed.status !== "complete") throw new Error("Expected a completed replay");
  expect(
    (
      await replay.auditPublicReleasePairReplayWitness({
        firestore: db,
        pair: baseline.pair,
        headCursor: event.cursor,
        witnessDigest: completed.witnessDigest,
      })
    ).witness,
  ).toEqual(completed.witness);
  await db
    .doc(
      `${sourceBodies.BODY_COLLECTION}/${event.bodyValues[event.entry.changes.findIndex((change) => change.action === "withdraw")].contentDigest}`,
    )
    .delete();
  await expect(
    replay.auditPublicReleasePairReplayWitness({
      firestore: db,
      pair: baseline.pair,
      headCursor: event.cursor,
      witnessDigest: completed.witnessDigest,
    }),
  ).rejects.toThrow();
}, 120_000);

it("rejects a stale route map even when its old view is valid and present in covered history", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const first = await stageReplayMixedChange(baseline);
  const second = await stageReplayMixedChange(baseline, {
    operationId: "replay-operation-two",
    versionDelta: 2,
  });
  const complete = await replayPublicReleasePairToHead({
    firestore: db,
    store,
    pair: baseline.pair,
    resolveView: async (entry) =>
      entry.operationId === first.entry.operationId ? first.reference : second.reference,
  });
  if (complete.status !== "complete") throw new Error("Expected a completed replay");
  const selected = [];
  for await (const row of readPublicReleasePairReplaySelection({
    store,
    pair: baseline.pair,
    kind: "content",
    cursor: second.cursor,
    digest: complete.witness.contentViewDigest,
  })) {
    selected.push(row.path === "/posts/story/" ? { ...row, view: first.reference } : row);
  }
  const stale = await writePublicReleasePairReplaySelection({
    store,
    pair: baseline.pair,
    kind: "content",
    cursor: second.cursor,
    members: selected,
  });
  await stagePublicReleasePairReplaySelection({
    firestore: db,
    store,
    pair: baseline.pair,
    kind: "content",
    cursor: second.cursor,
    digest: stale.digest,
  });
  const base = work.publicReleasePairPath(baseline.pair.pairId),
    pageDigest = (
      await db.runTransaction(
        (transaction) =>
          replay.readReplayWitnessLogPagesInTransaction({
            firestore: db,
            transaction,
            pair: baseline.pair,
            witness: complete.witness,
          }),
        { readOnly: true },
      )
    )[0];
  // Reproduce a bad privileged writer: all metadata hashes/references are valid,
  // but one latest route is relabeled with an older covered view.
  await db.doc(`${base}/replayTransitions/${pageDigest}`).update({ contentViewDigest: stale.digest });
  const forged = { ...complete.witness, contentViewDigest: stale.digest },
    witnessDigest = protocol.publicReleaseDigest(forged);
  await db.doc(`${base}/replayWitnesses/${witnessDigest}`).create(forged);
  await expect(
    db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: second.cursor,
          witnessDigest,
          selectedViews: selected.map((row) => row.view),
        }),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: "replay-current-selection-mismatch" });
}, 120_000);

it("rejects selected references outside the immutable witness coverage", async () => {
  const baseline = await replayBaselineFixture(db, store);
  await baseline.initialize();
  const sealed = await replay.sealPublicReleasePairReplayWitness({
    firestore: db,
    pair: baseline.pair,
  });
  const outside = { ...baseline.reference, manifestDigest: "9".repeat(64) };
  await expect(
    db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: baseline.cursor,
          witnessDigest: sealed.witnessDigest,
          selectedViews: [outside],
        }),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: "replay-selection-view-uncovered" });
});

it("refuses a code pack sealed for another baseline receipt or source census", async () => {
  const cursor = { baselineDigest, sequence: 0, lastDigest: baselineDigest };
  const pack = await stageReplayCodePackFixture(db, store, cursor);
  await expect(
    verifyPublicReleasePairReplayCodePack({
      firestore: db,
      store,
      pair: pack.pair,
      reference: pack.reference,
      cursor,
      expectedBaseline: {
        logBaselineDigest: "9".repeat(64),
        sourceInventoryDigest: "d".repeat(64),
        cursor,
      },
    }),
  ).rejects.toMatchObject({ code: "replay-code-pack-baseline-mismatch" });
  await expect(
    verifyPublicReleasePairReplayCodePack({
      firestore: db,
      store,
      pair: pack.pair,
      reference: pack.reference,
      cursor,
      expectedBaseline: {
        logBaselineDigest: "c".repeat(64),
        sourceInventoryDigest: "9".repeat(64),
        cursor,
      },
    }),
  ).rejects.toMatchObject({ code: "replay-code-pack-baseline-mismatch" });
});

it("refuses a partial or altered descriptor list against the native full G readback", async () => {
  const event = await prepared();
  const outputs = [];
  for await (const output of readPublicReleasePairView({
    store,
    pair,
    ...event.reference,
  }))
    outputs.push({
      path: output.path,
      status: output.status,
      headers: output.headers,
      bodyDigest: output.bodyDigest,
      bytes: output.bytes,
      objectKey: output.objectKey,
    });
  const args = {
    firestore: db,
    pair,
    reference: event.reference,
    cursor: event.cursor,
  };
  await expect(stageReplayOutputInventory({ ...args, outputs: outputs.slice(1) })).rejects.toThrow();
  const altered = outputs.map((output, index) =>
    index === 0
      ? {
          ...output,
          headers: { ...output.headers, "content-type": "text/plain" },
        }
      : output,
  );
  await expect(stageReplayOutputInventory({ ...args, outputs: altered })).rejects.toThrow();
  expect(
    (await db.doc(`${base}/replayOutputInventories/${event.reference.manifestDigest}`).get()).exists,
  ).toBe(false);
  await stageReplayOutputInventory({ ...args, outputs });
  expect(
    await db.runTransaction((transaction) => inventory.readReplayOutputInventory({ ...args, transaction }), {
      readOnly: true,
    }),
  ).toEqual(outputs);
});
it("exposes complete baseline code-pack G inventories to qualification", async () => {
  const baseline = await replayBaselineFixture(db, store);
  await baseline.initialize();
  const rows = await db.runTransaction(
    (transaction) =>
      inventory.readReplayOutputInventory({
        firestore: db,
        transaction,
        pair: baseline.pair,
        reference: baseline.codePack.reference,
        cursor: baseline.cursor,
      }),
    { readOnly: true },
  );
  expect(rows.map((row) => row.path)).toEqual(
    baseline.codePack.manifest.members.map((member) => member.path),
  );
});

// History fixtures follow the coordinator's bounded index-page specification.
// They represent real retained metadata; no workload or stress loop is run.
async function retainedHistory(count: number) {
  const fromCursor = {
    baselineDigest,
    sequence: 0,
    lastDigest: baselineDigest,
  };
  const digests = Array.from({ length: count }, (_, index) => sha(encode({ immutableLogPage: index + 1 })));
  const batch = db.batch(),
    base = work.publicReleasePairPath(pair.pairId);
  let previous: string | null = null;
  const pages: Array<{ digest: string; value: Record<string, unknown> }> = [];
  for (let index = 0; index < digests.length; index += 128) {
    const value = {
      schemaVersion: 2,
      kind: "pair-replay-history",
      pairDigest: protocol.publicReleaseDigest(pair),
      fromCursor,
      startIndex: index,
      prevPageDigest: previous,
      logPageDigests: digests.slice(index, index + 128),
    };
    const digest = protocol.publicReleaseDigest(value);
    batch.create(db.doc(`${base}/replayHistory/${digest}`), value);
    pages.push({ digest, value });
    previous = digest;
  }
  await batch.commit();
  const history = {
    fromCursor,
    headCursor: {
      ...fromCursor,
      sequence: count,
      lastDigest: sha(encode({ event: count })),
    },
    pageCount: count,
    logPagesRootDigest: previous!,
  };
  return { history, digests, pages, base };
}
it("appends beyond 512 history pages without growing a checkpoint or replacing prior index pages", async () => {
  const retained = await retainedHistory(513),
    pageDigest = sha(encode({ immutableLogPage: 514 }));
  const appended = await db.runTransaction(async (transaction) => {
    const appended = await replayHistory.appendReplayHistoryInTransaction({
      firestore: db,
      transaction,
      pair,
      history: retained.history,
      pageDigest,
      headCursor: {
        baselineDigest,
        sequence: 514,
        lastDigest: sha(encode({ event: 514 })),
      },
    });
    appended.write();
    return appended.history;
  });
  expect(appended.pageCount).toBe(514);
  expect(Buffer.byteLength(JSON.stringify(appended))).toBeLessThan(600);
  const expanded = await db.runTransaction(
    (transaction) =>
      replayHistory.readReplayHistoryInTransaction({
        firestore: db,
        transaction,
        pair,
        history: appended,
      }),
    { readOnly: true },
  );
  expect(expanded).toEqual([...retained.digests, pageDigest]);
  for (const page of retained.pages)
    expect((await db.doc(`${retained.base}/replayHistory/${page.digest}`).get()).data()).toEqual(page.value);
});
it("rotates a full history index page and refuses a missing or reordered predecessor", async () => {
  const retained = await retainedHistory(128),
    pageDigest = sha(encode({ immutableLogPage: 129 }));
  const appended = await db.runTransaction(async (transaction) => {
    const result = await replayHistory.appendReplayHistoryInTransaction({
      firestore: db,
      transaction,
      pair,
      history: retained.history,
      pageDigest,
      headCursor: {
        baselineDigest,
        sequence: 129,
        lastDigest: sha(encode({ event: 129 })),
      },
    });
    result.write();
    return result.history;
  });
  const tail = (await db.doc(`${retained.base}/replayHistory/${appended.logPagesRootDigest}`).get()).data()!;
  expect(tail.startIndex).toBe(128);
  expect(tail.prevPageDigest).toBe(retained.pages[0].digest);
  expect(tail.logPageDigests).toEqual([pageDigest]);
  const read = () =>
    db.runTransaction(
      (transaction) =>
        replayHistory.readReplayHistoryInTransaction({
          firestore: db,
          transaction,
          pair,
          history: appended,
        }),
      { readOnly: true },
    );
  const original = db.doc(`${retained.base}/replayHistory/${retained.pages[0].digest}`);
  await original.update({ logPageDigests: [...retained.digests].reverse() });
  await expect(read()).rejects.toMatchObject({
    code: "replay-history-invalid",
  });
  await original.delete();
  await expect(read()).rejects.toMatchObject({
    code: "replay-history-invalid",
  });
});
it("refuses duplicate log pages and an extra or truncated history index", async () => {
  const retained = await retainedHistory(129);
  const repeated = {
    ...retained.pages[1].value,
    logPageDigests: [retained.digests[0]],
  };
  const repeatedRoot = protocol.publicReleaseDigest(repeated);
  await db.doc(`${retained.base}/replayHistory/${repeatedRoot}`).create(repeated);
  const read = (history: typeof retained.history) =>
    db.runTransaction(
      (transaction) =>
        replayHistory.readReplayHistoryInTransaction({
          firestore: db,
          transaction,
          pair,
          history,
        }),
      { readOnly: true },
    );
  await expect(read({ ...retained.history, logPagesRootDigest: repeatedRoot })).rejects.toMatchObject({
    code: "replay-history-invalid",
  });
  await expect(read({ ...retained.history, pageCount: 128 })).rejects.toMatchObject({
    code: "replay-history-invalid",
  });
  await expect(
    read({ ...retained.history, logPagesRootDigest: retained.pages[0].digest }),
  ).rejects.toMatchObject({
    code: "replay-history-invalid",
  });
});

it("refuses baseline member ownership for a different immutable census member", async () => {
  const baseline = await replayBaselineFixture(db, store, false, true);
  await expect(baseline.initialize()).rejects.toMatchObject({
    code: "replay-baseline-source-mismatch",
  });
  expect((await db.doc(replay.checkpointPath(baseline.pair)).get()).exists).toBe(false);
});

function countedFirestore() {
  const seals: number[] = [];
  const firestore = new Proxy(db, {
    get(target, key) {
      if (key === "runTransaction")
        return async (update: (transaction: any) => Promise<any>, options?: any) => {
          let reads = 0;
          const result = await target.runTransaction(
            (transaction) =>
              update(
                new Proxy(transaction, {
                  get(tx, method) {
                    if (method === "get")
                      return (...args: any[]) => {
                        reads++;
                        return (tx.get as any)(...args);
                      };
                    if (method === "getAll")
                      return (...args: any[]) => {
                        reads += args.length;
                        return tx.getAll(...args);
                      };
                    const value = Reflect.get(tx, method, tx);
                    return typeof value === "function" ? value.bind(tx) : value;
                  },
                }),
              ),
            options,
          );
          if (result && typeof result === "object" && "witness" in result) seals.push(reads);
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { firestore, seals };
}
// A protocol-boundary fixture for already accepted immutable capsules. The
// current original H/G owner is real below. The full 513-publication producer
// flow is not run to measure a bounded final Firestore transaction.
async function acceptedCapsuleHistoryFixture(
  baseline: Awaited<ReturnType<typeof mixedBaseline>>,
  count: number,
) {
  const pair = baseline.pair,
    base = work.publicReleasePairPath(pair.pairId);
  const checkpoint = (await db.doc(replay.checkpointPath(pair)).get()).data()!;
  const genesis = await replayCapsules.readReplayCapsule({
    firestore: db,
    transaction: replayCapsules.outsideReplayRead(db),
    pair,
    capsuleDigest: checkpoint.capsuleDigest,
    accepted: true,
  });
  // Retained source rows are explicit protocol fixtures, serialized with the
  // actual codecs. This keeps the current H materialization real without
  // running 512 unrelated publication transactions for a read-count test.
  const story = (await db.doc("cmsPosts/story").get()).data()!;
  const sourceChange = producer.publicContentChange("cmsPosts", "story", story);
  const body = sourceBodies.makePublicReleaseSourceBody(sourceChange);
  const change = {
    kind: sourceChange.kind,
    id: sourceChange.id,
    action: sourceChange.action,
    sourceVersion: sourceChange.sourceVersion,
    snapshotDigest: protocol.publicReleaseDigest(sourceChange.snapshot),
  };
  let prefixBatch = db.batch(),
    prefixWrites = 0;
  const createPrefix = async (path: string, value: Record<string, unknown>) => {
    prefixBatch.create(db.doc(path), value);
    if (++prefixWrites === 400) {
      await prefixBatch.commit();
      prefixBatch = db.batch();
      prefixWrites = 0;
    }
  };
  const existingBody = await db.doc(`${sourceBodies.BODY_COLLECTION}/${body.contentDigest}`).get();
  if (!existingBody.exists)
    await createPrefix(`${sourceBodies.BODY_COLLECTION}/${body.contentDigest}`, {
      schemaVersion: 2,
      json: body.json,
    });
  else expect(existingBody.data()!.json).toBe(body.json);
  const accepted = [];
  let cursor = baseline.cursor;
  for (let index = 1; index <= count; index++) {
    const input = log.parsePublicReleaseChangeInput({
      operationId: `retained-${index}`,
      pair: protocol.publicReleasePairReference(baseline.shared.sourcePair),
      contextRevision: index + 1,
      changes: [change],
    });
    const core = { schemaVersion: 2, sequence: index, previousDigest: cursor.lastDigest, ...input };
    const entry = log.parsePublicReleaseChange({ ...core, entryDigest: protocol.publicReleaseDigest(core) });
    cursor = { ...baseline.cursor, sequence: index, lastDigest: entry.entryDigest };
    accepted.push({ entry, cursor });
    await createPrefix(
      `${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(index).padStart(16, "0")}`,
      entry,
    );
    await createPrefix(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations/${entry.operationId}`, {
      schemaVersion: 2,
      sequence: index,
      entryDigest: entry.entryDigest,
      inputDigest: protocol.publicReleaseDigest(input),
    });
    await createPrefix(producer.publicReleaseMemberPath(entry.operationId, change.kind, change.id), {
      schemaVersion: 2,
      operationId: entry.operationId,
      sequence: index,
      entryDigest: entry.entryDigest,
      change,
      json: canonical(sourceChange.snapshot),
      contentDigest: body.contentDigest,
    });
  }
  if (prefixWrites) await prefixBatch.commit();
  await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set({ schemaVersion: 2, ...cursor });
  await db.doc("system/publicDeployment/contexts/public").update({ revision: count + 1 });
  const selected = [];
  for await (const row of readPublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor: baseline.cursor,
    digest: checkpoint.contentViewDigest,
  }))
    selected.push(row);
  const content = await writePublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor,
    members: selected,
  });
  const overlay = await writePublicReleasePairReplaySelection({
    store,
    pair,
    kind: "code-pack-overlay",
    cursor,
    members: [],
  });
  await stagePublicReleasePairReplaySelection({
    firestore: db,
    store,
    pair,
    kind: "content",
    cursor,
    digest: content.digest,
  });
  await stagePublicReleasePairReplaySelection({
    firestore: db,
    store,
    pair,
    kind: "code-pack-overlay",
    cursor,
    digest: overlay.digest,
  });
  const logPageDigests = Array.from({ length: count }, (_, index) =>
    sha(encode({ retainedLogPage: index + 1 })),
  );
  let previousCapsule = checkpoint.capsuleDigest,
    previousFullIndex: string | null = null,
    state = replayCapsules.checkpointState(checkpoint);
  let batch = db.batch(),
    pending = 0;
  const write = async (path: string, value: Record<string, unknown>) => {
    batch.create(db.doc(path), value);
    pending++;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  };
  for (let index = 1; index <= count; index++) {
    const startIndex = Math.floor((index - 1) / 128) * 128;
    const indexPage = {
      schemaVersion: 2,
      kind: "pair-replay-history",
      pairDigest: protocol.publicReleaseDigest(pair),
      fromCursor: baseline.cursor,
      startIndex,
      prevPageDigest: previousFullIndex,
      logPageDigests: logPageDigests.slice(startIndex, index),
    };
    const root = protocol.publicReleaseDigest(indexPage);
    await write(`${base}/replayHistory/${root}`, indexPage);
    if (index % 128 === 0) previousFullIndex = root;
    const headCursor = accepted[index - 1].cursor;
    const nextState = {
      pairBaselineDigest: checkpoint.pairBaselineDigest,
      cursor: headCursor,
      history: {
        fromCursor: baseline.cursor,
        headCursor,
        pageCount: index,
        logPagesRootDigest: root,
      },
      coveredMembersDigest: sha(encode({ verifiedThrough: index })),
      contentViewDigest: content.digest,
      codePackOverlayDigest: overlay.digest,
    };
    const evidence = {
      ...genesis.evidence,
      priorStateDigest: protocol.publicReleaseDigest(state),
      state: nextState,
    };
    const coveredEvidenceDigest = protocol.publicReleaseDigest(evidence);
    const capsule = {
      pageIndex: index,
      pageDigest: logPageDigests[index - 1],
      prevCapsuleDigest: previousCapsule,
      coveredEvidenceDigest,
      verifiedAt: 1000 + index,
    };
    const capsuleDigest = protocol.publicReleaseDigest(capsule);
    await write(`${base}/replayCapsuleEvidence/${coveredEvidenceDigest}`, evidence);
    await write(`${base}/replayCapsules/${capsuleDigest}`, capsule);
    await write(`${base}/replayCapsuleIndexes/${index}`, {
      schemaVersion: 2,
      pairDigest: protocol.publicReleaseDigest(pair),
      pageIndex: index,
      capsuleDigest,
    });
    await write(`${base}/replayPageCapsules/${capsule.pageDigest}`, {
      capsuleDigest,
    });
    previousCapsule = capsuleDigest;
    state = nextState;
  }
  if (pending) await batch.commit();
  await db.doc(replay.checkpointPath(pair)).set({
    schemaVersion: 2,
    pairDigest: protocol.publicReleaseDigest(pair),
    ...state,
    capsuleDigest: previousCapsule,
    witnessDigest: null,
  });
}
it("keeps seal transaction reads constant after 513 accepted history pages", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const counted = countedFirestore();
  await replay.sealPublicReleasePairReplayWitness({
    firestore: counted.firestore,
    pair: baseline.pair,
  });
  await acceptedCapsuleHistoryFixture(baseline, 512);
  const event = await stageReplayMixedChange(baseline, {
    operationId: "after-retained-history",
  });
  const complete = await replayPublicReleasePairToHead({
    firestore: counted.firestore,
    store,
    pair: baseline.pair,
    resolveView: async () => event.reference,
  });
  expect(complete.status).toBe("complete");
  if (complete.status !== "complete") throw new Error("Expected complete replay");
  expect(complete.witness.pageCount).toBe(513);
  expect(counted.seals).toHaveLength(2);
  // The non-baseline head adds only its prior-capsule index, tail and log-entry
  // identity. Closed evidence never contributes transaction reads.
  expect(counted.seals[1]).toBeLessThanOrEqual(counted.seals[0] + 3);
  expect(counted.seals[1]).toBeLessThan(50);
}, 120_000);
it("refuses a changed current claim after its evidence capsule was accepted", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const event = await stageReplayMixedChange(baseline);
  const complete = await replayPublicReleasePairToHead({
    firestore: db,
    store,
    pair: baseline.pair,
    resolveView: async () => event.reference,
  });
  if (complete.status !== "complete") throw new Error("Expected complete replay");
  await db
    .doc(
      `${work.publicReleasePairPath(baseline.pair.pairId)}/work/${protocol.publicReleaseDigest(event.reference.identity)}`,
    )
    .update({ claimDigest: "e".repeat(64) });
  await expect(
    db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: event.cursor,
          witnessDigest: complete.witnessDigest,
        }),
      { readOnly: true },
    ),
  ).rejects.toThrow();
}, 120_000);
it("refuses a capsule whose accepted predecessor link is different", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const event = await stageReplayMixedChange(baseline);
  const complete = await replayPublicReleasePairToHead({
    firestore: db,
    store,
    pair: baseline.pair,
    resolveView: async () => event.reference,
  });
  if (complete.status !== "complete") throw new Error("Expected complete replay");
  const base = work.publicReleasePairPath(baseline.pair.pairId);
  const original = (await db.doc(`${base}/replayCapsules/${complete.witness.capsuleDigest}`).get()).data()!;
  const capsule = { ...original, prevCapsuleDigest: "f".repeat(64) },
    capsuleDigest = protocol.publicReleaseDigest(capsule);
  await db.doc(`${base}/replayCapsules/${capsuleDigest}`).create(capsule);
  await db.doc(`${base}/replayCapsuleIndexes/1`).update({ capsuleDigest });
  const forged = { ...complete.witness, capsuleDigest },
    witnessDigest = protocol.publicReleaseDigest(forged);
  await db.doc(`${base}/replayWitnesses/${witnessDigest}`).create(forged);
  await expect(
    db.runTransaction(
      (transaction) =>
        replay.assertReadReplayWitnessInTransaction({
          firestore: db,
          transaction,
          pair: baseline.pair,
          headCursor: event.cursor,
          witnessDigest,
        }),
      { readOnly: true },
    ),
  ).rejects.toMatchObject({ code: "replay-capsule-link-mismatch" });
}, 120_000);

it("retains a sealed zero-page feed namespace and its same-view index in the baseline capsule", async () => {
  const baseline = await replayBaselineFixture(db, store, false, false, true);
  await baseline.initialize();
  const sealed = await replay.sealPublicReleasePairReplayWitness({
    firestore: db,
    pair: baseline.pair,
  });
  const opened = await replay.openPublicReleasePairReplayWitnessProof({
    firestore: db,
    pair: baseline.pair,
    headCursor: baseline.cursor,
    witnessDigest: sealed.witnessDigest,
  });
  expect(opened.namespaces.map((value) => value.namespace)).toEqual(["/api/v1/content/", "/pagefind/"]);
  const feed = opened.namespaces[0];
  if (feed.namespace !== "/api/v1/content/") throw new Error("Expected content feed proof");
  expect(feed.members).toEqual([]);
  expect(feed.index.pageCount).toBe(0);
  expect(feed.index.view).toEqual(baseline.codePack.reference);
  expect(feed.index.cursor).toEqual(baseline.cursor);
});

it("accepts a longer page after a prepared partial page loses its cursor transaction", async () => {
  const baseline = await replayBaselineFixture(db, store);
  await baseline.initialize();
  const event = await prepared("complete", baseline.pair);
  const checkpoint = (await db.doc(replay.checkpointPath(baseline.pair)).get()).data()!;
  const genesis = await replayCapsules.readReplayCapsule({
    firestore: db,
    transaction: replayCapsules.outsideReplayRead(db),
    pair: baseline.pair,
    capsuleDigest: checkpoint.capsuleDigest,
    accepted: true,
  });
  const membershipPath = `${work.publicReleasePairPath(baseline.pair.pairId)}/replayCoveredViews/${protocol.publicReleaseDigest(event.reference)}`;
  // Capsule storage is tested at its protocol boundary. Full page verification
  // belongs to preparePublicReleasePairReplayPageCapsule, tested above.
  async function prepare(head: typeof event.cursor, pageDigest: string) {
    const evidence = {
      ...genesis.evidence,
      priorStateDigest: protocol.publicReleaseDigest(replayCapsules.checkpointState(checkpoint)),
      state: {
        ...genesis.evidence.state,
        cursor: head,
        history: {
          fromCursor: baseline.cursor,
          headCursor: head,
          pageCount: 1,
          logPagesRootDigest: "8".repeat(64),
        },
      },
    };
    return replayCapsules.prepareReplayCapsule({
      firestore: db,
      pair: baseline.pair,
      pageIndex: 1,
      pageDigest,
      prevCapsuleDigest: checkpoint.capsuleDigest,
      evidence,
      // An old prepare implementation reserved this view before cursor commit.
      references: [event.reference],
      verifiedAt: 1000,
    });
  }
  const partial = await prepare(event.cursor, "1".repeat(64));
  expect((await db.doc(membershipPath).get()).exists).toBe(false);
  await expect(
    db.runTransaction(async (transaction) => {
      const accept = await replayCapsules.prepareReplayCoveredViews({
        firestore: db,
        transaction,
        pair: baseline.pair,
        pairBaselineDigest: checkpoint.pairBaselineDigest,
        references: [event.reference],
        pageIndex: 1,
        capsuleDigest: partial.capsuleDigest,
      });
      accept();
      throw new Error("Simulated cursor transaction loss");
    }),
  ).rejects.toThrow("Simulated cursor transaction loss");
  expect((await db.doc(membershipPath).get()).exists).toBe(false);
  const longer = await prepare(
    {
      ...event.cursor,
      sequence: event.cursor.sequence + 1,
      lastDigest: "9".repeat(64),
    },
    "2".repeat(64),
  );
  expect(longer.capsuleDigest).not.toBe(partial.capsuleDigest);
  await db.runTransaction(async (transaction) => {
    const accept = await replayCapsules.prepareReplayCoveredViews({
      firestore: db,
      transaction,
      pair: baseline.pair,
      pairBaselineDigest: checkpoint.pairBaselineDigest,
      references: [event.reference],
      pageIndex: 1,
      capsuleDigest: longer.capsuleDigest,
    });
    accept();
  });
  expect((await db.doc(membershipPath).get()).data()!.capsuleDigest).toBe(longer.capsuleDigest);
});

it("resumes the original completed composite after a staging crash without another publication", async () => {
  const baseline = await mixedBaseline();
  await baseline.initialize();
  const event = await stageReplayMixedChange(baseline, { settleOnly: true });
  const base = work.publicReleasePairPath(baseline.pair.pairId);
  const receipt = (await db.doc(`${base}/receipts/${event.taskId}`).get()).data();
  const before = (await db.doc("system/publicDeployment").get()).data();
  expect((await db.doc(`${base}/views/${event.reference.manifestDigest}`).get()).exists).toBe(false);
  const options = {
    firestore: baseline.sourceDb,
    store,
    pair: baseline.pair,
    providerStore: baseline.providerStore,
    contentStore: { get: (key: string) => store.get(key) },
  };
  const complete = await reconcilePublicReleasePairReplay(options);
  expect(complete.status).toBe("complete");
  if (complete.status !== "complete") throw new Error("Expected complete recovery replay");
  expect(complete.witness.headCursor).toEqual(event.cursor);
  expect((await db.doc(`${base}/receipts/${event.taskId}`).get()).data()).toEqual(receipt);
  expect((await db.doc(`${base}/work/${event.taskId}`).get()).data()!.attempts).toBe(1);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(before);
  expect((await db.collection(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations`).get()).size).toBe(1);
  expect(await reconcilePublicReleasePairReplay(options)).toEqual({ ...complete, idempotent: true });
}, 120_000);
