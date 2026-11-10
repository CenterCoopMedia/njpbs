import { publicReleasePairCompositeFixture } from "./public-release-pair-composite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import producer from "../../functions/lib/public-release-producer.js";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { openStagedPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-executor";
import {
  writePublicReleasePairView,
  readPublicReleasePairView,
  type PairViewStore,
} from "../../site/scripts/public-release-pair-view-storage";
import { stagePublicReleasePairView } from "../../site/scripts/public-release-pair-view-staging";
import { preparePublicReleasePairNamespacesReadback } from "../../site/scripts/public-release-pair-namespace-storage";
import {
  createExternalContentStaticFeed,
  type ExternalContentManifest,
} from "../../site/src/lib/external-content-feed";
import { stageReplayOutputInventory } from "../../site/scripts/public-release-pair-replay-inventory";
import type { ReplayViewReference } from "../../functions/lib/public-release-pair-replay";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");

/** Use the executor's actual complete source fixture. The extra fixed shard
 * enters its real dist census and source/G seal, not a synthesized receipt. */
export async function replayRuntimeFixture(firestore: Firestore, store: PairViewStore) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pair-replay-runtime-"));
  await mkdir(path.join(directory, "dist/pagefind"), { recursive: true });
  await writeFile(path.join(directory, "dist/pagefind/baseline.pf_fragment"), "Baseline shard");
  let shared: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>> | undefined;
  try {
    shared = await publicReleasePairCompositeFixture({ firestore, store, directory, content: "baseline" });
    const pack = await openStagedPublicReleasePairCodePack({ firestore, store, pair: shared.pair });
    const staged = (await firestore.doc(`${shared.base}/views/${pack.record.viewManifestDigest}`).get()).data();
    if (
      !staged ||
      staged.status !== "staged" ||
      !pack.manifest.members.some((member) => member.path === "/pagefind/baseline.pf_fragment")
    )
      throw new Error("Missing actual baseline namespace fixture");
    const reference: ReplayViewReference = {
      identity: pack.record.identity,
      claimDigest: pack.record.claimDigest,
      manifestDigest: pack.record.viewManifestDigest,
      manifestBytes: staged.manifestBytes,
    };
    return {
      shared,
      firestore,
      sourceDb: shared.firestore,
      store,
      pair: shared.pair,
      global: shared.global,
      providerStore: shared.providerStore,
      baseline: { reference, cursor: shared.codePack.root.cursor, manifest: pack.manifest },
      close: async () => {
        await shared!.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await shared?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Namespace boundary evidence only: the actual namespace stager proves all
 * namespace G bytes. No route target proof or complete replay is claimed. */
export async function replayNamespaceFixture(
  runtime: Awaited<ReturnType<typeof replayRuntimeFixture>>,
  sequence: number,
  fragment: string,
  items = 1,
) {
  const { firestore, sourceDb, store, pair } = runtime;
  const old = (await firestore.doc("cmsPosts/story").get()).data()!;
  const published = { ...old.published, sourceVersion: 10 + sequence };
  const operationId = `namespace-event-${sequence}`;
  await firestore.runTransaction(async (transaction) => {
    const append = await producer.preparePublicReleaseProducerInTransaction({
      firestore,
      transaction,
      operationId,
      changes: [producer.publicContentChange("cmsPosts", "story", { published })],
    });
    append();
    transaction.set(firestore.doc("cmsPosts/story"), { ...old, published, version: 10 + sequence });
    transaction.update(firestore.doc("system/publicDeployment/contexts/public"), { revision: 1 + sequence });
  });
  const captured = await captureHistoricalPublicReleasePairInput({
    firestore: sourceDb,
    store,
    pair,
    sourceOperationId: operationId,
    providerStore: runtime.providerStore,
  });
  const { taskId } = await firestore.runTransaction((transaction) =>
    work.enqueuePublicReleasePairWorkInTransaction({
      firestore,
      transaction,
      pair,
      input: { ...captured.root.scope, inputManifestDigest: captured.receipt.inputManifestDigest },
    }),
  );
  const claim = await work.claimPublicReleasePairWork({ firestore, pair, taskId });
  if (!claim) throw new Error("Missing namespace fixture claim");
  const claimDigest = protocol.publicReleaseDigest(claim.token);
  const manifest: ExternalContentManifest = {
    apiVersion: 1,
    title: "NJ PBS released content",
    homeUrl: "https://njpbs.org/",
    feedUrl: "https://njpbs.org/api/v1/content.json",
    rssUrl: "https://njpbs.org/feeds/news.xml",
    items: Array.from({ length: items }, (_, index) => ({
      id: `post:${index}`,
      type: "post",
      sourceId: `post-${index}`,
      sourceVersion: 1,
      url: `https://njpbs.org/posts/story-${index}/`,
      locale: "en",
      title: `Story ${index}`,
      summary: "Released summary",
      contentHtml: "<p>Released</p>",
      publishedAt: "2026-10-28T04:00:00.000Z",
      modifiedAt: "2026-10-28T04:00:00.000Z",
      authors: [],
      categories: [],
      tags: [],
    })),
  };
  const feed = createExternalContentStaticFeed(manifest);
  const files = [
    { path: "/api/v1/content.json", mime: "application/json; charset=utf-8", bytes: encode(feed.index) },
    ...feed.pages.map((page) => ({
      path: `/api/v1/content/${page.page}.json`,
      mime: "application/json; charset=utf-8",
      bytes: encode(page),
    })),
    {
      path: "/pagefind/pagefind-entry.json",
      mime: "application/json; charset=utf-8",
      bytes: encode({ version: "sealed" }),
    },
    {
      path: "/pagefind/pagefind.js",
      mime: "application/javascript; charset=utf-8",
      bytes: new TextEncoder().encode("export{}"),
    },
    { path: `/pagefind/${fragment}.pf_fragment`, mime: "application/octet-stream", bytes: encode({ fragment }) },
  ].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  async function* outputs() {
    for (const file of files)
      yield {
        path: file.path,
        status: 200 as const,
        bytes: file.bytes,
        headers: { "content-type": file.mime, "cache-control": "no-store", "x-njpbs-renderer-sha": pair.commitSha },
      };
  }
  const owner = { firestore, store, pair, identity: claim.identity, claimDigest };
  const rendered = await writePublicReleasePairView({
    ...owner,
    cursor: captured.root.cursor,
    outputs: outputs(),
    deriveNamespaces: true,
  });
  await work.settlePublicReleasePairWork({
    firestore,
    pair,
    taskId,
    token: claim.token,
    manifestDigest: rendered.manifestDigest,
  });
  const verifier = await preparePublicReleasePairNamespacesReadback({
    ...owner,
    viewManifestDigest: rendered.manifestDigest,
  });
  const staged = await stagePublicReleasePairView({
    ...owner,
    manifestDigest: rendered.manifestDigest,
    verify: verifier,
  });
  await verifier.persist(staged.record);
  const reference = {
    identity: claim.identity,
    claimDigest,
    manifestDigest: rendered.manifestDigest,
    manifestBytes: rendered.manifestBytes,
  };
  const native = [];
  for await (const { body: _body, ...row } of readPublicReleasePairView({ store, pair, ...reference }))
    native.push(row);
  await stageReplayOutputInventory({ firestore, pair, reference, cursor: captured.root.cursor, outputs: native });
  return { reference, cursor: captured.root.cursor, outputs: native, files };
}
