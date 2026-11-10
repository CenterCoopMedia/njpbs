import { createRequire } from "node:module";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import type { PairRouteReceipt } from "../../functions/lib/public-release-serving.js";
import { originFor } from "../../packages/content-core/src/public-release-routing";
import { isPublicPairRequestPath, readPublicReleasePairOutput } from "../../workers/src/public-release-view-reader";
import { readQualificationEvidence, type QualificationEvidence } from "./public-release-pair-qualification-evidence";
import { parseQualificationReceipt, qualificationReceiptPath } from "./public-release-pair-qualification-receipt";
import { verifyStoredQualificationEvidence } from "./public-release-pair-qualification";
import { QUALIFICATION_ROUTE_LIMIT } from "./public-release-pair-qualification-authority";
import { readCanonicalBootstrapRoot } from "./public-release-bootstrap-root-proof";
import { bytesDigest, readBoundedBody, withinReaderDeadline } from "./public-release-pair-reader-contract";
import type { PairViewStore } from "./public-release-pair-view-storage";

const hash = protocol.publicReleaseDigest, same = (a: unknown, b: unknown) => hash(a) === hash(b);
const { readCurrentPairRouteInTransaction } = createRequire(import.meta.url)("../../functions/lib/public-release-serving.js") as {
  readCurrentPairRouteInTransaction(input: { firestore: Firestore; transaction: Transaction; path: string }): Promise<PairRouteReceipt>;
};
function refuse(): never { throw new Error("Bootstrap canonical readiness proof was refused"); }
export type PreparedBootstrapIngress = Readonly<{ kind: "fenced-bootstrap-readiness"; pairId: string; selectorDigest: string; qualificationDigest: string;
  rosterDigest: string; rootProofDigest: string; outputCount: number }>;
type Data = { firestore: Firestore; pairDigest: string; selectorDigest: string; at: number; clock(): number;
  signal: AbortSignal; evidence: readonly unknown[]; roots: readonly unknown[] };
const prepared = new WeakMap<PreparedBootstrapIngress, Data>();

/** Readiness only under the first-install fence. This grants no publication
 * terminal success or source-ownership certificate; those retain ingress.prove.
 * The paused source, exact qualified H/G bytes, identical public roots and final
 * transaction guards make an ordinary GET sufficient for this boundary only. */
export async function prepareBootstrapIngressProof(input: Parameters<typeof prepareReadiness>[0]): Promise<PreparedBootstrapIngress> {
  const { signal } = input;
  const store: PairViewStore = {
    async get(key) {
      signal.throwIfAborted();
      const object = await withinReaderDeadline(signal, async () => {
        const value = await input.store.get(key);
        if (signal.aborted) { void value?.body.cancel().catch(() => {}); signal.throwIfAborted(); }
        return value;
      });
      if (!object) return null;
      let body: ReadableStream<Uint8Array> | undefined;
      // Keep size/metadata checks in their original order. The stream is
      // connected lazily, and native pipe cancellation closes stalled bodies.
      return { get size() { return object.size; }, get customMetadata() { return object.customMetadata; },
        get body() { return body ??= object.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }); } };
    },
    async put() { return refuse(); },
  };
  return withinReaderDeadline(signal, () => prepareReadiness({ ...input, store }));
}

async function prepareReadiness({ firestore, store, pair: rawPair, selector: rawSelector,
  qualification, request = fetch, signal, clock = Date.now }: {
  firestore: Firestore; store: PairViewStore; pair: PublicReleasePair; selector: PublicReleaseSelector;
  qualification: { qualificationId: string; receiptDigest: string }; request?: typeof fetch; signal: AbortSignal; clock?: () => number;
}): Promise<PreparedBootstrapIngress> {
  const pair = protocol.parsePublicReleasePair(rawPair), selector = protocol.parsePublicReleaseSelector(rawSelector);
  signal.throwIfAborted();
  work.assertPublicReleasePairDatabase(firestore, pair);
  if (selector.epoch !== 1 || !same(selector.selectedPair, protocol.publicReleasePairReference(pair))) refuse();
  const receipt = parseQualificationReceipt((await firestore.doc(qualificationReceiptPath(pair, qualification.qualificationId)).get()).data(), pair);
  signal.throwIfAborted();
  if (hash(receipt) !== qualification.receiptDigest || receipt.witnessDigest !== selector.contentHead.viewId ||
      receipt.contentViewDigest !== selector.contentHead.manifestDigest) refuse();
  const head = log.parsePublicReleaseChangeHead((await firestore.doc("system/publicReleaseChanges").get()).data());
  signal.throwIfAborted();
  const witness = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair,
    headCursor: { baselineDigest: head.baselineDigest, sequence: head.sequence, lastDigest: head.lastDigest }, witnessDigest: receipt.witnessDigest });
  signal.throwIfAborted();
  const verified = await verifyStoredQualificationEvidence({ firestore, store, pair, receipt, witness: witness.witness,
    namespaces: witness.namespaces, signal });
  signal.throwIfAborted();
  const views = new Map(verified.selectedViews.map(reference => [hash({ manifestDigest: reference.manifestDigest,
    claimDigest: reference.claimDigest, inputManifestDigest: reference.identity.inputManifestDigest }), reference]));
  const firstRoot = await readCanonicalBootstrapRoot({ pair, selector, request, signal });
  const roster = new Map<string, QualificationEvidence[]>();
  for await (const member of readQualificationEvidence({ store, pair, qualificationId: receipt.qualificationId,
    witnessDigest: receipt.witnessDigest, ...receipt.evidence, signal })) {
    if (!isPublicPairRequestPath(member.path) || member.path.startsWith("/_pair-")) continue;
    const existing = roster.get(member.path) ?? []; existing.push(member); roster.set(member.path, existing);
    if (roster.size > QUALIFICATION_ROUTE_LIMIT) refuse();
  }
  if (!roster.size) refuse();
  const evidence: unknown[] = [], ordered = [...roster].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const prove = async ([path, members]: [string, QualificationEvidence[]]) => {
    const refuse: (condition: string) => never = condition => { throw new Error(`Bootstrap readiness refused ${path}: ${condition}`); };
    let expected: { status: number; bodyDigest: string; bytes: number; mime: string | null; location: string | null } | undefined;
    const route = members.some(member => member.kind !== "absence" && member.status !== 200)
      ? await withinReaderDeadline(signal, () => firestore.runTransaction(transaction =>
        readCurrentPairRouteInTransaction({ firestore, transaction, path }), { readOnly: true }))
        .catch(() => { signal.throwIfAborted(); return refuse("current route read failed"); }) : undefined;
    for (const member of members) {
      let candidate: NonNullable<typeof expected>;
      if (member.kind === "absence") candidate = { status: 404, bodyDigest: bytesDigest(new Uint8Array()), bytes: 0, mime: null, location: null };
      else {
        const reference = views.get(hash({ manifestDigest: member.manifestDigest, claimDigest: member.claimDigest, inputManifestDigest: member.inputManifestDigest }));
        if (!reference) refuse("qualified view reference is missing");
        const output = await readPublicReleasePairOutput({ store, pair, locator: { pairDigest: hash(pair), ...reference }, path })
          .catch(() => { signal.throwIfAborted(); return refuse("qualified stored output read failed"); });
        if (!output) refuse("qualified stored output is missing");
        if (output.status !== member.status) refuse("qualified stored status differs");
        if (output.bodyDigest !== member.bodyDigest) refuse("qualified stored digest differs");
        if (output.bytes !== member.bytes) refuse("qualified stored byte count differs");
        // Owned aliases/tombstones use the slot's empty, MIME-free response;
        // owner-less static redirects retain their qualified G headers. The
        // final source guard binds the current owner used for that distinction.
        if (member.status !== 200 && (member.bytes !== 0 || member.bodyDigest !== bytesDigest(new Uint8Array()))) refuse("qualified redirect/tombstone body is not empty");
        if (route && route.kind !== "unowned" && (route.kind !== (member.status === 302 ? "serve" : member.status === 308 ? "redirect" : "gone") ||
            member.status === 308 && route.canonicalPath !== output.headers.location)) refuse("current route ownership differs");
        candidate = { status: member.status, bodyDigest: member.bodyDigest, bytes: member.bytes,
          mime: route && route.kind !== "unowned" && member.status !== 302 ? null : output.headers["content-type"] ?? null,
          location: [302, 308].includes(member.status) ? output.headers.location ?? null : null };
      }
      if (expected && !same(expected, candidate)) refuse("qualification entries disagree"); expected = candidate;
    }
    if (!expected) refuse("qualified expectation is missing"); signal.throwIfAborted();
    const response = await request(`${originFor(pair.environment)}${path}`, { method: "GET", redirect: "manual", cache: "no-store",
      headers: { "accept-encoding": "identity" }, signal })
      .catch(() => { signal.throwIfAborted(); return refuse("public HTTP request failed"); });
    try {
      const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if (response.status !== expected.status) refuse("HTTP status differs");
      if (response.redirected) refuse("HTTP redirect was followed");
      if (response.headers.get("content-type") !== expected.mime) refuse("HTTP MIME differs");
      if (response.headers.get("location") !== expected.location) refuse("HTTP redirect target differs");
      if (expected.status === 302 && response.headers.get("x-robots-tag") !== "noindex, nofollow") refuse("HTTP redirect robots policy differs");
      if (!response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store")) refuse("HTTP cache-control lacks no-store");
      if (response.headers.get("publication-refresh") === "pending" || response.headers.get("x-njpbs-publication-refresh") === "pending") refuse("HTTP response is recovery-pending");
      if ((!encoding || encoding === "identity") && Number(response.headers.get("content-length")) > expected.bytes) refuse("identity Content-Length exceeds qualified bytes");
      let bytes: Uint8Array;
      try { bytes = await readBoundedBody(response.body ?? new ReadableStream({ start(controller) { controller.close(); } }), expected.bytes, signal); }
      catch { signal.throwIfAborted(); return refuse("decoded HTTP body read failed or exceeded qualified size"); }
      if (bytes.length !== expected.bytes) refuse("decoded HTTP byte count differs");
      if (bytesDigest(bytes) !== expected.bodyDigest) refuse("decoded HTTP digest differs");
      return { path, ...expected };
    } finally { await response.body?.cancel().catch(() => {}); }
  };
  for (let offset = 0; offset < ordered.length; offset += 4) {
    const results = await Promise.allSettled(ordered.slice(offset, offset + 4).map(prove));
    for (const result of results) { if (result.status === "rejected") throw result.reason; evidence.push(result.value); }
  }
  const secondRoot = await readCanonicalBootstrapRoot({ pair, selector, request, signal });
  signal.throwIfAborted();
  if (!same(firstRoot, secondRoot)) refuse();
  const at = clock(); if (!Number.isFinite(at)) refuse();
  const roots = Object.freeze([firstRoot, secondRoot]);
  const proof = Object.freeze({ kind: "fenced-bootstrap-readiness" as const, pairId: pair.pairId, selectorDigest: hash(selector), qualificationDigest: qualification.receiptDigest,
    rosterDigest: hash(evidence), rootProofDigest: hash(roots), outputCount: evidence.length });
  prepared.set(proof, { firestore, pairDigest: hash(pair), selectorDigest: hash(selector), at, clock, signal, evidence: Object.freeze(evidence), roots });
  return proof;
}

export function assertPreparedBootstrapIngress({ firestore, pair, selector, proof }: {
  firestore: Firestore; pair: PublicReleasePair; selector: PublicReleaseSelector; proof: PreparedBootstrapIngress;
}) {
  const data = prepared.get(proof), now = data?.clock();
  if (!data || data.firestore !== firestore || data.pairDigest !== hash(pair) || data.selectorDigest !== hash(selector) ||
      now === undefined || !Number.isFinite(now) || now < data.at || now - data.at > 60_000) refuse();
  data.signal.throwIfAborted(); return { roots: data.roots, roster: data.evidence };
}
