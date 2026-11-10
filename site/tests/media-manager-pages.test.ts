import { describe, it, expect } from "vitest";
import {
  CATALOG_BASE,
  episodePageMeta,
  episodePath,
  programPageMeta,
  programPath,
} from "../src/lib/media-manager-pages";
import type {
  CatalogEpisode,
  CatalogProgram,
} from "../src/lib/media-manager-catalog";

// Minimal catalog models. CatalogProgram / CatalogEpisode are the transform's
// output (media-manager-catalog.ts); here we build them directly to exercise the
// page-model seam's contract rather than re-run the transform.
function episode(over: Partial<CatalogEpisode> = {}): CatalogEpisode {
  return {
    id: "ep1",
    slug: "bald-eagles",
    title: "Bald eagles",
    description: "A year in the life of a bald eagle family.",
    seasonNumber: 2,
    episodeNumber: 5,
    premieredOn: "2026-03-14",
    playback: {
      partnerPlayerSrc: null,
      hasCaptions: false,
      captions: [],
      transcripts: [],
    },
    ...over,
  };
}

function program(over: Partial<CatalogProgram> = {}): CatalogProgram {
  return {
    id: "sh1",
    slug: "nature",
    title: "Nature",
    description: "Wildlife documentaries from around the world.",
    genre: "Documentary",
    episodes: [],
    ...over,
  };
}

describe("catalog route paths (issue #190)", () => {
  it("puts a program under the catalog base and an episode under its program", () => {
    expect(programPath(program())).toBe(`${CATALOG_BASE}/nature/`);
    expect(episodePath(program(), episode())).toBe(
      `${CATALOG_BASE}/nature/bald-eagles/`,
    );
  });

  it("scopes an episode path to its program, so a shared episode slug stays distinct", () => {
    const shared = episode({ slug: "pilot" });
    const a = episodePath(program({ slug: "nature" }), shared);
    const b = episodePath(program({ slug: "frontline" }), shared);
    expect(a).not.toBe(b);
    expect(a).toBe(`${CATALOG_BASE}/nature/pilot/`);
    expect(b).toBe(`${CATALOG_BASE}/frontline/pilot/`);
  });

  it("stays well-formed when a program slug fell back to the show id", () => {
    // buildProgram uses the show id when Media Manager gives no slug, so the path
    // builder must handle an id-shaped slug the same as a word slug.
    const p = program({ slug: "5e8f2a1c" });
    expect(programPath(p)).toBe(`${CATALOG_BASE}/5e8f2a1c/`);
    expect(episodePath(p, episode())).toBe(
      `${CATALOG_BASE}/5e8f2a1c/bald-eagles/`,
    );
  });
});

describe("catalog page metadata (issue #190)", () => {
  it("gives a program page its title, description, and canonical path", () => {
    const p = program();
    expect(programPageMeta(p)).toEqual({
      title: "Nature",
      description: "Wildlife documentaries from around the world.",
      canonicalPath: `${CATALOG_BASE}/nature/`,
    });
  });

  it("carries the program in an episode title so a generic episode name stays distinct", () => {
    const meta = episodePageMeta(program(), episode({ title: "Episode 1" }));
    expect(meta.title).toBe("Episode 1, Nature");
    expect(meta.canonicalPath).toBe(`${CATALOG_BASE}/nature/bald-eagles/`);
  });

  it("uses the episode's own description verbatim", () => {
    const meta = episodePageMeta(program(), episode());
    expect(meta.description).toBe("A year in the life of a bald eagle family.");
  });

  it("does not repeat the program when an episode shares its title (a one-off special)", () => {
    const meta = episodePageMeta(
      program({ title: "The Address" }),
      episode({ title: "The Address" }),
    );
    expect(meta.title).toBe("The Address");
  });
});
