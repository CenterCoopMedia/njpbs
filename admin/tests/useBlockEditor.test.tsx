import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBlockEditor } from "../src/hooks/useBlockEditor";

afterEach(cleanup);

function counterIds() {
  let count = 0;
  return () => `new-${++count}`;
}

describe("useBlockEditor authoritative state", () => {
  it("uses each synchronous result for a batched insert, remove, undo and reconcile sequence", () => {
    const { result } = renderHook(() => useBlockEditor("home", [], { newId: counterIds() }));
    const editor = result.current;
    let first: string | null = null;
    let refused: string | null = null;
    let second: string | null = null;

    act(() => {
      first = editor.insertContent("headline", {});
      refused = editor.insertContent("headline", {});
      second = editor.insertContent("prose", {});
      editor.removeBlock("new-1");
      editor.undo();
      editor.reconcileSavedIds({ "new-1": "saved-heading", "new-3": "saved-text" });
    });

    expect(first).toBe("new-1");
    expect(refused).toBeNull();
    expect(second).toBe("new-3");
    expect(result.current.blocks.map(block => block.id)).toEqual(["saved-heading", "saved-text"]);
    expect(result.current.error).toBeNull();
    expect(result.current.undoDepth).toBe(2);
    expect(result.current.canRedo).toBe(true);

    act(() => editor.redo());
    expect(result.current.blocks.map(block => block.id)).toEqual(["saved-text"]);
    act(() => editor.undo());
    expect(result.current.blocks.map(block => block.id)).toEqual(["saved-heading", "saved-text"]);
  });
});
