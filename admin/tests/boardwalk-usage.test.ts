import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUsageAnalytics, usageActionCollector, usageScreen, type UsageEvent } from "../src/lib/boardwalk-usage";

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
const events = () => batches.flatMap(batch => batch.events);
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
    expect(usageScreen("/content/post/record-123/edit")).toBe("posts");
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
      { name: "screen.view", screen: "posts" }, { name: "screen.view", screen: "videos" },
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
    expect(events()).toEqual([{ name: "screen.view", screen: "posts" }]);
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
});
