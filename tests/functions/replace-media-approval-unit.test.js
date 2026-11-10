import { describe, expect, it } from "vitest";
import replacement from "../../functions/replace-media.js";
import mediaContract from "../../functions/lib/media-contract.js";
import lifecycle from "../../functions/lifecycle-transition.js";

const { reserveReplacement, markReplacementObjectReady, replacementRecord, commitReplacement } = replacement;
const { finalObjectKey, mediaProjection } = mediaContract;
const assetId = "asset-one";
const oldHash = "a".repeat(64);
const newHash = "b".repeat(64);
const nowIso = "2026-10-09T12:00:00.000Z";
const actor = {
  uid: "editor-one", email: "editor@example.test",
  principal: { id: "editor-one", grants: [{ role: "editor" }] },
};

// Only the Firestore boundary is faked. Run the real reservation, ready and
// commit functions against document and collection-group query snapshots.
function database() {
  const storageKey = finalObjectKey({ category: "news", assetId, contentHash: oldHash, mimeType: "image/png" });
  const asset = {
    id: assetId, name: "Studio", originalName: "studio.png", category: "news",
    tags: [], description: "", altText: "Studio", license: "NJ PBS owned", credit: "NJ PBS",
    mimeType: "image/png", kind: "image", sizeBytes: 99, width: 10, height: 10,
    contentHash: oldHash, storageKey, url: `https://media.njpbs.org/${storageKey}`,
    lifecycle: "active", source: "upload", version: 2,
    createdAt: nowIso, createdBy: actor.uid, updatedAt: nowIso, updatedBy: actor.uid,
  };
  const records = new Map([
    [`media_assets/${assetId}`, asset],
    [`media_assets_public/${assetId}`, mediaProjection(asset)],
    [`system/media/hashOwners/${oldHash}`, {
      state: "committed", operation: "upload", assetId, category: "news", finalKey: storageKey,
    }],
  ]);
  let nextId = 0;
  const doc = path => ({
    path, id: path.split("/").at(-1),
    get parent() { return collection(path.split("/").slice(0, -1).join("/")); },
    collection: name => collection(`${path}/${name}`),
    get: async () => snapshot(path),
  });
  const collection = path => ({
    path, parent: path.includes("/") ? doc(path.split("/").slice(0, -1).join("/")) : null,
    doc: (id = `generated-${++nextId}`) => doc(`${path}/${id}`),
  });
  const snapshot = path => ({ ref: doc(path), exists: records.has(path), data: () => records.get(path) });
  const query = (group, filters = [], limit = Infinity) => ({
    group, filters, maximum: limit,
    where: (field, operator, value) => query(group, [...filters, { field, operator, value }], limit),
    limit: maximum => query(group, filters, maximum),
  });
  const firestore = {
    doc, collection, collectionGroup: group => query(group),
    async runTransaction(callback) {
      const writes = [];
      const write = (ref, value) => writes.push(() => records.set(ref.path, value));
      const result = await callback({
        async getAll(...refs) { return refs.map(ref => snapshot(ref.path)); },
        async get(ref) {
          if (!ref.group) return snapshot(ref.path);
          const docs = [...records].filter(([path, value]) =>
            path.split("/").at(-2) === ref.group && ref.filters.every(filter =>
              filter.operator === "array-contains"
                ? value[filter.field]?.includes(filter.value)
                : value[filter.field] === filter.value,
            ),
          ).slice(0, ref.maximum).map(([path]) => snapshot(path));
          return { docs, empty: docs.length === 0 };
        },
        set: write, create: write, update: write,
        delete: ref => writes.push(() => records.delete(ref.path)),
      });
      writes.forEach(write => write());
      return result;
    },
  };
  const use = (id, status, collectionName = "cmsPosts", usedAsset = assetId) => {
    records.set(`${collectionName}/${id}`, { status, version: 4, publishAt: status === "scheduled" ? "2026-10-10T12:00:00.000Z" : null });
    records.set(`${collectionName}/${id}/mediaUsage/working`, {
      state: "working", sourceVersion: 3, assetIds: [usedAsset], occurrenceCount: 1,
    });
  };
  return { firestore, records, asset, use };
}

function reserve(firestore) {
  return reserveReplacement({
    firestore, assetId, baseVersion: 2, contentHash: newHash, actor,
    upload: { originalName: "replacement.png", mimeType: "image/png", buffer: Buffer.from("image bytes"), source: null },
    dimensions: { width: 1, height: 1 }, attemptId: "replacement-attempt",
    nowDate: new Date(nowIso), publicOrigin: "https://media.njpbs.org",
  });
}

async function ready(firestore) {
  const reserved = await reserve(firestore);
  const claimRef = firestore.doc(`system/media/replacements/${assetId}`);
  const nextOwnerRef = firestore.doc(`system/media/hashOwners/${newHash}`);
  await markReplacementObjectReady({ firestore, claimRef, nextOwnerRef, attemptId: reserved.claim.attemptId, nowIso });
  return {
    firestore, claimRef, nextOwnerRef, claim: reserved.claim,
    record: replacementRecord(reserved.stored, reserved.claim, nowIso), actor, source: null, nowIso,
  };
}

describe("image replacement approval integrity", () => {
  it.each(["approved", "scheduled"])("refuses working-only %s usage, even after a draft match", async status => {
    const { firestore, records, use } = database();
    use("draft-first", "draft");
    use("story", status);
    const before = new Map(records);

    await expect(reserve(firestore)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/approved or scheduled.*Upload.*new image/),
    });
    expect(records).toEqual(before);
  });

  it("allows draft-only usage through commit and ignores unrelated scheduled assets", async () => {
    const { firestore, records, use } = database();
    use("draft", "draft");
    use("other-image", "scheduled", "cmsPosts", "asset-other");

    await commitReplacement(await ready(firestore));

    expect(records.get(`media_assets/${assetId}`)).toMatchObject({ contentHash: newHash, version: 3 });
    expect(records.get(`media_assets_public/${assetId}`).url).toContain(newHash);
    expect(records.get("cmsPosts/draft").status).toBe("draft");
    expect(records.has(`system/media/replacements/${assetId}`)).toBe(false);
  });

  it("preserves a prepared replacement when bootstrap closes source admission", async () => {
    const { firestore, records } = database();
    const options = await ready(firestore);
    records.set("system/publicReleaseAdmissions/controls/bootstrapFence", { schemaVersion: 2,
      operationId: "initial-install", attemptDigest: "a".repeat(64), status: "closed", resumeReceiptDigest: null });
    const before = new Map(records);
    await expect(commitReplacement(options)).rejects.toMatchObject({ code: "public_release_bootstrap_admission_paused" });
    expect(records).toEqual(before);
    expect(records.get(`media_assets/${assetId}`).contentHash).toBe(oldHash);
  });

  it.each(["approved", "scheduled"])("refuses commit when working content becomes %s after reservation", async status => {
    const { firestore, records, asset, use } = database();
    use("page", "draft", "cmsPages");
    const options = await ready(firestore);
    use("page", status, "cmsPages");
    const before = new Map(records);

    await expect(commitReplacement(options)).rejects.toMatchObject({ status: 409 });
    expect(records).toEqual(before);
    expect(records.get(`media_assets_public/${assetId}`).url).toBe(asset.url);
  });

  it("waits to approve an image until its replacement commits", async () => {
    const { firestore, records, use } = database();
    use("watch", "in_review", "cmsPages");
    records.set("cmsPages/watch", {
      ...records.get("cmsPages/watch"), id: "watch", template: "watch", title: "Watch NJ PBS",
      blocks: [], social: { imageAssetId: assetId }, createdBy: actor.uid,
    });
    const options = await ready(firestore);
    const handler = lifecycle.createCmsTransitionContentHandler({
      firestore, requirePrincipalFn: async () => actor, now: () => nowIso,
    });
    const approve = async () => {
      const res = { statusCode: null, body: null };
      res.status = code => { res.statusCode = code; return res; };
      res.json = body => { res.body = body; return res; };
      await handler({ method: "POST", headers: {}, body: {
        collection: "cmsPages", id: "watch", baseVersion: 4, action: "approve",
      } }, res);
      return res;
    };

    const refused = await approve();
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toMatch(/replacement is in progress/);
    expect(records.get("cmsPages/watch").status).toBe("in_review");

    await commitReplacement(options);
    expect((await approve()).statusCode).toBe(200);
    expect(records.get("cmsPages/watch").status).toBe("approved");
    expect(records.get(`media_assets/${assetId}`).contentHash).toBe(newHash);
  });
});

it("replaces with previously purged bytes using a fresh object attempt and preserves the purge receipt", async () => {
  const fixture = database();
  const prior = { state: "purged", assetId: "old-asset", attemptId: "old-attempt",
    finalKey: `cms-media/news/old-asset/${newHash}.png`, finalObjectAttemptId: "deleted-object-attempt" };
  fixture.records.set(`system/media/hashOwners/${newHash}`, prior);
  const result = await reserve(fixture.firestore);
  expect(result.claim.finalObjectAttemptId).toBe("replacement-attempt");
  expect(fixture.records.get(`system/media/hashOwners/${newHash}/superseded/old-attempt`)).toEqual(prior);
  expect(fixture.records.get(`system/media/hashOwners/${newHash}`).state).toBe("reserved");
});
