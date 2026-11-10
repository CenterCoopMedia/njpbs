// Typing in one block must not re-render the whole page (#511).
//
// The measurement is a render count, not a clock: a wall-clock assertion in the unit suite would
// be flaky on shared CI hardware and would answer a different question every time the machine
// changed. What the editor promises is structural -- a per-block edit reaches that block's card and
// its outline row, and nothing else -- and a count says exactly that, the same way on every
// machine. The wall-clock receipts for the same change live with the Admin performance receipts
// (#1064), not here.
//
// The instrument is ActionControl, the one component every block card and every outline row
// renders. It is wrapped, not replaced: the real control still renders, so these counts come from
// the shipped tree. It has to be wrapped *inside* the memo boundaries being measured -- a wrapper
// around a memoized component would re-render whenever its parent did and would report isolation
// that is not there. The card's controls name a block as "<label> <position>"; the outline's name
// it as "<label> <position> in content outline". Command-bar controls do not name a block and are
// excluded from the per-block counts.

import { forwardRef, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AdminBlock } from "../src/lib/block-factory";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";

vi.setConfig({ testTimeout: 10_000 });

const controlRenders: string[] = [];

vi.mock("../src/components/ui/ActionControl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/components/ui/ActionControl")>();
  return {
    ...actual,
    ActionControl: forwardRef<
      HTMLButtonElement,
      import("../src/components/ui/ActionControl").ActionControlProps
    >(function CountingActionControl(props, ref) {
      controlRenders.push(`${props.action}|${props.contextLabel ?? ""}`);
      return createElement(actual.ActionControl, { ...props, ref });
    }),
  };
});

const { BlockEditor } = await import("../src/components/BlockEditor");

beforeEach(() => {
  localStorage.setItem("njpbs-admin:outline-collapsed", "false");
  controlRenders.length = 0;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// A page of alternating headings and dividers, which is the shape a long page takes while it is
// being built: a lot of cards, each cheap, one of them being typed into.
function longPage(count: number): AdminBlock[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? {
          id: `b${index + 1}`,
          type: "headline" as const,
          order: index,
          visible: true,
          data: { text: `Heading ${index + 1}`, level: 2 },
        }
      : {
          id: `b${index + 1}`,
          type: "divider" as const,
          order: index,
          visible: true,
          data: {},
        },
  );
}

// How many times each named control rendered so far, so a before/after difference names exactly
// which surfaces React went back to.
function renderCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of controlRenders) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function since(before: Map<string, number>): Map<string, number> {
  const after = renderCounts();
  const delta = new Map<string, number>();
  for (const [name, count] of after) {
    const change = count - (before.get(name) ?? 0);
    if (change > 0) delta.set(name, change);
  }
  return delta;
}

// Every surface a delta names, reduced to the block it belongs to: "heading 3" for a card control,
// "heading 3 in content outline" for an outline control.
function touchedSurfaces(delta: Map<string, number>): string[] {
  return [
    ...new Set(
      [...delta.keys()].map((name) => name.split("|")[1]).filter(Boolean),
    ),
  ].sort();
}

function headingBody(position: number): HTMLTextAreaElement {
  const card = document.getElementById(`block-card-b${position}`);
  if (!card) throw new Error(`No card at position ${position}`);
  return within(card).getByRole("textbox", {
    name: "Heading",
  }) as HTMLTextAreaElement;
}

describe("BlockEditor per-block render isolation", () => {
  for (const size of [5, 20, 40]) {
    it(`re-renders only the edited block's card and outline row on a ${size}-block page`, async () => {
      render(<BlockEditor section="genericPage" initialBlocks={longPage(size)} />);
      await screen.findByRole("navigation", { name: "Content outline" });
      // Measure after the deferred outline mounts, so the next count is a difference
      // across the complete editor rather than a startup total.
      expect(renderCounts().size).toBeGreaterThan(size);

      fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
      const before = renderCounts();
      fireEvent.change(headingBody(1), {
        target: { value: "Tonight on NJ PBS" },
      });

      expect(touchedSurfaces(since(before))).toEqual([
        "heading 1",
        "heading 1 in content outline",
      ]);
      expect(headingBody(1).value).toBe("Tonight on NJ PBS");
    });
  }

  it("keeps the edit isolated across a run of keystrokes", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={longPage(40)} />);
    await screen.findByRole("navigation", { name: "Content outline" });

    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    const before = renderCounts();
    for (const value of ["T", "To", "Ton", "Toni", "Tonig"]) {
      fireEvent.change(headingBody(1), { target: { value } });
    }

    expect(touchedSurfaces(since(before))).toEqual([
      "heading 1",
      "heading 1 in content outline",
    ]);
    expect(headingBody(1).value).toBe("Tonig");
  });

  it("keeps a marked Home edit isolated when no row layout needs normalized orders", async () => {
    const freeBlocks = longPage(2);
    const initialBlocks = [...homeCompositionDefaults(), ...freeBlocks]
      .map((block, order) => ({ ...block, order })) as AdminBlock[];
    render(
      <BlockEditor
        section="home"
        pageId="home"
        homeCompositionVersion={1}
        initialBlocks={initialBlocks}
      />,
    );
    await screen.findByRole("navigation", { name: "Content outline" });

    const card = document.getElementById("block-card-b1");
    if (!card) throw new Error("No free Home heading card");
    fireEvent.click(within(card).getByRole("button", { name: /^Edit heading / }));
    const before = renderCounts();
    fireEvent.change(within(card).getByRole("textbox", { name: "Heading" }), {
      target: { value: "Tonight on NJ PBS" },
    });

    const touched = touchedSurfaces(since(before));
    expect(touched).toHaveLength(2);
    expect(touched.every((surface) => surface.startsWith("heading "))).toBe(true);
    expect(touched.some((surface) => surface.endsWith("in content outline"))).toBe(true);
  });

  it("re-renders a late block's own card without reaching the blocks before it", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={longPage(40)} />);
    await screen.findByRole("navigation", { name: "Content outline" });

    const card = document.getElementById("block-card-b39");
    if (!card) throw new Error("No card at position 39");
    fireEvent.click(within(card).getByRole("button", { name: "Edit heading 39" }));
    const before = renderCounts();
    fireEvent.change(headingBody(39), { target: { value: "Closing note" } });

    expect(touchedSurfaces(since(before))).toEqual([
      "heading 39",
      "heading 39 in content outline",
    ]);
  });

  // The other half of the contract: a change whose visible result reaches other surfaces must
  // still reach them. Isolation that swallowed those would be a correctness bug, not a speedup.
  it("still re-renders every surface a reorder moves", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={longPage(5)} />);
    await screen.findByRole("navigation", { name: "Content outline" });

    const before = renderCounts();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Move down: heading 1 in content outline",
      }),
    );

    // The moved block and the block it swapped with both change position, and a position is
    // rendered on the card, in the outline row, and on the insertion gaps that sit inside each
    // card's list item. They are named for where they landed: the divider is now first.
    expect(touchedSurfaces(since(before))).toEqual([
      "divider 1",
      "divider 1 in content outline",
      "heading 2",
      "heading 2 in content outline",
      "position 1",
      "position 2",
    ]);
  });

  it("still re-renders the card and row of a block whose visibility changed", async () => {
    render(<BlockEditor section="genericPage" initialBlocks={longPage(5)} />);
    await screen.findByRole("navigation", { name: "Content outline" });

    fireEvent.click(screen.getByRole("button", { name: "Edit heading 3" }));
    const before = renderCounts();
    fireEvent.click(
      screen.getByRole("button", { name: "Hide from page: heading 3" }),
    );

    expect(touchedSurfaces(since(before))).toEqual([
      "heading 3",
      "heading 3 in content outline",
    ]);
  });

  // A generated heading takes its rank from the authored headings before it, so an authored level
  // change is exactly the case where re-rendering only the edited card would be wrong.
  it("re-renders the blocks whose generated heading rank an authored change moves", async () => {
    const blocks: AdminBlock[] = [
      {
        id: "b1",
        type: "headline",
        order: 0,
        visible: true,
        data: { text: "Programs", level: 2 },
      },
      {
        id: "b2",
        type: "faq_item",
        order: 1,
        visible: true,
        data: { question: "Where can I watch?", answer: undefined },
      },
    ];
    render(<BlockEditor section="genericPage" initialBlocks={blocks} />);
    await screen.findByRole("navigation", { name: "Content outline" });
    const card = document.getElementById("block-card-b2");
    expect(card?.querySelector("h3")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit heading 1" }));
    fireEvent.change(screen.getByLabelText("Heading level"), {
      target: { value: "3" },
    });

    // The FAQ item's generated question heading follows the authored rank down.
    expect(document.getElementById("block-card-b2")?.querySelector("h4")).toBeTruthy();
  });
});
