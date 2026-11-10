import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { compiledPublicReleasePairCompositeArtifacts } from "../helpers/compiled-public-release-pair-composite";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { openStagedPublicReleasePairComposite } from "../../site/scripts/public-release-pair-composite-storage";
import { readPublicReleasePairView, type PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import work from "../../functions/lib/public-release-pair-work.js";
import producer from "../../functions/lib/public-release-producer.js";
import { DEFAULT_PUBLIC_SITE_CHROME_SETTINGS } from "../../packages/content-core/src/cms-settings";
const A = "au_" + "a".repeat(32), B = "au_" + "b".repeat(32);
const profile = (authorId: string, slug: string) => ({ authorId, slug, previousSlugs: [], displayName: `Reporter ${slug}`,
  jobTitle: "Reporter", bio: "Frozen author biography.", photo: null, links: {}, pinnedPostId: null, hiddenPostIds: [],
  snapshotVersion: 3, publishedAt: "2026-10-01T12:00:00.000Z" });
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>>, directory: string;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const compiledDirectory = path.resolve("site/.public-post-renderer");
let originalSeal: Uint8Array, originalInputs: Uint8Array | undefined;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "compiled-author", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "compiled-author" } } } }] });
  const firestore = isolatedFirestore("pair-compiled-author"); store = await runtime.getR2Bucket("CONTENT");
  directory = await mkdtemp(path.join(os.tmpdir(), "pair-compiled-author-"));
  fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, content: "baseline", seed: async db => {
    await db.doc("cmsSettings/public-site-chrome").set({ version: 6, published: { schemaVersion: 1, sourceVersion: 5,
      publishedAt: "2026-10-01T12:00:00.000Z", values: { ...DEFAULT_PUBLIC_SITE_CHROME_SETTINGS, newsletterLabel: "Frozen newsletter" } } });
    await db.doc(`cmsAuthorProfilesPublic/${A}`).set({ ...profile(A, "ada"), previousSlugs: ["ada-old"], pinnedPostId: "story" });
    await db.doc(`cmsAuthorProfilesPublic/${B}`).set(profile(B, "retired"));
    await db.doc("cmsPosts/story").update({ "published.metadata.credits": [{ kind: "registered", authorId: A, displayName: "Ada", slug: "ada" }] });
  }, prepareArtifacts: async (root, sourceInputs) => {
    originalSeal = await readFile(path.join(compiledDirectory, "pair-renderer-release.json"));
    try { originalInputs = await readFile(path.join(compiledDirectory, "pair-source-inputs.json")); } catch {}
    return compiledPublicReleasePairCompositeArtifacts(root, sourceInputs, {
      "authors/ada/index.html": "<html>STALE AUTHOR FALLBACK</html>", "authors/ada-old/index.html": "<html>STALE ALIAS FALLBACK</html>",
      "authors/retired/index.html": "<html>STALE WITHDRAWN FALLBACK</html>",
    });
  } });
}, 120_000);
afterAll(async () => {
  await fixture?.close(); await runtime?.dispose(); if (directory) await rm(directory, { recursive: true, force: true });
  if (originalSeal) {
    await writeFile(path.join(compiledDirectory, "pair-renderer-release.json"), originalSeal);
    if (originalInputs) await writeFile(path.join(compiledDirectory, "pair-source-inputs.json"), originalInputs);
    else await rm(path.join(compiledDirectory, "pair-source-inputs.json"), { force: true });
  }
});
it("renders the sealed AuthorPage, aliases and withdrawals from original H into the full G manifest", async () => {
  const db = fixture.firestore, pair = fixture.pair;
  const executor = createPublicReleasePairExecutor({ firestore: db, store, pair });
  const operations = { ...executor, execute: async (context: Parameters<typeof executor.execute>[0]) => {
    const result = await executor.execute(context);
    if ("metrics" in result) console.info("author-pair metrics", JSON.stringify(result.metrics));
    return result;
  } };
  expect(await runPublicReleasePairWorkOnce({ firestore: db, pair, ...operations })).toBe("complete");
  const ada = { ...profile(A, "ada-new"), previousSlugs: ["ada", "ada-old"], pinnedPostId: "story", snapshotVersion: 4 };
  await db.runTransaction(async transaction => {
    const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId: "author-render-change", changes: [
      { kind: "author", id: A, action: "dependency", sourceVersion: 4, snapshot: ada },
      { kind: "author", id: B, action: "withdraw", sourceVersion: 4, snapshot: null },
    ] });
    append(); transaction.set(db.doc(`cmsAuthorProfilesPublic/${A}`), ada); transaction.delete(db.doc(`cmsAuthorProfilesPublic/${B}`));
    transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 2 });
  });
  const frozen = await captureHistoricalPublicReleasePairInput({ firestore: db, pair, store, sourceOperationId: "author-render-change",
    providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resource"); } });
  const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair,
    input: { ...frozen.root.scope, inputManifestDigest: frozen.receipt.inputManifestDigest } }));
  await db.doc(`cmsAuthorProfilesPublic/${A}`).set(profile(A, "latest-must-not-leak"));
  await db.doc("cmsPosts/story").delete(); fixture.packet.boundary.objects.clear();
  expect(await runPublicReleasePairWorkOnce({ firestore: db, pair, ...operations })).toBe("complete");
  const receipt = (await db.doc(`${fixture.base}/receipts/${taskId}`).get()).data()!;
  const owner = { firestore: db, store, pair, identity: receipt.identity, claimDigest: receipt.claimDigest, viewManifestDigest: receipt.manifestDigest };
  const composite = await openStagedPublicReleasePairComposite(owner);
  const rows = composite.manifest.members.filter(row => row.kind === "author");
  expect(rows.map(row => [row.path, row.status])).toEqual([
    ["/authors/ada-new/", 200], ["/authors/ada-old/", 308], ["/authors/ada/", 308], ["/authors/retired/", 410],
  ]);
  const canonical = await composite.readMember("/authors/ada-new/");
  expect(canonical.member.path).toBe("/authors/ada-new/");
  const html = new TextDecoder().decode(canonical.body);
  expect(html).toContain("Reporter ada-new"); expect(html).toContain("Frozen author biography.");
  expect(html).toContain("Frozen newsletter");
  expect(html).toContain("A published fixture"); expect(html).not.toContain("latest-must-not-leak");
  expect(html).not.toContain("STALE AUTHOR FALLBACK"); expect(hash(canonical.body)).toBe(rows[0].sha256);
  const alias = await composite.readMember("/authors/ada/");
  expect([alias.member.status, alias.member.owner?.canonicalPath, alias.body.length]).toEqual([308, "/authors/ada-new/", 0]);
  const withdrawn = await composite.readMember("/authors/retired/");
  expect([withdrawn.member.status, withdrawn.body.length]).toEqual([410, 0]);
  const semantic = JSON.parse(new TextDecoder().decode((await composite.readMember("/search/meaning-index.json")).body));
  expect(semantic.passages.some((row: { url: string }) => row.url.startsWith("/authors/ada-new/"))).toBe(true);
  expect(semantic.passages.some((row: { url: string }) => row.url.startsWith("/authors/retired/"))).toBe(false);
  expect(JSON.stringify(semantic)).not.toContain("STALE");
  const sitemapRows = composite.manifest.members.filter(row => row.kind === "sitemap");
  const sitemap = (await Promise.all(sitemapRows.map(async row => new TextDecoder().decode((await composite.readMember(row.path)).body)))).join("\n");
  expect(sitemap).toContain("/authors/ada-new/"); expect(sitemap).not.toContain("/authors/retired/");
  const staged = (await db.doc(`${fixture.base}/views/${receipt.manifestDigest}`).get()).data()!;
  const outputs = [];
  for await (const output of readPublicReleasePairView({ ...owner, manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes })) outputs.push(output);
  expect(outputs.filter(output => output.path.startsWith("/authors/")).map(output => output.path)).toEqual(rows.map(row => row.path));
  expect(outputs.find(output => output.path === "/authors/ada/")!.headers.location).toBe("/authors/ada-new/");
  expect(JSON.stringify(outputs.filter(output => output.path.startsWith("/pagefind/")).map(output => new TextDecoder().decode(output.body))))
    .not.toContain("STALE AUTHOR FALLBACK");
  const canonicalOutput = outputs.find(output => output.path === "/authors/ada-new/")!;
  for (const mode of ["missing", "corrupt", "transport"]) {
    const damaged: PairViewStore = { put: async () => { throw new Error("Read only"); }, get: async key => {
      if (key !== canonicalOutput.objectKey) return store.get(key);
      if (mode === "missing") return null;
      if (mode === "transport") throw new Error("Storage unavailable");
      const original = await store.get(key); if (!original) throw new Error("Missing original");
      await original.body.cancel();
      const changed = canonical.body.slice(); changed[0] ^= 1;
      return { size: changed.length, customMetadata: original.customMetadata, body: new Response(changed).body! };
    } };
    const reopened = await openStagedPublicReleasePairComposite({ ...owner, store: damaged });
    await expect(reopened.readMember("/authors/ada-new/")).rejects.toThrow();
  }
  await operations.recover(); expect(await runPublicReleasePairWorkOnce({ firestore: db, pair, ...operations })).toBe("idle");
  expect((await db.collection(`${fixture.base}/receipts`).get()).size).toBe(3);
}, 120_000);
