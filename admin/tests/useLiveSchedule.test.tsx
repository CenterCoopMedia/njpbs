import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveSchedule } from "../src/components/useLiveSchedule";
import { renderScheduleNowNextFrame } from "../../packages/content-core/src/schedule-now-next-render";
import type { ScheduleSourceSnapshot } from "../../packages/content-core/src/schedule-source-snapshot";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../src/lib/schedule-source-snapshot", () => ({ loadScheduleSourceSnapshot: mocks.load }));
const snapshot: ScheduleSourceSnapshot = {
  schemaVersion: 1, publication: { buildBatchId: "test", generation: 62, commitSha: "a".repeat(40) },
  source: "pbs-tvss", timeZone: "America/New_York", checkedAt: "2026-09-06T00:00:00Z",
  days: [{ date: "2026-09-06", callsign: "wnjt", entries: [
    { title: "First program", startsAt: "2026-09-06T08:00:00-04:00", endsAt: "2026-09-06T09:00:00-04:00" },
    { title: "Second program", startsAt: "2026-09-06T09:00:00-04:00", endsAt: "2026-09-06T10:00:00-04:00" },
  ] }],
};
function frame() {
  const root = document.createElement("main");
  root.innerHTML = renderScheduleNowNextFrame("compact");
  document.body.append(root);
  return root;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T08:59:30-04:00"));
  mocks.load.mockReset().mockResolvedValue(snapshot);
});
afterEach(() => {
  cleanup(); document.body.replaceChildren(); vi.useRealTimers();
});

describe("Live canvas source lifecycle", () => {
  it("does not fetch schedule data for other service pages", () => {
    renderHook(() => useLiveSchedule(false));
    expect(mocks.load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates the real strip at the minute boundary without replacing focused content", async () => {
    const { result, unmount } = renderHook(() => useLiveSchedule(true));
    await act(async () => {});
    const root = frame();
    result.current.render(root);
    const program = root.querySelector("[data-now-next-current-program]")!;
    expect(program.textContent).toBe("First program");
    const focused = document.createElement("button");
    root.append(focused); focused.focus();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(program.textContent).toBe("Second program");
    expect(document.activeElement).toBe(focused);
    expect(root.querySelector("[data-now-next-current-program]")).toBe(program);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers source failure and reports a schedule window that does not cover today", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Unavailable"));
    const { result } = renderHook(() => useLiveSchedule(true));
    await act(async () => {});
    const root = frame();
    result.current.render(root);
    expect(result.current.source.status).toBe("error");
    expect(root.textContent).toContain("Reload schedule above");
    await act(async () => result.current.retry());
    result.current.render(root);
    expect(result.current.source.status).toBe("ready");
    expect(root.querySelector("[data-now-next-current-program]")?.textContent).toBe("First program");
    vi.setSystemTime(new Date("2026-09-07T08:59:30-04:00"));
    result.current.render(root);
    expect(root.querySelector("[data-now-next-fallback-message]")?.textContent).toContain("no listings for today");
    expect(root.querySelector<HTMLElement>("[data-now-next-ready]")?.hidden).toBe(true);
  });

  it("aborts a slow request and stops pending work when the editor closes", async () => {
    let signal: AbortSignal | undefined;
    mocks.load.mockImplementation((requestSignal: AbortSignal) => {
      signal = requestSignal;
      return new Promise((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
    });
    const { result, unmount } = renderHook(() => useLiveSchedule(true));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(signal?.aborted).toBe(true);
    expect(result.current.source.status).toBe("error");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
