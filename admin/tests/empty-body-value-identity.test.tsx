// A body field with nothing in it must hand the same document to its editor on every render.
//
// RichTextEditor is controlled, and its value-sync effect is keyed on `value`. When the render-time
// default minted a fresh `emptyRichTextDoc()` each pass, every empty body on the page got a new
// value identity whenever the block list re-rendered, the effect re-ran, and it deep-compared the
// editor's own JSON against the default. On a page of empty prose blocks that was one full
// serialize-and-compare per block per keystroke (#511). Nothing about it is visible on screen,
// which is why it is pinned here as an identity assertion rather than left to a timing test.
//
// The real RichTextEditor is replaced by a recorder: this is a test about what the parents pass,
// not about TipTap, and mounting real editors here would measure the wrong thing.

import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RichTextDoc } from "../../packages/content-core/src/content-model";
import { FieldRenderer } from "../src/components/FieldRenderer";
import { InlineBlockSurface } from "../src/components/InlineBlockSurface";
import type { EditorField } from "../../packages/content-core/src/editor-admin";
import type { AdminBlock } from "../src/lib/block-factory";

const seenValues: RichTextDoc[] = [];

vi.mock("../src/components/RichTextEditor", () => ({
  RichTextEditor: ({
    value,
    ariaLabel,
  }: {
    value: RichTextDoc;
    ariaLabel: string;
  }) => {
    seenValues.push(value);
    return <div role="textbox" aria-label={ariaLabel} />;
  },
}));

const bodyField: EditorField = {
  key: "content",
  label: "Body",
  help: "Write.",
  kind: "richText",
  required: true,
};

beforeEach(() => {
  seenValues.length = 0;
});

afterEach(cleanup);

// A parent that re-renders without touching the body, which is exactly what a sibling block's
// edit does to every other card in the block editor.
function Rerendering({ subject }: { subject: () => ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount(count + 1)}>
        Re-render {count}
      </button>
      {/* Called on every pass, so the subject really re-renders -- a child element held by
          identity would be skipped, and this measures what a re-rendered card does. */}
      {subject()}
    </div>
  );
}

describe("empty rich-text body value identity", () => {
  it("keeps one document identity across renders of a descriptor-rendered empty body", () => {
    render(
      <Rerendering
        subject={() => (
          <FieldRenderer
            field={bodyField}
            value={undefined}
            onChange={() => {}}
            fieldId="f"
          />
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));

    expect(seenValues.length).toBeGreaterThan(2);
    for (const value of seenValues) expect(value).toBe(seenValues[0]);
  });

  it("keeps one document identity across renders of an empty inline prose block", () => {
    const block: AdminBlock = {
      id: "prose-1",
      type: "prose",
      order: 0,
      visible: true,
      data: {},
    };
    render(
      <Rerendering
        subject={() => (
          <InlineBlockSurface block={block} hasError={false} onChange={() => {}} />
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));

    expect(seenValues.length).toBeGreaterThan(2);
    for (const value of seenValues) expect(value).toBe(seenValues[0]);
  });
});
