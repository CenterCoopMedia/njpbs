import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listSourceMedia, type SourceMediaPage } from "../src/lib/source-media";
import { useMediaProcessingPoll } from "../src/lib/use-media-processing-poll";

vi.mock("../src/lib/source-media", () => ({ listSourceMedia: vi.fn() }));
const token = vi.fn(async () => "token");
const result = vi.fn();
const complete = vi.fn();
const page = (ids: string[], state = "processing") => ({ success: true,
  records: ids.map(id => ({ id, viewingCopy: { state } })), nextCursor: null, hasMore: false, total: null,
}) as SourceMediaPage;
const tick = (ms = 10_000) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function hook(ids = ["pending-b", "pending-a", "pending-a"], scope = "user:page") {
  return renderHook(({ ids, scope }) => useMediaProcessingPoll(scope, "video-library", ids, token, result, complete),
    { initialProps: { ids, scope } });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(listSourceMedia).mockResolvedValue(page(["pending-a", "pending-b"]));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("coalesces distinct pending IDs and never overlaps a slow request", async () => {
  let finish!: (page: SourceMediaPage) => void;
  vi.mocked(listSourceMedia).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = hook();
  await tick();
  expect(listSourceMedia).toHaveBeenCalledExactlyOnceWith("token", { sourceId: "video-library", pendingIds: ["pending-a", "pending-b"] });
  view.rerender({ ids: ["pending-b", "pending-a"], scope: "user:page" });
  await tick(30_000);
  expect(listSourceMedia).toHaveBeenCalledTimes(1);
  await act(async () => { finish(page(["pending-a", "pending-b"], "ready")); });
  expect(complete).toHaveBeenCalledTimes(1);
  view.unmount();
  await tick();
  expect(listSourceMedia).toHaveBeenCalledTimes(1);
});

it("pauses hidden and offline, including a token wait, then resumes one batch", async () => {
  let hidden = true;
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => hidden ? "hidden" : "visible");
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  hook();
  await tick(60_000);
  expect(token).not.toHaveBeenCalled();
  hidden = false;
  online = false;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await tick(60_000);
  expect(listSourceMedia).not.toHaveBeenCalled();
  online = true;
  act(() => { window.dispatchEvent(new Event("online")); });
  await tick();
  expect(listSourceMedia).toHaveBeenCalledTimes(1);
  hidden = true;
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await tick(60_000);
  expect(listSourceMedia).toHaveBeenCalledTimes(1);
});

it("discards old page responses and waits for an existing request before another page poll", async () => {
  let finish!: (page: SourceMediaPage) => void;
  vi.mocked(listSourceMedia).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = hook();
  await tick();
  view.rerender({ ids: ["other"], scope: "user:other-page" });
  await tick();
  expect(listSourceMedia).toHaveBeenCalledTimes(1);
  await act(async () => { finish(page(["pending-a"], "ready")); });
  expect(result).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  await tick();
  expect(listSourceMedia).toHaveBeenLastCalledWith("token", { sourceId: "video-library", pendingIds: ["other"] });
});

it("backs off after 60 bounded polls and makes no request for an idle page", async () => {
  const view = hook();
  for (let i = 0; i < 60; i += 1) await tick();
  expect(listSourceMedia).toHaveBeenCalledTimes(60);
  await tick(59_999);
  expect(listSourceMedia).toHaveBeenCalledTimes(60);
  await tick(1);
  expect(listSourceMedia).toHaveBeenCalledTimes(61);
  view.rerender({ ids: [], scope: "user:page" });
  await tick(120_000);
  expect(listSourceMedia).toHaveBeenCalledTimes(61);
  view.rerender({ ids: ["new-upload"], scope: "user:page" });
  await tick(9_999);
  expect(listSourceMedia).toHaveBeenCalledTimes(61);
  await tick(1);
  expect(listSourceMedia).toHaveBeenCalledTimes(62);
  expect(listSourceMedia).toHaveBeenLastCalledWith("token", { sourceId: "video-library", pendingIds: ["new-upload"] });
});

it("retains backoff while a same-page refresh pauses polling", async () => {
  const view = renderHook(({ paused }) => useMediaProcessingPoll("user:page", "video-library",
    ["pending-a"], token, result, complete, paused), { initialProps: { paused: false } });
  for (let i = 0; i < 60; i += 1) await tick();
  view.rerender({ paused: true });
  await tick(120_000);
  expect(listSourceMedia).toHaveBeenCalledTimes(60);
  view.rerender({ paused: false });
  await tick(59_999);
  expect(listSourceMedia).toHaveBeenCalledTimes(60);
  await tick(1);
  expect(listSourceMedia).toHaveBeenCalledTimes(61);
});
