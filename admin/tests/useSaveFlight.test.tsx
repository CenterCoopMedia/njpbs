import { StrictMode } from "react";
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSaveFlight } from "../src/hooks/useSaveFlight";

afterEach(cleanup);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("save ownership", () => {
  it("keeps the same pending operation across renders and StrictMode", async () => {
    const saved = deferred<number>();
    const start = vi.fn(() => saved.promise);
    const { result, rerender } = renderHook(() => useSaveFlight<number>(), { wrapper: StrictMode });
    const first = result.current(start);
    rerender();
    expect(result.current(start)).toBe(first);
    await act(async () => saved.resolve(8));
    expect(await first).toBe(8);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("owns the operation before a callback can reenter", async () => {
    const { result } = renderHook(() => useSaveFlight<number>());
    const other = vi.fn(() => 9);
    let joined!: Promise<number>;
    const first = result.current(() => { joined = result.current(other); return 8; });
    expect(joined).toBe(first);
    expect(await joined).toBe(8);
    expect(other).not.toHaveBeenCalled();
  });

  it("does not coalesce two already completed synchronous operations", async () => {
    const { result } = renderHook(() => useSaveFlight<number>());
    const first = result.current(() => 7);
    const next = result.current(() => 8);
    expect(next).not.toBe(first);
    expect(await next).toBe(8);
  });

  it("releases synchronous validation throws without an automatic replay", async () => {
    const { result } = renderHook(() => useSaveFlight<number>());
    const start = vi.fn(() => { throw new Error("Invalid intent"); });
    await expect(result.current(start)).rejects.toThrow("Invalid intent");
    expect(start).toHaveBeenCalledTimes(1);
    expect(await result.current(() => 8)).toBe(8);
  });

  it("shares asynchronous refusal then permits a separate deliberate operation", async () => {
    const saved = deferred<number>();
    const { result } = renderHook(() => useSaveFlight<number>());
    const start = vi.fn(() => saved.promise);
    const first = result.current(start);
    expect(result.current(start)).toBe(first);
    const refused = expect(first).rejects.toThrow("Interrupted");
    saved.reject(new Error("Interrupted"));
    await refused;
    expect(start).toHaveBeenCalledTimes(1);
    expect(await result.current(() => 8)).toBe(8);
  });

  it("isolates document changes and late resolution of the previous document", async () => {
    const a = deferred<number>(); const b = deferred<number>();
    const { result, rerender } = renderHook(({ id }) => useSaveFlight<number>(id), { initialProps: { id: "page:a" } });
    const first = result.current(() => a.promise);
    rerender({ id: "post:b" });
    const second = result.current(() => b.promise);
    expect(second).not.toBe(first);
    a.resolve(7); await first;
    expect(result.current(() => 99)).toBe(second);
    b.resolve(8); expect(await second).toBe(8);
  });

  it("accepts thenables as pending without requiring native Promise identity", async () => {
    const saved = deferred<number>();
    const { result } = renderHook(() => useSaveFlight<number>());
    const thenable: PromiseLike<number> = { then: saved.promise.then.bind(saved.promise) };
    const first = result.current(() => thenable);
    expect(result.current(() => 99)).toBe(first);
    saved.resolve(8); expect(await first).toBe(8);
  });
});
