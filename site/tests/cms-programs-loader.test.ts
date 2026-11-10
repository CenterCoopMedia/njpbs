import { describe, expect, it } from "vitest";
import {
  assertProgramRouteUniqueness,
  projectCmsProgram,
  type CmsProgramDoc,
} from "../src/lib/cms-programs-loader";

// The public Program projection (#923). Mirrors tests/cms-posts-loader.test.ts in
// shape because the two answer the same question about different content: what
// may this build put on njpbs.org, and what must it refuse.
//
// A Program differs from a Post in three ways that each need their own case: it
// has no block layout, no byline and no editorial date; its synopsis is one
// rich-text document; and its key art is a PBS Media Manager identifier rather
// than a station media asset, so the projection must not try to resolve it.

const NOW = new Date("2026-08-22T18:00:00.000Z");

function synopsis(text = "A weekly look at law and policy in New Jersey.") {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function snapshotMetadata(overrides: Record<string, unknown> = {}) {
  return {
    type: "program",
    title: "Due Process",
    genre: "public affairs",
    description: synopsis(),
    keyArt: "pbsmm-asset-4821",
    memberOnly: false,
    slug: "due-process",
    previousSlugs: [],
    locale: "en",
    ...overrides,
  };
}

function program(
  overrides: Partial<CmsProgramDoc> = {},
  metadata: Record<string, unknown> = {},
): CmsProgramDoc {
  return {
    id: "prog-one",
    status: "published",
    publishAt: "2026-08-20T14:00:00.000Z",
    published: {
      blocks: [],
      metadata: snapshotMetadata(metadata),
      publishedAt: "2026-08-20T14:00:00.000Z",
      publishedBy: "uid-editor",
      sourceVersion: 4,
    },
    ...overrides,
  };
}

describe("admission", () => {
  it("projects an admitted published program at /programs/{slug}/", () => {
    const projected = projectCmsProgram(program(), { now: NOW });

    expect(projected).not.toBeNull();
    expect(projected?.path).toBe("/programs/due-process/");
    expect(projected?.programId).toBe("prog-one");
    expect(projected?.title).toBe("Due Process");
    expect(projected?.genre).toBe("public affairs");
    expect(projected?.memberOnly).toBe(false);
    expect(projected?.sourceVersion).toBe(4);
    expect(projected?.publishedAt).toBe("2026-08-20T14:00:00.000Z");
  });

  it("refuses to emit a draft, a soft-deleted program, or a future scheduled one", () => {
    expect(projectCmsProgram(program({ status: "draft" }), { now: NOW })).toBeNull();
    expect(projectCmsProgram(program({ deleted: true }), { now: NOW })).toBeNull();
    expect(
      projectCmsProgram(
        program({ status: "scheduled", publishAt: "2027-01-01T00:00:00.000Z" }),
        { now: NOW },
      ),
    ).toBeNull();
  });

  // Withdrawal is the property this route family is judged on: a program taken
  // off the site must stop being emitted on the next build, and its recovery
  // data must survive. Unpublish keeps the snapshot and clears public visibility.
  it("stops emitting a withdrawn program while its snapshot stays intact", () => {
    const withdrawn = program({ publiclyVisible: false });

    expect(projectCmsProgram(withdrawn, { now: NOW })).toBeNull();
    expect(withdrawn.published).toBeTruthy();
    // Restoring visibility brings the same route back rather than minting a new one.
    expect(
      projectCmsProgram(program({ publiclyVisible: true }), { now: NOW })?.path,
    ).toBe("/programs/due-process/");
  });

  it("ignores the other record kinds that share the cmsPosts collection", () => {
    for (const type of ["post", "event", "staff", "sponsor", "newsletter", "article"]) {
      expect(projectCmsProgram(program({}, { type }), { now: NOW }), type).toBeNull();
    }
  });

  it("never reads the working document over the published snapshot", () => {
    const projected = projectCmsProgram(
      program({
        title: "A draft retitle nobody approved",
        slug: "draft-slug",
        genre: "draft genre",
      }),
      { now: NOW },
    );

    expect(projected?.title).toBe("Due Process");
    expect(projected?.genre).toBe("public affairs");
    expect(projected?.path).toBe("/programs/due-process/");
  });
});

describe("routing", () => {
  it("emits a redirect stub for every route-safe retired slug", () => {
    const projected = projectCmsProgram(program({}, {
      slug: "due-process",
      previousSlugs: ["law-and-order-nj", "due-process-nj"],
    }), { now: NOW });

    expect(projected?.previousSlugs).toEqual(["law-and-order-nj", "due-process-nj"]);
  });

  it("drops a retired slug it cannot route without refusing the program", () => {
    // The live page is still correct; the unroutable old URL simply gets no stub.
    const projected = projectCmsProgram(program({}, {
      previousSlugs: ["Old Name", "old-name"],
    }), { now: NOW });

    expect(projected?.previousSlugs).toEqual(["old-name"]);
    expect(projected?.path).toBe("/programs/due-process/");
  });

  it("refuses a program whose published slug cannot be routed", () => {
    expect(() =>
      projectCmsProgram(program({}, { slug: "Due Process" }), { now: NOW }),
    ).toThrow(/route-safe/);
    expect(() =>
      projectCmsProgram(program({}, { slug: undefined }), { now: NOW }),
    ).toThrow(/route-safe/);
  });

  it("refuses a build in which two programs claim the same route", () => {
    const one = projectCmsProgram(program(), { now: NOW })!;
    const two = projectCmsProgram(
      program({ id: "prog-two" }, { previousSlugs: ["due-process"] }),
      { now: NOW },
    )!;

    expect(() => assertProgramRouteUniqueness([one, two])).toThrow(
      /\/programs\/due-process\/ is claimed by/,
    );
  });

  it("accepts a set with no collision", () => {
    const one = projectCmsProgram(program(), { now: NOW })!;
    const two = projectCmsProgram(
      program({ id: "prog-two" }, { slug: "state-of-affairs" }),
      { now: NOW },
    )!;

    expect(() => assertProgramRouteUniqueness([one, two])).not.toThrow();
  });
});

describe("the projected program body", () => {
  it("carries the frozen synopsis as rich text, not as a working draft", () => {
    const projected = projectCmsProgram(program(), { now: NOW });
    expect(projected?.description).toEqual(synopsis());
  });

  it("refuses an admitted program with no readable synopsis", () => {
    expect(() =>
      projectCmsProgram(program({}, { description: undefined }), { now: NOW }),
    ).toThrow(/synopsis/);
    expect(() =>
      projectCmsProgram(program({}, { description: "plain string" }), { now: NOW }),
    ).toThrow(/synopsis/);
    expect(() =>
      projectCmsProgram(
        program({}, { description: { type: "doc", content: [] } }),
        { now: NOW },
      ),
    ).toThrow(/synopsis/);
  });

  it("refuses an admitted program with no published title", () => {
    expect(() =>
      projectCmsProgram(program({}, { title: "  " }), { now: NOW }),
    ).toThrow(/title/);
  });

  it("refuses an admitted program with no source version or publish time", () => {
    expect(() =>
      projectCmsProgram(
        program({ published: { ...program().published as object, sourceVersion: 0 } }),
        { now: NOW },
      ),
    ).toThrow(/source version/);
    expect(() =>
      projectCmsProgram(
        program({
          published: { ...(program().published as object), publishedAt: 42 },
        }),
        { now: NOW },
      ),
    ).toThrow(/publish time/);
  });

  it("marks a members-only program without inventing one", () => {
    expect(projectCmsProgram(program({}, { memberOnly: true }), { now: NOW })?.memberOnly)
      .toBe(true);
    // A missing or non-boolean stored value reads as not members-only rather
    // than putting a Passport claim on a page nobody made.
    expect(
      projectCmsProgram(program({}, { memberOnly: undefined }), { now: NOW })?.memberOnly,
    ).toBe(false);
    expect(
      projectCmsProgram(program({}, { memberOnly: "yes" }), { now: NOW })?.memberOnly,
    ).toBe(false);
  });

  it("leaves an absent genre absent instead of printing an empty label", () => {
    expect(
      projectCmsProgram(program({}, { genre: undefined }), { now: NOW })?.genre,
    ).toBeNull();
    expect(
      projectCmsProgram(program({}, { genre: "   " }), { now: NOW })?.genre,
    ).toBeNull();
  });

  // Existing Media Manager identifiers are ignored until staff choose library art.

  it("resolves media-library key art and ignores the old Media Manager ID", () => {
    const asset = { url: "https://media.njpbs.org/cms-media/program.jpg", mimeType: "image/jpeg", width: 1200, height: 675 };
    const projected = projectCmsProgram(program({}, { keyArtAssetId: "program-art", keyArtAlt: "A studio portrait", keyArtDecorative: false, watchUrl: "https://watch.njpbs.org/show/due-process/" }), { now: NOW, assets: new Map([["program-art", asset]]) });
    expect(projected?.keyArt).toMatchObject({ assetId: "program-art", width: 1200 });
    expect(projected?.keyArtAlt).toBe("A studio portrait");
    expect(projected?.watchUrl).toBe("https://watch.njpbs.org/show/due-process/");
    expect(JSON.stringify(projected)).not.toContain("pbsmm-asset-4821");
  });

  it("accepts the watch portal root and rejects unrelated hosts", () => {
    expect(projectCmsProgram(program({}, { watchUrl: "https://watch.njpbs.org" }), { now: NOW })?.watchUrl).toBe("https://watch.njpbs.org/");
    expect(() => projectCmsProgram(program({}, { watchUrl: "https://watch.njpbs.org.example.com/show" }), { now: NOW })).toThrow(/watch URL/);
  });

  it("fails closed when referenced library art is missing", () => {
    expect(() => projectCmsProgram(program({}, { keyArtAssetId: "missing" }), { now: NOW })).toThrow(/missing media asset/);
  });

  it("ignores legacy Media Manager key art", () => {
    const projected = projectCmsProgram(program(), { now: NOW });
    expect(projected?.assets).toEqual({});
    expect(JSON.stringify(projected)).not.toContain("pbsmm-asset-4821");
  });
});
