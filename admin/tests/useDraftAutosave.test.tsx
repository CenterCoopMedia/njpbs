import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftAutosave } from "../src/hooks/useDraftAutosave";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function connectivity(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  act(() => window.dispatchEvent(new Event(online ? "online" : "offline")));
}

describe("Draft autosave", () => {
  it("saves only a dirty draft at the 60-second interval", async () => {
    let draft: string | null = null;
    const save = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useDraftAutosave({
      identity: "post-1",
      enabled: true,
      saving: false,
      draftKey: () => draft,
      save,
    }));

    await advance(60_000);
    expect(save).not.toHaveBeenCalled();

    draft = "edit-1";
    await advance(59_999);
    expect(save).not.toHaveBeenCalled();
    await advance(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("saved");
  });

  it("does not start a duplicate save while one is in flight", async () => {
    const pending = deferred<boolean>();
    const save = vi.fn(() => pending.promise);
    const { result } = renderHook(() => useDraftAutosave({
      identity: "post-1",
      enabled: true,
      saving: false,
      draftKey: () => "edit-1",
      save,
    }));

    await advance(60_000);
    expect(result.current).toBe("saving");
    await advance(180_000);
    expect(save).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(true));
    expect(result.current).toBe("saved");
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("waits for a new edit before retrying a failed draft", async () => {
    let draft = "edit-1";
    const save = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const { result } = renderHook(() => useDraftAutosave({
      identity: "post-1",
      enabled: true,
      saving: false,
      draftKey: () => draft,
      save,
    }));

    await advance(60_000);
    expect(result.current).toBe("error");
    await advance(180_000);
    expect(save).toHaveBeenCalledTimes(1);

    draft = "edit-2";
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current).toBe("saved");
  });

  it("keeps offline drafts pending until the ordinary interval after reconnect", async () => {
    connectivity(false);
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() => useDraftAutosave({
      identity: "post-1", enabled: true, saving: false,
      draftKey: () => "edit-1", save,
    }));
    await advance(180_000);
    expect(save).not.toHaveBeenCalled();
    connectivity(true);
    expect(save).not.toHaveBeenCalled();
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each(["refused", "rejected", "thrown"])("retries an unchanged %s draft once after reconnect", async (failure) => {
    const save = vi.fn().mockResolvedValue(false);
    if (failure === "rejected") save.mockRejectedValueOnce(new TypeError("Network error"));
    if (failure === "thrown") save.mockImplementationOnce(() => { throw new TypeError("Network error"); });
    const { result } = renderHook(() => useDraftAutosave({
      identity: "post-1", enabled: true, saving: false, savedVersion: 4,
      draftKey: () => "edit-1", save,
    }));
    await advance(60_000);
    expect(result.current).toBe("error");
    connectivity(true); // Duplicate online events do not enable another attempt.
    await advance(180_000);
    expect(save).toHaveBeenCalledTimes(1);
    connectivity(false);
    await advance(180_000);
    expect(save).toHaveBeenCalledTimes(1);
    connectivity(true);
    expect(save).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(2);
    // A refused retry remains suppressed until another edit/baseline/reconnect.
    await advance(180_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("settles an in-flight save before considering reconnect retry (saved: %s)", async (saved) => {
    const pending = deferred<boolean>();
    const save = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(true);
    const { result } = renderHook(() => useDraftAutosave({
      identity: "post-1", enabled: true, saving: false,
      draftKey: () => "edit-1", save,
    }));
    await advance(60_000);
    connectivity(false);
    connectivity(true);
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(saved));
    expect(result.current).toBe(saved ? "saved" : "error");
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(saved ? 1 : 2);
  });

  it("uses current draft and gates after reconnect, and removes listeners on exit", async () => {
    let draft: string | null = "edit-1";
    const save = vi.fn().mockResolvedValue(false);
    const remove = vi.spyOn(window, "removeEventListener");
    const { rerender, unmount } = renderHook(({ enabled, saving }) => useDraftAutosave({
      identity: "post-1", enabled, saving, draftKey: () => draft, save,
    }), { initialProps: { enabled: true, saving: false } });
    await advance(60_000);
    connectivity(false);
    connectivity(true);
    rerender({ enabled: false, saving: false });
    await advance(60_000);
    rerender({ enabled: true, saving: true });
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    draft = null; // Manual save or revert cleared the live draft while offline.
    rerender({ enabled: true, saving: false });
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalledWith("offline", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("online", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false])("retries an earlier edit after the saved baseline changes (first save: %s)", async (firstSaved) => {
    let draft = "edit-a";
    const save = vi.fn().mockResolvedValueOnce(firstSaved).mockResolvedValue(true);
    const { rerender } = renderHook(({ savedVersion }) => useDraftAutosave({
      identity: "post-1", enabled: true, saving: false, savedVersion,
      draftKey: () => draft, save,
    }), { initialProps: { savedVersion: 1 } });
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    // A manual save stores B, then undo restores the earlier local edit A.
    draft = "edit-b";
    rerender({ savedVersion: 2 });
    draft = "edit-a";
    await advance(60_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("ignores stale save feedback after an identity change or unmount", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const states: string[] = [];
    const { result, rerender, unmount } = renderHook(
      ({ identity }) => {
        const state = useDraftAutosave({
          identity,
          enabled: true,
          saving: false,
          draftKey: () => "edit-1",
          save,
        });
        states.push(state);
        return state;
      },
      { initialProps: { identity: "post-1" } },
    );

    await advance(60_000);
    expect(result.current).toBe("saving");
    rerender({ identity: "post-2" });
    expect(result.current).toBe("idle");

    await act(async () => first.resolve(true));
    expect(result.current).toBe("idle");
    expect(states).not.toContain("saved");

    await advance(60_000);
    expect(result.current).toBe("saving");
    unmount();
    await act(async () => second.resolve(false));
    expect(states).not.toContain("error");
    expect(vi.getTimerCount()).toBe(0);
  });
});
