import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseChange } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import log from "../../functions/lib/public-release-change-log.js";
import inventories from "../../functions/lib/public-release-pair-replay-inventory.js";
import search from "../../functions/lib/public-release-pair-replay-namespace.js";
import contentFeed from "../../functions/lib/public-release-pair-replay-content-feed.js";
import feedCodec from "../../functions/lib/public-release-pair-content-feed-namespace.js";
import views from "../../functions/lib/public-release-pair-view.js";
import work from "../../functions/lib/public-release-pair-work.js";
import type {
  ReplayCursor,
  ReplayViewReference,
  ReplayCoverage,
} from "../../functions/lib/public-release-pair-replay";
import { readReplayProofBatch, readPublicReleasePairReplayProofView } from "./public-release-replay-proof-reads";
import { prepareReplayOutputReadback } from "./public-release-pair-replay-output-proof";
import { publicReleasePairSourceInputsBytes } from "./public-release-pair-source-inputs";
import {
  PAIR_CODE_PACK_FILE,
  PAIR_COMPILED_PREFIX,
  parsePublicReleasePairCodePack,
} from "./public-release-pair-code-pack";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import {
  readPublicReleasePairView,
  readPublicReleasePairClaimJson,
  type PairViewStore,
} from "./public-release-pair-view-storage";
import { PAIR_RENDER_PLAN_FILE, parsePublicReleasePairRenderPlan } from "./public-release-pair-render-plan";
import { PAIR_SOURCE_METADATA_FILE } from "./public-release-pair-source-census";
import {
  readPublicReleasePairReplaySelection,
  writePublicReleasePairReplaySelection,
  stagePublicReleasePairReplaySelection,
  compareReplayPaths,
  type ReplaySelectionMember,
} from "./public-release-pair-replay-selection-storage";

const require = createRequire(import.meta.url);
const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => protocol.publicReleaseDigest(a) === protocol.publicReleaseDigest(b);
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const EMPTY_DIGEST = createHash("sha256").update("").digest("hex");
function refuse(code = "replay-evidence-invalid"): never {
  throw new replay.PairReplayError(code);
}
function exact(value: unknown, fields: string[]): Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    refuse();
  return value as Record<string, any>;
}
function authorityMemberPaths(raw: unknown, globalPaths: unknown, available: Map<string, ReplayOutput>) {
  const isGlobal = !!raw && typeof raw === "object" && "pathScope" in raw;
  const member = exact(raw, ["change", "paths", "withdrawnPaths", ...(isGlobal ? ["pathScope"] : [])]);
  if (
    !Array.isArray(member.paths) ||
    !Array.isArray(member.withdrawnPaths) ||
    new Set(member.paths).size !== member.paths.length ||
    new Set(member.withdrawnPaths).size !== member.withdrawnPaths.length
  ) {
    refuse("replay-member-evidence-missing");
  }
  let paths = member.paths;
  if (isGlobal) {
    if (
      member.pathScope !== "global" ||
      ["post", "page", "record"].includes(member.change?.kind) ||
      member.paths.length ||
      member.withdrawnPaths.length ||
      !Array.isArray(globalPaths) ||
      !globalPaths.length ||
      new Set(globalPaths).size !== globalPaths.length
    )
      refuse("replay-member-evidence-missing");
    paths = globalPaths;
  }
  if (
    !paths.length ||
    paths.some((path: unknown) => typeof path !== "string" || !available.has(path as string)) ||
    member.withdrawnPaths.some((path: unknown) => !paths.includes(path))
  )
    refuse("replay-member-evidence-missing");
  return { change: member.change, paths, withdrawnPaths: member.withdrawnPaths };
}
export type { ReplayOutput } from "../../functions/lib/public-release-pair-replay-inventory";
import type { ReplayOutput } from "../../functions/lib/public-release-pair-replay-inventory";
import {
  stageReplayOutputInventory,
  stageReplayCodePackInventory,
} from "./public-release-pair-replay-inventory";
type ReadbackOptions = {
  firestore: Firestore;
  store: PairViewStore;
  pair: PublicReleasePair;
  reference: ReplayViewReference;
  cursor: ReplayCursor;
  signal?: AbortSignal;
  sourceBodyDigests?: ReadonlySet<string>;
};

/** Complete input, plan, output and original ownership proof. No latest source
 * reader is used. Every input and output iterator is exhausted before return. */
export async function verifyPublicReleasePairReplayView(options: ReadbackOptions) {
  const { firestore, store, signal } = options;
  const pair = protocol.parsePublicReleasePair(options.pair),
    reference = replay.parseReplayViewReference(options.reference, pair);
  const cursor = replay.parseReplayCursor(options.cursor);
  signal?.throwIfAborted();
  const assertOwner = (transaction: import("firebase-admin/firestore").Transaction) =>
    replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference, cursor });
  const before = await firestore.runTransaction(assertOwner, { readOnly: true });
  const opened = await openPublicReleasePairInput({
    firestore,
    store,
    pair,
    identity: reference.identity,
    expectedSource: before.captured.source,
    expectedCursor: cursor,
    signal,
  });
  const files = new Map<string, Uint8Array>(),
    sourceChanges = new Map<string, unknown>();
  const descriptor = opened.root.files.find((file) => file.name === PAIR_RENDER_PLAN_FILE);
  if (!descriptor) refuse("replay-render-plan-missing");
  const planBytes = await opened.readFile(PAIR_RENDER_PLAN_FILE);
  const ordinaryPlan = parsePublicReleasePairRenderPlan(decode(planBytes), opened.root);
  files.set(PAIR_RENDER_PLAN_FILE, planBytes);
  // Hash every dependency, but retain only the small authority/snapshot set.
  // H allows large logical inventories; loading all bodies can exhaust a node.
  const dependencies = opened.root.files.filter(file => file.name !== PAIR_RENDER_PLAN_FILE);
  for (let offset = 0; offset < dependencies.length; offset += 4) {
    for await (const { file, bytes } of readReplayProofBatch(dependencies.slice(offset, offset + 4),
      async file => ({ file, bytes: await opened.readFile(file.name) }))) {
      if (hashBytes(bytes) !== file.digest) refuse();
      if (file.name === opened.root.snapshotFile || ["authority.json", PAIR_SOURCE_METADATA_FILE, "initial-controls.json"].includes(file.name)) files.set(file.name, bytes);
      if (options.sourceBodyDigests?.has(file.digest)) {
        const body = decode(bytes);
        sourceChanges.set(file.digest, {
          kind: body.kind,
          id: body.id,
          action: body.action,
          sourceVersion: body.sourceVersion,
          snapshotDigest: protocol.publicReleaseDigest(body.snapshot),
        });
      }
    }
  }
  const boundary = await prepareReplayOutputReadback({
    firestore,
    store,
    pair,
    reference,
    ordinaryPlan,
    signal,
  });
  const { plan, catalogImages, supplementalPaths, compositeManifest } = boundary;
  const entryPaths = new Set(ordinaryPlan.expectedOutputs.map((output) => output.path));
  const expectedOutputs = new Map(
    plan.expectedOutputs.map((row, index) => [row.path, { expected: row, route: plan.routes[index] }]),
  );
  const coveredRoutes = new Set<string>();
  const outputs: ReplayOutput[] = [];
  for await (const output of readPublicReleasePairReplayProofView({ store, pair, ...reference, signal })) {
    await boundary.output(output);
    const target = expectedOutputs.get(output.path);
    if (target) {
      const { expected, route } = target;
      if (output.status !== expected.status || output.headers["content-type"] !== expected.contentType)
        refuse("replay-output-coverage-missing");
      coveredRoutes.add(output.path);
      if (
        route.renderer === "withdrawal" &&
        (output.status !== 410 || output.bytes !== 0 || output.bodyDigest !== EMPTY_DIGEST)
      )
        refuse("replay-withdrawal-evidence-missing");
      if (route.renderer === "redirect") {
        const request = decode(await opened.readFile(route.inputFile));
        if (
          request.read?.kind !== "redirect" ||
          request.read.path !== route.path ||
          output.headers.location !== request.read.location
        )
          refuse("replay-redirect-evidence-missing");
      }
    } else if (!supplementalPaths.has(output.path)) refuse("replay-output-coverage-missing");
    outputs.push({
      path: output.path,
      status: output.status,
      bodyDigest: output.bodyDigest,
      bytes: output.bytes,
      headers: output.headers,
      objectKey: output.objectKey,
    });
  }
  if (coveredRoutes.size !== plan.expectedOutputs.length) refuse("replay-output-coverage-missing");
  const { renderTargetProofDigest } = await boundary.complete();
  signal?.throwIfAborted();
  const proof = await firestore.runTransaction(assertOwner, { readOnly: true });
  if (!same(before, proof)) refuse("replay-owner-changed");
  await stageReplayOutputInventory({
    firestore,
    pair,
    reference,
    cursor,
    outputs,
    renderTargetProofDigest,
    catalogImages,
    compositeManifest,
  });
  return {
    renderTargetProofDigest,
    proof,
    root: opened.root,
    plan,
    files,
    sourceChanges,
    outputs,
    routeOutputs: outputs.filter((row) => expectedOutputs.has(row.path)),
    entryRouteOutputs: outputs.filter((row) => entryPaths.has(row.path)),
    catalogImages,
    compositeManifest,
  };
}

/** Read immutable event provenance before comparing it with H. A CODE event
 * is appended by OLD but its sealed schema-two reference names the new reader.
 * Ordinary events retain their original entry-pair reader without exceptions. */
export async function assertPublicReleasePairReplayReaderSource(options: {
  firestore: Firestore; entry: PublicReleaseChange; readerSource: string;
}) {
  const entry = log.parsePublicReleaseChange(options.entry);
  return options.firestore.runTransaction(async transaction => {
    const evidence = await require("../../functions/lib/public-release-change-evidence.js")
      .assertReadPublicReleaseChangeEvidenceInTransaction({ firestore: options.firestore, transaction, entry });
    let readerSource = entry.pair.commitSha;
    const code = evidence.members.filter((member: any) => member.change.kind === "provider" &&
      member.change.id === "public-code" && member.change.action === "dependency" && member.snapshot.codeReference?.schemaVersion === 2);
    if (code.length) {
      if (code.length !== 1 || evidence.members.length !== 1) refuse("replay-member-evidence-missing");
      const snapshot = code[0].snapshot, reference = snapshot.codeReference;
      const resolved = await require("../../functions/lib/public-release-pair-code-reference.js")
        .assertPairCodeReferenceInTransaction({ firestore: options.firestore, transaction, reference });
      if (snapshot.commitSha !== resolved.pair.commitSha || snapshot.deploymentId !== resolved.pair.publicWorker.versionId)
        refuse("replay-member-evidence-missing");
      readerSource = resolved.pair.commitSha;
    }
    // Other events retain the entry-pair comparison; legacy activation
    // handovers remain isolated from this guarded-switch adapter.
    if (options.readerSource !== readerSource) refuse("replay-member-evidence-missing");
    return evidence as import("../../functions/lib/public-release-change-evidence").PublicReleaseChangeEvidence;
  }, { readOnly: true });
}

/** The historical source owner seals the mapping of each accepted member to
 * all of its owned and withdrawn paths, including aliases/shared aggregates. */
export async function verifyPublicReleasePairReplayEntry(
  options: ReadbackOptions & { entry: PublicReleaseChange },
) {
  const pair = protocol.parsePublicReleasePair(options.pair),
    entry = log.parsePublicReleaseChange(options.entry);
  const cursor = replay.parseReplayCursor(options.cursor);
  if (cursor.sequence !== entry.sequence || cursor.lastDigest !== entry.entryDigest) refuse("replay-log-gap");
  const verified = await verifyPublicReleasePairReplayView({ ...options, pair, cursor });
  const { identity } = verified.proof.reference;
  if (
    identity.sourceOperationId !== entry.operationId ||
    identity.sourceVersion !== Math.max(...entry.changes.map((change) => change.sourceVersion))
  )
    refuse();
  const authorityBytes = verified.files.get("authority.json");
  if (!authorityBytes) refuse("replay-member-evidence-missing");
  const authority = decode(authorityBytes);
  const accepted = await assertPublicReleasePairReplayReaderSource({ firestore: options.firestore, entry, readerSource: authority.readerSource });
  const inputDigests = new Set(verified.root.files.map((file) => file.digest));
  if (accepted.members.some((member) => !inputDigests.has(member.contentDigest))) refuse("replay-member-evidence-missing");
  if (
    authority.schemaVersion !== 2 ||
    !same(authority.entry, entry) ||
    !same(authority.cursor, cursor) ||
    authority.contextRevision !== entry.contextRevision ||
    authority.codeAssetManifestDigest !== pair.codeAssetManifestDigest ||
    !Array.isArray(authority.members) ||
    authority.members.length !== entry.changes.length
  )
    refuse("replay-member-evidence-missing");
  const snapshot = decode(verified.files.get(verified.root.snapshotFile)!);
  const snapshots = entry.changes.length === 1 ? [{ change: entry.changes[0], snapshot }] : snapshot;
  if (!Array.isArray(snapshots) || snapshots.length !== entry.changes.length)
    refuse("replay-member-evidence-missing");
  const available = new Map(verified.entryRouteOutputs.map((output) => [output.path, output])),
    used = new Set<string>();
  for (const [index, change] of entry.changes.entries()) {
    const frozen = exact(snapshots[index], ["change", "snapshot"]);
    if (
      !same(frozen.change, change) ||
      protocol.publicReleaseDigest(frozen.snapshot) !== change.snapshotDigest
    )
      refuse("replay-member-evidence-missing");
    const member = authorityMemberPaths(authority.members[index], authority.globalPaths, available);
    if (!same(member.change, change)) refuse("replay-member-evidence-missing");
    if (
      change.action === "withdraw" &&
      ["post", "page", "record"].includes(change.kind) &&
      !member.withdrawnPaths.length
    ) {
      refuse("replay-withdrawal-evidence-missing");
    }
    for (const path of member.paths) {
      const output = available.get(path);
      if (!output) refuse("replay-output-coverage-missing");
      if (member.withdrawnPaths.includes(path) && output.status !== 410) {
        refuse("replay-withdrawal-evidence-missing");
      }
      used.add(path);
    }
  }
  if (used.size !== verified.entryRouteOutputs.length) refuse("replay-output-coverage-missing");
  const memberContentDigests = accepted.members.map((member) => member.contentDigest);
  const membersDigest = protocol.publicReleaseDigest(
    entry.changes.map((change, index) => ({ change, contentDigest: memberContentDigests[index] })),
  );
  const coverage: ReplayCoverage = {
    entryDigest: entry.entryDigest,
    membersDigest,
    memberContentDigests,
    reference: verified.proof.reference,
    inputReceiptDigest: verified.proof.inputReceiptDigest,
    viewReceiptDigest: verified.proof.viewReceiptDigest,
    outputInventoryDigest: protocol.publicReleaseDigest(verified.outputs),
    renderTargetProofDigest: verified.renderTargetProofDigest,
  };
  return { ...verified, coverage };
}

async function retainedSelection(
  store: PairViewStore,
  pair: PublicReleasePair,
  kind: "content" | "code-pack-overlay",
  cursor: ReplayCursor,
  digest: string,
) {
  const selected = new Map<string, ReplaySelectionMember>();
  for await (const member of readPublicReleasePairReplaySelection({ store, pair, kind, cursor, digest }))
    selected.set(member.path, member);
  return selected;
}
async function createImmutableRecord(firestore: Firestore, path: string, value: unknown) {
  return firestore.runTransaction(async (transaction) => {
    const ref = firestore.doc(path),
      row = await transaction.get(ref);
    if (row.exists) {
      if (!same(row.data(), value)) refuse("replay-immutable-conflict");
      return;
    }
    transaction.create(ref, value as Record<string, unknown>);
  });
}

/** Private replay of complete pages. resolveView uses the source owner's
 * historical materializer and original private task receipts; null is pending.
 * A pending member never advances the cursor or starts accepted publication. */
export async function replayPublicReleasePairToHead({
  firestore,
  store,
  pair: rawPair,
  resolveView,
  signal,
  completedAt,
}: {
  firestore: Firestore;
  store: PairViewStore;
  pair: PublicReleasePair;
  resolveView: (entry: PublicReleaseChange, cursor: ReplayCursor) => Promise<ReplayViewReference | null>;
  signal?: AbortSignal;
  completedAt?: number;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    base = work.publicReleasePairPath(pair.pairId);
  const initialRow = await firestore.doc(replay.checkpointPath(pair)).get();
  if (!initialRow.exists) refuse("replay-baseline-missing");
  const initial = replay.parseReplayCheckpoint(initialRow.data(), pair);
  const baselineRow = await firestore.doc(`${base}/replayBaselines/${initial.pairBaselineDigest}`).get();
  const baseline = replay.parseReplayPairBaseline(baselineRow.data(), pair);
  const codePack = await verifyPublicReleasePairReplayCodePack({
    firestore,
    store,
    pair,
    reference: baseline.codePackView,
    cursor: baseline.cursor,
    signal,
    expectedBaseline: baseline,
  });
  const baselinePaths = new Map(codePack.manifest.members.map((member) => [member.path, member]));
  const capturedHead = log.parsePublicReleaseChangeHead(
    (await firestore.doc(log.PUBLIC_RELEASE_CHANGES_PATH).get()).data(),
  );
  while (true) {
    signal?.throwIfAborted();
    const checkpointRow = await firestore.doc(replay.checkpointPath(pair)).get();
    if (!checkpointRow.exists) refuse("replay-baseline-missing");
    const checkpoint = replay.parseReplayCheckpoint(checkpointRow.data(), pair);
    const fromCursor = replay.parseReplayCursor(checkpoint.cursor);
    if (
      fromCursor.baselineDigest !== capturedHead.baselineDigest ||
      fromCursor.sequence > capturedHead.sequence
    )
      refuse("replay-log-head-changed");
    if (fromCursor.sequence === capturedHead.sequence) {
      if (fromCursor.lastDigest !== capturedHead.lastDigest) refuse("replay-log-head-changed");
      return {
        status: "complete" as const,
        ...(await replay.sealPublicReleasePairReplayWitness({ firestore, pair, completedAt })),
      };
    }
    const rows = await firestore
      .collection(`${log.PUBLIC_RELEASE_CHANGES_PATH}/entries`)
      .orderBy("sequence")
      .startAfter(fromCursor.sequence)
      .endAt(capturedHead.sequence)
      .limit(replay.PAGE_LIMIT)
      .get();
    if (!rows.size) refuse("replay-log-gap");
    const entries = rows.docs.map((row) => {
      const entry = log.parsePublicReleaseChange(row.data());
      if (row.id !== String(entry.sequence).padStart(16, "0")) refuse("replay-log-gap");
      return entry;
    });
    const end = log.verifyPublicReleaseChangePage(fromCursor, entries),
      headCursor = { baselineDigest: fromCursor.baselineDigest, ...end };
    const content = await retainedSelection(store, pair, "content", fromCursor, checkpoint.contentViewDigest);
    const overlay = await retainedSelection(
      store,
      pair,
      "code-pack-overlay",
      fromCursor,
      checkpoint.codePackOverlayDigest,
    );
    const coverage: ReplayCoverage[] = [];
    for (const entry of entries) {
      const cursor = {
        baselineDigest: fromCursor.baselineDigest,
        sequence: entry.sequence,
        lastDigest: entry.entryDigest,
      };
      const reference = await resolveView(entry, cursor);
      if (!reference)
        return { status: "pending" as const, cursor: fromCursor, operationId: entry.operationId };
      const verified = await verifyPublicReleasePairReplayEntry({
        firestore,
        store,
        pair,
        reference,
        cursor,
        entry,
        signal,
      });
      coverage.push(verified.coverage);
      const selectedFeed = await firestore.runTransaction(
        (transaction) =>
          contentFeed.applyReplayContentFeedNamespace({
            firestore,
            transaction,
            pair,
            artifacts: baselinePaths,
            outputs: verified.outputs,
            reference,
            cursor,
            previous: contentFeed.baselineReplayContentFeedNamespace({
              pair,
              artifacts: baselinePaths,
              codePackView: baseline.codePackView,
              cursor: baseline.cursor,
            }),
            overlay,
          }),
        { readOnly: true },
      );
      if (selectedFeed.proof) {
        const manifest = await readPublicReleasePairClaimJson({
          store,
          pair,
          identity: reference.identity,
          claimDigest: reference.claimDigest,
          descriptor: selectedFeed.proof.descriptor,
          limit: views.BODY_BYTES_LIMIT,
          signal,
        });
        if (!same(manifest, selectedFeed.state?.manifest)) refuse("replay-content-feed-namespace-mismatch");
      }
      const namespace = await firestore.runTransaction(
        (transaction) =>
          search.applyReplaySearchNamespace({
            firestore,
            transaction,
            pair,
            artifacts: baselinePaths,
            outputs: selectedFeed.outputs,
            reference: verified.proof.reference,
            cursor,
            previous: search.baselineReplaySearchNamespace({
              pair,
              artifacts: baselinePaths,
              codePackView: baseline.codePackView,
              cursor: baseline.cursor,
            }),
            overlay,
          }),
        { readOnly: true },
      );
      if (namespace.proof) {
        const manifest = await readPublicReleasePairClaimJson({
          store,
          pair,
          identity: reference.identity,
          claimDigest: reference.claimDigest,
          descriptor: namespace.proof.descriptor,
          limit: views.BODY_BYTES_LIMIT,
          signal,
        });
        if (!same(manifest, namespace.state?.manifest)) refuse("replay-search-namespace-mismatch");
      }
      const remaining = await firestore.runTransaction(
        (transaction) =>
          inventories.applyReplayCatalogImages({
            firestore,
            transaction,
            pair,
            artifacts: baselinePaths,
            outputs: namespace.outputs,
            reference,
            cursor,
            overlay,
          }),
        { readOnly: true },
      );
      inventories.selectReplayOutputs({
        content,
        overlay,
        artifacts: baselinePaths,
        outputs: remaining,
        reference: verified.proof.reference,
        compositeVerified: Boolean(verified.compositeManifest),
      });
    }
    const sorted = (map: Map<string, ReplaySelectionMember>) =>
      [...map.values()].sort((a, b) => compareReplayPaths(a.path, b.path));
    const selected = await writePublicReleasePairReplaySelection({
      store,
      pair,
      kind: "content",
      cursor: headCursor,
      members: sorted(content),
    });
    const overlays = await writePublicReleasePairReplaySelection({
      store,
      pair,
      kind: "code-pack-overlay",
      cursor: headCursor,
      members: sorted(overlay),
    });
    await stagePublicReleasePairReplaySelection({
      firestore,
      store,
      pair,
      kind: "content",
      cursor: headCursor,
      digest: selected.digest,
    });
    await stagePublicReleasePairReplaySelection({
      firestore,
      store,
      pair,
      kind: "code-pack-overlay",
      cursor: headCursor,
      digest: overlays.digest,
    });
    const page = replay.parseReplayPage(
      {
        schemaVersion: 2,
        pairDigest: protocol.publicReleaseDigest(pair),
        fromCursor,
        headCursor,
        entries,
        coverage,
      },
      pair,
    );
    const pageDigest = protocol.publicReleaseDigest(page);
    // A crash here leaves private immutable orphans. Only the later CAS moves
    // the cursor, so retry reuses the original inputs/claims and byte objects.
    await createImmutableRecord(firestore, `${base}/replayTransitions/${pageDigest}`, {
      schemaVersion: 2,
      pairDigest: protocol.publicReleaseDigest(pair),
      fromCursor,
      headCursor,
      pageDigest,
      priorContentViewDigest: checkpoint.contentViewDigest,
      priorCodePackOverlayDigest: checkpoint.codePackOverlayDigest,
      contentViewDigest: selected.digest,
      codePackOverlayDigest: overlays.digest,
    });
    signal?.throwIfAborted();
    await replay.preparePublicReleasePairReplayPageCapsule({
      firestore,
      pair,
      page,
      contentViewDigest: selected.digest,
      codePackOverlayDigest: overlays.digest,
    });
    await replay.commitPublicReleasePairReplayPage({
      firestore,
      pair,
      page,
      contentViewDigest: selected.digest,
      codePackOverlayDigest: overlays.digest,
    });
  }
}

/** Full baseline pack readback uses the source owner's exact inventory codec.
 * The pack's digest stays fixed while later dynamic paths select overlays. */
export async function verifyPublicReleasePairReplayCodePack(
  options: ReadbackOptions & {
    expectedBaseline?: { logBaselineDigest: string; sourceInventoryDigest: string; cursor: ReplayCursor };
  },
) {
  const { firestore, store, signal } = options,
    pair = protocol.parsePublicReleasePair(options.pair);
  const reference = replay.parseReplayViewReference(options.reference, pair),
    cursor = replay.parseReplayCursor(options.cursor);
  const assertOwner = (transaction: import("firebase-admin/firestore").Transaction) =>
    replay.assertStagedReplayViewInTransaction({ firestore, transaction, pair, reference, cursor });
  const before = await firestore.runTransaction(assertOwner, { readOnly: true });
  const opened = await openPublicReleasePairInput({
    firestore,
    store,
    pair,
    identity: reference.identity,
    expectedSource: before.captured.source,
    expectedCursor: cursor,
    signal,
  });
  let manifest: ReturnType<typeof parsePublicReleasePairCodePack> | undefined;
  for (const file of opened.root.files) {
    const bytes = await opened.readFile(file.name);
    if (file.name === PAIR_CODE_PACK_FILE) manifest = parsePublicReleasePairCodePack(decode(bytes), pair);
  }
  if (!manifest) refuse("replay-code-pack-missing");
  const feedState = contentFeed.baselineReplayContentFeedNamespace({
    pair,
    artifacts: new Map(manifest.members.map((member) => [member.path, member])),
    codePackView: reference,
    cursor,
  });
  let feedIndex: ReturnType<typeof feedCodec.assertPublicReleasePairContentFeedIndex> | undefined;
  let count = 0;
  const outputs: ReplayOutput[] = [];
  let sourceInputs:
    | {
        schemaVersion: 1;
        logBaselineDigest: string;
        sourceMemberCensusDigest: string;
        baselineCursor: ReplayCursor;
      }
    | undefined;
  let sourceInputsDigest: string | undefined;
  let sourceInputBytes: Uint8Array | undefined;
  for await (const output of readPublicReleasePairView({ store, pair, ...reference, signal })) {
    const expected = manifest.members[count++];
    if (
      !expected ||
      output.path !== expected.path ||
      output.status !== 200 ||
      output.bytes !== expected.size ||
      output.bodyDigest !== expected.sha256 ||
      output.headers["content-type"] !== expected.mime
    )
      refuse("replay-code-pack-invalid");
    outputs.push({
      path: output.path,
      status: output.status,
      headers: output.headers,
      bodyDigest: output.bodyDigest,
      bytes: output.bytes,
      objectKey: output.objectKey,
    });
    if (feedState && output.path === feedCodec.PAIR_CONTENT_FEED_INDEX) {
      feedIndex = feedCodec.assertPublicReleasePairContentFeedIndex(output.body, feedState.manifest);
    } else if (feedState && output.path.startsWith(feedCodec.PAIR_CONTENT_FEED_NAMESPACE)) {
      if (!feedIndex) refuse("replay-content-feed-index-missing");
      feedCodec.assertPublicReleasePairContentFeedPage(
        output.body,
        output.path,
        feedState.manifest,
        feedIndex,
      );
    }
    if (output.path === `${PAIR_COMPILED_PREFIX}pair-source-inputs.json`) {
      const value = exact(decode(output.body), [
        "schemaVersion",
        "logBaselineDigest",
        "sourceMemberCensusDigest",
        "baselineCursor",
      ]);
      if (
        value.schemaVersion !== 1 ||
        !/^[a-f0-9]{64}$/.test(value.logBaselineDigest) ||
        !/^[a-f0-9]{64}$/.test(value.sourceMemberCensusDigest)
      ) {
        refuse("replay-code-pack-baseline-mismatch");
      }
      sourceInputs = {
        schemaVersion: 1,
        logBaselineDigest: value.logBaselineDigest,
        sourceMemberCensusDigest: value.sourceMemberCensusDigest,
        baselineCursor: replay.parseReplayCursor(value.baselineCursor),
      };
      sourceInputsDigest = output.bodyDigest;
      sourceInputBytes = new Uint8Array(output.body);
    }
  }
  if (feedState && !feedIndex) refuse("replay-content-feed-index-missing");
  if (count !== manifest.members.length || !sourceInputs || !sourceInputsDigest)
    refuse("replay-code-pack-baseline-missing");
  if (
    options.expectedBaseline &&
    (sourceInputs.logBaselineDigest !== options.expectedBaseline.logBaselineDigest ||
      sourceInputs.sourceMemberCensusDigest !== options.expectedBaseline.sourceInventoryDigest ||
      !same(sourceInputs.baselineCursor, options.expectedBaseline.cursor))
  )
    refuse("replay-code-pack-baseline-mismatch");
  const proof = await firestore.runTransaction(assertOwner, { readOnly: true });
  if (!same(before, proof)) refuse("replay-owner-changed");
  await stageReplayOutputInventory({ firestore, pair, reference, cursor, outputs });
  await stageReplayCodePackInventory({
    firestore,
    pair,
    codePackView: reference,
    manifest,
    sourceInputs,
    sourceInputsDigest,
  });
  return { manifest, proof, root: opened.root, sourceInputs, sourceInputBytes };
}

/** A pair baseline is sealed only after the entire authoritative global census,
 * all original H/G receipts and the full NEW code pack have passed readback. */
export async function initializePublicReleasePairReplayBaseline({
  firestore,
  store,
  pair: rawPair,
  logBaselineDigest,
  views: rawViews,
  codePackView: rawCodePackView,
  signal,
}: {
  firestore: Firestore;
  store: PairViewStore;
  pair: PublicReleasePair;
  logBaselineDigest: string;
  views: readonly ReplayViewReference[];
  codePackView: ReplayViewReference;
  signal?: AbortSignal;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair),
    base = work.publicReleasePairPath(pair.pairId);
  const globalBaseline = require("../../functions/lib/public-release-change-baseline.js");
  const global = await firestore.runTransaction<{
    receipt: import("../../functions/lib/public-release-change-baseline").PublicReleaseChangeBaseline;
    sourceMembers: import("../../functions/lib/public-release-change-baseline").PublicReleaseSourceMember[];
  }>(
    (transaction) =>
      globalBaseline.assertReadPublicReleaseChangeBaselineInTransaction({
        firestore,
        transaction,
        logBaselineDigest,
      }),
    { readOnly: true },
  );
  const cursor = replay.parseReplayCursor(global.receipt.baselineCursor);
  const references = rawViews.map((reference) => replay.parseReplayViewReference(reference, pair));
  const codePackView = replay.parseReplayViewReference(rawCodePackView, pair);
  if (
    !references.length ||
    references.length > 100 ||
    !Array.isArray(global.sourceMembers) ||
    protocol.publicReleaseDigest(global.sourceMembers) !== global.receipt.sourceMemberCensusDigest
  )
    refuse("replay-baseline-census-missing");
  const sourceBodyDigests = new Set(global.sourceMembers.map((member) => member.contentDigest));
  const inputBodies = new Set<string>(),
    inputReceiptDigests: string[] = [],
    viewReceiptDigests: string[] = [];
  for (const reference of references) {
    const verified = await verifyPublicReleasePairReplayView({
      firestore,
      store,
      pair,
      reference,
      cursor,
      signal,
      sourceBodyDigests,
    });
    const authorityBytes = verified.files.get("authority.json");
    if (!authorityBytes) refuse("replay-baseline-source-mismatch");
    const authority = decode(authorityBytes);
    let sourceOperationId = `baseline-${logBaselineDigest}`;
    const controlled = verified.files.get("initial-controls.json");
    if (controlled) {
      const receipt = decode(controlled);
      const actual = await firestore.runTransaction<{ controlsDigest: string }>(transaction => require("../../functions/lib/public-release-bootstrap-control-source.js")
        .assertInitialControlCaptureInTransaction({ firestore, transaction, pair, scope: reference.identity }), { readOnly: true });
      if (protocol.publicReleaseDigest(receipt) !== actual.controlsDigest) refuse("replay-baseline-source-mismatch");
      sourceOperationId = `baseline-controls-${actual.controlsDigest}`;
    }
    if (
      verified.root.source.kind !== "inventory" ||
      verified.root.source.id !== sourceOperationId ||
      reference.identity.sourceOperationId !== sourceOperationId ||
      reference.identity.snapshotDigest !== global.receipt.sourceMemberCensusDigest ||
      !same(decode(verified.files.get(verified.root.snapshotFile)!), global.sourceMembers) ||
      authority.schemaVersion !== 2 ||
      !same(authority.baseline, global.receipt) ||
      authority.logBaselineDigest !== logBaselineDigest ||
      !same(authority.cursor, cursor) ||
      !Array.isArray(authority.members) ||
      authority.members.length !== global.sourceMembers.length
    )
      refuse("replay-baseline-source-mismatch");
    const paths = new Map(verified.entryRouteOutputs.map((output) => [output.path, output])),
      covered = new Set<string>();
    for (const [index, raw] of authority.members.entries()) {
      const member = authorityMemberPaths(raw, authority.globalPaths, paths);
      const sourceChange = verified.sourceChanges.get(global.sourceMembers[index].contentDigest);
      if (!sourceChange || !same(member.change, sourceChange)) refuse("replay-baseline-source-mismatch");
      for (const path of member.paths) {
        if (!paths.has(path) || (member.withdrawnPaths.includes(path) && paths.get(path)!.status !== 410))
          refuse("replay-baseline-source-mismatch");
        covered.add(path);
      }
    }
    if (covered.size !== paths.size) refuse("replay-baseline-source-mismatch");
    for (const file of verified.root.files) inputBodies.add(file.digest);
    inputReceiptDigests.push(verified.proof.inputReceiptDigest);
    viewReceiptDigests.push(verified.proof.viewReceiptDigest);
  }
  // Bodies are independently sealed by the global census. Their presence in
  // the fully read H closure proves complete baseline input coverage.
  for (const source of global.sourceMembers) {
    if (!inputBodies.has(source.contentDigest)) refuse("replay-baseline-census-missing");
  }
  const pack = await verifyPublicReleasePairReplayCodePack({
    firestore,
    store,
    pair,
    reference: codePackView,
    cursor,
    signal,
    expectedBaseline: {
      logBaselineDigest,
      sourceInventoryDigest: global.receipt.sourceMemberCensusDigest,
      cursor,
    },
  });
  if (
    !pack.sourceInputBytes ||
    !Buffer.from(pack.sourceInputBytes).equals(
      Buffer.from(publicReleasePairSourceInputsBytes(global.receipt, logBaselineDigest)),
    )
  ) {
    refuse("replay-code-pack-baseline-mismatch");
  }
  inputReceiptDigests.push(pack.proof.inputReceiptDigest);
  viewReceiptDigests.push(pack.proof.viewReceiptDigest);
  const selections = await replay.readReplayBaselineSelectionState({
    firestore,
    pair,
    baseline: {
      views: references,
      codePackView,
      cursor,
      logBaselineDigest,
      sourceInventoryDigest: global.receipt.sourceMemberCensusDigest,
    },
  });
  const sorted = (members: Map<string, ReplaySelectionMember>) =>
    [...members.values()].sort((a, b) => compareReplayPaths(a.path, b.path));
  const content = await writePublicReleasePairReplaySelection({
    store,
    pair,
    kind: "content",
    cursor,
    members: sorted(selections.content),
  });
  const overlay = await writePublicReleasePairReplaySelection({
    store,
    pair,
    kind: "code-pack-overlay",
    cursor,
    members: sorted(selections.overlay),
  });
  await stagePublicReleasePairReplaySelection({
    firestore,
    store,
    pair,
    kind: "content",
    cursor,
    digest: content.digest,
  });
  await stagePublicReleasePairReplaySelection({
    firestore,
    store,
    pair,
    kind: "code-pack-overlay",
    cursor,
    digest: overlay.digest,
  });
  const baseline = replay.parseReplayPairBaseline(
    {
      schemaVersion: 2,
      pairDigest: protocol.publicReleaseDigest(pair),
      logBaselineDigest,
      cursor,
      sourceInventoryDigest: global.receipt.sourceMemberCensusDigest,
      codeAssetManifestDigest: pair.codeAssetManifestDigest,
      inputReceiptDigests,
      viewReceiptDigests,
      views: references,
      codePackView,
      contentViewDigest: content.digest,
      codePackOverlayDigest: overlay.digest,
    },
    pair,
  );
  const pairBaselineDigest = protocol.publicReleaseDigest(baseline);
  await createImmutableRecord(firestore, `${base}/replayBaselineReadbacks/${pairBaselineDigest}`, baseline);
  signal?.throwIfAborted();
  await replay.preparePublicReleasePairReplayBaselineCapsule({ firestore, pair, baseline });
  return replay.commitPublicReleasePairReplayBaseline({ firestore, pair, baseline });
}
