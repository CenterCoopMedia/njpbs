import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it } from "vitest";
import { useToolbarNavigation } from "../src/components/ui/useToolbarNavigation";

function PortalCommands({ late = false, locked = false, hidden = false }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  useToolbarNavigation(target);
  return <><div role="toolbar" aria-label="Editor commands" ref={setTarget} />{target ? createPortal(<>
    <button disabled={locked}>Outline</button><button hidden={hidden}>Arrange</button>{late ? <button>Add</button> : null}
    <select aria-label="Text style"><option>Normal</option><option>Heading</option></select>
  </>, target) : null}</>;
}

describe("shared toolbar command navigation", () => {
  it("keeps an explained unavailable action reachable only when its owner opts in", () => {
    function Fixture() {
      const [root, setRoot] = useState<HTMLDivElement | null>(null);
      useToolbarNavigation(root);
      return <div role="toolbar" ref={setRoot}><button>First</button><button aria-disabled="true">Unavailable</button>
        <button aria-disabled="true" data-toolbar-disabled-focusable="true" aria-describedby="locked-reason">Explained action</button>
        <button disabled data-toolbar-disabled-focusable="true">Native disabled</button><span id="locked-reason">Save or discard details first.</span></div>;
    }
    render(<Fixture />);
    const first = screen.getByRole("button", { name: "First" }); first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const explained = screen.getByRole("button", { name: "Explained action" });
    expect(explained).toHaveFocus();
    expect(explained).toHaveAccessibleDescription("Save or discard details first.");
    fireEvent.keyDown(explained, { key: "ArrowRight" }); expect(first).toHaveFocus();
  });

  it("includes controls arriving through a portal and keeps native select keys", async () => {
    const { rerender } = render(<PortalCommands />);
    const first = screen.getByRole("button", { name: "Outline" });
    first.focus(); rerender(<PortalCommands late />);
    const added = screen.getByRole("button", { name: "Add" });
    await waitFor(() => expect(added).toHaveAttribute("tabindex", "-1"));
    fireEvent.keyDown(first, { key: "End" }); expect(added).toHaveFocus();
    const select = screen.getByRole("combobox", { name: "Text style" });
    select.focus(); fireEvent.keyDown(select, { key: "ArrowLeft" }); expect(select).toHaveFocus();
  });
  it("chooses an eligible tab stop when the current command becomes disabled or hidden", async () => {
    const { rerender } = render(<PortalCommands late />);
    screen.getByRole("button", { name: "Outline" }).focus();
    rerender(<PortalCommands late locked hidden />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add" })).toHaveAttribute("tabindex", "0"));
    const added = screen.getByRole("button", { name: "Add" }); added.focus();
    fireEvent.keyDown(added, { key: "ArrowRight" }); expect(added).toHaveFocus();
  });
});

it("leaves a nested dialog's commands and navigation with its modal owner", () => {
  function ModalCommands() {
    const [target, setTarget] = useState<HTMLDivElement | null>(null);
    useToolbarNavigation(target);
    return <div ref={setTarget} role="toolbar"><button>Arrange</button><dialog open><button>Cancel move</button><button>Move content</button></dialog></div>;
  }
  render(<ModalCommands />);
  const cancel = screen.getByRole("button", { name: "Cancel move" });
  expect(cancel).not.toHaveAttribute("tabindex"); cancel.focus();
  fireEvent.keyDown(cancel, { key: "End" }); expect(cancel).toHaveFocus();
});
