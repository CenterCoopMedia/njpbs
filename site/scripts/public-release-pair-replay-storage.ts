import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairTaskIdentity } from "../../functions/lib/public-release-pair-work";
import input from "../../functions/lib/public-release-pair-input.js";
import protocol from "../../functions/lib/public-release-pair.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";
import work from "../../functions/lib/public-release-pair-work.js";
import view from "../../functions/lib/public-release-pair-view.js";
import { openPublicReleasePairInput } from "./public-release-pair-input-storage";
import { openPublicReleasePairRenderPlans } from "./public-release-pair-render-plans";
import { PAIR_REPLAY_PROVENANCE_FILE, isPublicReleasePairProjection, parsePublicReleasePairReplayProvenance,
  parsePublicReleasePairReplayTargetReceipt, type PairReplayTargetReceipt } from "./public-release-pair-replay";
import { projectPublicReleasePairReplay } from "./public-release-pair-replay";
import { readPublicReleasePairClaimJson, writePublicReleasePairClaimJson,
  readPublicReleasePairView, openPublicReleasePairViewMetadata, type PairClaimJsonDescriptor, type PairViewStore } from "./public-release-pair-view-storage";
import { openStagedPublicReleasePairComposite } from "./public-release-pair-composite-storage";

const decode = (bytes: Uint8Array) => {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return refuse(); }
};
const exact = (value: any, keys: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")) refuse();
};
function refuse(): never { throw new work.PairExecutionError("byte-mismatch"); }
type Owner = { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; identity: PairTaskIdentity; claimDigest: string; signal?: AbortSignal };
type Member = { receipt: PairReplayTargetReceipt; bodyDigest: string; status: number };
type Root = { schemaVersion: 1; kind: "pair-render-targets"; pairDigest: string; taskId: string; claimDigest: string;
  viewManifestDigest: string; inputManifestDigest: string; pages: PairClaimJsonDescriptor[]; targetCount: number };
const claimPath = (owner: Owner) => `${work.publicReleasePairPath(owner.pair.pairId)}/replayClaims/${owner.claimDigest}`;
export const publicReleasePairReplayProofPath = (pair: PublicReleasePair, manifestDigest: string) =>
  `${work.publicReleasePairPath(pair.pairId)}/renderTargets/${manifestDigest}`;

export async function openPublicReleasePairReplayContext(owner: Pick<Owner, "firestore" | "store" | "pair" | "identity" | "signal">) {
  const scope = input.parsePublicReleasePairInputScope({ kind: owner.identity.kind, sourceOperationId: owner.identity.sourceOperationId,
    sourceVersion: owner.identity.sourceVersion, snapshotDigest: owner.identity.snapshotDigest, contextSequence: owner.identity.contextSequence });
  const authority = await owner.firestore.runTransaction(transaction => work.assertPublicReleasePairInputOwnerInTransaction({
    firestore: owner.firestore, transaction, pair: owner.pair, scope, inputManifestDigest: owner.identity.inputManifestDigest }), { readOnly: true });
  if (!authority.receipt) refuse();
  const frozen = await openPublicReleasePairInput({ ...owner, expectedSource: authority.receipt.source, expectedCursor: authority.receipt.cursor });
  const { ordinaryPlan, aggregatePlan, plan } = await openPublicReleasePairRenderPlans(frozen.root, frozen.readFile);
  const projects = plan.routes.some(route => isPublicReleasePairProjection(route.renderer));
  const provenanceFile = frozen.root.files.find(file => file.name === PAIR_REPLAY_PROVENANCE_FILE);
  if (projects && !provenanceFile) refuse();
  const provenance = provenanceFile ? parsePublicReleasePairReplayProvenance(decode(await frozen.readFile(PAIR_REPLAY_PROVENANCE_FILE))) : null;
  const context = async (route: typeof plan.routes[number]) => {
    if (!provenance || !provenanceFile) refuse();
    const file = frozen.root.files.find(file => file.name === route.inputFile);
    if (!file) refuse();
    const request = decode(await frozen.readFile(route.inputFile));
    const homeSources = typeof request?.homeSourcesFile === "string" ? decode(await frozen.readFile(request.homeSourcesFile)) : undefined;
    return { pair: owner.pair, identity: owner.identity, route, request, homeSources, readFrozenFile: frozen.readFile,
      provenance, inputDigest: file.digest, provenanceDigest: provenanceFile.digest, renderedAt: plan.renderedAt };
  };
  return { frozen, ordinaryPlan, aggregatePlan, plan, context };
}

/** Persist before completion; no attempt can replace another claim's proof. */
export async function writePublicReleasePairReplayProof(owner: Owner & {
  viewManifestDigest: string; targets: AsyncIterable<Member>;
}) {
  const pages: PairClaimJsonDescriptor[] = [];
  let pending: Member[] = [], size = 0, targetCount = 0, previous = "";
  const flush = async () => {
    if (!pending.length) return;
    pages.push(await writePublicReleasePairClaimJson({ ...owner, value: { schemaVersion: 1, index: pages.length, targets: pending }, limit: view.VIEW_PAGE_BYTES_LIMIT }));
    pending = []; size = 0;
    if (pages.length > 512) refuse();
  };
  for await (const member of owner.targets) {
    if (member.receipt.path <= previous || !/^[a-f0-9]{64}$/.test(member.bodyDigest) || ![200, 302, 308].includes(member.status)) refuse();
    previous = member.receipt.path;
    const bytes = Buffer.byteLength(JSON.stringify(member), "utf8");
    if (pending.length && (pending.length === 256 || size + bytes > view.VIEW_PAGE_BYTES_LIMIT - 1024)) await flush();
    pending.push(member); size += bytes;
    if (++targetCount > view.VIEW_OUTPUT_LIMIT) refuse();
  }
  await flush();
  const root: Root = { schemaVersion: 1, kind: "pair-render-targets", pairDigest: protocol.publicReleaseDigest(owner.pair),
    taskId: protocol.publicReleaseDigest(owner.identity), claimDigest: owner.claimDigest, viewManifestDigest: owner.viewManifestDigest,
    inputManifestDigest: owner.identity.inputManifestDigest, pages, targetCount };
  const descriptor = await writePublicReleasePairClaimJson({ ...owner, value: root, limit: view.VIEW_ROOT_BYTES_LIMIT });
  const record = { schemaVersion: 1, pairDigest: root.pairDigest, identity: owner.identity, taskId: root.taskId,
    claimDigest: owner.claimDigest, viewManifestDigest: owner.viewManifestDigest, descriptor };
  await owner.firestore.runTransaction(async transaction => {
    const base = work.publicReleasePairPath(owner.pair.pairId);
    const [task, journal, before] = await Promise.all([transaction.get(owner.firestore.doc(`${base}/work/${root.taskId}`)),
      transaction.get(owner.firestore.doc(`${base}/journals/${owner.pair.publisher.journalNamespace}`)), transaction.get(owner.firestore.doc(claimPath(owner)))]);
    const current = task.data(), job = journal.data()?.job;
    if (current?.status !== "running" || current.claimDigest !== owner.claimDigest || current.leaseUntil <= Date.now() ||
        protocol.publicReleaseDigest(current.identity) !== root.taskId || job?.taskId !== root.taskId || job.claimDigest !== owner.claimDigest ||
        job.leaseUntil !== current.leaseUntil) refuse();
    owner.signal?.throwIfAborted();
    if (before.exists) { if (protocol.publicReleaseDigest(before.data()) !== protocol.publicReleaseDigest(record)) refuse(); }
    else transaction.create(owner.firestore.doc(claimPath(owner)), record);
  });
  return record;
}

/** Prepare the exact original H targets with bounded read concurrency, then
 * compare them beside G's full byte stream. No source or G check is skipped. */
export async function preparePublicReleasePairReplayReadback(owner: Owner & { viewManifestDigest: string }) {
  const assertOwner = (transaction: Parameters<typeof work.assertPublicReleasePairCompletedReceiptInTransaction>[0]["transaction"]) =>
    work.assertPublicReleasePairCompletedReceiptInTransaction({ ...owner, transaction, taskId: protocol.publicReleaseDigest(owner.identity),
      manifestDigest: owner.viewManifestDigest });
  await owner.firestore.runTransaction(assertOwner, { readOnly: true });
  const binding = (await owner.firestore.doc(claimPath(owner)).get()).data();
  if (!binding) refuse();
  exact(binding, ["schemaVersion", "pairDigest", "identity", "taskId", "claimDigest", "viewManifestDigest", "descriptor"]);
  if (binding.schemaVersion !== 1 || binding.pairDigest !== protocol.publicReleaseDigest(owner.pair) ||
      protocol.publicReleaseDigest(binding.identity) !== protocol.publicReleaseDigest(owner.identity) || binding.taskId !== protocol.publicReleaseDigest(owner.identity) ||
      binding.claimDigest !== owner.claimDigest || binding.viewManifestDigest !== owner.viewManifestDigest) refuse();
  const root = await readPublicReleasePairClaimJson({ ...owner, descriptor: binding.descriptor, limit: view.VIEW_ROOT_BYTES_LIMIT }) as Root;
  exact(root, ["schemaVersion", "kind", "pairDigest", "taskId", "claimDigest", "viewManifestDigest", "inputManifestDigest", "pages", "targetCount"]);
  if (root.schemaVersion !== 1 || root.kind !== "pair-render-targets" || root.pairDigest !== binding.pairDigest || root.taskId !== binding.taskId ||
      root.claimDigest !== owner.claimDigest || root.viewManifestDigest !== owner.viewManifestDigest || root.inputManifestDigest !== owner.identity.inputManifestDigest ||
      !Array.isArray(root.pages) || root.pages.length > 512 || !Number.isSafeInteger(root.targetCount) || root.targetCount < 0 || root.targetCount > view.VIEW_OUTPUT_LIMIT) refuse();
  const captured = await openPublicReleasePairReplayContext(owner);
  async function* members() {
    let count = 0;
    for (let index = 0; index < root.pages.length; index++) {
      const page = await readPublicReleasePairClaimJson({ ...owner, descriptor: root.pages[index], limit: view.VIEW_PAGE_BYTES_LIMIT }) as any;
      exact(page, ["schemaVersion", "index", "targets"]);
      if (page.schemaVersion !== 1 || page.index !== index || !Array.isArray(page.targets) || !page.targets.length || page.targets.length > 256) refuse();
      for (const target of page.targets) { if (++count > root.targetCount) refuse(); yield target as Member; }
    }
    if (count !== root.targetCount) refuse();
  }
  const targets = members(); let index = 0, targetCount = 0, finished = false;
  const verified: Array<{ bodyDigest: string; status: number } | undefined> = new Array(captured.plan.routes.length);
  let batch: Array<() => Promise<void>> = [];
  const flush = async () => {
    // At most four original contexts/projections in flight. Retain only their
    // small digest/status proofs, never the projected bodies or H read buffers.
    const results = await Promise.allSettled(batch.map(read => read())); batch = [];
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };
  for (let routeIndex = 0; routeIndex < captured.plan.routes.length; routeIndex++) {
    const route = captured.plan.routes[routeIndex];
    if (!isPublicReleasePairProjection(route.renderer)) continue;
    const next = await targets.next(); if (next.done) refuse();
    const member = next.value;
    exact(member, ["receipt", "bodyDigest", "status"]);
    batch.push(async () => {
      const context = await captured.context(route);
      parsePublicReleasePairReplayTargetReceipt(member.receipt, context);
      const projected = await projectPublicReleasePairReplay(context);
      if (protocol.publicReleaseDigest(projected.receipt) !== protocol.publicReleaseDigest(member.receipt)) refuse();
      verified[routeIndex] = { bodyDigest: member.bodyDigest, status: member.status };
    });
    targetCount++; if (batch.length === 4) await flush();
  }
  await flush();
  if (!(await targets.next()).done || targetCount !== root.targetCount) refuse();
  const record = () => {
    if (!finished) refuse();
    return { ...binding, status: "staged", inputManifestDigest: owner.identity.inputManifestDigest,
      snapshotDigest: owner.identity.snapshotDigest, cursor: captured.frozen.root.cursor, targetCount };
  };
  return {
    record,
    targets: members,
    async output(output: { path: string; status: number; headers: Readonly<Record<string, string>>; bodyDigest: string }) {
      const member = verified[index], route = captured.plan.routes[index], expected = captured.plan.expectedOutputs[index++];
      if (!route || output.path !== expected.path || output.status !== expected.status || output.headers["content-type"] !== expected.contentType ||
          output.headers["x-njpbs-renderer-sha"] !== owner.pair.commitSha) refuse();
      if (isPublicReleasePairProjection(route.renderer)) {
        if (!member || member.bodyDigest !== output.bodyDigest || member.status !== output.status) refuse();
      }
    },
    async complete() {
      if (index !== captured.plan.routes.length || targetCount !== root.targetCount) refuse();
      finished = true;
    },
    async persist() {
      const proof = record();
      return owner.firestore.runTransaction(async transaction => {
        await assertOwner(transaction);
        const ref = owner.firestore.doc(publicReleasePairReplayProofPath(owner.pair, owner.viewManifestDigest));
        const [before, staged, combined] = await Promise.all([transaction.get(ref), transaction.get(owner.firestore.doc(
          `${work.publicReleasePairPath(owner.pair.pairId)}/views/${owner.viewManifestDigest}`)), transaction.get(owner.firestore.doc(
          composite.publicReleasePairCompositeProofPath(owner.pair, owner.viewManifestDigest)))]);
        const actual = staged.data();
        if (actual?.status !== "staged" || actual.claimDigest !== owner.claimDigest || actual.manifestDigest !== owner.viewManifestDigest ||
            protocol.publicReleaseDigest(actual.identity) !== protocol.publicReleaseDigest(owner.identity) ||
            protocol.publicReleaseDigest(actual.cursor) !== protocol.publicReleaseDigest(captured.frozen.root.cursor)) refuse();
        if (actual.outputCount !== captured.plan.routes.length) {
          const full = composite.parsePublicReleasePairCompositeProof(combined.data(), owner.pair, owner.identity, owner.claimDigest, owner.viewManifestDigest);
          if (full.routeCount !== captured.plan.routes.length || full.outputCount !== actual.outputCount || full.outputBytes !== actual.outputBytes ||
              full.viewReadbackDigest !== actual.readbackDigest || protocol.publicReleaseDigest(full.cursor) !== protocol.publicReleaseDigest(captured.frozen.root.cursor)) refuse();
        }
        owner.signal?.throwIfAborted();
        if (before.exists) { if (protocol.publicReleaseDigest(before.data()) !== protocol.publicReleaseDigest(proof)) refuse(); }
        else transaction.create(ref, proof);
        return proof;
      });
    },
  };
}

/** Read-only consumer seam. Recheck original H and every G byte before exposing
 * the durable dual-identity target evidence; no publication outcome is granted. */
export async function openStagedPublicReleasePairReplayTargets(owner: Owner & { viewManifestDigest: string }) {
  const verification = await preparePublicReleasePairReplayReadback(owner);
  const staged = (await owner.firestore.doc(`${work.publicReleasePairPath(owner.pair.pairId)}/views/${owner.viewManifestDigest}`).get()).data();
  if (!staged || staged.status !== "staged" || staged.claimDigest !== owner.claimDigest ||
      staged.manifestDigest !== owner.viewManifestDigest || protocol.publicReleaseDigest(staged.identity) !== protocol.publicReleaseDigest(owner.identity)) refuse();
  const meta = await openPublicReleasePairViewMetadata({ ...owner, manifestDigest: owner.viewManifestDigest, manifestBytes: staged.manifestBytes });
  const combined = meta.root.composite ? await openStagedPublicReleasePairComposite(owner) : null;
  let index = 0;
  for await (const output of readPublicReleasePairView({ ...owner, manifestDigest: owner.viewManifestDigest, manifestBytes: staged.manifestBytes })) {
    if (combined) {
      const member = combined.manifest.members[index++];
      if (!member || member.path !== output.path || member.status !== output.status || member.mime !== output.headers["content-type"] ||
          member.size !== output.bytes || member.sha256 !== output.bodyDigest) refuse();
      if (member.role !== "route") continue;
    }
    await verification.output(output);
  }
  if (combined && index !== combined.manifest.members.length) refuse();
  await verification.complete();
  const proof = (await owner.firestore.doc(publicReleasePairReplayProofPath(owner.pair, owner.viewManifestDigest)).get()).data();
  if (!proof || protocol.publicReleaseDigest(proof) !== protocol.publicReleaseDigest(verification.record())) refuse();
  await owner.firestore.runTransaction(transaction => work.assertPublicReleasePairCompletedReceiptInTransaction({
    ...owner, transaction, taskId: protocol.publicReleaseDigest(owner.identity), manifestDigest: owner.viewManifestDigest }), { readOnly: true });
  return { record: verification.record(), targets: verification.targets };
}
