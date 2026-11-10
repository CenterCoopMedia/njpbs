import { schedulePacketFixture } from "../functions/page-schedule-packet-fixture";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Firestore } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import input from "../../functions/lib/public-release-pair-input.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import baselineOwner from "../../functions/lib/public-release-change-baseline.js";
import sourceBodies from "../../functions/lib/public-release-source-body.js";
import { releasePair, releaseSelector } from "./private-public-release-pair.js";
import { stageReplayCodePackFixture } from "./public-release-pair-replay-pack";
import { capturePublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { writePublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { writeReplayTargetFixture, stageReplayTargetFixture } from "./public-release-pair-log-targets";
import { initializePublicReleasePairReplayBaseline } from "../../site/scripts/public-release-pair-log-replay";

const source = JSON.parse(
  readFileSync(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8"),
);
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const encode = (value: unknown) => new TextEncoder().encode(sourceBodies.publicReleaseSnapshotJson(value));
export async function replayBaselineFixture(
  firestore: Firestore,
  store: PairViewStore,
  omitCensusBody = false,
  wrongAuthority = false,
  emptyFeed = false,
) {
  const anchor = "b".repeat(64),
    cursor = { baselineDigest: anchor, sequence: 0, lastDigest: anchor };
  await firestore.doc("system/publicDeployment").set(releaseSelector());
  const published = {
    ...source.document.published,
    metadata: { ...source.document.published.metadata, slug: "story", previousSlugs: [] },
  };
  await firestore.doc("cmsPosts/published").set({
    ...source.document,
    published,
    id: "published",
    type: "post",
    status: emptyFeed ? "archived" : "published",
    publiclyVisible: !emptyFeed,
  });
  await firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(log.initialPublicReleaseChangeHead(anchor));
  // The retained CODE reader uses a real local HTTP/Storage boundary. The
  // emulator project id stays internal; only the target selector sees dev.
  const sourceDb = new Proxy(firestore, {
    get(target, key) {
      if (key === "projectId") return "njpbs-site-dev";
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const packet = await schedulePacketFixture({
    firestore,
    rendererSha: releasePair().commitSha,
    generation: 1,
    attachExternalInputs: false,
  });
  let global: Awaited<ReturnType<typeof baselineOwner.capturePublicReleaseChangeBaseline>>;
  try {
    global = await baselineOwner.capturePublicReleaseChangeBaseline({
      firestore: sourceDb,
      logEpoch: "replay-test-epoch",
      currentCodeRequest: packet.request,
    });
  } finally {
    await packet.close();
  }
  await firestore.doc("system/publicReleaseChangeLog").set({
    schemaVersion: 2,
    enabled: true,
    pair: releaseSelector().selectedPair,
    head: log.initialPublicReleaseChangeHead(anchor),
    logEpoch: global.receipt.logEpoch,
  });
  const codePack = await stageReplayCodePackFixture(
    firestore,
    store,
    cursor,
    undefined,
    {
      schemaVersion: 1,
      logBaselineDigest: global.logBaselineDigest,
      sourceMemberCensusDigest: global.receipt.sourceMemberCensusDigest,
      baselineCursor: cursor,
    },
    emptyFeed,
    global,
  );
  const { pair } = codePack;
  const snapshot = global.sourceMembers,
    files = new Map<string, { bytes: Uint8Array; dependencies: string[] }>();
  files.set("snapshot.json", { bytes: encode(snapshot), dependencies: [] });
  files.set("reader-provenance.json", {
    bytes: encode({
      schemaVersion: 1,
      pair: releasePair(),
      rendererSha: releasePair().commitSha,
      readerContractDigest: releasePair().readerContractDigest,
      readerReceiptDigest: releasePair().readerReceiptDigest,
    }),
    dependencies: [],
  });
  files.set("request.json", {
    bytes: encode({
      schemaVersion: 1,
      read: {
        kind: source.kind,
        document: {
          id: "published",
          status: "published",
          publishAt: published.publishedAt,
          publiclyVisible: true,
          published,
        },
        assets: [],
      },
      homeSourcesFile: null,
      resources: [],
    }),
    dependencies: ["reader-provenance.json", "snapshot.json"],
  });
  for (const [index, member] of global.sourceMembers.entries()) {
    if (omitCensusBody && index === 0) continue;
    const row = await firestore.doc(`${sourceBodies.BODY_COLLECTION}/${member.contentDigest}`).get();
    files.set(`source-bodies/${member.contentDigest}.json`, {
      bytes: new TextEncoder().encode(row.data()!.json),
      dependencies: [],
    });
  }
  const authorityMembers = [];
  for (const member of global.sourceMembers) {
    const row = await firestore.doc(`${sourceBodies.BODY_COLLECTION}/${member.contentDigest}`).get();
    const body = JSON.parse(row.data()!.json);
    authorityMembers.push({
      change: {
        kind: body.kind,
        id: body.id,
        action: body.action,
        sourceVersion: body.sourceVersion,
        snapshotDigest: protocol.publicReleaseDigest(body.snapshot),
      },
      ...(["post", "page", "record"].includes(body.kind) ? {} : { pathScope: "global" }),
      paths: ["post", "page", "record"].includes(body.kind) ? ["/posts/story/"] : [],
      withdrawnPaths:
        body.action === "withdraw" && ["post", "page", "record"].includes(body.kind) ? ["/posts/story/"] : [],
    });
  }
  if (wrongAuthority) authorityMembers[0].change.id = "unrelated-member";
  files.set("authority.json", {
    bytes: encode({
      schemaVersion: 2,
      baseline: global.receipt,
      logBaselineDigest: global.logBaselineDigest,
      cursor,
      members: authorityMembers,
      globalPaths: ["/posts/story/"],
      readerSource: global.receipt.liveReleaseSha,
      contextRevision: 0,
      codeAssetManifestDigest: pair.codeAssetManifestDigest,
    }),
    dependencies: [],
  });
  const dependencies = [...files]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, file]) => ({ name, digest: sha(file.bytes) }));
  const snapshotDigest = sha(files.get("snapshot.json")!.bytes);
  const plan = {
    schemaVersion: 1,
    pairDigest: protocol.publicReleaseDigest(pair),
    snapshotDigest,
    renderedAt: global.receipt.createdAt,
    routes: [
      {
        path: "/posts/story/",
        method: "GET",
        renderer: emptyFeed ? "withdrawal" : "post",
        inputFile: "request.json",
        dependencies,
      },
    ],
    expectedOutputs: [
      { path: "/posts/story/", status: emptyFeed ? 410 : 200, contentType: "text/html; charset=utf-8" },
    ],
  };
  files.set("render-plan.json", { bytes: encode(plan), dependencies: dependencies.map((file) => file.name) });
  const scope = {
    kind: "qualification" as const,
    sourceOperationId: `baseline-${global.logBaselineDigest}`,
    sourceVersion: Math.max(...authorityMembers.map((member) => member.change.sourceVersion)),
    snapshotDigest,
    contextSequence: 0,
  };
  const root = input.parsePublicReleasePairInputRoot(
    {
      schemaVersion: 2,
      kind: "pair-render-input",
      pairDigest: protocol.publicReleaseDigest(pair),
      source: { kind: "inventory", id: scope.sourceOperationId },
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
          objectKey: input.publicReleasePairInputObjectKey(pair, sha(file.bytes)),
          dependencies: file.dependencies,
        })),
    },
    pair,
  );
  async function* sourceFiles() {
    for (const [name, file] of files) yield { name, bytes: file.bytes };
  }
  const captured = await capturePublicReleasePairInput({
    firestore,
    store,
    pair,
    plan: root,
    expectedSource: root.source,
    expectedCursor: cursor,
    files: sourceFiles(),
  });
  const { taskId } = await firestore.runTransaction((transaction) =>
    work.enqueuePublicReleasePairWorkInTransaction({
      firestore,
      transaction,
      pair,
      input: { ...scope, inputManifestDigest: captured.receipt.inputManifestDigest },
    }),
  );
  const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId, now: Date.now() });
  const claimDigest = protocol.publicReleaseDigest(claim!.token);
  async function* outputs() {
    yield {
      path: "/posts/story/",
      status: emptyFeed ? (410 as const) : (200 as const),
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-njpbs-renderer-sha": pair.commitSha,
      },
      bytes: new TextEncoder().encode(emptyFeed ? "" : "<!doctype html><html>Baseline story</html>"),
    };
  }
  const written = await writePublicReleasePairView({
    store,
    pair,
    identity: claim!.identity,
    claimDigest,
    cursor,
    outputs: outputs(),
  });
  const targetOwner = {
    firestore,
    store,
    pair,
    claim: claim!,
    claimDigest,
    manifestDigest: written.manifestDigest,
    manifestBytes: written.manifestBytes,
  };
  await writeReplayTargetFixture({
    ...targetOwner,
    bodies: new Map([
      ["/posts/story/", new TextEncoder().encode(emptyFeed ? "" : "<!doctype html><html>Baseline story</html>")],
    ]),
  });
  await work.settlePublicReleasePairWork({
    firestore,
    pair,
    taskId,
    token: claim!.token,
    manifestDigest: written.manifestDigest,
    now: Date.now(),
  });
  await stagePublicReleasePairView({
    firestore,
    store,
    pair,
    identity: claim!.identity,
    claimDigest,
    manifestDigest: written.manifestDigest,
  });
  await stageReplayTargetFixture(targetOwner);
  const reference = {
    identity: claim!.identity,
    claimDigest,
    manifestDigest: written.manifestDigest,
    manifestBytes: written.manifestBytes,
  };
  const args = {
    firestore,
    store,
    pair,
    logBaselineDigest: global.logBaselineDigest,
    views: [reference],
    codePackView: codePack.reference,
  };
  return {
    pair,
    global,
    cursor,
    codePack,
    reference,
    args,
    initialize: () => initializePublicReleasePairReplayBaseline(args),
  };
}
