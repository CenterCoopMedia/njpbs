import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import code from "../../functions/lib/public-release-pair-code-reference.js";
import { openFrozenPublicReleasePairCodePack, publicReleasePairCodePackBaselinePath } from "./public-release-pair-code-pack-storage";
import type { PairViewStore } from "./public-release-pair-view-storage";
import { readPrivateContextBytes, assertContextMatchesPublication } from "../src/lib/retained-public-context";
const historical = createRequire(import.meta.url)("../../functions/lib/public-release-historical-code.js");

/** Resolve the original sealed pack, hash the actual publication bytes and
 * persist their create-only binding. No live CODE request/latest lookup. */
export async function sealPublicReleasePairCodePublication(options: { firestore: Firestore; store: PairViewStore; pair: PublicReleasePair;
  publicContextPath: string; signal?: AbortSignal }) {
  const pair = protocol.parsePublicReleasePair(options.pair);
  work.assertPublicReleasePairDatabase(options.firestore, pair);
  const opened = await openFrozenPublicReleasePairCodePack({ ...options, pair });
  const bytes = await opened.readMember("/_publication.json");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const member = opened.manifest.members.find(member => member.path === "/_publication.json");
  const publication = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!member || member.sha256 !== digest || member.size !== bytes.length || publication.commitSha !== pair.commitSha) throw new protocol.PublicReleaseProtocolError();
  // The retained public context is private build output, outside the public
  // artifact. Bind its actual bytes to this pack's actual publication receipt;
  // neither OLD's CODE nor an invented empty context can stand in for it.
  const contextBytes = await readPrivateContextBytes(options.publicContextPath);
  options.signal?.throwIfAborted();
  assertContextMatchesPublication(JSON.parse(contextBytes.toString("utf8")), publication);
  const contextDigest = createHash("sha256").update(contextBytes).digest("hex");
  const legacyReference = { publication, manifest: { schemaVersion: 1, buildBatchId: publication.buildBatchId,
    artifactReceiptDigest: publication.artifactReceiptDigest, sha256: contextDigest, byteLength: contextBytes.length,
    key: `public-context/${publication.buildBatchId}/${contextDigest}.json` } };
  const qualified = createRequire(import.meta.url)("../../functions/lib/home-retained-sources.js")
    .qualifyHistoricalCodeContext({ reference: legacyReference, bytes: contextBytes });
  const retained = historical.prepareRetainedPublicReleaseCode(qualified);
  const reference = code.parsePairCodeReference({ schemaVersion: 2, kind: "pair", side: protocol.publicReleasePairReference(pair),
    commitSha: pair.commitSha, codeAssetManifestDigest: pair.codeAssetManifestDigest, publicationDigest: digest });
  const receipt = code.parsePairCodePublication({ schemaVersion: 2, kind: "pair-code-publication", pairDigest: protocol.publicReleaseDigest(pair),
    baselineDigest: protocol.publicReleaseDigest(opened.receipt), codePackManifestDigest: opened.receipt.codePackManifestDigest,
    reference, historicalCode: retained.descriptor }, pair);
  return options.firestore.runTransaction(async transaction => {
    const ref = options.firestore.doc(code.pairCodePublicationPath(pair));
    const [stored, baseline] = await transaction.getAll(ref, options.firestore.doc(publicReleasePairCodePackBaselinePath(pair)));
    const chunks = await transaction.getAll(...retained.chunks.map((chunk: { digest: string }) => options.firestore.doc(`${historical.CHUNKS}/${chunk.digest}`)));
    if (protocol.publicReleaseDigest(baseline.data()) !== receipt.baselineDigest) throw new protocol.PublicReleaseProtocolError();
    chunks.forEach((row, index) => {
      if (row.exists && protocol.publicReleaseDigest(row.data()) !== protocol.publicReleaseDigest(retained.chunks[index].value)) throw new protocol.PublicReleaseProtocolError();
    });
    if (stored.exists) {
      if (protocol.publicReleaseDigest(code.parsePairCodePublication(stored.data(), pair)) !== protocol.publicReleaseDigest(receipt)) throw new protocol.PublicReleaseProtocolError();
      return { idempotent: true, reference };
    }
    retained.chunks.forEach((chunk: { value: unknown }, index: number) => { if (!chunks[index].exists) transaction.create(chunks[index].ref, chunk.value); });
    transaction.create(ref, receipt); return { idempotent: false, reference };
  });
}
