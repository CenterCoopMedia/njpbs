import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import work from "../../functions/lib/public-release-pair-work.js";
import { captureHistoricalPublicReleasePairInput } from "./public-release-pair-source-owner";
import { PairStaticSourceError } from "./public-release-pair-static-source";
import { createPublicReleasePairExecutor } from "./public-release-pair-executor";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { replayPublicReleasePairToHead } from "./public-release-pair-log-replay";

/** Private reconciliation only. The materializer uses retained baseline/log
 * bodies; the existing pair runtime owns rendering, leases and missed wakes. */
export async function reconcilePublicReleasePairReplay({
  firestore,
  store,
  pair: rawPair,
  kind = "qualification",
  providerStore,
  codeStore,
  contentStore,
  signal,
}: {
  firestore: Firestore;
  store: PairViewStore;
  pair: PublicReleasePair;
  kind?: "qualification" | "recovery";
  providerStore?: PairViewStore;
  codeStore?: PairViewStore;
  contentStore: Pick<PairViewStore, "get">;
  signal?: AbortSignal;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    base = work.publicReleasePairPath(pair.pairId);
  const executor = createPublicReleasePairExecutor({ firestore, store, pair });
  if (!["qualification", "recovery"].includes(kind)) throw new replay.PairReplayError("replay-work-kind-invalid");
  if (!contentStore || typeof contentStore.get !== "function") throw new PairStaticSourceError("pair-static-source-missing");
  return replayPublicReleasePairToHead({
    firestore,
    store,
    pair,
    signal,
    resolveView: async (entry, cursor) => {
      signal?.throwIfAborted();
      const captured = await captureHistoricalPublicReleasePairInput({
        firestore,
        store,
        providerStore,
        codeStore,
        contentStore,
        pair,
        sourceOperationId: entry.operationId,
        kind,
        signal,
      });
      const root = captured.root;
      if (
        root.scope.kind !== kind ||
        root.scope.sourceOperationId !== entry.operationId ||
        protocol.publicReleaseDigest(root.cursor) !== protocol.publicReleaseDigest(cursor)
      ) {
        throw new replay.PairReplayError("replay-historical-pack-mismatch");
      }
      const input = { ...root.scope, inputManifestDigest: captured.receipt.inputManifestDigest };
      const { taskId, task } = await firestore.runTransaction((transaction) =>
        work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair, input }),
      );
      if (!task || typeof task !== "object" || !("status" in task))
        throw new replay.PairReplayError("replay-original-task-missing");
      if (task.status !== "complete") {
        if (task.status === "failed" && "nextAttemptAt" in task && task.nextAttemptAt === null)
          throw new replay.PairReplayError("replay-original-render-failed");
        return null;
      }
      const receipt = (await firestore.doc(`${base}/receipts/${taskId}`).get()).data();
      if (!receipt || protocol.publicReleaseDigest(receipt.identity) !== taskId)
        throw new replay.PairReplayError("replay-original-receipt-missing");
      // If the process stopped after private completion, recover the complete composite proof from
      // the original receipt. Never request another render or editorial operation.
      await executor.stage({
        identity: receipt.identity,
        claimDigest: receipt.claimDigest,
        manifestDigest: receipt.manifestDigest,
        signal,
      });
      const staged = (await firestore.doc(`${base}/views/${receipt.manifestDigest}`).get()).data();
      if (!staged || staged.status !== "staged") throw new replay.PairReplayError("replay-original-staging-missing");
      return replay.parseReplayViewReference(
        {
          identity: staged.identity,
          claimDigest: staged.claimDigest,
          manifestDigest: staged.manifestDigest,
          manifestBytes: staged.manifestBytes,
        },
        pair,
      );
    },
  });
}
