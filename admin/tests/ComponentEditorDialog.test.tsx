import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createPortal } from "react-dom";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MediaPickerDialog } from "../src/components/MediaPickerDialog";
import { ComponentEditorDialog, useOverlayOwner } from "../src/components/ComponentEditorDialog";


function NestedOverlay() {
  const owner = useOverlayOwner();
  return createPortal(<button>Nested action</button>, owner ?? document.body);
}
function Host({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Edit text</button>
    <ComponentEditorDialog open={open} disabled={disabled} onClose={() => setOpen(false)} title="Text" settings={<input aria-label="Setting" />}>
      <input aria-label="Draft text" defaultValue="Original" /><NestedOverlay />
    </ComponentEditorDialog></>;
}

describe("component editor dialog", () => {
  it("retains draft fields and portal ownership while closing and reopening", () => {
    render(<Host />);
    const input = screen.getByRole("textbox", { name: "Draft text", hidden: true });
    const trigger = screen.getByRole("button", { name: "Edit text" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Text" });
    expect(dialog).toContainElement(screen.getByRole("button", { name: "Nested action" }));
    fireEvent.change(input, { target: { value: "Unsaved text" } });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(trigger).toHaveFocus();
    expect(input).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole("textbox", { name: "Draft text" })).toBe(input);
    expect(input).toHaveValue("Unsaved text");
  });

  it("closes for native cancellation and when editing becomes disabled", () => {
    const view = render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    const dialog = screen.getByRole("dialog", { name: "Text" });
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(dialog).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
    view.rerender(<Host disabled />);
    expect(dialog).not.toHaveAttribute("open");
  });

  it("keeps a nested media picker inside the modal and leaves the editor open on Escape", async () => {
    function PickerHost() {
      const [picker, setPicker] = useState(false);
      return <ComponentEditorDialog open onClose={() => {}} title="Image">
        <button onClick={() => setPicker(true)}>Choose image</button>
        {picker ? <MediaPickerDialog currentAssetId="" loadMedia={async () => ({
          success: true, records: [], total: 0, allCount: 0, page: 1, pageCount: 1,
          categoryCounts: {}, kindCounts: { image: 0, document: 0 },
        })} onClose={() => setPicker(false)} onSelect={() => {}} /> : null}
      </ComponentEditorDialog>;
    }
    render(<PickerHost />);
    fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    const modal = screen.getByRole("dialog", { name: "Image" });
    const picker = (await screen.findAllByRole("dialog")).find(node => node !== modal)!;
    expect(modal).toContainElement(picker);
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(picker).not.toBeInTheDocument();
    expect(modal).toHaveAttribute("open");
  });

  it("returns focus to the actual canvas trigger inside a shadow root", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    shadow.append(trigger); document.body.append(host);
    const view = render(<ComponentEditorDialog open={false} onClose={() => {}} title="Canvas"><input /></ComponentEditorDialog>);
    trigger.focus();
    view.rerender(<ComponentEditorDialog open onClose={() => {}} title="Canvas"><input /></ComponentEditorDialog>);
    screen.getByRole("button", { name: "Close Canvas" }).focus();
    view.rerender(<ComponentEditorDialog open={false} onClose={() => {}} title="Canvas"><input /></ComponentEditorDialog>);
    expect(shadow.activeElement).toBe(trigger);
    host.remove();
  });

  it("does not promote an editor out of an inert ancestor", async () => {
    const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const view = render(<div><ComponentEditorDialog open={false} onClose={() => {}} title="Text"><input /></ComponentEditorDialog></div>);
    view.container.firstElementChild!.setAttribute("inert", "");
    await act(async () => view.rerender(<div><ComponentEditorDialog open onClose={() => {}} title="Text"><input /></ComponentEditorDialog></div>));
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });
  it("leaves the component open when a nested native dialog is cancelled", () => {
    const close = vi.fn();
    render(<ComponentEditorDialog open onClose={close} title="Row">
      <dialog open aria-label="Move row" onCancel={event => event.preventDefault()} />
    </ComponentEditorDialog>);
    fireEvent(screen.getByRole("dialog", { name: "Move row" }), new Event("cancel", { bubbles: true, cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Row" })).toHaveAttribute("open");
  });

  it("renders header actions before close and reports keys from the dialog frame", () => {
    const onFrameKeyDown = vi.fn();
    render(<ComponentEditorDialog open onClose={() => {}} title="Video preview"
      headerActions={<button type="button">Next video</button>}
      onFrameKeyDown={onFrameKeyDown}>
      <video aria-label="Preview" />
    </ComponentEditorDialog>);
    const dialog = screen.getByRole("dialog", { name: "Video preview" });
    expect(dialog).toHaveAttribute("data-viewer-keys", "on");
    const header = dialog.querySelector(".component-editor-dialog-header")!;
    const actions = within(header as HTMLElement).getByRole("button", { name: "Next video" });
    const close = within(header as HTMLElement).getByRole("button", { name: "Close Video preview" });
    expect(actions.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(onFrameKeyDown).toHaveBeenCalledOnce();
  });

});
