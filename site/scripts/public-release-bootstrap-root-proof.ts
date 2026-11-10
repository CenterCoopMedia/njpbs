import type { PublicReleasePair, PublicReleaseSelector } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import { ROOT_RECEIPT_PATH, originFor, canonicalReleaseValue } from "../../packages/content-core/src/public-release-routing";
import { bytesDigest, exact, readBoundedBody } from "./public-release-pair-reader-contract";

function refuse(): never { throw new Error("Canonical bootstrap root was refused"); }
/** Ordinary public GET exercises the deployed router.fetch root owner. The
 * URL is derived only from the validated pair environment, never caller input. */
export async function readCanonicalBootstrapRoot({ pair: rawPair, selector: rawSelector, request = fetch, signal }: {
  pair: PublicReleasePair; selector: PublicReleaseSelector; request?: typeof fetch; signal: AbortSignal;
}) {
  const pair = protocol.parsePublicReleasePair(rawPair), selector = protocol.parsePublicReleaseSelector(rawSelector);
  if (selector.epoch !== 1 || protocol.publicReleaseDigest(selector.selectedPair) !== protocol.publicReleaseDigest(protocol.publicReleasePairReference(pair))) refuse();
  const expected = { schemaVersion: 2, environment: pair.environment, epoch: selector.epoch, pair: selector.selectedPair,
    codeReceiptDigest: pair.codeAssetManifestDigest, contentHead: selector.contentHead, selectorDigest: protocol.publicReleaseDigest(selector) };
  signal.throwIfAborted();
  const response = await request(`${originFor(pair.environment)}${ROOT_RECEIPT_PATH}`, { method: "GET", redirect: "error", cache: "no-store",
    headers: { accept: "application/json" }, signal });
  try {
    if (response.status !== 200 || response.redirected || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
        response.headers.get("x-njpbs-publication-origin") !== (pair.environment === "production" ? "njpbs-production" : "template-dev-public") ||
        !response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "no-store") ||
        response.headers.get("publication-refresh") === "pending" || response.headers.get("x-njpbs-publication-refresh") === "pending" ||
        Number(response.headers.get("content-length")) > 64 * 1024) refuse();
    const bytes = await readBoundedBody(response.body ?? new ReadableStream({ start(controller) { controller.close(); } }), 64 * 1024, signal);
    signal.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = exact(JSON.parse(text), ["schemaVersion", "environment", "epoch", "pair", "codeReceiptDigest", "contentHead", "selectorDigest"]);
    if (protocol.publicReleaseDigest(value) !== protocol.publicReleaseDigest(expected) || text !== canonicalReleaseValue(expected)) refuse();
    return Object.freeze({ selectorDigest: expected.selectorDigest, rootDigest: bytesDigest(bytes), bytes: bytes.byteLength });
  } finally { await response.body?.cancel().catch(() => {}); }
}
