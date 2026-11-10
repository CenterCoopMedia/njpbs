import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaSearchField } from "../src/components/media/MediaSearchField";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(props: Partial<Parameters<typeof MediaSearchField>[0]> = {}) {
  const onCommit = vi.fn();
  const onSubmit = vi.fn();
  const view = render(<MediaSearchField onCommit={onCommit} onSubmit={onSubmit} value="" {...props} />);
  const input = screen.getByRole("searchbox", { name: "Search media" });
  return { ...view, input, onCommit, onSubmit };
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });
const css = readFileSync(resolve(process.cwd(), "src/components/media/MediaSearchField.css"), "utf8");

describe("MediaSearchField", () => {
  it("is a searchbox named Search media with id media-search-input inside a search landmark named Media library search", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("id", "media-search-input");
    expect(input).toHaveAttribute("type", "search");
    expect(screen.getByRole("search", { name: "Media library search" })).toContainElement(input);
    expect(screen.getAllByLabelText("Search media")).toEqual([input]);
    expect(screen.queryByRole("button", { name: /search/i })).toBeNull();
  });

  it("takes another id when a page needs one", () => {
    render(<MediaSearchField id="video-search" onCommit={() => {}} onSubmit={() => {}} value="" />);
    expect(screen.getByRole("searchbox", { name: "Search media" })).toHaveAttribute("id", "video-search");
  });

  it("shows the placeholder Search media and the title Search names, tags, credits and types · /", () => {
    const { input } = setup();
    expect(input).toHaveAttribute("placeholder", "Search media");
    expect(input).toHaveAttribute("title", "Search names, tags, credits and types · /");
  });

  it("commits the trimmed draft 300ms after the last keystroke, not at 299ms, and not when it equals the value", () => {
    const { input, onCommit } = setup({ value: "dome" });
    type(input, "dom");
    act(() => vi.advanceTimersByTime(200));
    type(input, " trenton ");
    act(() => vi.advanceTimersByTime(299));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("trenton");

    type(input, " dome ");
    act(() => vi.advanceTimersByTime(600));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit while commits are suppressed, then commits the pending draft once they resume", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<MediaSearchField locked onCommit={onCommit} onSubmit={() => {}} value="" />);
    type(screen.getByRole("searchbox"), "dome");
    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).not.toHaveBeenCalled();

    rerender(<MediaSearchField onCommit={onCommit} onSubmit={() => {}} value="" />);
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("dome");
  });

  it("submits the draft on Enter at once, even while commits are suppressed", () => {
    const { input, onCommit, onSubmit } = setup({ locked: true });
    type(input, " dome ");
    fireEvent.submit(input.closest("form")!);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("dome");
    act(() => vi.advanceTimersByTime(1000));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("re-syncs the draft when the value prop changes", () => {
    const { input, rerender } = setup({ value: "dome" });
    expect(input).toHaveValue("dome");
    rerender(<MediaSearchField onCommit={() => {}} onSubmit={() => {}} value="statehouse" />);
    expect(input).toHaveValue("statehouse");
  });

  it("cancels a pending draft when the source changes with the same applied search", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<MediaSearchField onCommit={onCommit} onSubmit={() => {}} syncKey="source-a" value="" />);
    const input = screen.getByRole("searchbox");
    type(input, "pending");
    rerender(<MediaSearchField onCommit={onCommit} onSubmit={() => {}} syncKey="source-b" value="" />);
    expect(input).toHaveValue("");
    act(() => vi.advanceTimersByTime(300));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("reports a draft to a route that coordinates it with filter changes", () => {
    const onDraftChange = vi.fn();
    const { input } = setup({ onDraftChange });
    type(input, "report");
    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith("report");
  });

  it("keeps a trailing space typed after a commit", () => {
    function Parent() {
      const [value, setValue] = useState("");
      return <MediaSearchField onCommit={setValue} onSubmit={setValue} value={value} />;
    }
    render(<Parent />);
    const input = screen.getByRole("searchbox");
    type(input, "new ");
    act(() => vi.advanceTimersByTime(300));
    expect(input).toHaveValue("new ");
  });

  it("a keystroke re-renders only the field, not its parent", () => {
    let parentRenders = 0;
    function Parent() {
      parentRenders += 1;
      return <MediaSearchField onCommit={() => {}} onSubmit={() => {}} value="" />;
    }
    render(<Parent />);
    const before = parentRenders;
    type(screen.getByRole("searchbox"), "d");
    type(screen.getByRole("searchbox"), "do");
    expect(screen.getByRole("searchbox")).toHaveValue("do");
    expect(parentRenders).toBe(before);
  });

  it("Escape with text commits an empty search when commits are allowed, and only clears the draft while they are suppressed; an empty field blurs; propagation stops", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    const { input, onCommit, rerender } = setup({ value: "dome" });
    input.focus();
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(input).toHaveValue("");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");

    rerender(<MediaSearchField locked onCommit={onCommit} onSubmit={() => {}} value="statehouse" />);
    expect(input).toHaveValue("statehouse");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(input).toHaveFocus();

    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(input).not.toHaveFocus();
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });

  it("shows Clear search only with text, follows the same commit rule, and returns focus to the field", () => {
    const { input, onCommit, rerender } = setup({ value: "" });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    type(input, "dome");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    // The value was already empty, so there is nothing to commit.
    expect(onCommit).not.toHaveBeenCalled();

    rerender(<MediaSearchField onCommit={onCommit} onSubmit={() => {}} value="dome" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("");

    rerender(<MediaSearchField locked onCommit={onCommit} onSubmit={() => {}} value="statehouse" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("shows the lock glyph and describes Save or discard details first while locked, and still accepts typing", () => {
    const { container, input } = setup({ locked: true });
    expect(input).toHaveAccessibleDescription("Save or discard details first.");
    expect(container.querySelector(".media-search-field-lock")).not.toBeNull();
    type(input, "dome");
    expect(input).toHaveValue("dome");
    expect(input).not.toBeDisabled();
  });

  it("describes nothing while unlocked", () => {
    const { container, input } = setup();
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(container.querySelector(".media-search-field-lock")).toBeNull();
  });

  it("focuses on / from the page but not from another text field, a shadow-root field, or while a dialog is open", () => {
    const { input } = setup();
    const other = document.createElement("textarea");
    document.body.append(other);
    const host = document.createElement("div");
    document.body.append(host);
    const shadowField = host.attachShadow({ mode: "open" }).appendChild(document.createElement("input"));

    other.focus();
    fireEvent.keyDown(other, { key: "/" });
    expect(input).not.toHaveFocus();
    shadowField.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, composed: true }));
    expect(input).not.toHaveFocus();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(input).not.toHaveFocus();
    dialog.remove();

    expect(fireEvent.keyDown(document.body, { key: "/" })).toBe(false);
    expect(input).toHaveFocus();
    other.remove();
    host.remove();
  });

  it("uses the shared standard Clear search target (36px fine, 44px coarse)", () => {
    const rule = css.match(/\.media-search-field-clear \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/width: var\(--cms-control-standard-target\);/);
    expect(rule).toMatch(/height: var\(--cms-control-standard-target\);/);
  });

  it("caps input at 200 characters", () => {
    expect(setup().input).toHaveAttribute("maxLength", "200");
  });

  it("hides the / hint at 60rem or less and while the field is focused or filled", () => {
    const narrow = css.match(/@media \(max-width: 60rem\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toMatch(/\.media-search-field-hint \{\s*display: none;/);
    expect(css).toMatch(/\.media-search-field:focus-within \.media-search-field-hint,\s*\.media-search-field\[data-filled\] \.media-search-field-hint \{\s*display: none;/);
    const { container, input } = setup();
    expect(container.querySelector(".media-search-field-hint")).toHaveAttribute("aria-hidden", "true");
    type(input, "dome");
    expect(container.querySelector(".media-search-field")).toHaveAttribute("data-filled");
  });
});
