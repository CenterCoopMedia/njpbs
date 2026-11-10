import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover } from "../src/components/ui/Popover";

function setViewport(width: number) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: /max-width:\s*47\.99rem/.test(query) ? width < 768 : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function Harness({ label = "Display", onClose }: { label?: string; onClose?: () => void }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button aria-expanded={open} onClick={() => setOpen(!open)} ref={anchorRef} type="button">
        {label}
      </button>
      <button type="button">Outside</button>
      <Popover
        anchorRef={anchorRef}
        label={label}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClose?.();
        }}
        open={open}
      >
        <label>
          Sort by <select defaultValue="updated"><option value="updated">Last updated</option></select>
        </label>
        <button type="button">Reset to default</button>
      </Popover>
    </>
  );
}

afterEach(() => {
  setViewport(1280);
  vi.restoreAllMocks();
});

describe("Popover", () => {
  it("opens as a named, nonmodal dialog and moves focus inside", () => {
    setViewport(1280);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));

    const panel = screen.getByRole("dialog", { name: "Display" });
    expect(panel).toHaveAttribute("aria-modal", "false");
    expect(panel).not.toHaveClass("ui-popover-sheet");
    expect(screen.getByRole("combobox", { name: "Sort by" })).toHaveFocus();
    fireEvent.blur(screen.getByRole("combobox", { name: "Sort by" }), {
      relatedTarget: screen.getByRole("button", { name: "Reset to default" }),
    });
    expect(screen.getByRole("dialog", { name: "Display" })).toBeInTheDocument();
  });

  it("closes on an outside press without taking focus back", () => {
    setViewport(1280);
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when focus leaves the page", () => {
    setViewport(1280);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.blur(screen.getByRole("combobox", { name: "Sort by" }), { relatedTarget: null });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps only one popover open at a time", () => {
    setViewport(1280);
    render(<><Harness label="Display" /><Harness label="Filter" /></>);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));

    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Filter" })).toBeInTheDocument();
  });

  it("becomes a bottom sheet with a scrim on phone widths", () => {
    setViewport(390);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));

    const panel = screen.getByRole("dialog", { name: "Display" });
    expect(panel).toHaveClass("ui-popover-sheet");
    const scrim = document.querySelector(".ui-popover-scrim");
    expect(scrim).not.toBeNull();
    fireEvent.pointerDown(scrim!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focuses initialFocusRef on open when it is inside the panel, else the first control", () => {
    setViewport(1280);
    function Focused({ outside }: { outside: boolean }) {
      const anchorRef = useRef<HTMLButtonElement>(null);
      const targetRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} ref={anchorRef} type="button">Sort</button>
          {outside ? <button ref={targetRef} type="button">Elsewhere</button> : null}
          <Popover anchorRef={anchorRef} initialFocusRef={targetRef} label="Sort" onOpenChange={setOpen} open={open}>
            <button type="button">First</button>
            {outside ? null : <button ref={targetRef} type="button">Checked</button>}
          </Popover>
        </>
      );
    }
    const { unmount } = render(<Focused outside={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByRole("button", { name: "Checked" })).toHaveFocus();
    unmount();

    render(<Focused outside />);
    fireEvent.click(screen.getByRole("button", { name: "Sort" }));
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

});
