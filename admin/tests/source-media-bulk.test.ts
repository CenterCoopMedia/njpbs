import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { buildBulkMetadataPlan, emptyBulkMetadataDraft, hasBulkMetadataIntent, pendingBulkResults, runBulkMetadataPlan, type BulkPlanEntry, type BulkResult, type BulkFailure } from "../src/lib/source-media-bulk";
import { BULK_SAVE_INTERVAL_MS, MAX_BULK_IMAGES, buildImageBulkPlan, classifyImageBulkFailure, imageBulkSave, type BulkMetadataDraft, type ImageBulkPatch } from "../src/lib/source-media-bulk";
import { HttpError, type MediaAssetSummary } from "../src/lib/functions";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

function video(id: string, extra: Partial<SourceMediaAssetSummary> = {}): SourceMediaAssetSummary {
  return { id, sourceId: "video-library", name: `Video ${id}`, originalName: `${id}.mp4`, description: `Description ${id}`, credit: `Credit ${id}`, license: null, tags: ["Original"], rightsStatus: "pending", version: 4, kind: "video", mimeType: "video/mp4", sizeBytes: 1024, preview: "browser", createdAt: null, updatedAt: null, ...extra };
}
function tagPlan(mode: "add" | "remove" | "replace" | "clear", value: string, assets = [video("a"), video("b")]) {
  return buildBulkMetadataPlan("video-library", assets, { ...emptyBulkMetadataDraft(), tags: { mode, value } });
}
function ports(overrides: Partial<Parameters<typeof runBulkMetadataPlan>[1]> = {}) {
  const calls: BulkPlanEntry[] = [];
  const progress: BulkResult[][] = [];
  let waits = 0;
  return { calls, progress, waits: () => waits, options: {
    save: async (entry: BulkPlanEntry) => { calls.push(entry); return { ...entry.asset, ...entry.changes, version: entry.asset.version + 1 }; },
    classifyFailure: (): BulkFailure => ({ status: "unconfirmed", stop: true, message: "Unconfirmed" }),
    shouldStop: () => false,
    wait: async () => { waits += 1; },
    onProgress: (rows: BulkResult[]) => { progress.push(rows); },
    ...overrides,
  } };
}

describe("bulk metadata planning", () => {
  it("defaults to preserving every video's distinct metadata", () => {
    const draft = emptyBulkMetadataDraft();
    assert.equal(hasBulkMetadataIntent(draft), false);
    const plan = buildBulkMetadataPlan("video-library", [video("a"), video("b")], draft);
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.entries.map(entry => entry.changes), [{}, {}]);
    assert.deepEqual(pendingBulkResults(plan).map(row => row.status), ["unchanged", "unchanged"]);
  });
  it("adds tags per file without replacing existing tags or unrelated metadata", () => {
    const assets = [video("a", { tags: ["Original", "Interview"] }), video("b", { tags: ["B-roll"] })];
    const before = JSON.stringify(assets);
    const plan = tagPlan("add", "Interview, Newark\n Newark, Budget", assets);
    assert.deepEqual(plan.entries.map(entry => entry.changes), [{ tags: ["Original", "Interview", "Newark", "Budget"] }, { tags: ["B-roll", "Interview", "Newark", "Budget"] }]);
    assert.equal(JSON.stringify(assets), before);
    assert.deepEqual(plan.errors, []);
  });
  it("preserves exact tag spelling and case", () => {
    assert.deepEqual(tagPlan("add", "original").entries[0].changes, { tags: ["Original", "original"] });
    assert.deepEqual(tagPlan("remove", "original").entries[0].changes, {});
  });
  it("removes only the requested tags", () => {
    const plan = tagPlan("remove", "Original", [video("a", { tags: ["Original", "Keep"] }), video("b", { tags: ["Keep"] })]);
    assert.deepEqual(plan.entries.map(entry => entry.changes), [{ tags: ["Keep"] }, {}]);
  });
  it("replaces or clears tags only with an explicit operation", () => {
    assert.deepEqual(tagPlan("replace", "Replacement").entries[0].changes, { tags: ["Replacement"] });
    assert.deepEqual(tagPlan("clear", "ignored").entries[0].changes, { tags: [] });
  });
  it("does not save a no-op or reorder-only tag edit", () => {
    assert.deepEqual(tagPlan("add", "Original").entries[0].changes, {});
    assert.deepEqual(tagPlan("replace", "Second, Original", [video("a", { tags: ["Original", "Second"] })]).entries[0].changes, {});
  });
  it("requires explicit clear rather than interpreting a blank replacement as deletion", () => {
    assert.ok(tagPlan("replace", " , \n ").errors.length);
    const draft = emptyBulkMetadataDraft();
    draft.description = { mode: "set", value: " " };
    assert.ok(buildBulkMetadataPlan("video-library", [video("a")], draft).errors.length);
    draft.description.mode = "clear";
    assert.deepEqual(buildBulkMetadataPlan("video-library", [video("a")], draft).entries[0].changes, { description: "" });
  });
  it("patches only chosen text and rights fields and skips already matching values", () => {
    const draft = emptyBulkMetadataDraft();
    draft.credit = { mode: "set", value: "  NJ PBS  " };
    draft.license = { mode: "clear", value: "unused" };
    draft.rightsStatus = "complete";
    const plan = buildBulkMetadataPlan("video-library", [video("a", { license: "Old" }), video("b", { credit: "NJ PBS", rightsStatus: "complete" })], draft);
    assert.deepEqual(plan.entries.map(entry => entry.changes), [{ credit: "NJ PBS", license: "", rightsStatus: "complete" }, {}]);
    assert.equal(hasBulkMetadataIntent(draft), true);
  });
  it("rejects overlong fields without silently truncating", () => {
    assert.ok(tagPlan("add", "x".repeat(81)).errors.length);
    for (const field of ["description", "credit", "license"] as const) {
      const draft = emptyBulkMetadataDraft();
      draft[field] = { mode: "set", value: "x".repeat(field === "description" ? 2001 : 501) };
      assert.ok(buildBulkMetadataPlan("video-library", [video("a")], draft).errors.length);
    }
  });
  it("validates each resulting tag set, not just the added tags", () => {
    const assets = [video("a", { tags: Array.from({ length: 30 }, (_, i) => `tag${i}`) }), video("b")];
    assert.match(tagPlan("add", "New", assets).errors[0], /Video a.*30 tags/);
    assert.deepEqual(tagPlan("add", "tag0", [assets[0]]).errors, []);
    assert.deepEqual(tagPlan("remove", "tag0", [assets[0]]).errors, []);
  });
  it("rejects empty, oversized, duplicate, cross-source and invalid-revision selections", () => {
    const draft = emptyBulkMetadataDraft();
    for (const assets of [[], Array.from({ length: 101 }, (_, i) => video(String(i))), [video("a"), video("a")], [video("a", { sourceId: "other" })], [video("a", { version: 0 })], [video("a", { version: 1.5 })]]) {
      assert.ok(buildBulkMetadataPlan("video-library", assets, draft).errors.length);
    }
    assert.deepEqual(buildBulkMetadataPlan("video-library", Array.from({ length: 100 }, (_, i) => video(String(i))), draft).errors, []);
  });
});

describe("bounded bulk saves", () => {
  it("uses one serial write per changed file, exact revisions and waits between writes", async () => {
    const p = ports();
    const plan = tagPlan("add", "New");
    const rows = await runBulkMetadataPlan(plan, p.options);
    assert.deepEqual(p.calls.map(entry => [entry.asset.id, entry.asset.version]), [["a", 4], ["b", 4]]);
    assert.equal(p.waits(), 1);
    assert.deepEqual(rows.map(row => row.status), ["saved", "saved"]);
    assert.equal(rows[0].asset.version, 5);
    assert.deepEqual(p.progress[0].map(row => row.status), ["saving", "pending"]);
    assert.deepEqual(p.progress[1].map(row => row.status), ["saved", "pending"]);
  });
  it("skips unchanged files without a token-consuming save", async () => {
    const p = ports();
    const rows = await runBulkMetadataPlan(tagPlan("add", "Original"), p.options);
    assert.equal(p.calls.length, 0);
    assert.equal(p.waits(), 0);
    assert.deepEqual(rows.map(row => row.status), ["unchanged", "unchanged"]);
  });
  it("rejects an invalid plan before making any write", async () => {
    const p = ports();
    await assert.rejects(runBulkMetadataPlan(tagPlan("add", "x".repeat(81)), p.options), /validation/);
    assert.equal(p.calls.length, 0);
  });
  it("continues after a confirmed conflict without retrying or changing the stale version", async () => {
    const ids: string[] = [];
    const p = ports({
      save: async entry => { ids.push(entry.asset.id); if (entry.asset.id === "a") throw new Error("Conflict"); return { ...entry.asset, version: 5 }; },
      classifyFailure: () => ({ status: "conflict", stop: false, message: "Review current details" }),
    });
    const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    assert.deepEqual(ids, ["a", "b"]);
    assert.deepEqual(rows.map(row => row.status), ["conflict", "saved"]);
    assert.equal(rows[0].asset.version, 4);
  });
  it("stops on an unconfirmed response and leaves later files unattempted", async () => {
    let calls = 0;
    const p = ports({ save: async () => { calls += 1; throw new Error("Network disconnected"); } });
    const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    assert.deepEqual(rows.map(row => row.status), ["unconfirmed", "pending"]);
    assert.equal(calls, 1);
  });
  it("stops after permission or rate-limit failure without automatic retries", async () => {
    const p = ports({ save: async () => { throw new Error("Stop"); }, classifyFailure: () => ({ status: "failed", stop: true, message: "Limit reached" }) });
    const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    assert.deepEqual(rows.map(row => row.status), ["failed", "pending"]);
    assert.equal(p.waits(), 0);
  });
  it("can stop before any writes, including while authentication was pending", async () => {
    const p = ports({ shouldStop: () => true });
    const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    assert.equal(p.calls.length, 0);
    assert.deepEqual(rows.map(row => row.status), ["pending", "pending"]);
  });
  it("can stop during the pacing delay without sending the next write", async () => {
    let stop = false;
    const p = ports({ shouldStop: () => stop, wait: async () => { stop = true; } });
    const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    assert.equal(p.calls.length, 1);
    assert.deepEqual(rows.map(row => row.status), ["saved", "pending"]);
  });
  it("waits for an in-flight save and reports it before honoring stop", async () => {
    let stop = false;
    const p = ports({ shouldStop: () => stop, save: async entry => { stop = true; return { ...entry.asset, version: 5 }; } });
    const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    assert.deepEqual(rows.map(row => row.status), ["saved", "pending"]);
    assert.equal(p.waits(), 0);
  });
  it("does not accept an unrelated or stale success response as a confirmed save", async () => {
    for (const extra of [{ id: "other" }, { sourceId: "other" }, { version: 4 }, { version: NaN }]) {
      const p = ports({ save: async entry => ({ ...entry.asset, version: 5, ...extra }) });
      const rows = await runBulkMetadataPlan(tagPlan("add", "New"), p.options);
      assert.deepEqual(rows.map(row => row.status), ["unconfirmed", "pending"]);
    }
  });
  it("never starts a second request until the first settles", async () => {
    let release!: (asset: SourceMediaAssetSummary) => void;
    let calls = 0;
    const p = ports({ save: async entry => { calls += 1; return calls === 1 ? new Promise(resolve => { release = resolve; }) : { ...entry.asset, version: 5 }; } });
    const work = runBulkMetadataPlan(tagPlan("add", "New"), p.options);
    await Promise.resolve();
    assert.equal(calls, 1);
    release(video("a", { version: 5 }));
    await work;
    assert.equal(calls, 2);
  });
});

function image(id: string, extra: Partial<MediaAssetSummary> = {}): MediaAssetSummary {
  return {
    id, name: `Image ${id}`, originalName: `${id}.jpg`, category: "news", categories: ["news"], tags: ["Original"],
    description: null, altText: null, license: null, credit: null, mimeType: "image/jpeg", kind: "image", sizeBytes: 2048,
    width: 1200, height: 800, url: `https://media.example/${id}.jpg`, lifecycle: "active", version: 3, etag: `"media-${id}-v3"`,
    createdAt: null, createdBy: null, updatedAt: null, updatedBy: null, ...extra,
  };
}
function editTags(add: string[], remove: string[]): BulkMetadataDraft {
  return { ...emptyBulkMetadataDraft(), tags: { mode: "edit", value: "", add, remove } };
}
const canEditAll = () => true;

describe("bulk tag editing from the inspector", () => {
  it("edit mode adds tags everywhere and removes them only where present", () => {
    const assets = [video("a", { tags: ["Original", "Budget"] }), video("b", { tags: ["B-roll"] })];
    const plan = buildBulkMetadataPlan("video-library", assets, editTags(["Newark"], ["Budget"]));
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.entries.map(entry => entry.changes), [{ tags: ["Original", "Newark"] }, { tags: ["B-roll", "Newark"] }]);
    const images = buildImageBulkPlan([image("a", { tags: ["Original", "Budget"] }), image("b", { tags: ["B-roll"] })], editTags(["Newark"], ["Budget"]), canEditAll);
    assert.deepEqual(images.errors, []);
    assert.deepEqual(images.entries.map(entry => entry.changes), [{ tags: ["Original", "Newark"] }, { tags: ["B-roll", "Newark"] }]);
    // An edit with nothing to add or remove is no tag change at all.
    assert.equal(hasBulkMetadataIntent(editTags([], [])), false);
    assert.deepEqual(buildBulkMetadataPlan("video-library", assets, editTags([], [])).entries.map(entry => entry.changes), [{}, {}]);
  });
  it("video edit mode removes only the exact spelling; the image plan removes any case variant and keeps an item's own spelling when adding one it already holds in another case", () => {
    const videos = buildBulkMetadataPlan("video-library", [video("a", { tags: ["Interview", "interview"] })], editTags([], ["interview"]));
    assert.deepEqual(videos.entries[0].changes, { tags: ["Interview"] });
    const images = buildImageBulkPlan([
      image("a", { tags: ["INTERVIEW", "Newark"] }),
      image("b", { tags: ["Budget"] }),
    ], editTags(["budget", "Trenton"], ["interview"]), canEditAll);
    assert.deepEqual(images.entries.map(entry => entry.changes), [{ tags: ["Newark", "budget", "Trenton"] }, { tags: ["Budget", "Trenton"] }]);
  });
  it("the image plan limits each result to 20 tags of 40 characters and drops case duplicates", () => {
    const full = image("a", { tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) });
    assert.deepEqual(buildImageBulkPlan([full, image("b")], editTags(["New"], []), canEditAll).errors, ["Image a: this change would exceed 20 tags."]);
    assert.deepEqual(buildImageBulkPlan([full], editTags(["TAG0"], []), canEditAll).errors, []);
    assert.deepEqual(buildImageBulkPlan([image("a")], editTags(["x".repeat(41)], []), canEditAll).errors, ["Keep each tag under 41 characters."]);
    const dupes = buildImageBulkPlan([image("a", { tags: ["Newark", "newark"] })], editTags(["Budget"], []), canEditAll);
    assert.deepEqual(dupes.entries[0].changes, { tags: ["Newark", "Budget"] });
    const added = buildImageBulkPlan([image("a")], { ...emptyBulkMetadataDraft(), tags: { mode: "add", value: "Budget, budget\nNewark" } }, canEditAll);
    assert.deepEqual(added.entries[0].changes, { tags: ["Original", "Budget", "Newark"] });
  });
  it("the image plan checks the image field limits and clears a field to null", () => {
    for (const [field, limit] of [["description", 2000], ["credit", 300], ["license", 120]] as const) {
      const draft = emptyBulkMetadataDraft();
      draft[field] = { mode: "set", value: "x".repeat(limit + 1) };
      assert.equal(buildImageBulkPlan([image("a")], draft, canEditAll).errors.length, 1);
      draft[field] = { mode: "set", value: "x".repeat(limit) };
      assert.deepEqual(buildImageBulkPlan([image("a")], draft, canEditAll).errors, []);
    }
    const draft = emptyBulkMetadataDraft();
    draft.credit = { mode: "set", value: " NJ PBS " };
    draft.license = { mode: "clear", value: "" };
    draft.rightsStatus = "complete";
    const plan = buildImageBulkPlan([image("a", { license: "CC BY" }), image("b", { credit: "NJ PBS" })], draft, canEditAll);
    assert.deepEqual(plan.entries.map(entry => entry.changes), [{ credit: "NJ PBS", license: null }, {}]);
  });
  it("the image plan leaves out images the role cannot edit and names them", () => {
    const plan = buildImageBulkPlan([image("a"), image("b", { category: "sports" })], editTags(["New"], []), asset => asset.category !== "sports");
    assert.deepEqual(plan.errors, []);
    assert.deepEqual(plan.entries.map(entry => entry.asset.id), ["a"]);
    assert.deepEqual(plan.excluded.map(row => [row.asset.name, row.reason]), [["Image b", "Your role cannot edit this image."]]);
    assert.deepEqual(buildImageBulkPlan([image("b")], editTags(["New"], []), () => false).errors, ["Your role cannot edit any of the selected images."]);
  });
  it("the image plan refuses more than MAX_BULK_IMAGES before any write", async () => {
    assert.equal(MAX_BULK_IMAGES, 100);
    const many = Array.from({ length: 101 }, (_, i) => image(String(i)));
    const plan = buildImageBulkPlan(many, editTags(["New"], []), canEditAll);
    assert.deepEqual(plan.errors, ["Select 1–100 images."]);
    assert.deepEqual(buildImageBulkPlan(many.slice(0, 100), editTags(["New"], []), canEditAll).errors, []);
    for (const assets of [[], [image("a"), image("a")], [image("a", { version: 0 })], [image("a", { etag: "" })]]) {
      assert.equal(buildImageBulkPlan(assets, editTags(["New"], []), canEditAll).errors.length, 1);
    }
    let calls = 0;
    await assert.rejects(runBulkMetadataPlan(plan, {
      save: async entry => { calls += 1; return entry.asset; },
      classifyFailure: classifyImageBulkFailure, shouldStop: () => false, wait: async () => {}, onProgress: () => {},
    }), /validation/);
    assert.equal(calls, 0);
  });
});

describe("image bulk saves", () => {
  afterEach(() => { vi.useRealTimers(); });
  function imagePorts(update: (token: string, asset: MediaAssetSummary, metadata: ImageBulkPatch) => Promise<{ asset: MediaAssetSummary }>) {
    const progress: BulkResult<MediaAssetSummary, ImageBulkPatch>[][] = [];
    return {
      progress,
      options: {
        save: imageBulkSave("id-token", update),
        classifyFailure: classifyImageBulkFailure,
        shouldStop: () => false,
        wait: () => new Promise<void>(resolve => { setTimeout(resolve, BULK_SAVE_INTERVAL_MS); }),
        onProgress: (rows: BulkResult<MediaAssetSummary, ImageBulkPatch>[]) => { progress.push(rows); },
      },
    };
  }
  it("runs the image plan one write at a time, 2.1 seconds apart, with exact ETags", async () => {
    vi.useFakeTimers();
    const sent: { at: number; token: string; etag: string; tags?: string[] }[] = [];
    const p = imagePorts(async (token, asset, metadata) => {
      sent.push({ at: Date.now(), token, etag: asset.etag, tags: metadata.tags });
      return { asset: { ...asset, ...metadata, version: asset.version + 1, etag: `"media-${asset.id}-v${asset.version + 1}"` } };
    });
    const plan = buildImageBulkPlan([image("a"), image("b", { etag: '"media-b-v7"', version: 7 }), image("c")], editTags(["New"], []), canEditAll);
    const work = runBulkMetadataPlan(plan, p.options);
    await vi.runAllTimersAsync();
    const rows = await work;
    assert.equal(BULK_SAVE_INTERVAL_MS, 2100);
    assert.deepEqual(sent.map(call => call.etag), ['"media-a-v3"', '"media-b-v7"', '"media-c-v3"']);
    assert.deepEqual(sent.map(call => call.at - sent[0].at), [0, 2100, 4200]);
    assert.ok(sent.every(call => call.token === "id-token"));
    assert.deepEqual(rows.map(row => [row.status, row.asset.version]), [["saved", 4], ["saved", 8], ["saved", 4]]);
  });
  it("confirms an image save by the same id and a higher version, and reports a missing or equal version as unconfirmed", async () => {
    for (const extra of [{ id: "other" }, { version: 3 }, { version: undefined as unknown as number }, { version: 2 }]) {
      const p = imagePorts(async (_token, asset) => ({ asset: { ...asset, version: 4, ...extra } }));
      const rows = await runBulkMetadataPlan(buildImageBulkPlan([image("a"), image("b")], editTags(["New"], []), canEditAll), { ...p.options, wait: async () => {} });
      assert.deepEqual(rows.map(row => row.status), ["unconfirmed", "pending"]);
    }
  });
  it("treats a 412 as a conflict and continues without retrying", async () => {
    const ids: string[] = [];
    const p = imagePorts(async (_token, asset) => {
      ids.push(asset.id);
      if (asset.id === "a") throw new HttpError(412, "Precondition failed");
      return { asset: { ...asset, version: asset.version + 1 } };
    });
    const rows = await runBulkMetadataPlan(buildImageBulkPlan([image("a"), image("b")], editTags(["New"], []), canEditAll), { ...p.options, wait: async () => {} });
    assert.deepEqual(ids, ["a", "b"]);
    assert.deepEqual(rows.map(row => row.status), ["conflict", "saved"]);
    assert.equal(rows[0].asset.version, 3);
    for (const [status, stop] of [[401, true], [403, true], [429, true], [400, false]] as const) {
      assert.equal(classifyImageBulkFailure(new HttpError(status, "No")).stop, stop);
    }
    assert.deepEqual(classifyImageBulkFailure(new HttpError(409, "A file replacement is in progress. Try again after it finishes.")), {
      status: "failed", stop: false, message: "A file replacement is in progress. Try again after it finishes.",
    });
    assert.deepEqual(classifyImageBulkFailure(new Error("offline")).status, "unconfirmed");
  });
});
