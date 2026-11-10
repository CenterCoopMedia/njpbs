// The editor surface of the two dynamic blocks (#1046).
//
// The property under test is the one the request turns on: what an editor sees while
// configuring the shelf is the public renderer's own output over the same committed
// catalog, not a mock row. These use the real approved index by default, with explicit
// fixtures for empty-topic and off-topic-pin states that a future snapshot may lack.
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InlineBlockSurface } from "../src/components/InlineBlockSurface";
import { defaultBlockData, type AdminBlock } from "../src/lib/block-factory";
import { blockHasSettings } from "../src/lib/block-settings";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";
import type { ShelfSnapshot, StoryShelfItem } from "../../packages/content-core/src/dynamic-shelves";

const catalogOverride = vi.hoisted(() => ({
  snapshot: undefined as ShelfSnapshot<StoryShelfItem> | undefined,
}));
vi.mock("../../packages/content-core/src/shelf-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/content-core/src/shelf-catalog")>();
  return {
    ...actual,
    get RELATED_STORY_INDEX() { return catalogOverride.snapshot ?? actual.RELATED_STORY_INDEX; },
  };
});
afterEach(() => {
  cleanup();
  catalogOverride.snapshot = undefined;
});

const sparseCatalog: ShelfSnapshot<StoryShelfItem> = {
  checkedAt: "2026-09-08T00:00:00.000Z",
  provenance: "Test fixture with no Delaney Hall stories",
  items: ["business", "budget"].map((topic) => ({
    id: `fixture-${topic}`,
    source: "njpbs_related_index",
    title: `Fixture ${topic} story`,
    href: `https://www.njspotlightnews.org/2026/09/fixture-${topic}/`,
    topics: [topic],
    publishedAt: "2026-09-01T00:00:00.000Z",
    sourceLabel: "NJ Spotlight News",
  })),
};

function topicShelfBlock(overrides: Record<string, unknown> = {}): AdminBlock {
  return {
    id: "shelf-1",
    type: "topic_shelf",
    order: 0,
    visible: true,
    data: {
      title: "More on Delaney Hall",
      topic: "delaney-hall",
      source: "njpbs_related_index",
      itemLimit: 4,
      sort: "newest",
      pinned: [],
      ...overrides,
    },
  } as AdminBlock;
}

function playlistBlock(overrides: Record<string, unknown> = {}): AdminBlock {
  return {
    id: "play-1",
    type: "video_playlist",
    order: 0,
    visible: true,
    data: {
      title: "Watch: immigration",
      topic: "immigration",
      library: "njpbs_watch",
      itemLimit: 4,
      sort: "newest",
      pinned: [],
      ...overrides,
    },
  } as AdminBlock;
}

describe("the topic shelf editor surface", () => {
  it("previews the real stories the build will publish", () => {
    const topic = RELATED_STORY_INDEX.items[0].topics[0];
    const { container } = render(
      <InlineBlockSurface block={topicShelfBlock({ topic })} hasError={false} onChange={vi.fn()} />,
    );
    const newest = RELATED_STORY_INDEX.items.filter((item) =>
      item.topics.includes(topic),
    ).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0];
    expect(container.querySelector(".topic-shelf")).not.toBeNull();
    expect(container.textContent).toContain(newest.title);
  });

  it("previews an empty topic when a reviewed catalog has no matching stories", () => {
    catalogOverride.snapshot = sparseCatalog;
    const { container } = render(
      <InlineBlockSurface block={topicShelfBlock()} hasError={false} onChange={vi.fn()} />,
    );
    expect(container.querySelectorAll(".topic-shelf .shelf-card")).toHaveLength(0);
    expect(container.querySelector(".topic-shelf .shelf-empty")?.textContent).toContain("no related stories");
    const note = container.querySelector(".inline-dynamic-shelf-note")?.textContent;
    expect(note).toContain("0 cards.");
    expect(note).toContain("The topic matches 0 approved stories");
  });

  it("says how many approved stories the query found", () => {
    const { container } = render(
      <InlineBlockSurface block={topicShelfBlock()} hasError={false} onChange={vi.fn()} />,
    );
    const matches = RELATED_STORY_INDEX.items.filter((item) => item.topics.includes("delaney-hall")).length;
    const shown = Math.min(4, matches);
    const note = container.querySelector(".inline-dynamic-shelf-note")?.textContent;
    expect(note).toContain(`${shown} card${shown === 1 ? "" : "s"}.`);
    expect(note).toContain(`The topic matches ${matches} approved stor${matches === 1 ? "y" : "ies"}`);
  });

  it("previews no more cards than the cap the editor chose", () => {
    const { container } = render(
      <InlineBlockSurface
        block={topicShelfBlock({ topic: "business", itemLimit: 3 })}
        hasError={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      container.querySelectorAll(".topic-shelf .shelf-card").length,
    ).toBeLessThanOrEqual(3);
  });

  it("warns when a pinned story is no longer on the approved list", () => {
    const { container } = render(
      <InlineBlockSurface
        block={topicShelfBlock({ pinned: [{ id: "a-story-that-was-removed" }] })}
        hasError={false}
        onChange={vi.fn()}
      />,
    );
    expect(container.querySelector(".inline-dynamic-shelf-note")?.textContent).toContain(
      "a-story-that-was-removed",
    );
  });

  it("offers the bounded choices as pickers, with no free-text query field", () => {
    const { container } = render(
      <InlineBlockSurface block={topicShelfBlock()} hasError={false} onChange={vi.fn()} />,
    );
    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects.length).toBeGreaterThanOrEqual(4);
    // The only typed field is the heading an editor writes.
    const textInputs = Array.from(
      container.querySelectorAll('input[type="text"], input:not([type])'),
    );
    expect(textInputs.length).toBe(1);
    expect(screen.getByLabelText(/^Topic/)).toBeDefined();
  });

  it("edits the topic through the picker and reports the new value", () => {
    const onChange = vi.fn();
    render(
      <InlineBlockSurface block={topicShelfBlock()} hasError={false} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText(/^Topic/), { target: { value: "budget" } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "budget" }),
    );
  });

  // Finding 3: an off-topic pin is deliberately supported, so it is in `items` but not in
  // `totalMatched`. Reporting the two as one fraction produced "2 of 1 approved stories on
  // this topic", which reads as a bug in the shelf rather than as the override it is.
  it("counts a pinned override separately from the topic query", () => {
    catalogOverride.snapshot = sparseCatalog;
    const { container } = render(
      <InlineBlockSurface
        block={topicShelfBlock({
          topic: "budget",
          pinned: [{ id: "fixture-business" }],
        })}
        hasError={false}
        onChange={vi.fn()}
      />,
    );
    const note = container.querySelector(".inline-dynamic-shelf-note")?.textContent ?? "";
    expect(note).not.toMatch(/\d+ of \d+ approved/);
    expect(note).toContain("2 cards");
    expect(note).toContain("The topic matches 1 approved story");
    expect(note).toMatch(/1 pinned/i);
  });

  // Finding 1: the seventh pin used to be buildable in the UI and refused only by the
  // final parser, with a message that named no limit.
  it("stops offering Add once the pin limit is reached", () => {
    const sixPins = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    const { container, rerender } = render(
      <InlineBlockSurface
        block={topicShelfBlock({ pinned: [{ id: "x" }] })}
        hasError={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Add pinned stor/i })).not.toBeNull();
    rerender(
      <InlineBlockSurface
        block={topicShelfBlock({ pinned: sixPins })}
        hasError={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Add pinned stor/i })).toBeNull();
    expect(container.textContent).toMatch(/most .*6|6 .*most|limit of 6/i);
  });

  it("keeps its whole contract on its own surface rather than in a settings sheet", () => {
    expect(blockHasSettings("topic_shelf")).toBe(false);
    expect(blockHasSettings("video_playlist")).toBe(false);
  });
});

describe("the video playlist editor surface", () => {
  it("shows the honest empty state the shipped approved library produces", () => {
    const { container } = render(
      <InlineBlockSurface block={playlistBlock()} hasError={false} onChange={vi.fn()} />,
    );
    expect(container.querySelector(".video-playlist")).not.toBeNull();
    expect(container.querySelector(".shelf-empty")?.textContent).toContain(
      "no videos to show",
    );
    // The reason belongs to the editor, not to the public page.
    expect(container.querySelector(".inline-dynamic-shelf-note")?.textContent).toContain(
      "no videos with complete details yet",
    );
  });

  it("offers no pin control while the approved library is empty", () => {
    // An Add button that opens a picker with no choices is a dead end. The control is
    // derived from the catalog at render time, so it returns by itself once the library
    // holds a video the chosen library can resolve.
    render(
      <InlineBlockSurface block={playlistBlock()} hasError={false} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: /Add pinned video/i })).toBeNull();
  });

  // Finding 5: the picker used to offer every catalog entry whatever library the block was
  // pointed at, so an editor could pin a video the resolver would then refuse to place.
  it("offers only pins the chosen library can actually resolve", () => {
    render(
      <InlineBlockSurface
        block={playlistBlock({ library: "pbs_national" })}
        hasError={false}
        onChange={vi.fn()}
      />,
    );
    // The shipped library is empty in both halves, so no pin control is offered at all.
    expect(screen.queryByRole("button", { name: /Add pinned video/i })).toBeNull();
  });

  it("names an approved video library rather than an arbitrary source", () => {
    render(
      <InlineBlockSurface block={playlistBlock()} hasError={false} onChange={vi.fn()} />,
    );
    const library = screen.getByLabelText(/^Video library/) as HTMLSelectElement;
    const options = Array.from(library.options).map((option) => option.value);
    expect(options).toEqual(["njpbs_watch", "pbs_national"]);
  });
});

describe("a freshly inserted dynamic block", () => {
  it("starts from approved defaults for both types", () => {
    const topic = defaultBlockData("topic_shelf");
    expect(topic).toEqual({
      title: "",
      topic: "budget",
      source: "njpbs_related_index",
      itemLimit: 3,
      sort: "newest",
      pinned: [],
    });
    const playlist = defaultBlockData("video_playlist");
    expect(playlist).toEqual({
      title: "",
      topic: "budget",
      library: "njpbs_watch",
      itemLimit: 3,
      sort: "newest",
      pinned: [],
    });
  });

  it("renders a brand-new block without crashing on its blank heading", () => {
    const fresh: AdminBlock = {
      id: "new-1",
      type: "video_playlist",
      order: 0,
      visible: true,
      data: defaultBlockData("video_playlist"),
    };
    const { container } = render(
      <InlineBlockSurface block={fresh} hasError={false} onChange={vi.fn()} />,
    );
    expect(container.querySelector(".video-playlist")).not.toBeNull();
  });
});
