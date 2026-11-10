import { expect, it } from "vitest";
import contract from "../../functions/lib/no-build-record-contract.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import { projectCmsProgram } from "../../site/src/lib/cms-programs-projection";
import { projectCmsEvent } from "../../site/src/lib/cms-events-projection";
import { recordDocument, now, asset } from "../../site/tests/fixtures/published-records/fixtures";

function fixture(kind: "program" | "event") {
  const source = recordDocument(kind);
  // The existing snapshot writer and static fixtures predate this contract.
  const snapshot = snapshots.createPublishedSnapshot({ collection: "cmsPosts",
    document: { ...source.published.metadata, version: 7 },
    publishedAt: "2026-10-10T12:00:00.000Z", publishedBy: "fixture-editor" });
  return { family: kind === "program" ? "programs" : "events", documentId: `${kind}-one`, snapshot };
}

it.each(["program", "event"] as const)("retains the static %s fixture's canonical and historical routes", kind => {
  const input = fixture(kind);
  const plan = contract.validateNoBuildRecordSnapshot(input);
  const document = { ...recordDocument(kind), published: input.snapshot };
  const options = { now, assets: new Map([[asset.id, asset]]) };
  const projected = kind === "program" ? projectCmsProgram(document, options) : projectCmsEvent(document, options);
  expect(projected?.path).toBe(`/${input.family}/current-${kind}-one/`);
  expect(projected?.previousSlugs).toEqual([`earlier-${kind}-one`]);
  expect(plan).toEqual({ family: input.family, kind, documentId: `${kind}-one`, sourceVersion: 7,
    canonicalPath: `/${input.family}/current-${kind}-one/`, assetIds: ["record-art"],
    ownedPaths: kind === "program" ? ["/programs/current-program-one/", "/programs/earlier-program-one/",
      "/shows/current-program-one/", "/shows/earlier-program-one/"] :
      ["/events/current-event-one/", "/events/earlier-event-one/"] });
  expect(contract.recordIndexPaths(input.family)).toEqual(kind === "program" ? ["/programs/", "/shows/"] : ["/events/"]);
});

it("matches static alias filtering without losing route-safe historical addresses", () => {
  const input = fixture("program");
  input.snapshot.metadata.previousSlugs = ["current-program-one", "older", "older", "old/bad", "Old", ""];
  expect(contract.validateNoBuildRecordSnapshot(input).ownedPaths).toEqual([
    "/programs/current-program-one/", "/programs/older/", "/shows/current-program-one/", "/shows/older/",
  ]);
});

it("recognizes only exact detail/index paths, including the retained shows family", () => {
  for (const path of ["/programs/", "/shows/", "/programs/a/", "/shows/old-a/"]) {
    expect(contract.recordFamilyForPath(path)).toBe("programs");
  }
  for (const path of ["/events/", "/events/one/"]) expect(contract.recordFamilyForPath(path)).toBe("events");
  for (const path of ["/programs", "/shows/a/b/", "/programs/A/", "/programs/%61/", "/events/../", "/posts/a/", "/events/a/?x=1"]) {
    expect(contract.recordFamilyForPath(path)).toBeNull();
  }
});

it.each(["program", "event"] as const)("refuses malformed %s snapshots before accepting source identity", kind => {
  const input = fixture(kind);
  const snapshot = input.snapshot;
  const metadata = snapshot.metadata;
  for (const candidate of [
    { ...snapshot, sourceVersion: 0 }, { ...snapshot, sourceVersion: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, contentVersion: 0 }, { ...snapshot, publishedAt: "2026-02-30T12:00:00.000Z" },
    { ...snapshot, publishedBy: " " }, { ...snapshot, blocks: [{ type: "text" }] },
    { ...snapshot, privateNotes: "private" }, { ...snapshot, metadata: { ...metadata, draftTitle: "private" } },
    { ...snapshot, metadata: { ...metadata, type: "post" } },
    { ...snapshot, metadata: { ...metadata, slug: "../escape" } },
    { ...snapshot, metadata: { ...metadata, previousSlugs: [7] } },
    { ...snapshot, metadata: { ...metadata, previousSlugs: Array(101).fill("old") } },
    { ...snapshot, metadata: { ...metadata, description: { type: "doc", content: [] } } },
    { ...snapshot, metadata: { ...metadata, [kind === "program" ? "keyArtAssetId" : "imageAssetId"]: "../private" } },
    { ...snapshot, metadata: { ...metadata, [kind === "program" ? "watchUrl" : "registrationUrl"]: "javascript:alert(1)" } },
    { ...snapshot, metadata: { ...metadata, [kind === "program" ? "watchUrl" : "registrationUrl"]: 0 } },
  ]) {
    expect(() => contract.validateNoBuildRecordSnapshot({ ...input, snapshot: candidate })).toThrow();
  }
  expect(() => contract.validateNoBuildRecordSnapshot({ ...input, documentId: "cmsPosts/id" })).toThrow();
  expect(() => contract.validateNoBuildRecordSnapshot({ ...input, family: "posts" })).toThrow();
});

it("keeps Event date, registration, and image accessibility validation", () => {
  const input = fixture("event");
  for (const patch of [{ startsAt: "bad" }, { endsAt: "2026-10-20T22:00:00.000Z" },
    { onlineUrl: "http://example.test" }, { imageDecorative: true, imageAlt: "nonempty" }, { isFree: true, priceText: "$5" }]) {
    expect(() => contract.validateNoBuildRecordSnapshot({ ...input,
      snapshot: { ...input.snapshot, metadata: { ...input.snapshot.metadata, ...patch } } })).toThrow();
  }
});

it("bounds untrusted input without invoking getters or admitting typed/cyclic values", () => {
  const input = fixture("program");
  let called = false;
  const getter = { get metadata() { called = true; return input.snapshot.metadata; } };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const snapshot of [getter, cycle, { ...input.snapshot, blocks: Array(1) },
    { ...input.snapshot, metadata: { ...input.snapshot.metadata, genre: new Date() } },
    { ...input.snapshot, metadata: { ...input.snapshot.metadata, title: "a".repeat(512 * 1024) } }]) {
    expect(() => contract.validateNoBuildRecordSnapshot({ ...input, snapshot })).toThrow();
    expect(() => contract.recordSnapshotDigest(snapshot)).toThrow();
  }
  expect(called).toBe(false);
});

it("seals map values independent of insertion order and preserves array order", () => {
  const { snapshot } = fixture("program");
  const reversed = { ...snapshot, metadata: Object.fromEntries(Object.entries(snapshot.metadata).reverse()) };
  expect(contract.recordSnapshotDigest(snapshot)).toBe(contract.recordSnapshotDigest(reversed));
  const changed = { ...snapshot, metadata: { ...snapshot.metadata, title: "A different title" } };
  expect(contract.recordSnapshotDigest(snapshot)).not.toBe(contract.recordSnapshotDigest(changed));
  expect(contract.recordSnapshotDigest(["one", "two"])).not.toBe(contract.recordSnapshotDigest(["two", "one"]));
});
