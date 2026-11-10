import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RetainedEditorHost } from "../src/components/RetainedEditorHost";
import { createPortal } from "react-dom";
import { within } from "@testing-library/react";
import { useOverlayRoot } from "../src/components/ui/floating";

it("retains a portaled control's native form owner and DOM through pane moves", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  function Fixture() {
    const [target, setTarget] = useState<HTMLDivElement | null>(null);
    const [moved, setMoved] = useState(true);
    return <><div ref={setTarget} />
      <form id="original-editor" onSubmit={submit}>
        <RetainedEditorHost target={moved ? target : null}>
          <fieldset disabled><input aria-label="Locked value" defaultValue="retained" /></fieldset>
          <input aria-label="Draft" defaultValue="original" />
          <button type="submit">Save</button>
        </RetainedEditorHost>
      </form>
      <button onClick={() => setMoved(value => !value)}>Move pane</button>
    </>;
  }
  render(<Fixture />);
  const input = screen.getByRole("textbox", { name: "Draft" }) as HTMLInputElement;
  expect(input.form?.id).toBe("original-editor");
  expect(screen.getByRole("textbox", { name: "Locked value" })).toBeDisabled();
  fireEvent.change(input, { target: { value: "new draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(submit).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Move pane" }));
  fireEvent.click(screen.getByRole("button", { name: "Move pane" }));
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(input);
  expect(input.value).toBe("new draft");
  await waitFor(() => expect(input.form?.id).toBe("original-editor"));
});

it("moves nested overlays into the physical pane dialog while retaining the draft host", () => {
  function Overlay() {
    const root = useOverlayRoot();
    return root ? createPortal(<button>Nested action</button>, root) : null;
  }
  function Fixture() {
    const [inside, setInside] = useState(true);
    const [modal, setModal] = useState(true);
    const [pane, setPane] = useState<HTMLDivElement | null>(null);
    const [canvas, setCanvas] = useState<HTMLDivElement | null>(null);
    return <><dialog open aria-label="Details"><div ref={setPane} /></dialog><div ref={setCanvas} />
      <RetainedEditorHost target={inside ? pane : canvas} overlayOwner={modal ? undefined : null}><input aria-label="Retained draft" defaultValue="Saved" /><Overlay /></RetainedEditorHost>
      <button onClick={() => setInside(value => !value)}>Move draft</button>
      <button onClick={() => setModal(value => !value)}>Change pane modality</button></>;
  }
  render(<Fixture />);
  const pane = screen.getByRole('dialog', { name: 'Details' });
  const draft = screen.getByRole('textbox', { name: 'Retained draft' });
  fireEvent.change(draft, { target: { value: 'Unsaved' } });
  expect(within(pane).getByRole('button', { name: 'Nested action' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Move draft' }));
  expect(within(pane).queryByRole('button', { name: 'Nested action' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBe(draft);
  expect(draft).toHaveValue('Unsaved');
  fireEvent.click(screen.getByRole('button', { name: 'Move draft' }));
  expect(within(pane).getByRole('button', { name: 'Nested action' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBe(draft);
  fireEvent.click(screen.getByRole('button', { name: 'Change pane modality' }));
  expect(within(pane).queryByRole('button', { name: 'Nested action' })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBe(draft);
  expect(draft).toHaveValue('Unsaved');
});
