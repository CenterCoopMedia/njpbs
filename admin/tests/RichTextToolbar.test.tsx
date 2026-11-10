import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { RichTextEditor } from "../src/components/RichTextEditor";
import { ComponentEditorDialog } from "../src/components/ComponentEditorDialog";
import { renderRichText, type RichTextDoc } from "../../packages/content-core/src/content-model";

const initial: RichTextDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Draft text" }] }] };
function Host() {
  const [value, setValue] = useState(initial);
  const [open, setOpen] = useState(true);
  return <ControlPresentationProvider value="text"><button onClick={() => setOpen(true)}>Edit text</button><ComponentEditorDialog open={open} onClose={() => setOpen(false)} title="Text">
    <RichTextEditor value={value} onChange={setValue} ariaLabel="Body" />
    <output data-testid="json">{JSON.stringify(value)}</output>
    <output data-testid="rendered">{renderRichText(value)}</output>
  </ComponentEditorDialog></ControlPresentationProvider>;
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const saved = () => JSON.parse(screen.getByTestId("json").textContent!);

describe("rich text toolbar", () => {
  it("keeps modal controls docked without focus and can float and pin them", () => {
    render(<Host />);
    const toolbar = screen.getByRole("toolbar", { name: "Formatting for Body" });
    expect(toolbar.closest(".rich-text")).toContainElement(screen.getByRole("textbox", { name: "Body" }));
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    click("Float toolbar");
    expect(screen.getByRole("toolbar").closest(".rich-text")).toBeNull();
    click("Pin toolbar");
    expect(screen.getByRole("toolbar").closest(".rich-text")).not.toBeNull();
  });

  it("returns keyboard focus to the mode button after its toolbar moves", () => {
    render(<Host />);
    const float = screen.getByRole("button", { name: "Float toolbar" });
    float.focus();
    fireEvent.click(float, { detail: 0 });
    const pin = screen.getByRole("button", { name: "Pin toolbar" });
    expect(pin).toHaveFocus();
    fireEvent.click(pin, { detail: 0 });
    expect(screen.getByRole("button", { name: "Float toolbar" })).toHaveFocus();
  });

  it("keeps expanded controls until explicitly collapsed, including after reopen", () => {
    render(<Host />);
    expect(screen.queryByRole("button", { name: "Code block" })).toBeNull();
    click("Expand formatting");
    click("Done"); click("Edit text");
    expect(screen.getByRole("button", { name: "Code block" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Collapse formatting" })).toHaveAttribute("aria-expanded", "true");
    click("Collapse formatting");
    expect(screen.queryByRole("button", { name: "Code block" })).toBeNull();
  });

  it("saves supported code and rule nodes that the public renderer displays", () => {
    render(<Host />);
    click("Expand formatting"); click("Select all"); click("Code block");
    expect(saved().content[0].type).toBe("codeBlock");
    expect(screen.getByTestId("rendered").textContent).toContain("<pre><code>Draft text</code></pre>");
    click("Paragraph");
    expect(saved().content[0].type).toBe("paragraph");
    click("Horizontal rule");
    expect(saved().content.some((node: { type: string }) => node.type === "horizontalRule")).toBe(true);
    expect(screen.getByTestId("rendered").textContent).toContain("<hr");
  });

  it("clears marks and blocks with one command and disables invalid list depth changes", () => {
    render(<Host />);
    click("Expand formatting");
    expect(screen.getByRole("button", { name: "Indent list" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Outdent list" })).toBeDisabled();
    click("Select all"); click("Bold"); click("Heading level 2"); click("Clear formatting");
    expect(saved().content).toEqual(initial.content);
  });
});
