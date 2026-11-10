import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SelectionBar, type SelectionBarProps } from "../src/components/media/SelectionBar";
import { mediaBarActions, mediaSelectionActions } from "../src/lib/media-tile-actions";
import { selectionSummary } from "../src/lib/media-selection";

const css = readFileSync(resolve(process.cwd(), "src/components/media/SelectionBar.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

function bar(overrides: Partial<SelectionBarProps> = {}) {
  const count = overrides.count ?? 5;
  const props: SelectionBarProps = {
    label: "Collection selection",
    count,
    offPage: 0,
    info: "Selection carries across image pages and filters.",
    pageState: "some",
    onPageChange: vi.fn(),
    actions: mediaBarActions(mediaSelectionActions({ surface: "images", count, canEdit: false })),
    onAction: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<SelectionBar {...props} />) };
}

describe("SelectionBar", () => {
  it("shows only with a selection", () => {
    const { rerender, props } = bar({ count: 0 });
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    rerender(<SelectionBar {...props} count={5} />);
    const group = screen.getByRole("group", { name: "Collection selection" });
    // The route's always-mounted status announces the count; the bar has no live region.
    expect(group.querySelector("[role='status'], [aria-live]")).toBeNull();
    expect(screen.getByRole("button", { name: "About selection" })).toHaveAccessibleDescription(
      "Selection carries across image pages and filters.",
    );
  });

  it("summarizes the off-page count and the cap", () => {
    bar({
      label: "Video selection",
      count: 7,
      cap: 100,
      offPage: 3,
      info: undefined,
      actions: mediaBarActions(mediaSelectionActions({ surface: "video", count: 7, canEdit: true })),
    });
    const group = screen.getByRole("group", { name: "Video selection" });
    expect(group.querySelector(".media-selection-bar-count")?.textContent).toBe(
      selectionSummary({ count: 7, offPage: 3, cap: 100 }),
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Add to favorites", "Remove from favorites", "Add to collection", "Edit selected", "Clear selection",
    ]);
  });

  it("Select this page is mixed when part of the page is selected", () => {
    const { props, rerender } = bar({ pageState: "some" });
    const page = screen.getByRole("checkbox", { name: "Select this page" }) as HTMLInputElement;
    expect(page.indeterminate).toBe(true);
    expect(page).not.toBeChecked();
    fireEvent.click(page);
    expect(props.onPageChange).toHaveBeenCalledWith(true);

    rerender(<SelectionBar {...props} pageState="all" />);
    expect(page.indeterminate).toBe(false);
    expect(page).toBeChecked();
    fireEvent.click(page);
    expect(props.onPageChange).toHaveBeenLastCalledWith(false);
  });

  it("Add to collection is disabled past 30 and says why", () => {
    const { props } = bar({ count: 31 });
    const collect = screen.getByRole("button", { name: "Add to collection" });
    expect(collect).toBeDisabled();
    expect(collect).toHaveAccessibleDescription("Select no more than 30 items for one collection change.");
    expect(screen.getByRole("alert")).toHaveTextContent("Select no more than 30 items for one collection change.");
    fireEvent.click(collect);
    expect(props.onAction).not.toHaveBeenCalled();
  });

  it("the promoted actions call back with their ids", () => {
    const { props } = bar();
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    expect(props.onAction).toHaveBeenCalledWith("collect");
  });

  it("Clear selection clears and hands focus back to the caller", () => {
    function Caller() {
      const [count, setCount] = useState(4);
      const card = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={card} type="button">Item 3</button>
          <SelectionBar
            actions={mediaBarActions(mediaSelectionActions({ surface: "images", count, canEdit: false }))}
            count={count}
            label="Collection selection"
            offPage={0}
            onAction={() => {}}
            onClear={() => {
              setCount(0);
              card.current?.focus();
            }}
            onPageChange={() => {}}
            pageState="all"
          />
        </>
      );
    }
    render(<Caller />);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("group", { name: "Collection selection" })).toBeNull();
    expect(screen.getByRole("button", { name: "Item 3" })).toHaveFocus();
  });

  it("uses explicit pointer targets and preserves text preference as results narrow, down to 21rem", () => {
    expect(css).toMatch(/@container media-selection \(max-width: 40rem\)/);
    expect(css).toMatch(/@container media-selection \(max-width: 25rem\)/);
    expect(css).toMatch(/@container media-selection \(max-width: 21rem\)\s*\{\s*\.media-selection-bar-page-short,\s*\.media-selection-bar-divider\s*\{\s*display: none;/);
    expect(css).toMatch(/min-width: var\(--cms-control-standard-target\)/);
    expect(css).toContain('.media-selection-bar[data-presentation="icons"] .media-selection-bar-label');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
