import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { openPublicReleasePairInput } from "../../site/scripts/public-release-pair-input-storage";
import { derivePublicReleasePairAuthors, assertPublicReleasePairAuthorRoster, type PairAuthorContext } from "../../site/scripts/public-release-pair-author";
import { authorPageContent } from "../../site/src/lib/author-pages";
import { DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } from "../../packages/content-core/src/cms-settings";
import protocol from "../../functions/lib/public-release-pair.js";
import producer from "../../functions/lib/public-release-producer.js";
import ownerCodec from "../../functions/lib/public-release-pair-author.js";
import work from "../../functions/lib/public-release-pair-work.js";
import inputCodec from "../../functions/lib/public-release-pair-input.js";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { publicReleasePairExecutionRenewal } from "../../site/scripts/public-release-pair-execution-renewal";
import { openPublicReleasePairSourceDocuments } from "../../site/scripts/public-release-pair-source-documents";

const A = "au_" + "a".repeat(32), B = "au_" + "b".repeat(32), C = "au_" + "c".repeat(32), D = "au_" + "d".repeat(32);
const profile = (authorId: string, slug: string, overrides = {}) => ({ authorId, slug, previousSlugs: [], displayName: `Reporter ${slug}`,
  jobTitle: "Reporter", bio: "Frozen public biography.", photo: null, links: {}, pinnedPostId: null, hiddenPostIds: [],
  snapshotVersion: 3, publishedAt: "2026-10-01T12:00:00.000Z", ...overrides });
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>, directory: string;
let baselineContext: PairAuthorContext, currentContext: PairAuthorContext, transientContext: PairAuthorContext, collisionContext: PairAuthorContext, frozenFiles: Map<string, Uint8Array>;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "author-source", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "author-source" } } } }] });
  const db = isolatedFirestore("pair-author-adapter"), store = await runtime.getR2Bucket("CONTENT");
  directory = await mkdtemp(path.join(os.tmpdir(), "pair-author-"));
  fixture = await publicReleasePairCompositeFixture({ firestore: db, store, directory, content: "baseline", seed: async db => {
    await db.doc(`cmsAuthorProfilesPublic/${A}`).set(profile(A, "ada", { previousSlugs: ["ada-old"], pinnedPostId: "story" }));
    await db.doc(`cmsAuthorProfilesPublic/${B}`).set(profile(B, "ben"));
    await db.doc(`cmsAuthorProfilesPublic/${C}`).set(profile(C, "retired", { previousSlugs: ["retired-old"] }));
    await db.doc(`cmsAuthorProfilesPublic/${D}`).set(profile(D, "dropped", { previousSlugs: ["dropped-old"] }));
    await db.doc("cmsSettings/public-site-chrome").set({ version: 6, published: { schemaVersion: 1, sourceVersion: 5,
      publishedAt: "2026-10-01T12:00:00.000Z", values: { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, newsletterLabel: "Frozen newsletter" } } });
    await db.doc("cmsSettings/nj-decides-brand").set({ version: 1, published: { sourceVersion: 1, values: { invalid: true } } });
    await db.doc("cmsPosts/story").update({ "published.metadata.credits": [{ kind: "registered", authorId: A, displayName: "Frozen Ada", slug: "ada" }] });
  } });
  const open = async (captured: typeof fixture.content): Promise<PairAuthorContext> => {
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...captured.root.scope,
      inputManifestDigest: captured.receipt.inputManifestDigest };
    const frozen = await openPublicReleasePairInput({ firestore: db, store, pair: fixture.pair, identity, expectedSource: captured.root.source, expectedCursor: captured.root.cursor });
    const files = new Map<string, Uint8Array>();
    for (const file of frozen.root.files) files.set(file.name, await frozen.readFile(file.name));
    frozenFiles = files;
    return { pair: fixture.pair, identity, root: frozen.root, async readFrozenFile(name) {
      const bytes = files.get(name); if (!bytes) throw new Error("Unlisted frozen input"); return bytes;
    } };
  };
  baselineContext = await open(fixture.content);
  const ada = profile(A, "ada-new", { previousSlugs: ["ada", "ada-old"], pinnedPostId: "story", snapshotVersion: 4 });
  const dropped = profile(D, "dropped", { snapshotVersion: 4 });
  await db.runTransaction(async transaction => {
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "author-change", changes: [
      { kind: "author", id: A, action: "dependency", sourceVersion: 4, snapshot: ada },
      { kind: "author", id: C, action: "withdraw", sourceVersion: 4, snapshot: null },
      { kind: "author", id: D, action: "dependency", sourceVersion: 4, snapshot: dropped },
    ] });
    append(); transaction.set(db.doc(`cmsAuthorProfilesPublic/${A}`), ada); transaction.delete(db.doc(`cmsAuthorProfilesPublic/${C}`));
    transaction.set(db.doc(`cmsAuthorProfilesPublic/${D}`), dropped);
    transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 2 });
  });
  const current = await captureHistoricalPublicReleasePairInput({ firestore: fixture.firestore, store, pair: fixture.pair,
    sourceOperationId: "author-change", providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resource"); } });
  currentContext = await open(current);
  const currentFiles = frozenFiles;
  const finalAda = profile(A, "ada-final", { previousSlugs: ["ada"], snapshotVersion: 5 });
  await db.runTransaction(async transaction => {
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "author-final-name",
      changes: [{ kind: "author", id: A, action: "dependency", sourceVersion: 5, snapshot: finalAda }] });
    append(); transaction.set(db.doc(`cmsAuthorProfilesPublic/${A}`), finalAda);
    transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 3 });
  });
  transientContext = await open(await captureHistoricalPublicReleasePairInput({ firestore: fixture.firestore, store, pair: fixture.pair,
    sourceOperationId: "author-final-name", providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resource"); } }));
  const collision = profile(B, "retired", { snapshotVersion: 4 });
  await db.runTransaction(async transaction => {
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "author-collision",
      changes: [{ kind: "author", id: B, action: "dependency", sourceVersion: 4, snapshot: collision }] });
    append(); transaction.set(db.doc(`cmsAuthorProfilesPublic/${B}`), collision);
    transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 4 });
  });
  collisionContext = await open(await captureHistoricalPublicReleasePairInput({ firestore: fixture.firestore, store, pair: fixture.pair,
    sourceOperationId: "author-collision", providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resource"); } }));
  frozenFiles = currentFiles;
  // Prove that later mutable data and unavailable provider/CODE transports do
  // not affect either already captured author view.
  await db.doc(`cmsAuthorProfilesPublic/${A}`).set(profile(A, "latest-must-not-leak"));
  await db.doc("cmsPosts/story").update({ "published.metadata.title": "LATEST MUST NOT LEAK" });
  fixture.packet.boundary.objects.clear();
}, 90_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });

it("lists every public author and alias, including an author with no Posts", async () => {
  const result = await derivePublicReleasePairAuthors(baselineContext);
  expect(result.routes.map(({ path, status }) => [path, status])).toEqual([
    ["/authors/ada-old/", 308], ["/authors/ada/", 200], ["/authors/ben/", 200], ["/authors/dropped-old/", 308], ["/authors/dropped/", 200],
    ["/authors/retired-old/", 308], ["/authors/retired/", 200],
  ]);
  expect(result.routes[0].location).toBe("/authors/ada/");
  const content = result.content("/authors/ada/"), author = content.authors.find(author => author.authorId === A)!;
  expect(authorPageContent(author, content.posts).listings.map(item => [item.postId, item.pinned, item.title])).toEqual([["story", true, "A published fixture"]]);
  expect(authorPageContent(content.authors.find(author => author.authorId === B)!, content.posts).listings).toEqual([]);
});
it("keeps baseline/history routes and explicitly withdraws every removed author path", async () => {
  const result = await derivePublicReleasePairAuthors(currentContext);
  expect(result.routes.map(({ path, status, location }) => [path, status, location])).toEqual([
    ["/authors/ada-new/", 200, null], ["/authors/ada-old/", 308, "/authors/ada-new/"], ["/authors/ada/", 308, "/authors/ada-new/"],
    ["/authors/ben/", 200, null], ["/authors/dropped-old/", 410, null], ["/authors/dropped/", 200, null],
    ["/authors/retired-old/", 410, null], ["/authors/retired/", 410, null],
  ]);
  expect(result.routes.find(route => route.path === "/authors/retired/")!.owner.authorId).toBe(C);
  expect(result.content("/authors/ada-new/").target.rendererSha).toBe(fixture.pair.commitSha);
  expect(JSON.stringify(result.content("/authors/ada-new/"))).not.toContain("LATEST MUST NOT LEAK");
  expect(result.routes.some(route => route.path.includes("latest"))).toBe(false);
});
it("withdraws transient canonical names and removed aliases across the full contiguous history", async () => {
  const result = await derivePublicReleasePairAuthors(transientContext);
  expect(result.routes.find(route => route.path === "/authors/ada-new/")?.status).toBe(410);
  expect(result.routes.find(route => route.path === "/authors/ada-old/")?.status).toBe(410);
  expect(result.routes.find(route => route.path === "/authors/ada/")?.status).toBe(308);
  expect(result.routes.find(route => route.path === "/authors/ada-final/")?.status).toBe(200);
});
it("refuses a historical withdrawal claimed by another author", async () => {
  await expect(derivePublicReleasePairAuthors(collisionContext)).rejects.toMatchObject({ code: "author-route-collision" });
});
it("keeps the published reader's fallback for invalid optional chrome", async () => {
  const result = await derivePublicReleasePairAuthors(currentContext);
  expect(result.content("/authors/ada-new/").settings.some(row => row.settingId === "nj-decides-brand")).toBe(false);
});
it("retains the published version and values of valid frozen chrome", async () => {
  const result = await derivePublicReleasePairAuthors(currentContext);
  expect(result.content("/authors/ada-new/").settings.find(row => row.settingId === "public-site-chrome"))
    .toMatchObject({ sourceVersion: 5, newsletterLabel: "Frozen newsletter" });
});
it.each([20_000, 20_001])("matches the shared frozen source bound at %i document rows", async count => {
  const files = new Map(frozenFiles), root = structuredClone(currentContext.root) as any;
  const census = JSON.parse(new TextDecoder().decode(files.get("source-census.json")!));
  const addedFiles: string[] = [];
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const put = (name: string, value: unknown) => {
    const bytes = encode(value); files.set(name, bytes);
    const index = root.files.findIndex((file: { name: string }) => file.name === name);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const descriptor = { name, digest, bytes: bytes.length, objectKey: inputCodec.publicReleasePairInputObjectKey(currentContext.pair, digest),
      dependencies: index < 0 ? [] : root.files[index].dependencies };
    if (index < 0) root.files.push(descriptor); else root.files[index] = descriptor;
  };
  // Immutable history support rows can share bodies and exceed the count of
  // public metadata members, without exceeding H's separate 10,000-file cap.
  let index = 0;
  while (census.documents.length < count) {
    const documents = Array.from({ length: Math.min(100, count - census.documents.length) }, () => ({
      path: `cmsVersionHistory/boundary-${String(index++).padStart(5, "0")}`, data: { sourceVersion: 1 },
    }));
    const body = { schemaVersion: 2, kind: "provider", id: `history-boundary-${index}`, action: "dependency", sourceVersion: 1, snapshot: {}, documents };
    const contentDigest = protocol.publicReleaseDigest(body), bodyFile = `sources/${contentDigest}.json`;
    put(bodyFile, body); addedFiles.push(bodyFile);
    census.documents.push(...documents.map(document => ({ path: document.path, contentDigest, bodyFile })));
  }
  census.documents.sort((a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : 1);
  put("source-census.json", census);
  root.files.find((file: { name: string }) => file.name === "source-dependencies.json").dependencies.push(...addedFiles);
  root.files.find((file: { name: string }) => file.name === "source-dependencies.json").dependencies.sort();
  root.files.sort((a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : 1);
  const parsedRoot = inputCodec.parsePublicReleasePairInputRoot(root, currentContext.pair);
  const context = { ...currentContext, root: parsedRoot, identity: { ...currentContext.identity,
    inputManifestDigest: createHash("sha256").update(JSON.stringify(parsedRoot)).digest("hex") },
  readFrozenFile: async (name: string) => files.get(name)! };
  if (count === 20_001) {
    await expect(openPublicReleasePairSourceDocuments(parsedRoot, context.readFrozenFile)).rejects.toMatchObject({ code: "input-unavailable" });
    await expect(derivePublicReleasePairAuthors(context)).rejects.toMatchObject({ code: "author-input-mismatch" });
    return;
  }
  expect((await openPublicReleasePairSourceDocuments(parsedRoot, context.readFrozenFile)).documents.size).toBe(20_000);
  expect((await derivePublicReleasePairAuthors(context)).routes.map(route => route.path))
    .toEqual((await derivePublicReleasePairAuthors(currentContext)).routes.map(route => route.path));
});
it("renews the original claim across a frozen source walk longer than its lease", async () => {
  let time = 0, leaseUntil = 60_000, renewals = 0;
  const checkpoint = publicReleasePairExecutionRenewal(async () => {
    if (time >= leaseUntil) throw new work.PairExecutionError("lease-expired");
    renewals++; leaseUntil = time + 60_000; return { leaseUntil };
  }, new AbortController().signal, () => time);
  const result = await derivePublicReleasePairAuthors({ ...currentContext, checkpoint, readFrozenFile: async name => {
    time += 4_000;
    if (time >= leaseUntil) throw new work.PairExecutionError("lease-expired");
    return currentContext.readFrozenFile(name);
  } });
  expect(time).toBeGreaterThan(60_000); expect(renewals).toBeGreaterThan(1);
  expect(result.routes.find(route => route.path === "/authors/ada-new/")?.status).toBe(200);
  const lost = new work.PairExecutionError("lease-lost");
  await expect(derivePublicReleasePairAuthors({ ...currentContext, checkpoint: async () => { throw lost; } })).rejects.toBe(lost);
});
it("refuses a missing raw profile body by name without a latest fallback", async () => {
  const census = JSON.parse(new TextDecoder().decode(frozenFiles.get("source-census.json")!));
  const file = census.documents.find((row: any) => row.path === `cmsAuthorProfilesPublic/${A}`).bodyFile;
  await expect(derivePublicReleasePairAuthors({ ...currentContext, readFrozenFile: name => name === file ? Promise.reject(new work.PairExecutionError("input-unavailable")) : currentContext.readFrozenFile(name) }))
    .rejects.toMatchObject({ code: "author-input-missing" });
});
it("refuses changed raw bytes even when they are still valid JSON", async () => {
  await expect(derivePublicReleasePairAuthors({ ...currentContext, readFrozenFile: name => name === "source-census.json"
    ? Promise.resolve(new TextEncoder().encode("{}")) : currentContext.readFrozenFile(name) })).rejects.toMatchObject({ code: "author-input-mismatch" });
});
it("refuses a missing sealed CODE chunk by name", async () => {
  const descriptor = JSON.parse(new TextDecoder().decode(frozenFiles.get("code-source.json")!));
  await expect(derivePublicReleasePairAuthors({ ...currentContext, readFrozenFile: name => name === descriptor.chunkFiles[0]
    ? Promise.reject(new work.PairExecutionError("input-unavailable")) : currentContext.readFrozenFile(name) })).rejects.toMatchObject({ code: "author-input-missing" });
});
it.each([new work.PairExecutionError("storage-unavailable"), new Error("Storage transport unavailable"), new DOMException("Cancelled", "AbortError")])
  ("preserves frozen read transport and cancellation failures: %s", async error => {
    await expect(derivePublicReleasePairAuthors({ ...currentContext, readFrozenFile: name => name === "source-census.json"
      ? Promise.reject(error) : currentContext.readFrozenFile(name) })).rejects.toBe(error);
  });
it("binds the target to the exact H root independently of the snapshot digest", async () => {
  expect(currentContext.identity.inputManifestDigest).not.toBe(currentContext.identity.snapshotDigest);
  await expect(derivePublicReleasePairAuthors({ ...currentContext, identity: { ...currentContext.identity, inputManifestDigest: "f".repeat(64) } }))
    .rejects.toMatchObject({ code: "author-input-mismatch" });
});
it("requires the full author roster and source owners for composite settlement", async () => {
  const result = await derivePublicReleasePairAuthors(currentContext);
  const rows = result.routes.map(route => ({ path: route.path, status: route.status, mime: route.contentType, owner: route.owner }));
  expect(() => assertPublicReleasePairAuthorRoster(rows, result.routes)).not.toThrow();
  expect(() => assertPublicReleasePairAuthorRoster(rows.slice(1), result.routes)).toThrow();
  expect(() => assertPublicReleasePairAuthorRoster(rows.map((row, index) => index ? row : { ...row, owner: { ...row.owner, authorId: B } }), result.routes)).toThrow();
  for (const route of result.routes) expect(ownerCodec.parsePublicReleasePairAuthorOwner(route.owner)).toEqual(route.owner);
});
it("refuses actual G settlement when the author roster is omitted", async () => {
  await expect(stagedPublicReleasePairCompositeFixture(fixture, await runtime.getR2Bucket("CONTENT")))
    .rejects.toMatchObject({ code: "author-owner-mismatch" });
  expect((await fixture.firestore.collection(`${fixture.base}/compositeViews`).get()).empty).toBe(true);
});
it.each(["/authors/", "/authors/ada/child/", "/authors/../", "/authors/ADA/", "/authors/ada%2fben/"])("never grants namespace authority for %s", path => {
  expect(ownerCodec.isPublicReleasePairAuthorPath(path)).toBe(false);
});
