import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MediaSortControl } from "../src/components/media/MediaSortControl";
import type { MediaSortDirection, MediaSortField } from "../src/lib/functions";

function Harness({ onChange = () => {} }: { onChange?: (next: unknown) => void }) {
  const [sort, setSort] = useState<{ sort: MediaSortField; direction: MediaSortDirection }>({ sort: "updatedAt", direction: "desc" });
  return (
    <MediaSortControl
      direction={sort.direction}
      onChange={(next) => {
        onChange(next);
        setSort({ sort: next.sort, direction: next.direction });
      }}
      sort={sort.sort}
    />
  );
}

describe("MediaSortControl", () => {
  it("names the trigger with field and direction", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Sort: Last updated, newest first" });
    expect(trigger).toHaveClass("button", "button-secondary");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Sort: Last updated");
  });

  it("opens a Sort dialog with focus on the checked field radio, and radios that reflect the query", () => {
    render(<MediaSortControl direction="asc" onChange={() => {}} sort="name" />);
    const trigger = screen.getByRole("button", { name: "Sort: Name, A–Z" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Sort" });
    const name = within(dialog).getByRole("radio", { name: "Name" });
    expect(name).toBeChecked();
    expect(name).toHaveFocus();
    expect(within(dialog).getByRole("group", { name: "Sort by" })).toContainElement(name);
    const direction = within(dialog).getByRole("group", { name: "Direction" });
    expect(within(direction).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label") ?? radio.parentElement?.textContent))
      .toEqual(["A–Z", "Z–A"]);
    expect(within(direction).getByRole("radio", { name: "A–Z" })).toBeChecked();
  });

  it("reports page 1 with each field or direction change and stays open", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "File size" }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: "sizeBytes", direction: "desc", page: 1 });
    fireEvent.click(screen.getByRole("radio", { name: "Smallest first" }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: "sizeBytes", direction: "asc", page: 1 });
    expect(screen.getByRole("dialog", { name: "Sort" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort: File size, smallest first" })).toBeInTheDocument();
  });

  it("uses the target field's first direction when the current direction is not allowed", () => {
    const onModelChange = vi.fn();
    render(
      <MediaSortControl
        model={{
          value: "updated",
          direction: "desc",
          options: [
            { value: "updated", label: "Last updated", directions: [{ value: "desc", label: "Newest first" }, { value: "asc", label: "Oldest first" }] },
            { value: "name", label: "Name", directions: [{ value: "asc", label: "A–Z" }] },
          ],
        }}
        onModelChange={onModelChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Sort:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Name" }));
    expect(onModelChange).toHaveBeenCalledWith({ value: "name", direction: "asc" });
  });

  it("returns focus to the trigger on Escape", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /^Sort:/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("uses a supplied anchor when the trigger is not mounted", () => {
    function FromMore() {
      const moreRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} ref={moreRef} type="button">More actions</button>
          <MediaSortControl
            anchorRef={moreRef}
            direction="desc"
            onChange={() => {}}
            onOpenChange={setOpen}
            open={open}
            showTrigger={false}
            sort="updatedAt"
          />
        </>
      );
    }
    render(<FromMore />);
    expect(screen.queryByRole("button", { name: /^Sort:/ })).toBeNull();
    const more = screen.getByRole("button", { name: "More actions" });
    fireEvent.click(more);
    expect(screen.getByRole("radio", { name: "Last updated" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sort" }), { key: "Escape" });
    expect(more).toHaveFocus();
  });
});
