import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

import switches from "../../functions/lib/public-release-switch.js";
import protocol from "../../functions/lib/public-release-pair.js";
import historical from "../../functions/lib/public-release-historical-state.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";

import targets from "../../functions/lib/publication-target.js";
import { publicReleasePairFrozenSourceCensus } from "../../site/scripts/public-release-pair-frozen-sources";
import { projectPublicReleasePairSourceCensusDocuments, preparePublicReleasePairSourceCensus } from "../../site/scripts/public-release-pair-source-census";
import { capturePublicReleasePairInput, openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { openPublicReleasePairSourceDocuments } from "../../site/scripts/public-release-pair-source-documents";
import { createHistoricalPublicReleaseReader } from "../../site/scripts/public-release-pair-historical-reader";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { seedSwitch, fixtureGuard, fixtureReadOwner } from "../helpers/public-release-switch.js";
import { pageDocument } from "./fixtures/home-decision-3441.js";
const require = createRequire(import.meta.url);
const source = require("../../functions/lib/public-release-source-body.js");
const pageContext = require("../../functions/lib/no-build-page-render-context.js");
const media = require("../../functions/lib/media-contract.js");
const ROOT = "system/publicDeployment", MEDIA = `${ROOT}/pairMedia/current`, assetId = "frozen-upload";
const asset = { source: "upload", lifecycle: "active", altText: "Original uploaded Page", url: "https://media.njpbs.org/cms-media/original.webp", mimeType: "image/webp", width: 640, height: 360 };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = (value: unknown) => new TextEncoder().encode(source.publicReleaseSnapshotJson(value, 2000000));
let db: Firestore, runtime: Miniflare, store: PairViewStore;
const target = targets.publicationTarget("development");
const dev = (value: any) => new Proxy(value, { get(object, key) { if (key === "projectId")
        return target.projectId; const result = Reflect.get(object, key); return typeof result === "function" ? result.bind(object) : result; } });
beforeAll(async () => {
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
    db = isolatedFirestore("public-release-frozen-media.test.ts");
    runtime = new Miniflare({ workers: [{
                config: { name: "frozen-media", type: "worker", compatibilityDate: "2026-07-09",
                    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
                    env: { CONTENT: { type: "r2", name: "frozen-media" } }
                }
            }] });
    store = await runtime.getR2Bucket("CONTENT") as unknown as PairViewStore;
});
afterAll(async () => { await runtime?.dispose(); vi.unstubAllEnvs(); });
beforeEach(async () => {
    await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
    const document = pageDocument();
    document.published.metadata.heroBackgroundImage = assetId;
    await db.doc("cmsPages/contact").set(document);
    await db.doc(`media_assets/${assetId}`).set(asset);
    await db.doc(`media_assets_public/${assetId}`).set(JSON.parse(JSON.stringify(media.mediaProjection(asset))));
});
async function switched() {
    const model = await seedSwitch(db), firestore = dev(db);
    // Only the qualification late-guard seam is modelled. The switch, original
    // source/log transaction, immutable history, H storage and read projections
    // below are real implementations; this supplies no deployed qualification.
    await switches.reservePublicReleaseSwitch({ firestore, attempt: model.attempt });
    await switches.applyPublicReleaseSwitch({ firestore, attempt: model.attempt, assertAcceptedWorkIncludedInTransaction: fixtureGuard,
        assertQualificationsCurrentInTransaction: fixtureGuard, qualificationReadOwner: fixtureReadOwner });
    const operationId = switches.switchChangeOperationId(model.attempt.operationId);
    const state = await historical.reconstructPublicReleaseState({ firestore, sourceOperationId: operationId });
    // The shared switch fixture supplies its original CODE manifests virtually.
    // Persist those exact immutable fixture records for the actual live SDK
    // metadata comparator too; this does not claim deployed CODE qualification.
    for (const [path, data] of state.documents)
        if (path.startsWith("cmsPreviewPublicContexts/"))
            await db.doc(path).set(data);
    return { model, firestore, state };
}
async function freeze(state: any, pair: PublicReleasePair) {
    const files = new Map<string, Uint8Array>();
    for (const [digest, body] of state.sourceBodies)
        files.set(`sources/${digest}.json`, bytes(body));
    files.set("source-census.json", bytes(publicReleasePairFrozenSourceCensus(state)));
    files.set("source-metadata.json", bytes(projectPublicReleasePairSourceCensusDocuments(state.documents)));
    const member = state.event.members.find((item: any) => item.change.id === "public-code");
    files.set("snapshot.json", bytes(member.snapshot));
    const scope = { kind: "accepted" as const, sourceOperationId: state.event.entry.operationId, sourceVersion: member.change.sourceVersion,
        snapshotDigest: member.change.snapshotDigest, contextSequence: state.cursor.sequence };
    const sourceIdentity = { kind: "provider" as const, id: "public-code" };
    const names = [...files.keys()].sort();
    const plan = { schemaVersion: 2, kind: "pair-render-input", pairDigest: protocol.publicReleaseDigest(pair), source: sourceIdentity, scope, cursor: state.cursor,
        snapshotFile: "snapshot.json", entryFiles: ["snapshot.json"], files: names.map(name => ({ name, digest: hash(files.get(name)!), bytes: files.get(name)!.length,
            objectKey: `release-pair-inputs/v2/${pair.pairId}/objects/${hash(files.get(name)!)}.json`, dependencies: name === "snapshot.json" ? ["source-census.json"] : name === "source-census.json" ? names.filter(value => value.startsWith("sources/") || value === "source-metadata.json") : [] })) };
    const captured = await capturePublicReleasePairInput({ firestore: dev(db), store, pair, plan, expectedCursor: state.cursor, expectedSource: sourceIdentity,
        files: (async function* () { for (const [name, value] of files)
            yield { name, bytes: value }; })() });
    const opened = await openPublicReleasePairInput({ firestore: dev(db), store, pair,
        identity: { schemaVersion: 2, pair: protocol.publicReleasePairReference(pair), ...scope, inputManifestDigest: captured.receipt.inputManifestDigest },
        expectedSource: sourceIdentity, expectedCursor: state.cursor });
    return { opened, ...await openPublicReleasePairSourceDocuments(opened.root, opened.readFile) };
}
async function readPage(firestore: any, rendererSha: string, renderedAt: string) {
    return firestore.runTransaction((transaction: any) => pageContext.assertNoBuildPageContextInTransaction({ firestore, transaction, pageId: "contact",
        rendererSha, target, now: new Date(renderedAt) }), { readOnly: true });
}
function frozenReader(documents: Map<string, any>, state: any) {
    let reads = 0;
    const forbidden = new Proxy({ projectId: target.projectId }, { get(object, key) { if (key === "projectId")
            return object.projectId; reads++; throw new Error("Mutable SDK fallback was attempted"); } });
    return { reader: createHistoricalPublicReleaseReader({ firestore: forbidden as any, documents, cursor: state.cursor, renderedAt: state.renderedAt }), reads: () => reads };
}
it("logs the exact media record written by a real switch and retains schema-two raw authority", async () => {
    const { model, state } = await switched(), written = (await db.doc(MEDIA).get()).data();
    if (!state.event) throw new Error("Missing original CODE event");
    const logged = state.event.members.flatMap((member: any) => member.body.documents).find((doc: any) => doc.path === MEDIA);
    expect(logged?.data).toEqual(written);
    expect(logged?.data).toEqual({ schemaVersion: 2, epoch: model.selector.epoch + 1,
        activeGeneration: model.selector.activeGeneration + 1, lastReservedGeneration: model.selector.activeGeneration + 1, newestEligibleGeneration: model.selector.activeGeneration + 1,
        references: [model.old, model.next].map((pair: PublicReleasePair) => ({ pairId: pair.pairId, manifestDigest: "e".repeat(64) })).sort((a, b) => a.pairId.localeCompare(b.pairId)) });
    expect(state.documents.get(ROOT).schemaVersion).toBe(2);
    expect(state.documents.get(MEDIA)).toEqual(written);
});
it("selects the same uploaded Page media through live SDK and an actual sealed H rebuilt from that CODE log", async () => {
    const { model, state, firestore } = await switched(), frozen = await freeze(state, model.next);
    expect(frozen.opened.root.cursor).toEqual(state.cursor);
    expect(frozen.documents.get(ROOT).schemaVersion).toBe(2);
    expect(frozen.documents.get(MEDIA)).toEqual((await db.doc(MEDIA).get()).data());
    const live = await readPage(firestore, model.next.commitSha, state.renderedAt), isolated = frozenReader(frozen.documents, state);
    const original = await readPage(isolated.reader, model.next.commitSha, state.renderedAt);
    expect(live.page.assets[assetId].url).toBe(asset.url);
    expect(original.page.assets[assetId]).toEqual(live.page.assets[assetId]);
    await db.doc(MEDIA).delete();
    await db.doc(`media_assets_public/${assetId}`).update({ url: "https://media.njpbs.org/cms-media/later.webp" });
    await expect(readPage(firestore, model.next.commitSha, state.renderedAt)).rejects.toThrow();
    expect((await readPage(isolated.reader, model.next.commitSha, state.renderedAt)).page.assets[assetId].url).toBe(asset.url);
    expect(isolated.reads()).toBe(0);
});
it.each(["missing", "epoch", "references"])("refuses %s frozen pairMedia without a mutable SDK fallback", async (variant) => {
    const { model, state, firestore } = await switched(), frozen = await freeze(state, model.next), documents = new Map(frozen.documents);
    if (variant === "missing")
        documents.delete(MEDIA);
    else {
        const value = structuredClone(documents.get(MEDIA));
        if (variant === "epoch")
            value.epoch++;
        else
            value.references = value.references.slice(1);
        documents.set(MEDIA, value);
    }
    const isolated = frozenReader(documents, state);
    expect(() => projectPublicReleasePairSourceCensusDocuments(documents)).toThrow();
    await expect(readPage(isolated.reader, model.next.commitSha, state.renderedAt)).rejects.toThrow();
    expect(isolated.reads()).toBe(0);
    const actual = (await db.doc(MEDIA).get()).data();
    if (variant === "missing")
        await db.doc(MEDIA).delete();
    else
        await db.doc(MEDIA).set(documents.get(MEDIA));
    await expect(readPage(firestore, model.next.commitSha, state.renderedAt)).rejects.toThrow();
    await db.doc(MEDIA).set(actual!);
});
it("retains actual raw authority while operational activation heads do not change source identity", async () => {
    const { state, firestore } = await switched(), before = projectPublicReleasePairSourceCensusDocuments(state.documents), documents = new Map(state.documents);
    const root = structuredClone(documents.get(ROOT)), record = structuredClone(documents.get(MEDIA));
    root.contentHead = { ...root.contentHead, viewId: "later-head", manifestDigest: "a".repeat(64) };
    record.references = record.references.map((reference: any) => ({ ...reference, manifestDigest: "a".repeat(64) }));
    documents.set(ROOT, root);
    documents.set(MEDIA, record);
    expect(projectPublicReleasePairSourceCensusDocuments(documents)).toEqual(before);
    expect(source.publicReleaseAuthorityDocument(ROOT, root).contentHead.viewId).toBe("later-head");
    expect(source.publicReleaseAuthorityDocument(MEDIA, record)).toEqual(record);
    const census = await firestore.runTransaction((transaction: any) => baseline.readPublicReleaseSourceCensusInTransaction({ firestore, transaction }));
    const actual = new Map<string, any>();
    for (const value of census.values)
        for (const document of JSON.parse(value.json).documents)
            if (document.data !== null)
                actual.set(document.path, document.data);
    const metadata = projectPublicReleasePairSourceCensusDocuments(actual);
    expect(metadata.members).toEqual(before.members.filter(member => !member.path.startsWith("cmsPreviewPublicContexts/")));
    expect((await preparePublicReleasePairSourceCensus({ firestore, expected: before, cursor: state.cursor })).metadata).toEqual(before);
});
it("keeps old schema-one source bodies readable without inventing media authority or reading current SDK", async () => {
    const root = { schemaVersion: 1, state: "idle", mediaLifecycleReady: true, activeGeneration: 7, activeDeploymentId: "legacy", activeCommitSha: "a".repeat(40), lastReservedGeneration: 7, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "legacy" };
    const projected = source.publicReleaseAuthorityDocument(ROOT, root);
    expect(projected).toEqual(root);
    // Read an actual old immutable source body without consulting today's root
    // or filling in a pair-media document that this body never contained.
    const body = source.makePublicReleaseSourceBody({ kind: "provider", id: "public-code", action: "dependency", sourceVersion: 7,
        snapshot: { commitSha: root.activeCommitSha, generation: 7, deploymentId: "legacy" }, sourceDocuments: [{ path: ROOT, data: root }] });
    await db.runTransaction(async (transaction) => { const write = await source.preparePublicReleaseSourceBodies({ firestore: db, transaction, values: [body] }); write(); });
    const original = await db.runTransaction<any>(transaction => source.readPublicReleaseSourceBody({ firestore: db, transaction, contentDigest: body.contentDigest }), { readOnly: true });
    expect(original.documents).toEqual([{ path: ROOT, data: root }]);
    const documents = new Map<string, any>([[ROOT, original.documents[0].data], ["cmsPages/contact", (await db.doc("cmsPages/contact").get()).data()],
        [`media_assets/${assetId}`, asset], [`media_assets_public/${assetId}`, JSON.parse(JSON.stringify(media.mediaProjection(asset)))],
        [`${ROOT}/contexts/public`, { schemaVersion: 1, revision: 1 }]]);
    const state = { cursor: { baselineDigest: "1".repeat(64), sequence: 0, lastDigest: "1".repeat(64) }, renderedAt: "2026-10-28T00:00:00.000Z" }, isolated = frozenReader(documents, state);
    expect((await readPage(isolated.reader, "a".repeat(40), state.renderedAt)).page.assets[assetId].url).toBe(asset.url);
    expect(documents.has(MEDIA)).toBe(false);
    expect(isolated.reads()).toBe(0);
});
