import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicContentStatusProvider, usePublicContentStatus } from "../src/context/PublicContentStatusContext";

const identity = { schemaVersion: 1, buildBatchId: "build-one", generation: 1, commitSha: "a".repeat(40) };
const routes = [{ path: "/", source: "site" }];
const response = (url: string, paths = routes) => Response.json(url.includes("_content-status")
  ? { ...identity, collections: ["cmsPages", "cmsPosts"], routes: paths } : identity);

function Watcher({ name = "Status" }: { name?: string }) {
  const status = usePublicContentStatus();
  return <output aria-label={name}>{status?.state}: {status?.routes.map(route => route.path).join(",")}</output>;
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const focus = () => act(async () => { window.dispatchEvent(new Event("focus")); });
async function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("public receipt recovery", () => {
  it.each(["interval", "focus", "visible"])("recovers failed reads on the next %s refresh", async trigger => {
    let failed = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (failed) throw new TypeError("Failed to fetch");
      return response(url);
    }));
    render(<PublicContentStatusProvider><Watcher /></PublicContentStatusProvider>);
    await act(async () => {});
    expect(screen.getByLabelText("Status")).toHaveTextContent("unavailable");
    failed = false;
    if (trigger === "interval") await advance(10_000);
    else if (trigger === "focus") await focus();
    else {
      await visibility("hidden");
      await visibility("visible");
    }
    expect(screen.getByLabelText("Status")).toHaveTextContent("current: /");
  });

  it("cancels the other receipt when one read fails, then retries the pair", async () => {
    let failed = true;
    let pendingSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      if (!failed) return Promise.resolve(response(url));
      if (url.includes("_publication")) return Promise.reject(new TypeError("Failed to fetch"));
      pendingSignal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        pendingSignal!.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true });
      });
    }));
    render(<PublicContentStatusProvider><Watcher /></PublicContentStatusProvider>);
    await act(async () => {});
    expect(screen.getByLabelText("Status")).toHaveTextContent("unavailable");
    expect(pendingSignal?.aborted).toBe(true);
    failed = false;
    await advance(10_000);
    expect(screen.getByLabelText("Status")).toHaveTextContent("current: /");
  });

  it.each(["fetch", "body"])("releases a timed-out %s even when cancellation has not settled it", async boundary => {
    let stalled = false;
    const pending: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      if (!stalled) return Promise.resolve(response(url));
      signals.push(options.signal as AbortSignal);
      // Model a read which has not delivered its abort rejection yet.
      if (boundary === "fetch") return new Promise<Response>(resolve => {
        pending.push(() => resolve(response(url, [{ path: "/obsolete/", source: "site" }])));
      });
      const result = response(url);
      result.text = () => new Promise<string>(resolve => {
        pending.push(() => resolve(JSON.stringify(url.includes("_content-status")
          ? { ...identity, collections: ["cmsPages", "cmsPosts"], routes: [{ path: "/obsolete/", source: "site" }] }
          : identity)));
      });
      return Promise.resolve(result);
    }));
    render(<PublicContentStatusProvider><Watcher /></PublicContentStatusProvider>);
    await act(async () => {});
    expect(screen.getByLabelText("Status")).toHaveTextContent("current: /");
    stalled = true;
    await advance(10_000);
    await advance(8_000);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(screen.getByLabelText("Status")).toHaveTextContent("unavailable");
    stalled = false;
    await advance(2_000);
    expect(screen.getByLabelText("Status")).toHaveTextContent("current: /");
    await act(async () => { pending.forEach(resolve => resolve()); });
    expect(screen.getByLabelText("Status")).toHaveTextContent("current: /");
    expect(screen.getByLabelText("Status")).not.toHaveTextContent("obsolete");
  });

  it("recovers an unavailable tab after hiding aborts a pending refresh", async () => {
    let mode: "failed" | "stalled" | "current" = "failed";
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      if (mode === "failed") return Promise.reject(new TypeError("Failed to fetch"));
      if (mode === "current") return Promise.resolve(response(url));
      signals.push(options.signal as AbortSignal);
      return new Promise<Response>(() => {});
    }));
    render(<PublicContentStatusProvider><Watcher /></PublicContentStatusProvider>);
    await act(async () => {});
    expect(screen.getByLabelText("Status")).toHaveTextContent("unavailable");
    mode = "stalled";
    await focus();
    await visibility("hidden");
    expect(signals.every(signal => signal.aborted)).toBe(true);
    mode = "current";
    await visibility("visible");
    await advance(10_000);
    expect(screen.getByLabelText("Status")).toHaveTextContent("current: /");
  });

  it("starts a hidden tab on visibility and keeps polling after repeated visibility changes", async () => {
    await visibility("hidden");
    let paths = routes;
    const fetchMock = vi.fn(async (url: string) => response(url, paths));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicContentStatusProvider><Watcher /></PublicContentStatusProvider>);
    await advance(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await visibility("visible");
      expect(screen.getByLabelText("Status")).toHaveTextContent("current");
      paths = [{ path: `/cycle-${cycle}/`, source: "site" }];
      await advance(10_000);
      expect(screen.getByLabelText("Status")).toHaveTextContent(`current: /cycle-${cycle}/`);
      await visibility("hidden");
      const calls = fetchMock.mock.calls.length;
      await advance(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
  });

  it("shares polling across rows, stops at zero watchers and revalidates when rows return", async () => {
    let failed = true;
    const fetchMock = vi.fn(async (url: string) => {
      if (failed) throw new TypeError("Failed to fetch");
      return response(url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const rows = (count: number) => <PublicContentStatusProvider>
      {Array.from({ length: count }, (_, index) => <Watcher key={index} name={`Row ${index}`} />)}
    </PublicContentStatusProvider>;
    const view = render(rows(2));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.rerender(rows(1));
    failed = false;
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText("Row 0")).toHaveTextContent("current: /");
    view.rerender(rows(0));
    await advance(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    failed = true;
    view.rerender(rows(1));
    await act(async () => {});
    expect(screen.getByLabelText("Row 0")).toHaveTextContent("unavailable");
    failed = false;
    await advance(10_000);
    expect(screen.getByLabelText("Row 0")).toHaveTextContent("current: /");
  });
});
