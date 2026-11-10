import { afterAll, beforeAll, expect, it } from "vitest";
import { createRequire } from "node:module";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { createHistoricalPublicReleaseReader } from "../../site/scripts/public-release-pair-historical-reader";
import historical from "../../functions/lib/public-release-historical-state.js";
const require = createRequire(import.meta.url);
const home = require("../../functions/lib/no-build-page-home-code-capture.js");
const retainedCode = require("../../functions/lib/public-release-historical-code.js");
const pairCode = require("../../functions/lib/public-release-pair-code-reference.js");
const target = require("../../functions/lib/publication-target.js").publicationTarget("development");
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let state: Awaited<ReturnType<typeof historical.reconstructPublicReleaseState>>, qualifiedCode: any;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "home-code-owner", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "home-code-owner" } } } }] });
  fixture = await switchedPairFixture(isolatedFirestore("home-pair-code-owner"), await runtime.getR2Bucket("CONTENT"));
  state = await historical.reconstructPublicReleaseState({ firestore: fixture.firestore, sourceOperationId: fixture.codeOperationId });
  qualifiedCode = await retainedCode.readRetainedPublicReleaseCode({ firestore: fixture.firestore,
    descriptor: state.documents.get(retainedCode.CODE_PATH) });
}, 30_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });
const reader = (documents = structuredClone(state.documents)) => createHistoricalPublicReleaseReader({
  firestore: fixture.firestore, documents, cursor: state.cursor, renderedAt: state.renderedAt });
const capture = (firestore = reader(), code = qualifiedCode) => home.captureHistoricalPageHomeCodeSources({
  firestore, target, rendererSha: fixture.pair.commitSha, originalPair: fixture.pair, qualifiedCode: code });
const read = (firestore: ReturnType<typeof reader>, seal: object) => firestore.runTransaction(transaction =>
  home.readCapturedPageHomeCodeSourcesInTransaction({ firestore, transaction, target, rendererSha: fixture.pair.commitSha, capture: seal }), { readOnly: true });
it("captures the complete selected CODE H through real sealed publication and guarded event authority", async () => {
  const captured = await fixture.captureCode();
  expect(captured.root.scope).toMatchObject({ kind: "recovery", sourceOperationId: fixture.codeOperationId });
  expect(captured.root.files.some(file => file.name === "aggregate-render-plan.json")).toBe(true);
});

it("reads only the sealed pair publication when the historical legacy CMS context is absent", async () => {
  const firestore = reader();
  expect((await firestore.doc(`cmsPreviewPublicContexts/${qualifiedCode.publication.buildBatchId}`).get()).exists).toBe(false);
  const seal = await capture(firestore), result = await read(firestore, seal);
  expect(result.homeSources).toEqual(qualifiedCode.publicContext.homeSources);
  expect(result.codeSource).toEqual(qualifiedCode.reference);
});

it.each(["missing-publication", "publication-digest", "foreign-pair", "generation", "qualified-dto", "unsupported-reference"])(
  "refuses %s without consulting a matching legacy context", async mode => {
    const documents = structuredClone(state.documents), code = structuredClone(qualifiedCode);
    const descriptor = documents.get(retainedCode.CODE_PATH);
    // A plausible legacy row must never become a fallback for schema two.
    documents.set(`cmsPreviewPublicContexts/${code.publication.buildBatchId}`, code.reference.manifest);
    const ref = fixture.firestore.doc(pairCode.pairCodePublicationPath(fixture.pair)), publication = (await ref.get()).data()!;
    try {
      if (mode === "missing-publication") await ref.delete();
      if (mode === "publication-digest") descriptor.reference.publicationDigest = "f".repeat(64);
      if (mode === "foreign-pair") descriptor.pair = { ...descriptor.pair, pairId: fixture.sourcePair.pairId };
      if (mode === "generation") {
        code.publication.generation++; code.reference.publication.generation = code.publication.generation;
        code.publicContext.receipt.generation = code.publication.generation;
        expect(() => retainedCode.verifyPublicReleaseQualifiedCode(code)).not.toThrow();
      }
      if (mode === "qualified-dto") code.publicContext.homeSources.spotlight.checkedAt = "2026-10-12T11:00:00.000Z";
      if (mode === "unsupported-reference") descriptor.reference.kind = "legacy";
      await expect(capture(reader(documents), code)).rejects.toThrow();
    } finally { if (mode === "missing-publication") await ref.set(publication); }
  });

it("rechecks the immutable publication on every final read", async () => {
  const firestore = reader(), seal = await capture(firestore);
  const ref = fixture.firestore.doc(pairCode.pairCodePublicationPath(fixture.pair)), publication = (await ref.get()).data()!;
  try {
    await ref.update({ "historicalCode.qualifiedCodeDigest": "f".repeat(64) });
    await expect(read(firestore, seal)).rejects.toThrow();
  } finally { await ref.set(publication); }
});
