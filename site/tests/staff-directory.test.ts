import { describe, expect, it } from "vitest";
import { staffDirectoryEntries, staffProfileHref, type StaffDirectorySource } from "../src/lib/staff-directory";
import { projectPublishedPageRead } from "../src/lib/published-page-render";
import { publishedPageRead, now } from "./fixtures/published-pages/fixtures";

const AUTHOR_A = `au_${"a".repeat(32)}`;
const AUTHOR_B = `au_${"b".repeat(32)}`;
const AUTHOR_C = `au_${"c".repeat(32)}`;

function author(
  authorId: string,
  displayName: string,
  overrides: Partial<StaffDirectorySource> = {},
): StaffDirectorySource {
  return {
    authorId,
    slug: `staff-${authorId.slice(3, 11)}`,
    displayName,
    jobTitle: null,
    bio: null,
    photo: null,
    links: [],
    ...overrides,
  };
}

describe("staffDirectoryEntries", () => {
  it.each([false, true, undefined])("carries server route readiness %s through the real Staff projection to its link", async ready => {
    const input = publishedPageRead("staff");
    Object.assign(input.authors[0], { profilePageReady: ready });
    const content = await projectPublishedPageRead(input, "staff", "a".repeat(40), now);
    const [entry] = staffDirectoryEntries(content.authors);
    expect(entry.displayName).toBe("Ada Reporter");
    expect(staffProfileHref(entry)).toBe(ready === false ? undefined : entry.path);
  });
  it("sorts by public name and breaks equivalent names by stable author id", () => {
    const entries = staffDirectoryEntries([
      author(AUTHOR_C, "Zoë Carter"),
      author(AUTHOR_B, "ada reporter"),
      author(AUTHOR_A, "Ada Reporter"),
    ]);

    expect(entries.map((entry) => entry.authorId)).toEqual([
      AUTHOR_A,
      AUTHOR_B,
      AUTHOR_C,
    ]);
  });

  it("projects the canonical author route without changing public fields", () => {
    const [entry] = staffDirectoryEntries([
      author(AUTHOR_A, "Ada Reporter", {
        slug: "ada-reporter",
        jobTitle: "Statehouse reporter",
        bio: "Covers the Legislature for NJ PBS.",
        photo: {
          url: "https://media.njpbs.org/cms-media/ada.jpg",
          displayUrl: "https://media.njpbs.org/cms-media/ada.jpg",
          width: 800,
          height: 800,
          focalX: 50,
          focalY: 42,
          credit: "NJ PBS",
        },
        links: [{ platform: "bluesky", url: "https://bsky.app/profile/ada.example" }],
      }),
    ]);

    expect(entry).toMatchObject({
      authorId: AUTHOR_A,
      path: "/authors/ada-reporter/",
      initials: "AR",
      displayName: "Ada Reporter",
      jobTitle: "Statehouse reporter",
      bio: "Covers the Legislature for NJ PBS.",
      links: [{ platform: "bluesky", url: "https://bsky.app/profile/ada.example" }],
    });
  });
});
