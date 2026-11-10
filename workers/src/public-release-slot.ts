import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairServingDecision } from "../../functions/lib/public-release-serving";
import type { PairProofEvidence, PublicSlot, SlotReply } from "./public-release-router";
import { bytesDigest, canonicalReleaseValue, matchesSelectedPair, originFor, responseCacheKey, stripInternalHeaders, type SelectorReceipt } from "../../packages/content-core/src/public-release-routing";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { readBoundedPairObject, readPublicReleasePairOutput, verifyPairRouteTarget, isPublicPairRequestPath, type PairReadStore } from "./public-release-view-reader";
import protocol from "../../functions/lib/public-release-pair.js";
import inputs from "../../functions/lib/public-release-pair-input.js";
import views from "../../functions/lib/public-release-pair-view.js";
import composite from "../../functions/lib/public-release-pair-composite-view.js";

type Decision = PairServingDecision | { kind: "reselect" };
const miss = (): SlotReply => ({ kind: "reselect" });
const fail = (): never => { throw new Error("Private public slot is unavailable"); };
/** Unowned frames and aggregates have no route owner. Private confirmation
 * instead requires the exact selected output's complete manifest and original
 * H identity. Reading an arbitrary G body or caller-supplied digest is insufficient. */
async function unownedProof(pair: PublicReleasePair, store: PairReadStore, decision: PairServingDecision,
  output: NonNullable<Awaited<ReturnType<typeof readPublicReleasePairOutput>>>): Promise<PairProofEvidence> {
  const locator = decision.locator, identity = views.parseViewIdentity(locator.identity, pair);
  const pairDigest = protocol.publicReleaseDigest(pair), same = (a: unknown, b: unknown) => canonicalReleaseValue(a) === canonicalReleaseValue(b);
  if (locator.pairDigest !== pairDigest || decision.pairId !== pair.pairId || decision.route.kind !== "unowned") fail();
  const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const frozen = inputs.parsePublicReleasePairInputRoot(decode(await readBoundedPairObject(store,
    inputs.publicReleasePairInputRootKey(pair, identity.inputManifestDigest), inputs.INPUT_ROOT_BYTES_LIMIT,
    { schemaversion: "2", pairdigest: pairDigest, bodydigest: identity.inputManifestDigest })), pair);
  if (!same(frozen.scope, { kind: identity.kind, sourceOperationId: identity.sourceOperationId, sourceVersion: identity.sourceVersion,
    snapshotDigest: identity.snapshotDigest, contextSequence: identity.contextSequence }) || frozen.cursor.sequence !== identity.contextSequence ||
      frozen.cursor.sequence > decision.contentHead.contextSequence) fail();
  const prefix = views.publicReleasePairViewPrefix(pair, identity, locator.claimDigest);
  const metadata = (bodydigest: string) => ({ schemaversion: "2", pairdigest: pairDigest,
    taskid: protocol.publicReleaseDigest(identity), claimdigest: locator.claimDigest, bodydigest });
  const root = views.parsePublicReleasePairViewRoot(decode(await readBoundedPairObject(store,
    `${prefix}views/${locator.manifestDigest}.json`, views.VIEW_ROOT_BYTES_LIMIT, metadata(locator.manifestDigest), locator.manifestBytes)), pair);
  const link = root.composite;
  if (!link) return fail();
  if (!same(root.identity, identity) || root.claimDigest !== locator.claimDigest || !same(root.cursor, frozen.cursor)) fail();
  const descriptor = link.descriptor;
  const manifest = composite.parsePublicReleasePairCompositeManifest(decode(await readBoundedPairObject(store, descriptor.key,
    views.BODY_BYTES_LIMIT, metadata(descriptor.digest), descriptor.bytes)), pair, identity, frozen.cursor);
  if (descriptor.key !== views.publicReleasePairViewObjectKey(pair, identity, locator.claimDigest, descriptor.digest) ||
      link.memberCount !== manifest.members.length || link.memberBytes !== manifest.members.reduce((sum, member) => sum + member.size, 0) ||
      manifest.authority.sourceDependencyDigest !== protocol.publicReleaseDigest(frozen.files.map(file => ({ name: file.name, digest: file.digest, bytes: file.bytes })))) fail();
  const path = decision.composition?.artifactPath ?? decision.path, member = manifest.members.find(value => value.path === path);
  if (!member || output.path !== path || member.status !== output.status || member.sha256 !== output.bodyDigest ||
      member.size !== output.bytes || member.mime !== output.headers["content-type"] ||
      await bytesDigest(output.body) !== member.sha256) fail();
  return { epoch: decision.epoch, pairId: pair.pairId, manifestDigest: decision.contentHead.manifestDigest,
    operationId: frozen.scope.sourceOperationId, sourceVersion: frozen.scope.sourceVersion, snapshotDigest: frozen.scope.snapshotDigest,
    rendererSha: pair.commitSha, bodyDigest: output.bodyDigest };
}
const none = (status: number, headers?: HeadersInit) => {
  const safe = new Headers({ ...SECURITY_HEADER_BASELINE, "cache-control": "no-store" });
  new Headers(headers).forEach((value, name) => safe.set(name, value));
  return new Response(null, { status, headers: safe });
};
function httpResponse(request: Request, bytes: Uint8Array, status: number, rawHeaders: Record<string, string>): Response {
  const headers = stripInternalHeaders(new Headers(rawHeaders));
  for (const [name, value] of Object.entries(SECURITY_HEADER_BASELINE)) if (!headers.has(name)) headers.set(name, value);
  headers.set("cache-control", "no-store");
  if (status !== 200) return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { status, headers });
  const etag = `"${rawHeaders["x-njpbs-html-sha256"]}"`;
  headers.set("etag", etag); headers.set("accept-ranges", "bytes");
  const matches = (value: string | null, weak = false) => value?.split(",").some(tag => tag.trim() === "*" || (weak ? tag.trim().replace(/^W\//, "") : tag.trim()) === etag);
  if (request.headers.has("if-match") && !matches(request.headers.get("if-match"))) return none(412, headers);
  if (matches(request.headers.get("if-none-match"), true)) return none(304, headers);
  const range = request.headers.get("range"), ifRange = request.headers.get("if-range");
  if (request.method === "GET" && range && (!ifRange || ifRange === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      const suffix = !match[1], length = bytes.length;
      const start = suffix ? Math.max(0, length - Number(match[2])) : Number(match[1]);
      const end = suffix || !match[2] ? length - 1 : Math.min(length - 1, Number(match[2]));
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length) {
        headers.set("content-range", `bytes */${length}`); return none(416, headers);
      }
      headers.set("content-range", `bytes ${start}-${end}/${length}`); headers.set("content-length", String(end - start + 1));
      return new Response(bytes.slice(start, end + 1), { status: 206, headers });
    }
  }
  headers.set("content-length", String(bytes.length));
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), { status, headers });
}

export function createPublicReleaseSlot({ pair, workerVersionId, store, getDecision, cache }: {
  pair: PublicReleasePair; workerVersionId: string; store: PairReadStore;
  getDecision(selection: SelectorReceipt, path: string, budgetMs?: number): Promise<Decision>;
  cache?: Pick<Cache, "match" | "put">;
}): PublicSlot {
  return { identity: pair,
    async serve(request, selection, proof = false, budgetMs = 3_000) {
      if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_000) fail();
      const deadline = performance.now() + budgetMs;
      if (workerVersionId !== pair.publicWorker.versionId || !matchesSelectedPair(pair, selection) ||
          new URL(request.url).origin !== originFor(pair.environment) || !["GET", "HEAD"].includes(request.method)) fail();
      let path: string;
      try { path = decodeURI(new URL(request.url).pathname); } catch { return { kind: "response", response: none(404) }; }
      if (!isPublicPairRequestPath(path)) return { kind: "response", response: none(404) };
      const decide = () => {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) fail();
        return getDecision(selection, path, remaining);
      };
      const before = await decide();
      if (before.kind === "reselect") return miss();
      if (before.pairId !== pair.pairId || before.epoch !== selection.selector.epoch || before.path !== path ||
          before.contentHead.pairId !== pair.pairId || before.locator.manifestDigest !== before.contentHead.manifestDigest && before.composition?.witnessDigest !== before.contentHead.viewId) fail();
      let unownedEvidence: PairProofEvidence | undefined;
      const evidenceFor = (bodyDigest: string): PairProofEvidence | undefined => before.route.kind !== "unowned" ? {
        epoch: before.epoch, pairId: pair.pairId, manifestDigest: before.contentHead.manifestDigest,
        operationId: before.route.operationId, sourceVersion: before.route.sourceVersion, snapshotDigest: before.route.snapshotDigest,
        rendererSha: pair.commitSha, bodyDigest } : unownedEvidence?.bodyDigest === bodyDigest ? unownedEvidence : undefined;
      // Tombstones/aliases are current decisions, never cached old bodies.
      if (before.route.kind === "gone" || before.route.kind === "redirect") {
        const after = await decide();
        if (after.kind !== "decision" || before.authorityDigest !== after.authorityDigest) return miss();
        return { kind: "response", response: none(before.route.kind === "gone" ? 410 : 308, {
          ...(before.route.kind === "redirect" ? { location: before.route.canonicalPath } : {}), "cache-control": "no-store" }),
          evidence: evidenceFor(await bytesDigest(new Uint8Array())) };
      }
      const output = before.composition?.absent ? null : await readPublicReleasePairOutput({ store, pair, locator: before.locator,
        path: before.composition?.artifactPath ?? path });
      if (before.composition?.expectedBodyDigest && (!output || output.bodyDigest !== before.composition.expectedBodyDigest)) fail();
      if (!output) {
        const after = await decide();
        if (after.kind !== "decision" || before.authorityDigest !== after.authorityDigest) return miss();
        return before.route.kind === "unowned" ? { kind: "response", response: none(404, { "cache-control": "no-store" }) } : miss();
      }
      let proofOutput = output;
      if (before.route.kind === "serve" && before.composition?.proofLocator) {
        const current = await readPublicReleasePairOutput({ store, pair, locator: before.composition.proofLocator, path });
        if (!current || current.status !== output.status || current.headers["content-type"] !== output.headers["content-type"] ||
            current.bytes !== output.bytes || current.bodyDigest !== output.bodyDigest || current.body.length !== output.body.length ||
            canonicalReleaseValue(Object.fromEntries(stripInternalHeaders(new Headers(current.headers)))) !==
              canonicalReleaseValue(Object.fromEntries(stripInternalHeaders(new Headers(output.headers)))) ||
            !current.body.every((byte, index) => byte === output.body[index])) return miss();
        proofOutput = current;
      }
      if (before.route.kind === "serve" && (![200, 302].includes(proofOutput.status) ||
          !await verifyPairRouteTarget({ store, pair, decision: before, output: proofOutput }))) return miss();
      if (proof === true && before.route.kind === "unowned") unownedEvidence = await unownedProof(pair, store, before, output).catch(() => undefined);
      const currentSelection = { ...selection, selector: { ...selection.selector, contentHead: before.contentHead } };
      const key = new Request(`https://pair-response.invalid/v2/${await responseCacheKey(currentSelection, request)}/${before.authorityDigest}`);
      let bytes = output.body;
      const cached = await cache?.match(key).catch(() => undefined);
      if (cached) {
        const body = new Uint8Array(await cached.arrayBuffer());
        if (body.length !== output.bytes || await bytesDigest(body) !== output.bodyDigest) fail();
        bytes = body;
      }
      if (cache && !cached) await cache.put(key, new Response(new Uint8Array(bytes), { headers: { "cache-control": "public, max-age=60" } })).catch(() => {});
      // Current ownership, withdrawal, context and head are rechecked after I/O,
      // including cache hits and negative/static decisions.
      const after = await decide();
      if (after.kind !== "decision" || before.authorityDigest !== after.authorityDigest) return miss();
      const response = httpResponse(request, bytes, output.status, { ...output.headers, "x-njpbs-html-sha256": output.bodyDigest });
      return { kind: "response", response, evidence: evidenceFor(output.bodyDigest) };
    },
  };
}
