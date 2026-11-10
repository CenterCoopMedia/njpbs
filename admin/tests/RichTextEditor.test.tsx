import { EditorInlineWriting } from "../src/context/EditorInlineWriting";
import { useState } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RichTextEditor } from "../src/components/RichTextEditor";
import { ControlPresentationProvider } from "../src/context/ControlPresentationContext";
import { emptyRichTextDoc } from "../src/lib/rich-text";
import type { RichTextDoc } from "../../packages/content-core/src/content-model";

afterEach(cleanup);

const docWithText = (text: string): RichTextDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const docWithHeading = (text: string, level: number): RichTextDoc => ({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level },
      content: [{ type: "text", text }],
    },
  ],
});

const docWithInlineCode = (text: string): RichTextDoc => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text, marks: [{ type: "code" }] }],
    },
  ],
});

function ContextualHistoryEditor({ headingLevelOffset }: { headingLevelOffset: number }) {
  const [value, setValue] = useState(() => docWithHeading("Original details", 2));
  return (
    <RichTextEditor
      value={value}
      onChange={setValue}
      ariaLabel="Card text"
      headingLevelOffset={headingLevelOffset}
      minimumHeadingLevel={headingLevelOffset + 2}
    />
  );
}

describe("RichTextEditor", () => {
  it("shows supported formatting tools only while the editor is active", () => {
    render(
      <ControlPresentationProvider value="text">
        <RichTextEditor value={emptyRichTextDoc()} onChange={() => {}} ariaLabel="Body" />
      </ControlPresentationProvider>,
    );
    expect(screen.queryByRole("toolbar", { name: "Formatting for Body" })).toBeNull();
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    expect(screen.getByRole("button", { name: "Bold" })).toHaveTextContent("Bold");
    expect(screen.getByRole("button", { name: "Heading level 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link" })).toBeTruthy();
    // Strikethrough is deliberately not offered (the renderer drops it).
    expect(screen.queryByRole("button", { name: /strike/i })).toBeNull();
  });

  it("exposes controls only for the active rich-text field", () => {
    render(
      <>
        <RichTextEditor value={emptyRichTextDoc()} onChange={() => {}} ariaLabel="Lead" />
        <RichTextEditor value={emptyRichTextDoc()} onChange={() => {}} ariaLabel="Body" />
      </>,
    );

    act(() => screen.getByRole("textbox", { name: "Lead" }).focus());
    expect(screen.getByRole("toolbar", { name: "Formatting for Lead" })).toBeVisible();
    expect(screen.queryByRole("toolbar", { name: "Formatting for Body" })).toBeNull();

    act(() => screen.getByRole("textbox", { name: "Body" }).focus());
    expect(screen.queryByRole("toolbar", { name: "Formatting for Lead" })).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Formatting for Body" })).toBeVisible();
  });

  it("moves keyboard focus into the toolbar and back to the same editor", async () => {
    render(
      <RichTextEditor value={docWithText("Station update")} onChange={() => {}} ariaLabel="Body" />,
    );
    const surface = screen.getByRole("textbox", { name: "Body" });
    fireEvent.focus(surface);

    fireEvent.keyDown(surface, { altKey: true, key: "F10" });
    expect(screen.getByRole("button", { name: "Bold" })).toBe(document.activeElement);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(surface).toBe(document.activeElement));
  });

  it("uses the saved icon presentation only for registered formatting actions", () => {
    render(
      <ControlPresentationProvider value="icons">
        <RichTextEditor
          value={emptyRichTextDoc()}
          onChange={() => {}}
          ariaLabel="Body"
        />
      </ControlPresentationProvider>,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));

    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold).not.toHaveTextContent("Bold");
    expect(bold.querySelector(".icon")).toBeInTheDocument();
    const heading = screen.getByRole("button", {
      name: "H2: Heading level 2",
    });
    expect(heading).toHaveTextContent("H2");
    act(() => bold.focus());
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(
      "Bold",
    );
  });

  it("re-syncs the surface when the value prop changes under a reused instance", () => {
    // A repeatable list keys its items by index, so reordering hands this same editor
    // instance a different item's body. TipTap reads `content` only at creation, so
    // without a value->editor sync the surface would keep showing the old body and the
    // next keystroke would write it back onto the wrong item.
    const { rerender } = render(
      <RichTextEditor value={docWithText("Alpha")} onChange={() => {}} ariaLabel="Body" />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    expect(screen.getByRole("textbox").textContent).toContain("Alpha");
    rerender(
      <RichTextEditor value={docWithText("Bravo")} onChange={() => {}} ariaLabel="Body" />,
    );
    expect(screen.getByRole("textbox").textContent).toContain("Bravo");
    expect(screen.getByRole("textbox").textContent).not.toContain("Alpha");
  });

  it("keeps an external value sync out of the undo history", () => {
    const { rerender } = render(
      <RichTextEditor value={docWithText("Alpha")} onChange={() => {}} ariaLabel="Body" />,
    );

    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    // A fresh editor has nothing to undo.
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <RichTextEditor value={docWithText("Bravo")} onChange={() => {}} ariaLabel="Body" />,
    );
    // The reorder-driven content swap must not become an undoable step: if it did, Undo
    // would restore the previous item's body and write it into the current slot.
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews contextual heading ranks without changing the stored document", () => {
    const onChange = vi.fn();
    const value = docWithHeading("Local details", 2);
    const { rerender } = render(
      <ControlPresentationProvider value="text">
        <RichTextEditor
          value={value}
          onChange={onChange}
          ariaLabel="Card text"
          headingLevelOffset={1}
          minimumHeadingLevel={3}
        />
      </ControlPresentationProvider>,
    );

    fireEvent.focus(screen.getByRole("textbox", { name: "Card text" }));

    expect(screen.getByRole("heading", { level: 3, name: "Local details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Heading level 3" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Heading level 4" })).toBeVisible();

    rerender(
      <ControlPresentationProvider value="text">
        <RichTextEditor
          value={value}
          onChange={onChange}
          ariaLabel="Card text"
          headingLevelOffset={2}
          minimumHeadingLevel={4}
        />
      </ControlPresentationProvider>,
    );

    expect(screen.getByRole("heading", { level: 4, name: "Local details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Heading level 4" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Heading level 5" })).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves local undo history when heading context changes", async () => {
    const { rerender } = render(<ContextualHistoryEditor headingLevelOffset={1} />);
    const surface = screen.getByRole("textbox", { name: "Card text" });
    fireEvent.focus(surface);

    await act(async () => {
      surface.innerHTML =
        '<h3 data-rich-text-stored-heading-level="2">Edited details</h3>';
      fireEvent.input(surface);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    rerender(<ContextualHistoryEditor headingLevelOffset={2} />);

    expect(screen.getByRole("textbox", { name: "Card text" })).toBe(surface);
    expect(screen.getByRole("heading", { level: 4, name: "Edited details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("heading", { level: 4, name: "Original details" })).toBeVisible();
  });

  it("offers a visible cancel action for link settings and returns focus to Link", () => {
    render(
      <RichTextEditor value={emptyRichTextDoc()} onChange={() => {}} ariaLabel="Body" />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    const linkButton = screen.getByRole("button", { name: "Link" });
    fireEvent.click(linkButton);

    expect(screen.getByRole("group", { name: "Link settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group", { name: "Link settings" })).not.toBeInTheDocument();
    expect(linkButton).toBe(document.activeElement);
  });

  it("offers a per-link legacy host opt-in in link settings", () => {
    render(
      <RichTextEditor value={emptyRichTextDoc()} onChange={() => {}} ariaLabel="Body" />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    const optIn = screen.getByRole("checkbox", {
      name: "Allow this legacy host link",
    });
    expect(optIn).not.toBeChecked();
    fireEvent.click(optIn);
    expect(optIn).toBeChecked();
  });

  it("shows link guidance and keeps settings open when a manual link is refused", () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor value={docWithText("Read more")} onChange={onChange} ariaLabel="Body" />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    const address = screen.getByRole("textbox", { name: "Link address" });
    expect(address).toHaveAttribute("inputmode", "url");
    expect(address).toHaveAccessibleDescription(
      "Use http://, https://, mailto:, tel:, or a relative NJ PBS path such as /about/.",
    );
    fireEvent.change(address, { target: { value: "javascript:alert(1)" } });
    fireEvent.keyDown(address, { key: "Enter" });

    expect(screen.getByRole("group", { name: "Link settings" })).toBeInTheDocument();
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a link that starts with http://, https://, mailto:, tel:, or a relative NJ PBS path.",
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(address).toBe(document.activeElement);

    fireEvent.change(address, { target: { value: "https://njpbs.org/about/" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("group", { name: "Link settings" })).not.toBeInTheDocument();
  });

  it("distinguishes a valid address that the current selection cannot link", () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor
        value={docWithInlineCode("const answer = 42")}
        onChange={onChange}
        ariaLabel="Body"
      />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    const address = screen.getByRole("textbox", { name: "Link address" });
    fireEvent.change(address, { target: { value: "https://njpbs.org/about/" } });
    fireEvent.keyDown(address, { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This text cannot have a link. Select ordinary text and try again.",
    );
    expect(address).not.toHaveAttribute("aria-invalid");
    expect(address).toBe(document.activeElement);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves common Google Docs press-release formatting on paste", () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor value={emptyRichTextDoc()} onChange={onChange} ariaLabel="Body" />,
    );
    const surface = screen.getByRole("textbox", { name: "Body" });
    fireEvent.focus(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        getData: (type: string) => type === "text/html" ? [
          '<p><span style="font-weight: 700">NJPBS welcomes six new hires</span></p>',
          '<p>Montclair State University announced <a href="https://njpbs.org/about/">the appointments</a>.</p>',
          '<ul><li><em>Newsroom leadership</em></li><li>Audience development</li></ul>',
        ].join("") : "",
      },
    });

    expect(surface.querySelector("strong")).toHaveTextContent("NJPBS welcomes six new hires");
    expect(surface.querySelector("a")).toHaveAttribute("href", "https://njpbs.org/about/");
    expect(surface.querySelector("em")).toHaveTextContent("Newsroom leadership");
    expect(Array.from(surface.querySelectorAll("ul > li"), (item) => item.textContent)).toEqual([
      "Newsroom leadership",
      "Audience development",
    ]);
    expect(onChange).toHaveBeenCalled();
  });

  it("preserves common Word press-release formatting on paste", () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor value={emptyRichTextDoc()} onChange={onChange} ariaLabel="Body" />,
    );
    const surface = screen.getByRole("textbox", { name: "Body" });
    fireEvent.focus(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        getData: (type: string) => type === "text/html" ? [
          '<h2>New leadership</h2>',
          '<p class="MsoNormal"><b>Jane Doe</b> joins NJPBS.</p>',
          '<ol><li>First appointment</li><li>Second appointment</li></ol>',
        ].join("") : "",
      },
    });

    expect(screen.getByRole("heading", { level: 2, name: "New leadership" })).toBeVisible();
    expect(surface.querySelector("strong")).toHaveTextContent("Jane Doe");
    expect(Array.from(surface.querySelectorAll("ol > li"), (item) => item.textContent)).toEqual([
      "First appointment",
      "Second appointment",
    ]);
    expect(onChange).toHaveBeenCalled();
  });

  it("dismisses link settings with Escape without applying the typed address", () => {
    const onChange = vi.fn();
    render(
      <RichTextEditor value={emptyRichTextDoc()} onChange={onChange} ariaLabel="Body" />,
    );
    fireEvent.focus(screen.getByRole("textbox", { name: "Body" }));
    const linkButton = screen.getByRole("button", { name: "Link" });
    fireEvent.click(linkButton);
    const address = screen.getByRole("textbox", { name: "Link address" });
    fireEvent.change(address, { target: { value: "https://example.org/draft" } });
    fireEvent.keyDown(address, { key: "Escape" });

    expect(screen.queryByRole("group", { name: "Link settings" })).not.toBeInTheDocument();
    expect(linkButton).toBe(document.activeElement);
    expect(onChange).not.toHaveBeenCalled();
  });
});

it("locks the retained inline editor without replacing its document host", () => {
  const onChange = vi.fn();
  const value = docWithText("Retained writing");
  const editor = (readOnly: boolean) => <EditorInlineWriting.Provider value={{ inline: true, readOnly }}><RichTextEditor value={value} onChange={onChange} ariaLabel="Body" /></EditorInlineWriting.Provider>;
  const view = render(editor(true)); const surface = screen.getByRole("textbox", { name: "Body" });
  expect(surface).toHaveAttribute("contenteditable", "false");
  view.rerender(editor(false)); expect(screen.getByRole("textbox", { name: "Body" })).toBe(surface);
  expect(surface).toHaveAttribute("contenteditable", "true"); expect(surface).toHaveTextContent("Retained writing"); expect(onChange).not.toHaveBeenCalled();
});
