import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionControl } from "../src/components/ui/ActionControl";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { FieldRenderer } from "../src/components/FieldRenderer";
import type { EditorField } from "../../packages/content-core/src/editor-admin";

afterEach(cleanup);

const links: EditorField = {
  key: "links", label: "Links", help: "Links in order.", kind: "list", required: false,
  itemFields: [{ key: "label", label: "Label", help: "Link label.", kind: "text", required: true }],
};

function List() {
  const [items, setItems] = useState<unknown[]>([{ label: "First" }, { label: "Second" }]);
  return <FieldRenderer field={links} fieldId="links" value={items} onChange={value => setItems(value as unknown[])} />;
}

describe("contextual item actions", () => {
  it("uses quiet named icons by default without submitting an enclosing form", () => {
    const click = vi.fn();
    const submit = vi.fn();
    render(<form onSubmit={submit}>
      <ActionControl action="remove-item" variant="ghost" label="Remove"
        accessibleName="Remove Ada from the byline" onClick={click} />
    </form>);
    const remove = screen.getByRole("button", { name: "Remove Ada from the byline" });
    expect(remove).toHaveClass("action-control-icon", "button-ghost");
    expect(remove).not.toHaveTextContent("Remove");
    expect(remove.querySelector("svg")).not.toBeNull();
    fireEvent.click(remove);
    expect(click).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("honors explicit text mode while retaining a target-specific name", () => {
    render(<ControlPresentationProvider value="text">
      <ActionControl action="remove-item" label="Remove" accessibleName="Remove Ada from the byline" />
      <ActionControl action="add-item" label="Add staff byline" />
    </ControlPresentationProvider>);
    expect(screen.getByRole("button", { name: "Remove Ada from the byline" })).toHaveTextContent("Remove");
    expect(screen.getByRole("button", { name: "Add staff byline" })).toHaveTextContent("Add staff byline");
    expect(screen.getByRole("button", { name: "Remove Ada from the byline" })).toHaveClass("action-control-text");
  });

  it("keeps the disabled action inert", () => {
    const click = vi.fn();
    render(<ActionControl action="add-item" label="Add staff byline" disabled onClick={click} />);
    fireEvent.click(screen.getByRole("button", { name: "Add staff byline" }));
    expect(click).not.toHaveBeenCalled();
  });

  it("returns focus to the adjacent remove control, then Add after the last removal", () => {
    render(<List />);
    const first = screen.getByRole("button", { name: "Remove Links 1" });
    expect(first).toHaveClass("action-control-icon", "button-ghost");
    act(() => first.focus());
    fireEvent.click(first);
    const remaining = screen.getByRole("button", { name: "Remove Links 1" });
    expect(remaining).toHaveFocus();
    fireEvent.click(remaining);
    expect(screen.getByRole("button", { name: "Add link" })).toHaveFocus();
    expect(screen.getByText("Nothing added yet.")).toBeVisible();
  });

  it("renders contextual add/remove labels when the editor requests text controls", () => {
    render(<ControlPresentationProvider value="text"><List /></ControlPresentationProvider>);
    expect(screen.getByRole("button", { name: "Remove Links 1" })).toHaveTextContent("Remove");
    expect(screen.getByRole("button", { name: "Add link" })).toHaveTextContent("Add link");
  });
});
