import { useState } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FieldRenderer } from "../src/components/FieldRenderer";
import type { EditorField } from "../../packages/content-core/src/editor-admin";
import { parsePublishInstant } from "../../packages/content-core/src/publish-instant";

afterEach(cleanup);

const textField: EditorField = {
  key: "title",
  label: "Headline",
  help: "The article title.",
  kind: "text",
  required: true,
};

describe("FieldRenderer single-value widgets", () => {
  it("associates supplemental field help and an error with the same labelled input", () => {
    render(<FieldRenderer field={{ key: "alt", label: "Image description", kind: "text", help: "", required: false }} value="" onChange={() => {}} fieldId="image-alt" error="Describe this image." />);
    const input = screen.getByRole("textbox", { name: "Image description" });
    expect(input).toHaveAccessibleDescription(expect.stringContaining("Describe the information this image adds"));
    expect(input).toHaveAccessibleDescription(expect.stringContaining("Describe this image."));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "About Image description" })).toHaveAccessibleDescription(expect.stringContaining("Describe the information this image adds"));
  });

  it("uses one accessible URL policy without native validity rejecting relative links", () => {
    const field: EditorField = { key: "href", label: "Website", help: "The link.", kind: "url", required: true };
    render(
      <FieldRenderer
        field={field}
        value="javascript:alert(1)"
        onChange={() => {}}
        fieldId="f"
        error="Website must use a safe link."
      />,
    );
    const input = screen.getByLabelText(/^Website/) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("url");
    expect(input.checkValidity()).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("f-help f-error");
    expect(document.getElementById("f-error")).toHaveTextContent("Website must use a safe link.");
  });

  it("edits a stored instant in station time and stores the instant back", () => {
    const field: EditorField = {
      key: "startsAt",
      label: "Starts",
      help: "When the event begins, in New Jersey time.",
      kind: "datetime",
      required: true,
    };
    const onChange = vi.fn();
    render(
      <FieldRenderer
        field={field}
        value="2026-07-10T20:00:00.000Z"
        onChange={onChange}
        fieldId="f"
      />,
    );
    const input = screen.getByLabelText(/^Starts/) as HTMLInputElement;
    expect(input.type).toBe("datetime-local");
    // 8 PM UTC is 4 PM in New Jersey, and that is the time the editor sees.
    expect(input.value).toBe("2026-07-10T16:00");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026-07-10T19:30" } });
    expect(onChange).toHaveBeenCalledWith("2026-07-10T23:30:00.000Z");
  });

  it("keeps a half-typed year visible instead of snapping back to the stored time", () => {
    // Typing a year fills the segment a digit at a time, so the control reports 0002
    // and 0020 before 2026. None of those convert, and if the displayed text were
    // derived from the store the form would restore the old value after each one and
    // the year could never be typed.
    const field: EditorField = {
      key: "startsAt",
      label: "Starts",
      help: "When the event begins, in New Jersey time.",
      kind: "datetime",
      required: true,
    };
    const onChange = vi.fn();
    render(
      <FieldRenderer
        field={field}
        value="2026-07-10T20:00:00.000Z"
        onChange={onChange}
        fieldId="f"
      />,
    );
    const input = screen.getByLabelText(/^Starts/) as HTMLInputElement;

    for (const partial of ["0002-08-01T13:00", "0020-08-01T13:00", "0202-08-01T13:00"]) {
      fireEvent.change(input, { target: { value: partial } });
      expect(input.value).toBe(partial);
    }
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026-08-01T13:00" } });
    expect(onChange).toHaveBeenCalledWith("2026-08-01T17:00:00.000Z");
  });

  it("moves a time in the hour that never happens to the hour that does", () => {
    // 2026-03-08 02:30 does not exist in New Jersey; the clock jumps 02:00 to 03:00.
    // station-time carries it forward, and the control has to follow rather than keep
    // showing a time the record does not hold. This is the one value that does not
    // round-trip, so it needs a parent that stores, the way the record form does.
    const field: EditorField = {
      key: "startsAt",
      label: "Starts",
      help: "When the event begins, in New Jersey time.",
      kind: "datetime",
      required: true,
    };
    const stored: unknown[] = [];
    function StoringForm() {
      const [value, setValue] = useState<unknown>("2026-07-10T20:00:00.000Z");
      return (
        <FieldRenderer
          field={field}
          value={value}
          onChange={(next) => {
            stored.push(next);
            setValue(next);
          }}
          fieldId="f"
        />
      );
    }
    render(<StoringForm />);
    const input = screen.getByLabelText(/^Starts/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-03-08T02:30" } });

    expect(stored).toEqual(["2026-03-08T07:30:00.000Z"]);
    expect((screen.getByLabelText(/^Starts/) as HTMLInputElement).value).toBe(
      "2026-03-08T03:30",
    );
  });

  it("re-seeds the control when the stored instant changes underneath it", () => {
    // An undo or a reload replaces the record, and the control has to follow rather
    // than keep showing what somebody typed into the previous one.
    const field: EditorField = {
      key: "startsAt",
      label: "Starts",
      help: "When the event begins, in New Jersey time.",
      kind: "datetime",
      required: true,
    };
    const { rerender } = render(
      <FieldRenderer
        field={field}
        value="2026-07-10T20:00:00.000Z"
        onChange={() => {}}
        fieldId="f"
      />,
    );
    const input = screen.getByLabelText(/^Starts/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0202-08-01T13:00" } });
    expect(input.value).toBe("0202-08-01T13:00");

    rerender(
      <FieldRenderer
        field={field}
        value="2026-09-01T14:00:00.000Z"
        onChange={() => {}}
        fieldId="f"
      />,
    );
    expect((screen.getByLabelText(/^Starts/) as HTMLInputElement).value).toBe(
      "2026-09-01T10:00",
    );
  });

  it("never stores a value the publish gate would refuse", () => {
    // The regression this pins: the date control emitted YYYY-MM-DD, which
    // parsePublishInstant cannot read, so touching an article's publish date failed
    // the gate closed and dropped the article from the build (#509). Everything the
    // control can emit now is either an absolute instant or an empty field.
    const field: EditorField = {
      key: "publishAt",
      label: "Publish date and time",
      help: "When this should go live.",
      kind: "datetime",
      required: false,
    };
    const onChange = vi.fn();
    render(
      <FieldRenderer
        field={field}
        value="2026-07-10T20:00:00.000Z"
        onChange={onChange}
        fieldId="f"
      />,
    );
    const input = screen.getByLabelText(/^Publish date and time/) as HTMLInputElement;

    // A date with no time is not a value this control can hold; the widget sanitizes
    // it away rather than handing the form a calendar day, the way the old one did.
    fireEvent.change(input, { target: { value: "2026-07-10" } });
    // Clearing is a real intent of its own, and a blank publishAt means "publish now".
    fireEvent.change(input, { target: { value: "" } });

    for (const [stored] of onChange.mock.calls) {
      expect(stored === "" || parsePublishInstant(stored as string) !== null).toBe(true);
    }
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("shows an unreadable stored value instead of a blank control, and clears it on request", () => {
    // The control cannot render "2026-08-01", so before #850 it rendered blank and the
    // record's garbage survived every save with nobody told. The field now says what it is
    // holding, quotes it, and offers the one thing a blank control could never do: write the
    // cleared value back.
    const field: EditorField = {
      key: "endsAt",
      label: "Ends",
      help: "When the event ends, in New Jersey time, if it has a set end.",
      kind: "datetime",
      required: false,
    };
    const onChange = vi.fn();
    function ClearingForm() {
      const [value, setValue] = useState<unknown>("2026-08-01");
      return (
        <FieldRenderer
          field={field}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          fieldId="f"
        />
      );
    }
    render(<ClearingForm />);
    // Exact, because the clear affordance below carries the field's name too.
    const input = screen.getByLabelText("Ends") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      screen.getByText(
        'Ends holds "2026-08-01", which is not a date and time this control can show. Clear it or set a new one.',
      ),
    ).toBeTruthy();
    // The message is wired to the control, not just printed near it.
    expect(input.getAttribute("aria-describedby")).toContain("f-error");

    fireEvent.click(screen.getByRole("button", { name: /Clear this value/ }));
    expect(onChange).toHaveBeenCalledWith("");
    // Cleared means cleared: the field is now an ordinary empty optional field.
    const cleared = screen.getByLabelText("Ends") as HTMLInputElement;
    expect(cleared.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear this value/ })).toBeNull();
    expect(screen.queryByText(/which is not a date and time/)).toBeNull();
  });

  it("offers no clear affordance for an empty or readable datetime", () => {
    const field: EditorField = {
      key: "endsAt",
      label: "Ends",
      help: "When the event ends.",
      kind: "datetime",
      required: false,
    };
    const { rerender } = render(
      <FieldRenderer field={field} value="" onChange={() => {}} fieldId="f" />,
    );
    expect(screen.queryByRole("button", { name: /Clear this value/ })).toBeNull();
    rerender(
      <FieldRenderer
        field={field}
        value="2026-08-01T21:00:00.000Z"
        onChange={() => {}}
        fieldId="f"
      />,
    );
    expect(screen.queryByRole("button", { name: /Clear this value/ })).toBeNull();
  });

  it("tells the form when its draft has not become an instant, and when it has", () => {
    // The half-typed year case. The control keeps the text on purpose, so the only way the
    // form can know the record and the widget disagree is for the field to say so.
    const field: EditorField = {
      key: "startsAt",
      label: "Starts",
      help: "When the event begins, in New Jersey time.",
      kind: "datetime",
      required: true,
    };
    const onDraftError = vi.fn();
    render(
      <FieldRenderer
        field={field}
        value="2026-07-10T20:00:00.000Z"
        onChange={() => {}}
        onDraftError={onDraftError}
        fieldId="f"
      />,
    );
    const input = screen.getByLabelText(/^Starts/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "0202-08-01T13:00" } });
    expect(onDraftError).toHaveBeenLastCalledWith(
      "Starts is not a complete date and time yet. Finish it or clear it before saving.",
    );
    // Nothing is shouted at the editor mid-keystroke; the form decides when to show it.
    expect(screen.queryByText(/not a complete date and time/)).toBeNull();

    fireEvent.change(input, { target: { value: "2026-08-01T13:00" } });
    expect(onDraftError).toHaveBeenLastCalledWith(null);

    fireEvent.change(input, { target: { value: "0202-08-01T13:00" } });
    fireEvent.change(input, { target: { value: "" } });
    // Clearing is a real intent, not an unfinished draft.
    expect(onDraftError).toHaveBeenLastCalledWith(null);
  });

  it("withdraws a draft report when the stored value changes underneath it", () => {
    const field: EditorField = {
      key: "startsAt",
      label: "Starts",
      help: "When the event begins, in New Jersey time.",
      kind: "datetime",
      required: true,
    };
    const onDraftError = vi.fn();
    const { rerender } = render(
      <FieldRenderer
        field={field}
        value="2026-07-10T20:00:00.000Z"
        onChange={() => {}}
        onDraftError={onDraftError}
        fieldId="f"
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Starts/), {
      target: { value: "0202-08-01T13:00" },
    });
    expect(onDraftError).toHaveBeenLastCalledWith(expect.stringContaining("not a complete"));

    // An undo or reload re-seeds the control, so the draft it was reporting is gone.
    rerender(
      <FieldRenderer
        field={field}
        value="2026-09-01T14:00:00.000Z"
        onChange={() => {}}
        onDraftError={onDraftError}
        fieldId="f"
      />,
    );
    expect(onDraftError).toHaveBeenLastCalledWith(null);
  });

  it("projects a valid instant into a date input without reporting an edit", () => {
    const field: EditorField = { key: "startsAt", label: "Starts", help: "When.", kind: "date", required: true };
    const onChange = vi.fn();
    const { rerender } = render(
      <FieldRenderer
        field={field}
        value="2026-07-24T23:30:00-04:00"
        onChange={onChange}
        fieldId="f"
      />,
    );
    const input = screen.getByLabelText(/^Starts/) as HTMLInputElement;
    expect(input.value).toBe("2026-07-24");
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <FieldRenderer
        field={field}
        value="2026-07-24"
        onChange={onChange}
        fieldId="f"
      />,
    );
    expect(input.value).toBe("2026-07-24");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2026-07-25" } });
    expect(onChange).toHaveBeenCalledWith("2026-07-25");
  });

});

describe("FieldRenderer list widgets", () => {
  const tagsField: EditorField = { key: "tags", label: "Tags", help: "Group articles.", kind: "list", required: false };
  const categoriesField: EditorField = { key: "categories", label: "Categories", help: "Order sections.", kind: "list", required: false };

  it("reorders categories so an editor can choose the main category", () => {
    const onChange = vi.fn();
    render(
      <FieldRenderer
        field={categoriesField}
        value={["Station news", "Community"]}
        onChange={onChange}
        fieldId="f"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move up: category Community" }));
    expect(onChange).toHaveBeenCalledWith(["Community", "Station news"]);
  });

  it("adds a trimmed tag with Enter and keeps focus in the entry control", () => {
    const stored: unknown[][] = [];
    function StoringTags() {
      const [tags, setTags] = useState<unknown[]>([]);
      return (
        <FieldRenderer
          field={tagsField}
          value={tags}
          onChange={(next) => {
            stored.push(next as unknown[]);
            setTags(next as unknown[]);
          }}
          fieldId="f"
        />
      );
    }
    render(<StoringTags />);
    const input = screen.getByRole("textbox", { name: "New tag" });

    fireEvent.change(input, { target: { value: "  elections  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(stored).toEqual([["elections"]]);
    expect(screen.getByText("elections")).toHaveClass("editor-tag-label");
    expect(document.activeElement).toBe(input);
  });

  it("adds with the explicit action and refuses empty or duplicate tags", () => {
    const onChange = vi.fn();
    render(<FieldRenderer field={tagsField} value={["arts"]} onChange={onChange} fieldId="f" />);
    const input = screen.getByRole("textbox", { name: "New tag" });

    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Enter a tag first.");

    fireEvent.change(input, { target: { value: "  ARTS " } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("ARTS is already added.");

    fireEvent.change(input, { target: { value: "community" } });
    fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
    expect(onChange).toHaveBeenCalledWith(["arts", "community"]);
    expect(document.activeElement).toBe(input);
  });

  it("adds unique comma-separated tags from one paste", () => {
    const onChange = vi.fn();
    render(
      <FieldRenderer
        field={tagsField}
        value={["arts"]}
        onChange={onChange}
        fieldId="f"
      />,
    );
    const input = screen.getByRole("textbox", { name: "New tag" });

    fireEvent.paste(input, {
      clipboardData: {
        getData: () => " elections, Arts,  community news  ",
      },
    });

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith([
      "arts",
      "elections",
      "community news",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("2 tags added.");
  });

  it("commits pending tag text when focus leaves the tag group before save", () => {
    const saved: unknown[][] = [];
    function StoringForm() {
      const [tags, setTags] = useState<unknown[]>(["arts"]);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saved.push(tags);
          }}
        >
          <FieldRenderer
            field={tagsField}
            value={tags}
            onChange={(next) => setTags(next as unknown[])}
            fieldId="f"
          />
          <button type="submit">Save record</button>
        </form>
      );
    }
    render(<StoringForm />);
    const input = screen.getByRole("textbox", { name: "New tag" });
    const save = screen.getByRole("button", { name: "Save record" });
    input.focus();
    fireEvent.change(input, { target: { value: "elections" } });
    fireEvent.blur(input, { relatedTarget: save });
    fireEvent.click(save);

    expect(saved).toEqual([["arts", "elections"]]);
  });

  it("uses compact pills, includes the tag in each remove name, and keeps focus predictable", () => {
    function StoringTags() {
      const [tags, setTags] = useState<unknown[]>(["arts", "elections"]);
      return (
        <FieldRenderer
          field={tagsField}
          value={tags}
          onChange={(next) => setTags(next as unknown[])}
          fieldId="f"
        />
      );
    }
    const { container } = render(<StoringTags />);

    expect(container.querySelectorAll(".editor-tag-pill")).toHaveLength(2);
    expect(container.querySelector(".editor-list-item")).toBeNull();
    const removeArts = screen.getByRole("button", { name: "Remove tag arts" });
    act(() => removeArts.focus());
    fireEvent.click(removeArts);

    const removeElections = screen.getByRole("button", { name: "Remove tag elections" });
    expect(document.activeElement).toBe(removeElections);
    fireEvent.click(removeElections);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "New tag" }));
  });

  it("connects tag validation help and errors to the group and entry control", () => {
    render(
      <FieldRenderer
        field={tagsField}
        value={[]}
        onChange={() => {}}
        fieldId="f"
        error="Add at least one tag."
      />,
    );

    const group = screen.getByRole("group", { name: "Tags" });
    expect(group).toHaveAttribute("tabindex", "-1");
    group.focus();
    expect(group).toHaveFocus();
    expect(screen.getByRole("group", { name: "Tags" })).toHaveAttribute(
      "aria-describedby",
      "f-help f-error",
    );
    expect(screen.getByRole("textbox", { name: "New tag" })).toHaveAttribute(
      "aria-describedby",
      "f-help f-error",
    );
  });

  const ctasField: EditorField = {
    key: "ctas",
    label: "Buttons",
    help: "Add buttons.",
    kind: "list",
    required: true,
    itemFields: [
      { key: "label", label: "Button label", help: "The words.", kind: "text", required: true },
      { key: "href", label: "Button link", help: "The link.", kind: "url", required: true },
    ],
  };

  it("adds an object item seeded from itemFields", () => {
    const onChange = vi.fn();
    render(<FieldRenderer field={ctasField} value={[]} onChange={onChange} fieldId="f" />);
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    expect(onChange).toHaveBeenCalledWith([{ label: "", href: "" }]);
  });

  it("keeps the structured object-list surface and reorder controls", () => {
    const { container } = render(
      <FieldRenderer
        field={ctasField}
        value={[{ label: "Donate", href: "/support/" }]}
        onChange={() => {}}
        fieldId="f"
      />,
    );

    expect(container.querySelector(".editor-list-item")).toBeTruthy();
    expect(container.querySelector(".editor-tag-pill")).toBeNull();
    expect(screen.getByRole("button", { name: "Move up: Buttons 1" })).toBeDisabled();
    expect(screen.queryByText(/^Up$/)).toBeNull();
    expect(screen.queryByText(/^Down$/)).toBeNull();
  });

  it("renders each item as a sub-form and reports a nested edit", () => {
    const onChange = vi.fn();
    render(<FieldRenderer field={ctasField} value={[{ label: "", href: "" }]} onChange={onChange} fieldId="f" />);
    expect(screen.getByLabelText(/^Button label/)).toBeTruthy();
    expect(screen.getByLabelText(/^Button link/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Button label/), { target: { value: "Watch now" } });
    expect(onChange).toHaveBeenCalledWith([{ label: "Watch now", href: "" }]);
  });

  it("reorders object items", () => {
    const onChange = vi.fn();
    render(
      <FieldRenderer
        field={ctasField}
        value={[{ label: "A", href: "" }, { label: "B", href: "" }]}
        onChange={onChange}
        fieldId="f"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Move down: Buttons 1" }));
    expect(onChange).toHaveBeenCalledWith([{ label: "B", href: "" }, { label: "A", href: "" }]);
  });
});

describe("FieldRenderer required-state accessibility", () => {
  const requiredList: EditorField = {
    key: "ctas",
    label: "Buttons",
    help: "Add buttons.",
    kind: "list",
    required: true,
    itemFields: [{ key: "label", label: "Button label", help: "The words.", kind: "text", required: true }],
  };
  const optionalList: EditorField = { key: "tags", label: "Tags", help: "Group articles.", kind: "list", required: false };
  const requiredRichText: EditorField = { key: "body", label: "Body", help: "Write.", kind: "richText", required: true };
  const optionalRichText: EditorField = { key: "body", label: "Body", help: "Write.", kind: "richText", required: false };

  it("exposes required and optional list and rich-text states", () => {
    const requiredGroup = render(<FieldRenderer field={requiredList} value={[]} onChange={() => {}} fieldId="f" />);
    expect(screen.getByRole("group", { name: /required/i })).toBe(screen.getByRole("group", { name: /Buttons/ }));
    requiredGroup.unmount();

    const optionalGroup = render(<FieldRenderer field={optionalList} value={[]} onChange={() => {}} fieldId="f" />);
    expect(screen.queryByRole("group", { name: /required/i })).toBeNull();
    expect(screen.getByRole("group", { name: "Tags" })).toBeTruthy();
    optionalGroup.unmount();

    const requiredBody = render(<FieldRenderer field={requiredRichText} value={undefined} onChange={() => {}} fieldId="f" />);
    expect(screen.getByRole("textbox", { name: "Body" }).getAttribute("aria-required")).toBe("true");
    requiredBody.unmount();

    render(<FieldRenderer field={optionalRichText} value={undefined} onChange={() => {}} fieldId="f" />);
    expect(screen.getByRole("textbox", { name: "Body" }).getAttribute("aria-required")).toBe("false");
  });
});

it("preserves an unknown stored crop until an explicit supported choice", () => {
  const change = vi.fn();
  render(<FieldRenderer field={{ key: "heroBackgroundPosition", label: "Background crop position", help: "Choose a stored crop position.", kind: "select", required: false, options: [{ value: "top", label: "Top" }, { value: "center", label: "Center" }, { value: "bottom", label: "Bottom" }] }} selectPresentation="crop" value="legacy-position" onChange={change} fieldId="crop" />);
  expect(screen.getByRole("group", { name: "Background crop position" })).toHaveTextContent("Stored crop: legacy-position");
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Top" })); expect(change).toHaveBeenCalledExactlyOnceWith("top");
});


it.each(["headline", "summary", "identifier"] as const)("keeps %s saved text unchanged and preserves Enter submission outside composition", presentation => {
  const change = vi.fn();
  const submit = vi.fn();
  render(<form onSubmit={event => { event.preventDefault(); submit(); }}><FieldRenderer field={textField} value="Saved value" textPresentation={presentation} onChange={change} fieldId="single-line" /></form>);
  const input = screen.getByRole("textbox", { name: "Headline" });
  expect(input).toHaveValue("Saved value"); expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229, isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).toHaveBeenCalledOnce(); expect(change).not.toHaveBeenCalled();
});
