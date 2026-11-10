import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TokenInput, type Token } from "../src/components/ui/TokenInput";
import { addTokens } from "../src/components/ui/tokenInputModel";

function Harness({
  initial = [],
  caseSensitive,
  maxCount,
  maxLength = 40,
  onChange,
  onCommit,
  onDraftChange,
  promoteMixed,
  suggestions = [],
  suggestionsNote,
}: {
  initial?: Token[];
  caseSensitive?: boolean;
  maxCount?: number;
  maxLength?: number;
  onChange?: (tokens: Token[]) => void;
  onCommit?: (values: string[]) => void;
  onDraftChange?: (value: string) => void;
  promoteMixed?: boolean;
  suggestions?: string[];
  suggestionsNote?: string;
}) {
  const [tokens, setTokens] = useState(initial);
  const [draft, setDraft] = useState("");
  return (
    <TokenInput
      label="Tags"
      caseSensitive={caseSensitive}
      maxCount={maxCount}
      maxLength={maxLength}
      onChange={(next) => {
        setTokens(next);
        onChange?.(next);
      }}
      onCommit={onCommit}
      {...(onDraftChange ? {
        draft,
        onDraftChange: (value: string) => {
          setDraft(value);
          onDraftChange(value);
        },
      } : {})}
      promoteMixed={promoteMixed}
      suggestions={suggestions}
      suggestionsNote={suggestionsNote}
      tokens={tokens}
    />
  );
}

const field = () => screen.getByRole("combobox", { name: "Tags" });
const names = () => screen.queryAllByRole("button", { name: /^Remove tag / }).map((button) =>
  button.getAttribute("aria-label")?.replace("Remove tag ", "").replace(", on some items", ""));
const removeButton = (name: string) => screen.getByRole("button", { name: `Remove tag ${name}` });

describe("TokenInput", () => {
  it("finds published spelling without case sensitivity while allowing exact-case tokens", () => {
    render(<Harness initial={[{ value: "transit" }]} caseSensitive suggestions={["transit", "Transit"]} />);
    fireEvent.change(field(), { target: { value: "trans" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /^Transit$/ }));
    expect(names()).toEqual(["transit", "Transit"]);
    expect(field()).toHaveValue("");
  });

  it("commits a token on comma or Return and clears the field", () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: "interview," } });
    expect(names()).toEqual(["interview"]);
    expect(field()).toHaveValue("");

    fireEvent.change(field(), { target: { value: "b-roll" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(names()).toEqual(["interview", "b-roll"]);
  });

  it("reports unfinished text and its removal to the owner", () => {
    const onDraftChange = vi.fn();
    render(<Harness onDraftChange={onDraftChange} />);

    fireEvent.change(field(), { target: { value: "unfinished" } });
    expect(field()).toHaveValue("unfinished");
    expect(onDraftChange).toHaveBeenLastCalledWith("unfinished");

    fireEvent.change(field(), { target: { value: "finished," } });
    expect(names()).toEqual(["finished"]);
    expect(field()).toHaveValue("");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
  });

  it("splits a pasted list into tokens", () => {
    render(<Harness />);
    fireEvent.paste(field(), { clipboardData: { getData: () => "interview, b-roll\nnewark" } });
    expect(names()).toEqual(["interview", "b-roll"]);
    expect(field()).toHaveValue("newark");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(names()).toEqual(["interview", "b-roll", "newark"]);
  });

  it("keeps stored spelling and rejects a duplicate in any case", () => {
    render(<Harness initial={[{ value: "Newark" }]} />);
    fireEvent.change(field(), { target: { value: "newark," } });
    expect(names()).toEqual(["Newark"]);
    expect(screen.getByRole("status")).toHaveTextContent("Newark is already a tag.");
  });

  it("enforces the length and count limits at commit", () => {
    render(<Harness initial={[{ value: "a" }, { value: "b" }]} maxCount={2} maxLength={5} />);
    fireEvent.change(field(), { target: { value: "c," } });
    expect(screen.getByRole("status")).toHaveTextContent("Use 2 tags or fewer.");
    expect(field()).toHaveValue("c");

    fireEvent.click(screen.getByRole("button", { name: "Remove tag b" }));
    fireEvent.change(field(), { target: { value: "toolong," } });
    expect(names()).toEqual(["a"]);
    expect(screen.getByRole("status")).toHaveTextContent("Keep each tag to 5 characters or fewer.");
  });

  it("removes the last token with two presses of Backspace in an empty field", () => {
    render(<Harness initial={[{ value: "news" }, { value: "trenton" }]} />);
    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(names()).toEqual(["news", "trenton"]);
    expect(screen.getByRole("button", { name: "Remove tag trenton" }).closest(".ui-token"))
      .toHaveClass("ui-token-pending");

    fireEvent.keyDown(field(), { key: "Backspace" });
    expect(names()).toEqual(["news"]);
  });

  it("announces the pending Backspace and points the marked token at it", () => {
    render(<Harness initial={[{ value: "news" }, { value: "trenton" }]} />);
    fireEvent.keyDown(field(), { key: "Backspace" });
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Press Backspace again to remove trenton.");
    expect(removeButton("trenton")).toHaveAttribute("aria-describedby", status.id);

    fireEvent.change(field(), { target: { value: "s" } });
    expect(status).toHaveTextContent("");
    expect(removeButton("trenton")).not.toHaveAttribute("aria-describedby");
  });

  it("marks tokens that only some selected items share", () => {
    render(<Harness initial={[{ value: "news" }, { value: "b-roll", mixed: true }]} />);
    const mixed = removeButton("b-roll, on some items").closest(".ui-token");
    expect(mixed).toHaveClass("ui-token-mixed");
    expect(mixed).toHaveTextContent("mixed");
    expect(removeButton("news")).toBeInTheDocument();
  });

  it("suggests matching tags that are not already used", () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ value: "trenton" }]} onChange={onChange} suggestions={["trenton", "transit", "studio"]} />);
    fireEvent.change(field(), { target: { value: "tr" } });

    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["transit"]);
    expect(field()).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field()).toHaveAttribute("aria-activedescendant", screen.getByRole("option").id);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(names()).toEqual(["trenton", "transit"]);
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("inserts a pasted list at the cursor and keeps the incomplete part in the field", () => {
    render(<Harness />);
    const input = field() as HTMLInputElement;
    fireEvent.change(input, { target: { value: "old text" } });
    input.setSelectionRange(0, 3);
    fireEvent.paste(input, { clipboardData: { getData: () => "x,y" } });
    expect(names()).toEqual(["x"]);
    expect(input).toHaveValue("y text");
  });

  it("closes the suggestion list when focus leaves the field", () => {
    render(<Harness suggestions={["transit"]} />);
    fireEvent.change(field(), { target: { value: "tr" } });
    expect(field()).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(field());
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the field one tab stop and moves between tokens with the arrow keys", () => {
    render(<Harness initial={[{ value: "a" }, { value: "b" }, { value: "c" }]} />);
    expect(removeButton("a")).toHaveAttribute("tabindex", "-1");
    const input = field() as HTMLInputElement;
    input.focus();

    fireEvent.change(input, { target: { value: "xy" } });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "" } });

    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(removeButton("c")).toHaveFocus();
    fireEvent.keyDown(removeButton("c"), { key: "ArrowLeft" });
    expect(removeButton("b")).toHaveFocus();
    fireEvent.keyDown(removeButton("b"), { key: "ArrowRight" });
    expect(removeButton("c")).toHaveFocus();
    fireEvent.keyDown(removeButton("c"), { key: "ArrowRight" });
    expect(input).toHaveFocus();

    removeButton("b").focus();
    fireEvent.keyDown(removeButton("b"), { key: "Backspace" });
    expect(names()).toEqual(["a", "c"]);
    expect(removeButton("a")).toHaveFocus();
    fireEvent.keyDown(removeButton("a"), { key: "Delete" });
    expect(names()).toEqual(["c"]);
    expect(input).toHaveFocus();
  });

  it("ignores Return and comma splits while an IME is composing", () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: "東京" } });
    fireEvent.keyDown(field(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(names()).toEqual([]);
    expect(field()).toHaveValue("東京");

    fireEvent.compositionStart(field());
    fireEvent.change(field(), { target: { value: "東京,大阪" } });
    expect(names()).toEqual([]);
    fireEvent.compositionEnd(field());
    expect(names()).toEqual(["東京"]);
    expect(field()).toHaveValue("大阪");
  });

  it("selects the last suggestion on the first ArrowUp and the first on ArrowDown", () => {
    render(<Harness suggestions={["transit", "trenton", "trivia"]} />);
    fireEvent.change(field(), { target: { value: "tr" } });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[2].id);

    fireEvent.change(field(), { target: { value: "tr" } });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(field()).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[0].id);
  });

  it("keeps rejected text in the field so staff can edit it", () => {
    render(<Harness initial={[{ value: "Newark" }]} maxLength={5} />);
    fireEvent.change(field(), { target: { value: "toolong" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(names()).toEqual(["Newark"]);
    expect(field()).toHaveValue("toolong");

    fireEvent.paste(field(), { clipboardData: { getData: () => "," } });
    expect(field()).toHaveValue("toolong");

    fireEvent.change(field(), { target: { value: "ok, newark, x" } });
    expect(names()).toEqual(["Newark", "ok"]);
    expect(field()).toHaveValue("newark, x");
  });

  it("renders and removes stored tags that differ only in case independently", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Harness initial={[{ value: "News" }, { value: "news" }]} />);
    expect(names()).toEqual(["News", "news"]);
    fireEvent.click(removeButton("News"));
    expect(names()).toEqual(["news"]);
    expect(error.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    error.mockRestore();
  });

  it("applies no count limit when maxCount is omitted, as in bulk editing", () => {
    render(<Harness initial={[{ value: "a" }, { value: "b", mixed: true }, { value: "c", mixed: true }]} />);
    fireEvent.change(field(), { target: { value: "d," } });
    expect(names()).toEqual(["a", "b", "c", "d"]);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("shows the suggestion note as the last line and it is not an option", () => {
    const note = "From this page and your recent tags.";
    render(<Harness suggestions={["trenton", "transit", "studio"]} suggestionsNote={note} />);
    expect(screen.queryByText(note)).toBeNull();

    fireEvent.change(field(), { target: { value: "tr" } });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["trenton", "transit"]);
    const line = screen.getByText(note);
    expect(line).not.toHaveAttribute("role", "option");
    expect(line.closest("[role='option']")).toBeNull();
    expect(options.at(-1)?.compareDocumentPosition(line)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Screen readers hear the note with the list, not as a choice.
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-describedby", line.id);

    // Arrow keys cycle through the options only.
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field()).toHaveAttribute("aria-activedescendant", options[1].id);
    fireEvent.change(field(), { target: { value: "zz" } });
    expect(screen.queryByText(note)).toBeNull();
  });

  it("reports each committed tag once through onCommit", () => {
    const onCommit = vi.fn();
    render(<Harness initial={[{ value: "Newark" }, { value: "Interview", mixed: true }]} onCommit={onCommit} promoteMixed />);
    fireEvent.paste(field(), { clipboardData: { getData: () => "b-roll, studio, b-roll\n" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(["b-roll", "studio"]);

    // A refused duplicate is not a commit.
    fireEvent.change(field(), { target: { value: "newark" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);

    // Typing a mixed tag puts it on every item: it is committed in its stored spelling.
    fireEvent.change(field(), { target: { value: "interview" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(["Interview"]);
    expect(removeButton("Interview")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove tag Interview, on some items" })).toBeNull();

    // Removing a tag is not a commit.
    fireEvent.click(removeButton("studio"));
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("offers a mixed tag as a suggestion when typing it would put it on every item", () => {
    render(<Harness initial={[{ value: "trenton", mixed: true }, { value: "transit" }]} promoteMixed suggestions={["trenton", "transit"]} />);
    fireEvent.change(field(), { target: { value: "tr" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["trenton"]);
  });

  it("scrolls the active suggestion into view", () => {
    const original = Element.prototype.scrollIntoView;
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      render(<Harness suggestions={["transit", "trenton"]} />);
      fireEvent.change(field(), { target: { value: "tr" } });
      act(() => {
        fireEvent.keyDown(field(), { key: "ArrowDown" });
      });
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(screen.getAllByRole("option")[0]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("TokenInput model", () => {
  it("typing a mixed tag makes it solid instead of refusing it", () => {
    const tokens = [{ value: "Newark" }, { value: "Interview", mixed: true }];
    const promoted = addTokens(tokens, ["interview"], { maxLength: 40, promoteMixed: true });
    expect(promoted).toEqual({ tokens: [{ value: "Newark" }, { value: "Interview" }], accepted: 1, rejected: [], error: "" });
    // Without the flag, and for a solid token, it stays a refused duplicate.
    expect(addTokens(tokens, ["interview"], { maxLength: 40 })).toMatchObject({ tokens, accepted: 0, rejected: ["interview"], error: "Interview is already a tag." });
    expect(addTokens(tokens, ["newark"], { maxLength: 40, promoteMixed: true })).toMatchObject({ accepted: 0, error: "Newark is already a tag." });
    // The exact spelling wins when stored case variants are both mixed, as video tags may be.
    const variants = [{ value: "Interview", mixed: true }, { value: "interview", mixed: true }];
    expect(addTokens(variants, ["interview"], { maxLength: 40, promoteMixed: true }).tokens).toEqual([{ value: "Interview", mixed: true }, { value: "interview" }]);
  });
});
