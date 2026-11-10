import { describe, expect, it } from "vitest";
import { resolvePublicCreditLinks } from "../src/lib/public-author-links";

describe("resolvePublicCreditLinks", () => {
  it("uses the current public profile name and slug", () => {
    expect(
      resolvePublicCreditLinks(
        [{ name: "Ada Reporter", authorId: "au_ada", slug: "old-ada" }],
        [{ authorId: "au_ada", displayName: "Ada Newname", slug: "ada-newname" }],
      ),
    ).toEqual([
      { name: "Ada Newname", authorId: "au_ada", slug: "ada-newname" },
    ]);
  });

  it("removes the link when the public profile is withdrawn", () => {
    expect(
      resolvePublicCreditLinks(
        [{ name: "Ada Reporter", authorId: "au_ada", slug: "ada-reporter" }],
        [],
      ),
    ).toEqual([{ name: "Ada Reporter", authorId: "au_ada" }]);
  });

  it("keeps custom credits as unlinked display text", () => {
    expect(
      resolvePublicCreditLinks([{ name: "NJ PBS staff" }], [
        { authorId: "au_ada", displayName: "NJ PBS staff", slug: "ada-reporter" },
      ]),
    ).toEqual([{ name: "NJ PBS staff" }]);
  });

  it("keeps credit order and stable identity while only public profiles supply new names", () => {
    const credits = [
      { name: "Ada Reporter", authorId: "au_ada", slug: "old-ada" },
      { name: "Guest contributor" },
      { name: "Ben Producer", authorId: "au_ben", slug: "old-ben" },
    ];
    const authors = [
      { authorId: "au_uncredited", displayName: "Unrelated public author", slug: "another-author" },
      { authorId: "au_ada", displayName: "Ada Newname", slug: "ada-newname" },
    ];
    expect(resolvePublicCreditLinks(credits, authors)).toEqual([
      { name: "Ada Newname", authorId: "au_ada", slug: "ada-newname" },
      { name: "Guest contributor" },
      { name: "Ben Producer", authorId: "au_ben" },
    ]);
    expect(credits).toEqual([
      { name: "Ada Reporter", authorId: "au_ada", slug: "old-ada" },
      { name: "Guest contributor" },
      { name: "Ben Producer", authorId: "au_ben", slug: "old-ben" },
    ]);
  });
});
