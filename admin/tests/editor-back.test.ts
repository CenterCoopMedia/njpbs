import { describe, expect, it } from "vitest";
import { editorBackDestination } from "../src/lib/editor-back";

// The Back action an editor offers: where it goes and what it says. Kept pure so the rule is
// checked here rather than through a rendered editor, and so the editor holds one call instead of
// its own origin parsing.
describe("editorBackDestination", () => {
  it("sends a record editor to its own list when nothing says where it came from", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
      }),
    ).toEqual({ to: "/content/post", label: "Back to post list", shortLabel: "Posts" });
  });

  it("sends a page editor to the page directory when nothing says where it came from", () => {
    expect(editorBackDestination({ surface: { kind: "page" } })).toEqual({
      to: "/content",
      label: "Back to pages", shortLabel: "Pages",
    });
  });

  it("returns a record editor to the filtered library it was opened from", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/content/library?status=draft&kind=post",
      }),
    ).toEqual({
      to: "/content/library?status=draft&kind=post",
      label: "Back to All content", shortLabel: "All content",
    });
  });

  it("returns a page editor to the filtered library it was opened from", () => {
    expect(
      editorBackDestination({
        surface: { kind: "page" },
        origin: "/content/library?status=published",
      }),
    ).toEqual({
      to: "/content/library?status=published",
      label: "Back to All content", shortLabel: "All content",
    });
  });

  it("keeps a record list origin of the same type, query and all", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/content/post?page=2",
      }),
    ).toEqual({ to: "/content/post?page=2", label: "Back to post list", shortLabel: "Posts" });
  });

  it("ignores a record list origin for a different record type", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/content/article",
      }),
    ).toEqual({ to: "/content/post", label: "Back to post list", shortLabel: "Posts" });
  });

  it("ignores an origin that is not a content list at all", () => {
    for (const origin of [
      "/content/post/post-1/edit",
      "/content/pages/home/edit",
      "/media",
      "https://example.com/content/library",
      "//evil.example.com",
      "",
      null,
    ]) {
      expect(
        editorBackDestination({
          surface: { kind: "record", record: "post" },
          listLabel: "Post",
          origin,
        }),
      ).toEqual({ to: "/content/post", label: "Back to post list", shortLabel: "Posts" });
    }
  });

  it("returns a record editor to the editorial queue it was opened from", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/publish-queue",
      }),
    ).toEqual({ to: "/publish-queue", label: "Back to editorial queue", shortLabel: "Editorial queue" });
  });

  it("returns a page editor to the editorial queue it was opened from", () => {
    // The queue lists pages and records side by side, so either editor can honestly go back to it.
    expect(
      editorBackDestination({
        surface: { kind: "page" },
        origin: "/publish-queue",
      }),
    ).toEqual({ to: "/publish-queue", label: "Back to editorial queue", shortLabel: "Editorial queue" });
  });

  it("returns an editor to newsroom home when the work was opened from there", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/",
      }),
    ).toEqual({ to: "/", label: "Back to newsroom home", shortLabel: "Home" });
  });

  it("keeps a work list's own query when it carries one", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/publish-queue?assignee=me",
      }),
    ).toEqual({
      to: "/publish-queue?assignee=me",
      label: "Back to editorial queue", shortLabel: "Editorial queue",
    });
  });

  it("recognizes a work list recorded with a trailing slash", () => {
    // The same route, spelled the way a hand-typed or copied address often arrives. Failing the
    // match here would recreate the exact wrong turn this destination exists to remove.
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/publish-queue/",
      }),
    ).toEqual({ to: "/publish-queue", label: "Back to editorial queue", shortLabel: "Editorial queue" });
  });

  it("keeps a trailing-slash work list's query", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/publish-queue/?assignee=me",
      }),
    ).toEqual({
      to: "/publish-queue?assignee=me",
      label: "Back to editorial queue", shortLabel: "Editorial queue",
    });
  });

  it("does not treat a work list's sub-path as that work list", () => {
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/publish-queue/anything",
      }),
    ).toEqual({ to: "/content/post", label: "Back to post list", shortLabel: "Posts" });
  });

  it("accepts the page directory as a page editor origin", () => {
    expect(
      editorBackDestination({ surface: { kind: "page" }, origin: "/content" }),
    ).toEqual({ to: "/content", label: "Back to pages", shortLabel: "Pages" });
  });

  it("does not treat the page directory as a record editor origin", () => {
    // The page directory lists pages, not records, so a record editor that somehow carries it
    // still offers its own list rather than a destination that cannot show the record.
    expect(
      editorBackDestination({
        surface: { kind: "record", record: "post" },
        listLabel: "Post",
        origin: "/content",
      }),
    ).toEqual({ to: "/content/post", label: "Back to post list", shortLabel: "Posts" });
  });
});
