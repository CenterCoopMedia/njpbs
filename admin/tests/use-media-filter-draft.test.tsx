import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaKind } from "../src/lib/functions";
import { useMediaFilterDraft, type MediaFilterDraft } from "../src/lib/use-media-filter-draft";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The applied filters stand in for the URL: a commit lands there, as a route would.
function setup({ immediate = false, initial = { kinds: [] as MediaKind[], categories: [] as string[] } } = {}) {
  const onCommit = vi.fn();
  const hook = renderHook(({ immediate: now }) => {
    const [applied, setApplied] = useState<MediaFilterDraft>(initial);
    const draft = useMediaFilterDraft({
      applied,
      immediate: now,
      onCommit: (next) => {
        onCommit(next);
        setApplied(next);
      },
    });
    return { applied, draft };
  }, { initialProps: { immediate } });
  return { ...hook, onCommit };
}

describe("useMediaFilterDraft", () => {
  it("commits two quick toggles once, 300ms after the last", () => {
    const { onCommit, result } = setup();
    act(() => result.current.draft.toggleKind("image"));
    act(() => vi.advanceTimersByTime(200));
    act(() => result.current.draft.toggleCategory("news"));
    expect(result.current.draft.value).toEqual({ kinds: ["image"], categories: ["news"] });
    act(() => vi.advanceTimersByTime(299));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ kinds: ["image"], categories: ["news"] });
    expect(result.current.applied).toEqual({ kinds: ["image"], categories: ["news"] });
  });

  it("commits a pending draft at once when flushed on close", () => {
    const { onCommit, result } = setup();
    act(() => result.current.draft.toggleCategory("sports"));
    act(() => result.current.draft.flush());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ kinds: [], categories: ["sports"] });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Nothing pending: a flush sends nothing.
    act(() => result.current.draft.flush());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("commits each toggle at once when immediate is set", () => {
    const { onCommit, result } = setup({ immediate: true });
    act(() => result.current.draft.toggleKind("document"));
    expect(onCommit).toHaveBeenLastCalledWith({ kinds: ["document"], categories: [] });
    act(() => result.current.draft.toggleKind("image"));
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith({ kinds: ["document", "image"], categories: [] });
  });

  it("reset drops the draft and shows the URL values again", () => {
    const { onCommit, result } = setup({ initial: { kinds: ["image"], categories: ["news"] } });
    act(() => result.current.draft.toggleCategory("news"));
    expect(result.current.draft.value).toEqual({ kinds: ["image"], categories: [] });
    act(() => result.current.draft.reset());
    expect(result.current.draft.value).toEqual({ kinds: ["image"], categories: ["news"] });
    act(() => vi.advanceTimersByTime(1_000));
    expect(onCommit).not.toHaveBeenCalled();
  });
});
