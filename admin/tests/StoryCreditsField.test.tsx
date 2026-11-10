// The ordered-byline control (issue #1040). What an editor can actually do with
// a byline: credit one colleague or several, add a credit that is only text,
// reorder them, and still read a credit whose author has left.

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FieldRenderer } from "../src/components/FieldRenderer";
import { RecordForm } from "../src/components/RecordForm";
import type { EditorField } from "../../packages/content-core/src/editor-admin";
import { mintAuthorId } from "../../packages/content-core/src/author-profiles";
import type { StoryCredit } from "../../packages/content-core/src/story-credits";
import type { BylineAuthorOption } from "../src/lib/functions";

afterEach(cleanup);

const ADA = mintAuthorId("a".repeat(32));
const BEN = mintAuthorId("b".repeat(32));
const GONE = mintAuthorId("c".repeat(32));

const AUTHORS: BylineAuthorOption[] = [
  { authorId: ADA, displayName: "Ada Reporter", jobTitle: "Reporter" },
  { authorId: BEN, displayName: "Ben Producer", jobTitle: null },
];

const bylineField: EditorField = {
  key: "credits",
  label: "Byline",
  help: "Credit the people who made this.",
  kind: "storyCredits",
  required: false,
};

function Harness({
  initial = [],
  authors = AUTHORS,
  authorsUnavailable = false,
  onValue,
}: {
  initial?: StoryCredit[];
  authors?: BylineAuthorOption[];
  authorsUnavailable?: boolean;
  onValue?: (credits: StoryCredit[]) => void;
}) {
  const [value, setValue] = useState<StoryCredit[]>(initial);
  return (
    <FieldRenderer
      field={bylineField}
      value={value}
      onChange={(next) => {
        setValue(next as StoryCredit[]);
        onValue?.(next as StoryCredit[]);
      }}
      fieldId="byline"
      bylineAuthors={authors}
      bylineAuthorsUnavailable={authorsUnavailable}
    />
  );
}

function creditRows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Byline, in order" })).getAllByRole(
    "listitem",
  );
}

describe("the byline control", () => {
  it("is a group named by its label, with an empty state that is not a blank input", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: /Byline/ });
    expect(group).toBeTruthy();
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });

  it("adds a registered author by name and stores their id, not their name", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText("Add a staff byline"), {
      target: { value: ADA },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add staff byline" }));
    expect(onValue).toHaveBeenCalledWith([{ kind: "registered", authorId: ADA }]);
    expect(creditRows()).toHaveLength(1);
    expect(creditRows()[0].textContent).toContain("Ada Reporter");
  });

  it("credits more than one person, in the order they were added", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText("Add a staff byline"), {
      target: { value: ADA },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add staff byline" }));
    fireEvent.change(screen.getByLabelText("Add a staff byline"), {
      target: { value: BEN },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add staff byline" }));
    expect(onValue).toHaveBeenLastCalledWith([
      { kind: "registered", authorId: ADA },
      { kind: "registered", authorId: BEN },
    ]);
    expect(creditRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Ada Reporter"),
      expect.stringContaining("Ben Producer"),
    ]);
  });

  it("does not offer someone who is already credited", () => {
    render(<Harness initial={[{ kind: "registered", authorId: ADA }]} />);
    const picker = screen.getByLabelText("Add a staff byline") as HTMLSelectElement;
    const options = [...picker.options].map((option) => option.textContent);
    expect(options.some((label) => label?.includes("Ben Producer"))).toBe(true);
    expect(options.some((label) => label?.includes("Ada Reporter"))).toBe(false);
  });

  it("adds a custom credit as sanitized text and creates no identity", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText("Add a custom credit"), {
      target: { value: "  NJ  PBS staff " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add custom credit" }));
    expect(onValue).toHaveBeenCalledWith([{ kind: "custom", name: "NJ PBS staff" }]);
    expect(creditRows()[0].textContent).toContain("Custom credit");
  });

  it("adds a custom credit from the keyboard", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const input = screen.getByLabelText("Add a custom credit");
    fireEvent.change(input, { target: { value: "The Associated Press" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValue).toHaveBeenCalledWith([
      { kind: "custom", name: "The Associated Press" },
    ]);
  });

  it("reorders credits and names each control by the credit it moves", () => {
    const onValue = vi.fn();
    render(
      <Harness
        initial={[
          { kind: "registered", authorId: ADA },
          { kind: "custom", name: "NJ PBS staff" },
        ]}
        onValue={onValue}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Move down.*Ada Reporter/ }));
    expect(onValue).toHaveBeenCalledWith([
      { kind: "custom", name: "NJ PBS staff" },
      { kind: "registered", authorId: ADA },
    ]);
    expect(creditRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("NJ PBS staff"),
      expect.stringContaining("Ada Reporter"),
    ]);
  });

  it("disables the reorder controls at each end", () => {
    render(
      <Harness
        initial={[
          { kind: "registered", authorId: ADA },
          { kind: "registered", authorId: BEN },
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Move up.*Ada Reporter/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Move down.*Ben Producer/ }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Move down.*Ada Reporter/ }),
    ).not.toBeDisabled();
  });

  it("removes a credit by name", () => {
    const onValue = vi.fn();
    render(
      <Harness
        initial={[
          { kind: "registered", authorId: ADA },
          { kind: "custom", name: "NJ PBS staff" },
        ]}
        onValue={onValue}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Ada Reporter from the byline" }),
    );
    expect(onValue).toHaveBeenCalledWith([{ kind: "custom", name: "NJ PBS staff" }]);
  });

  it("keeps a departed author's credit readable rather than showing a raw id", () => {
    // The author is gone from the picker feed, but the story still credits them.
    // The published snapshot froze the name; the editor shows that, never `au_…`.
    render(
      <Harness
        initial={[
          { kind: "registered", authorId: GONE, displayName: "Cam Editor" },
        ]}
      />,
    );
    const row = creditRows()[0];
    expect(row.textContent).toContain("Cam Editor");
    expect(row.textContent).not.toContain(GONE);
  });

  it("says an author is no longer listed when nothing froze their name", () => {
    render(<Harness initial={[{ kind: "registered", authorId: GONE }]} />);
    expect(creditRows()[0].textContent).toContain("Author no longer listed");
    expect(creditRows()[0].textContent).not.toContain(GONE);
  });

  it("still allows custom credits when the staff list cannot be read", () => {
    const onValue = vi.fn();
    render(<Harness authors={[]} authorsUnavailable onValue={onValue} />);
    expect(screen.getByLabelText("Add a staff byline")).toBeDisabled();
    expect(screen.getByText(/staff list could not be loaded/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Add a custom credit"), {
      target: { value: "NJ PBS staff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add custom credit" }));
    expect(onValue).toHaveBeenCalledWith([{ kind: "custom", name: "NJ PBS staff" }]);
  });
});

describe("the post editor's byline", () => {
  function renderPostForm(props: Record<string, unknown> = {}) {
    return render(
      <RecordForm
        kind="post"
        canSave
        bylineAuthors={AUTHORS}
        {...props}
      />,
    );
  }

  it("replaces the old free-text byline input", () => {
    renderPostForm();
    expect(screen.getByRole("group", { name: /Byline/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /^Byline/ })).toBeNull();
  });

  it("defaults a new post to the signed-in author when they have an identity", () => {
    renderPostForm({ selfAuthorId: ADA });
    expect(creditRows()[0].textContent).toContain("Ada Reporter");
  });

  it("defaults to no byline for an account with no author identity", () => {
    renderPostForm({ selfAuthorId: null });
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });

  it("opens a legacy post on its free-text author as one custom credit", () => {
    renderPostForm({
      selfAuthorId: ADA,
      initial: {
        id: "post-legacy",
        type: "post",
        title: "Budget vote",
        author: "Dana Freelancer",
        tags: [],
        blocks: [],
      },
      initialIsClean: true,
    });
    const rows = creditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Dana Freelancer");
    expect(rows[0].textContent).toContain("Custom credit");
  });

  it("does not default an existing post with no byline to the signed-in author", () => {
    renderPostForm({
      selfAuthorId: ADA,
      initial: {
        id: "post-existing",
        type: "post",
        title: "Budget vote",
        tags: [],
        blocks: [],
      },
      initialIsClean: true,
    });
    expect(screen.getByText("No byline yet.")).toBeTruthy();
  });

  it("carries the byline out of the form as ordered credits", () => {
    const onDraftChange = vi.fn();
    renderPostForm({
      selfAuthorId: ADA,
      onDraftChange,
      initial: {
        id: "post-1",
        type: "post",
        title: "Budget vote",
        tags: [],
        blocks: [],
        credits: [{ kind: "registered", authorId: ADA }],
      },
      initialIsClean: true,
    });
    fireEvent.change(screen.getByLabelText("Add a custom credit"), {
      target: { value: "NJ PBS staff" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add custom credit" }));
    expect(onDraftChange).toHaveBeenCalled();
    const draft = onDraftChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(draft.credits).toEqual([
      { kind: "registered", authorId: ADA },
      { kind: "custom", name: "NJ PBS staff" },
    ]);
  });
});
