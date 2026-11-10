import type { Firestore } from "firebase-admin/firestore";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { replayRuntimeFixture } from "./public-release-pair-replay-runtime";
import { stagedPublicReleasePairCompositeFixture } from "./staged-public-release-pair-composite";
import { initializePublicReleasePairReplayBaseline } from "../../site/scripts/public-release-pair-log-replay";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import producer from "../../functions/lib/public-release-producer.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";

/** Real retained source and complete owner staging. The shared stager's route
 * and Pagefind bodies are fixture bytes; this tests replay, not renderer SSR. */
export async function replayMixedBaselineFixture(firestore: Firestore, store: PairViewStore) {
  const runtime = await replayRuntimeFixture(firestore, store);
  try {
    const staged = await stagedPublicReleasePairCompositeFixture(runtime.shared, store);
    const reference = {
      identity: staged.claim.identity,
      claimDigest: staged.owner.claimDigest,
      manifestDigest: staged.rendered.manifestDigest,
      manifestBytes: staged.rendered.manifestBytes,
    };
    const args = {
      firestore,
      store,
      pair: runtime.pair,
      logBaselineDigest: runtime.global.logBaselineDigest,
      views: [reference],
      codePackView: runtime.baseline.reference,
    };
    return {
      ...runtime,
      reference,
      args,
      cursor: runtime.baseline.cursor,
      initialize: () => initializePublicReleasePairReplayBaseline(args),
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

export async function appendReplayMixedChange(
  runtime: Awaited<ReturnType<typeof replayMixedBaselineFixture>>,
  options: { operationId?: string; versionDelta?: number } = {},
) {
  const { firestore } = runtime;
  const operationId = options.operationId ?? "replay-operation",
    delta = options.versionDelta ?? 0;
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const published = {
    ...story.published,
    sourceVersion: 10 + delta,
    metadata: {
      ...story.published.metadata,
      slug: "story",
      previousSlugs: [
        ...new Set([...(story.published.metadata.previousSlugs ?? []), story.published.metadata.slug]),
      ].filter((slug) => slug !== "story"),
    },
  };
  const removed = {
    ...published,
    sourceVersion: 11 + delta,
    metadata: {
      ...published.metadata,
      slug: "removed",
      previousSlugs: ["removed-old"],
    },
  };
  const context = (await firestore.doc("system/publicDeployment/contexts/public").get()).data()!;
  await firestore.runTransaction(async (transaction) => {
    const append = await producer.preparePublicReleaseProducerInTransaction({
      firestore,
      transaction,
      operationId,
      changes: [
        producer.publicContentChange("cmsPosts", "story", { published }),
        producer.publicContentChange("cmsPosts", "removed", { published: removed }, false),
      ],
    });
    append();
    transaction.set(firestore.doc("cmsPosts/story"), {
      ...story,
      version: published.sourceVersion,
      published,
    });
    transaction.set(firestore.doc("cmsPosts/removed"), {
      ...story,
      id: "removed",
      status: "archived",
      publiclyVisible: false,
      version: removed.sourceVersion,
      published: removed,
    });
    transaction.update(firestore.doc("system/publicDeployment/contexts/public"), {
      revision: context.revision + 1,
    });
  });
  const head = log.parsePublicReleaseChangeHead(
    (await firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH).get()).data(),
  );
  const entry = log.parsePublicReleaseChange(
    (
      await firestore
        .doc(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries/${String(head.sequence).padStart(16, "0")}`)
        .get()
    ).data(),
  );
  return {
    entry,
    cursor: {
      baselineDigest: head.baselineDigest,
      sequence: head.sequence,
      lastDigest: head.lastDigest,
    },
  };
}

export async function stageReplayMixedChange(
  runtime: Awaited<ReturnType<typeof replayMixedBaselineFixture>>,
  options: { operationId?: string; versionDelta?: number; settleOnly?: boolean } = {},
) {
  const accepted = await appendReplayMixedChange(runtime, options);
  const { firestore, pair, store } = runtime;
  const captured = await captureHistoricalPublicReleasePairInput({
    firestore: runtime.sourceDb,
    store,
    pair,
    providerStore: runtime.providerStore,
    sourceOperationId: accepted.entry.operationId,
  });
  const { taskId } = await firestore.runTransaction((transaction) =>
    work.enqueuePublicReleasePairWorkInTransaction({
      firestore,
      transaction,
      pair,
      input: {
        ...captured.root.scope,
        inputManifestDigest: captured.receipt.inputManifestDigest,
      },
    }),
  );
  const staged = await stagedPublicReleasePairCompositeFixture(
    { ...runtime.shared, content: captured, taskId },
    store,
    options.settleOnly,
  );
  const bodyValues = await Promise.all(
    accepted.entry.changes.map(async (change) => {
      const row = await firestore
        .doc(producer.publicReleaseMemberPath(accepted.entry.operationId, change.kind, change.id))
        .get();
      return { contentDigest: row.data()!.contentDigest };
    }),
  );
  return {
    ...accepted,
    taskId,
    bodyValues,
    reference: {
      identity: staged.claim.identity,
      claimDigest: staged.owner.claimDigest,
      manifestDigest: staged.rendered.manifestDigest,
      manifestBytes: staged.rendered.manifestBytes,
    },
  };
}
