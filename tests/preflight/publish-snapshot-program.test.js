import { describe, expect, it } from "vitest";
import snapshot from "../../functions/lib/publish-snapshot.js";

// The immutable public projection for a Program record (#923).
//
// Program is the first non-post cmsPosts kind with a public route, so this is
// where the snapshot writer stops being "posts and pages" and starts asking the
// shared routed-kind contract. Two properties matter and neither is obvious from
// reading the happy path:
//
//   - It still refuses every kind that has no route. An approved event or staff
//     record must not become a frozen public snapshot pointing at an address the
//     build never emits; the Admin hides the button, and this is the boundary
//     that holds when something calls the function anyway.
//   - A Program carries no block layout. It is a structured form -- title, genre,
//     one rich-text synopsis -- so requiring a blocks array (which is what the
//     post and page contract does) would refuse every valid program forever.

const { PROGRAM_METADATA_FIELDS, PublishSnapshotError, createPublishedSnapshot } =
  snapshot;

const AT = "2026-08-22T15:00:00.000Z";

function richText(text) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function program(overrides = {}) {
  return {
    id: "prog-one",
    type: "program",
    title: "Due Process",
    genre: "public affairs",
    description: richText("A weekly look at law and policy in New Jersey."),
    keyArt: "pbsmm-asset-4821",
    memberOnly: false,
    slug: "due-process",
    previousSlugs: [],
    locale: "en",
    version: 3,
    ...overrides,
  };
}

const freeze = (document) =>
  createPublishedSnapshot({
    collection: "cmsPosts",
    document,
    publishedAt: AT,
    publishedBy: "uid-editor",
  });

describe("freezing a program snapshot", () => {
  it("freezes the viewer-visible program metadata and its source version", () => {
    const frozen = freeze(program());

    expect(frozen.sourceVersion).toBe(3);
    expect(frozen.publishedAt).toBe(AT);
    expect(frozen.publishedBy).toBe("uid-editor");
    expect(frozen.metadata).toEqual({
      type: "program",
      title: "Due Process",
      genre: "public affairs",
      description: richText("A weekly look at law and policy in New Jersey."),
      keyArt: "pbsmm-asset-4821",
      memberOnly: false,
      slug: "due-process",
      previousSlugs: [],
      locale: "en",
    });
  });

  it("gives a program an empty block list rather than demanding one", () => {
    // A program is a structured form, not a block layout. The post and page
    // contract requires `blocks`; requiring it here would refuse every program.
    expect(program().blocks).toBeUndefined();
    expect(freeze(program()).blocks).toEqual([]);
  });

  it("copies rather than aliases, so a later draft edit cannot reach the snapshot", () => {
    const working = program();
    const frozen = freeze(working);
    working.description.content[0].content[0].text = "Rewritten after publication";
    working.previousSlugs.push("old-name");

    expect(frozen.metadata.description).toEqual(
      richText("A weekly look at law and policy in New Jersey."),
    );
    expect(frozen.metadata.previousSlugs).toEqual([]);
  });

  it("omits an absent optional field instead of storing an undefined", () => {
    const frozen = freeze(
      program({ genre: undefined, keyArt: undefined, memberOnly: undefined }),
    );
    expect(Object.keys(frozen.metadata).sort()).toEqual([
      "description",
      "locale",
      "previousSlugs",
      "slug",
      "title",
      "type",
    ]);
  });

  it("never freezes an editorial or workflow field the program form does not own", () => {
    const frozen = freeze(
      program({
        status: "published",
        createdBy: "uid-someone",
        updatedBy: "uid-someone",
        assignedTo: "uid-someone",
        reviewRequest: { note: "internal" },
      }),
    );
    for (const field of [
      "status",
      "createdBy",
      "updatedBy",
      "assignedTo",
      "reviewRequest",
    ]) {
      expect(field in frozen.metadata, field).toBe(false);
    }
    // Stated as a set as well, so a field added to the freeze list has to be a
    // deliberate edit to PROGRAM_METADATA_FIELDS rather than a silent widening.
    expect([...PROGRAM_METADATA_FIELDS].sort()).toEqual([
      "description",
      "genre",
      "keyArt",
      "keyArtAlt",
      "keyArtAssetId",
      "keyArtDecorative",
      "locale",
      "memberOnly",
      "previousSlugs",
      "slug",
      "title",
      "type",
      "watchUrl",
    ]);
  });
});

describe("refusing a program that cannot be routed or rendered", () => {
  const refuses = (document, message) => {
    expect(() => freeze(document)).toThrow(PublishSnapshotError);
    expect(() => freeze(document)).toThrow(message);
  };

  it("requires a title", () => {
    refuses(program({ title: "   " }), /requires a title/i);
  });

  it("requires a readable synopsis", () => {
    refuses(program({ description: undefined }), /synopsis/i);
    refuses(program({ description: "just a string" }), /synopsis/i);
    refuses(program({ description: { type: "doc", content: [] } }), /synopsis/i);
  });

  it("requires canonical routing metadata", () => {
    refuses(program({ slug: "" }), /canonical routing metadata/i);
    refuses(program({ previousSlugs: undefined }), /canonical routing metadata/i);
    refuses(program({ previousSlugs: [7] }), /canonical routing metadata/i);
    refuses(program({ locale: "" }), /canonical routing metadata/i);
  });

  it("requires a positive source version", () => {
    refuses(program({ version: 0 }), /source version/i);
  });
});

describe("the kinds that still have no public route", () => {
  it("refuses every library-only record kind before anything is frozen", () => {
    for (const type of ["staff", "sponsor", "newsletter"]) {
      expect(() => freeze(program({ type, blocks: [] }))).toThrow(
        /cannot be published/i,
      );
    }
  });

  it("refuses a retired kind and a missing kind the same way", () => {
    for (const type of ["article", undefined, "", "Program", "__proto__"]) {
      expect(() => freeze(program({ type, blocks: [] })), String(type)).toThrow(
        PublishSnapshotError,
      );
    }
  });

  it("still refuses an unknown collection", () => {
    expect(() =>
      createPublishedSnapshot({
        collection: "cmsPrograms",
        document: program(),
        publishedAt: AT,
        publishedBy: "uid-editor",
      }),
    ).toThrow(/Unknown publish collection/);
  });
});
