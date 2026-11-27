import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMAGE_UPLOAD_ACTIONS, measureEndpointUsage, measureUsage, startUsageAnalytics, VIDEO_START_ACTIONS, VIDEO_TRANSFER_ACTIONS, usageActionCollector, usageScreen, type UsageEvent } from "../src/lib/boardwalk-usage";

let visible = true;
let time = 0;
let active: ReturnType<typeof startUsageAnalytics> | undefined;
const batches: { batchId: string; events: UsageEvent[] }[] = [];
beforeEach(() => {
  vi.useFakeTimers(); visible = true; time = 0; batches.length = 0;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
});
afterEach(() => { active?.stop(); active = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
const send = async (batch: { batchId: string; events: UsageEvent[] }) => { batches.push(batch); };
// Offsets are checked in their own test; other tests compare the rest of each event.
const events = () => batches.flatMap(batch => batch.events).map(event => { const copy = { ...event }; delete copy.offsetMs; return copy; });
const tick = async (ms: number) => { time += ms; await vi.advanceTimersByTimeAsync(ms); };

describe("standard usage analytics (#4495)", () => {
  it("creates no timers, requests or action collection while disabled", async () => {
    const before = vi.getTimerCount();
    active = startUsageAnalytics({ enabled: false, send, pathname: "/content/post", now: () => time });
    usageActionCollector()("content.publish.request", "record", "private-id");
    active.navigate("/media/images");
    expect(vi.getTimerCount()).toBe(before);
    await tick(120_000);
    expect(batches).toEqual([]);
  });

  it("classifies destinations without retaining addresses, queries or source IDs", () => {
    expect(usageScreen("/content/post/record-123/edit")).toBe("posts-editor");
    expect(usageScreen("/content/post")).toBe("posts-list");
    expect(usageScreen("/media/favorites")).toBe("media-favorites");
    expect(usageScreen("/media/collections/private-collection")).toBe("media-collections");
    expect(usageScreen("/media/submissions")).toBe("media-submissions");
    expect(usageScreen("/media")).toBe("media-landing");
    expect(usageScreen("/media/videos/custom-private-source")).toBe("videos");
    expect(usageScreen("/media/images")).toBe("images");
    expect(usageScreen("/unrecognized/private-data")).toBeNull();
  });

  it("records visible duration, pauses hidden time and labels accepted actions only", async () => {
    active = startUsageAnalytics({ enabled: true, send, pathname: "/content/post", now: () => time });
    await tick(5_000);
    time += 10_000; visible = false; document.dispatchEvent(new Event("visibilitychange"));
    await tick(120_000);
    visible = true; document.dispatchEvent(new Event("visibilitychange"));
    await tick(5_000);
    active.navigate("/media/videos/private-source-id");
    usageActionCollector()("preview.request", "page", "page-123");
    await tick(5_000);
    expect(events().filter(event => event.name === "screen.view")).toEqual([
      { name: "screen.view", screen: "posts-list" }, { name: "screen.view", screen: "videos" },
    ]);
    const duration = events().filter(event => event.name === "screen.duration");
    expect(duration.reduce((sum, event) => sum + ("durationMs" in event ? event.durationMs : 0), 0)).toBe(20_000);
    expect(events()).toContainEqual({ name: "preview.request", screen: "videos", objectType: "page", objectId: "page-123" });
    expect(JSON.stringify(events())).not.toMatch(/private-source|\/content|\/media/);
  });

  it("defers an initially hidden view until it is visible", async () => {
    visible = false;
    active = startUsageAnalytics({ enabled: true, send, pathname: "/content/post", now: () => time });
    await tick(60_000); expect(events()).toEqual([]);
    visible = true; document.dispatchEvent(new Event("visibilitychange"));
    await tick(5_000);
    expect(events()).toEqual([{ name: "screen.view", screen: "posts-list" }]);
  });

  it("batches rapid tab visibility changes instead of sending more than once in five seconds", async () => {
    active = startUsageAnalytics({ enabled: true, send, pathname: "/content/post", now: () => time });
    await tick(5_000);
    for (let index = 0; index < 10; index++) {
      time += 100; visible = !visible; document.dispatchEvent(new Event("visibilitychange"));
    }
    expect(batches).toHaveLength(1);
    await tick(4_000);
    expect(batches).toHaveLength(2);
  });

  it("bounds queued work, drops failures and never overlaps delivery", async () => {
    let finish!: () => void;
    const network = vi.fn(async (batch: { batchId: string; events: UsageEvent[] }) => {
      batches.push(batch); await new Promise<void>(resolve => { finish = resolve; });
      throw new Error("Network unavailable");
    });
    active = startUsageAnalytics({ enabled: true, send: network, pathname: "/content/post", now: () => time });
    const record = usageActionCollector();
    for (let index = 0; index < 100; index++) record("content.publish.request", "record", `post-${index}`);
    await tick(5_000);
    expect(batches[0].events).toHaveLength(20);
    record("content.publish.request", "record", "later");
    await tick(60_000);
    expect(network).toHaveBeenCalledTimes(1);
    finish(); await tick(0); await tick(60_000);
    expect(network).toHaveBeenCalledTimes(2);
    // The later batch contains only new duration; failed and overlapping actions were dropped.
    expect(batches[1].events.every(event => event.name === "screen.duration")).toBe(true);
  });

  it("drops pending and late actions after session departure, including across another sign-in", async () => {
    active = startUsageAnalytics({ enabled: true, send, pathname: "/content/post", now: () => time });
    const oldAction = usageActionCollector();
    active.stop();
    active = startUsageAnalytics({ enabled: true, send, pathname: "/media/images", now: () => time });
    oldAction("content.publish.request", "record", "private-old-user-record");
    await tick(5_000);
    expect(events()).toEqual([{ name: "screen.view", screen: "images" }]);
  });

  it("stamps each event with its age when the batch is sent", async () => {
    active = startUsageAnalytics({ enabled: true, send, pathname: "/content/post", now: () => time });
    time += 3_000;
    usageActionCollector()("preview.request", "page", "page-1");
    await tick(5_000);
    expect(batches[0].events.map(event => [event.name, event.offsetMs])).toEqual([["screen.view", 8_000], ["preview.request", 5_000]]);
  });

  it("counts a search, without its text, when a search box's query reaches its first character", async () => {
    active = startUsageAnalytics({ enabled: true, send, pathname: "/media/images", now: () => time });
    const box = document.body.appendChild(Object.assign(document.createElement("input"), { type: "search" }));
    const other = document.body.appendChild(Object.assign(document.createElement("input"), { type: "text" }));
    const type = (input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
    type(box, "   ");
    type(other, "private");
    type(box, "p"); type(box, "private search text");
    // A Clear button resets a controlled box without an input event; the next query still counts.
    box.value = ""; type(box, "s"); type(box, "second");
    // A query pasted into a box that was reset without an input event also counts.
    box.value = ""; type(box, "pasted query");
    // A browser fires beforeinput with the box's real value before each edit.
    const paste = (input: HTMLInputElement, value: string) => {
      input.dispatchEvent(new Event("beforeinput", { bubbles: true })); type(input, value);
    };
    // A multi-character paste into a new, empty box counts.
    const fresh = document.body.appendChild(Object.assign(document.createElement("input"), { type: "search" }));
    paste(fresh, "first pasted query");
    // After Clear resets the box without an input event, pasting the same query again counts.
    fresh.value = ""; paste(fresh, "first pasted query");
    // Typing more of the same query does not count again.
    paste(fresh, "first pasted query more");
    await tick(5_000);
    box.remove(); other.remove(); fresh.remove();
    expect(events()).toEqual([{ name: "screen.view", screen: "images" },
      ...Array.from({ length: 5 }, () => ({ name: "search", screen: "images" }))]);
    expect(JSON.stringify(batches)).not.toMatch(/private|second|pasted/);
  });

  it("measures upload outcomes once per operation and endpoint actions at the Functions boundary", async () => {
    active = startUsageAnalytics({ enabled: true, send, pathname: "/media/videos", now: () => time });
    await measureUsage(VIDEO_START_ACTIONS, undefined, async () => "ok");
    await measureUsage(VIDEO_TRANSFER_ACTIONS, undefined, async () => "ok");
    // A transfer stopped by an internal timeout is a failure; only the person's own cancel is not.
    const timedOut = new AbortController();
    await expect(measureUsage(VIDEO_TRANSFER_ACTIONS, new AbortController().signal, async () => { timedOut.abort(); throw new Error("timeout"); })).rejects.toThrow();
    await expect(measureUsage(IMAGE_UPLOAD_ACTIONS, undefined, async () => { throw new Error("refused"); })).rejects.toThrow("refused");
    await measureEndpointUsage("cmsUploadMedia", undefined, async () => "ok");
    await measureEndpointUsage("cmsRequestVideoClip", undefined, async () => "ok");
    await expect(measureEndpointUsage("cmsSaveContent", undefined, async () => { throw new Error("conflict"); })).rejects.toThrow();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(measureEndpointUsage("cmsSaveContent", cancelled.signal, async () => { throw new Error("aborted"); })).rejects.toThrow();
    await measureEndpointUsage("cmsListContent", undefined, async () => "ok");
    await tick(5_000);
    expect(events().slice(1).map(event => event.name)).toEqual(["media.upload.start", "media.upload.finish",
      "media.upload.failure", "media.upload.start", "media.upload.failure", "media.clip.request", "content.save.failure"]);
  });
});
