import { describe, expect, it, vi } from "vitest";
import { ROUTE_CATEGORIES } from "../src/lib/perf-receipts";
import { routeCategoryForPath } from "../src/lib/routes";
import { adminRouteModules, routeModuleKeyForPath, type RouteModuleKey } from "../src/routes/routeModules";
import { createRoutePrefetcher, saveDataRequested, ROUTE_PREFETCH_DELAY_MS, type RoutePrefetchModules } from "../src/lib/route-prefetch";

// A controllable scheduler, so the intent delay is proved rather than waited out. Nothing here
// touches wall-clock time: a test that sleeps 120 ms proves the machine is slow, not that the
// timer exists.
function scheduler() {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    delays,
    pendingCount: () => pending.size,
    schedule(run: () => void, delayMs: number) {
      const handle = next;
      next += 1;
      delays.push(delayMs);
      pending.set(handle, run);
      return handle;
    },
    cancelScheduled(handle: number) {
      pending.delete(handle);
    },
    fire() {
      const due = Array.from(pending.entries());
      pending.clear();
      for (const [, run] of due) run();
    },
  };
}

function modules(): {
  loaders: RoutePrefetchModules;
  calls: Record<RouteModuleKey, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    accountSettings: vi.fn(async () => undefined),
    premiereConnect: vi.fn(async () => undefined),
    accountProfile: vi.fn(async () => undefined),
    authorProfiles: vi.fn(async () => undefined),
    adminSettings: vi.fn(async () => undefined),
    costs: vi.fn(async () => undefined),
    activity: vi.fn(async () => undefined),
    analytics: vi.fn(async () => undefined),
    content: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    postTemplates: vi.fn(async () => undefined),
    cuez: vi.fn(async () => undefined),
    dashboard: vi.fn(async () => undefined),
    media: vi.fn(async () => undefined),
    voiceovers: vi.fn(async () => undefined),
    notFound: vi.fn(async () => undefined),
    queue: vi.fn(async () => undefined),
    reports: vi.fn(async () => undefined),
    guide: vi.fn(async () => undefined),
    resources: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
    liveProduction: vi.fn(async () => undefined),
    staff: vi.fn(async () => undefined),
  };
  return { loaders: calls, calls };
}

function prefetcher(
  options: {
    saveData?: boolean;
    loaders?: RoutePrefetchModules;
    clock?: ReturnType<typeof scheduler>;
  } = {},
) {
  const clock = options.clock ?? scheduler();
  const built = options.loaders ? { loaders: options.loaders, calls: null } : modules();
  const connection = { saveData: options.saveData ?? false };
  const instance = createRoutePrefetcher({
    modules: built.loaders,
    saveData: () => connection.saveData,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
  return { instance, clock, calls: built.calls, loaders: built.loaders, connection };
}

describe("Admin route module keys", () => {
  it("resolves every route category to a real adminRouteModules loader", () => {
    for (const category of ROUTE_CATEGORIES) {
    const paths: Record<string, string> = {
      cuez: "/cuez-storydesk",
        dashboard: "/",
        open: "/open",
        content: "/content/pages/home/edit",
        "post-templates": "/post-templates",
        "premiere-connect": "/premiere/connect",
        activity: "/activity",
        analytics: "/analytics",
        media: "/media",
        voiceovers: "/voiceovers",
        queue: "/publish-queue",
        reports: "/reports",
        guide: "/guide/overview",
        resources: "/resources/nj-politics",
        schedule: "/schedule",
        "live-production": "/live-production",
        "account-settings": "/account/settings",
        "account-profile": "/account/profile",
        "author-profiles": "/staff-profiles",
        "admin-settings": "/admin/settings",
        costs: "/admin/settings/costs",
        "staff-access": "/staff-access",
        "not-found": "/nowhere-in-the-cms",
      };
      const path = paths[category];
      expect(routeCategoryForPath(path)).toBe(category);
      const key = routeModuleKeyForPath(path);
      expect(typeof adminRouteModules[key]).toBe("function");
    }
  });

});

describe("intent-based route prefetch", () => {
  it("starts the matching module after a sustained pointer intent", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/media", "pointer");
    expect(calls?.media).not.toHaveBeenCalled();
    expect(clock.delays).toEqual([ROUTE_PREFETCH_DELAY_MS]);

    clock.fire();
    expect(calls?.media).toHaveBeenCalledTimes(1);
    expect(instance.started()).toEqual(["media"]);
  });

  it("starts the matching module after keyboard focus settles on the control", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/activity", "focus");
    expect(calls?.activity).not.toHaveBeenCalled();

    clock.fire();
    expect(calls?.activity).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending intent when the pointer leaves before the delay", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/publish-queue", "pointer");
    instance.cancel();
    clock.fire();

    expect(calls?.queue).not.toHaveBeenCalled();
    expect(instance.started()).toEqual([]);
  });

  it("keeps a focus-armed intent when the pointer leaves the same control", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/media", "focus");
    instance.cancel("pointer");
    clock.fire();

    // The pointer moving off a control the keyboard is still on is not a withdrawal: no second
    // focus event follows, so cancelling here would leave Enter navigating cold.
    expect(calls?.media).toHaveBeenCalledTimes(1);
  });

  it("keeps a pointer-armed intent when focus moves off the same control", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/activity", "pointer");
    instance.cancel("focus");
    clock.fire();

    expect(calls?.activity).toHaveBeenCalledTimes(1);
  });

  it("cancels once every modality that armed the intent has withdrawn", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/queue-not-a-path", "pointer");
    instance.intent("/publish-queue", "pointer");
    instance.intent("/publish-queue", "focus");
    instance.cancel("pointer");
    instance.cancel("focus");
    clock.fire();

    expect(calls?.queue).not.toHaveBeenCalled();
  });

  it("lets intent toward another destination supersede the pending one", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/media", "focus");
    instance.intent("/activity", "pointer");
    clock.fire();

    expect(calls?.activity).toHaveBeenCalledTimes(1);
    expect(calls?.media).not.toHaveBeenCalled();
  });

  it("downloads only the destination a sweep settles on, not the whole rail", () => {
    const { instance, clock, calls } = prefetcher();

    for (const path of ["/", "/content", "/activity", "/media"]) {
      instance.intent(path, "pointer");
    }
    clock.fire();

    expect(calls?.media).toHaveBeenCalledTimes(1);
    for (const key of ["dashboard", "content", "activity"] as const) {
      expect(calls?.[key]).not.toHaveBeenCalled();
    }
  });

  it("starts immediately on pointer-down or touch, the strongest intent", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/staff-access", "activation");

    expect(calls?.staff).toHaveBeenCalledTimes(1);
    expect(clock.pendingCount()).toBe(0);
  });

  it("loads a module once however often intent repeats", () => {
    const { instance, clock, calls } = prefetcher();

    instance.intent("/content", "pointer");
    clock.fire();
    instance.intent("/content", "focus");
    clock.fire();
    instance.intent("/content/library", "activation");

    expect(calls?.content).toHaveBeenCalledTimes(1);
  });

  it("does not restart the timer while the same destination is already pending", () => {
    const { instance, clock } = prefetcher();

    instance.intent("/media", "pointer");
    instance.intent("/media", "focus");

    expect(clock.delays).toEqual([ROUTE_PREFETCH_DELAY_MS]);
    expect(clock.pendingCount()).toBe(1);
  });

  it("lets a later intent retry a module whose download failed", async () => {
    const { loaders, calls } = modules();
    const failure = vi.fn(async () => {
      throw new Error("chunk unavailable");
    });
    loaders.media = failure;
    const clock = scheduler();
    const instance = createRoutePrefetcher({
      modules: loaders,
      saveData: () => false,
      schedule: clock.schedule,
      cancelScheduled: clock.cancelScheduled,
    });

    instance.intent("/media", "activation");
    await Promise.resolve();
    await Promise.resolve();

    expect(instance.started()).toEqual([]);
    instance.intent("/media", "activation");
    expect(failure).toHaveBeenCalledTimes(2);
    expect(calls.dashboard).not.toHaveBeenCalled();
  });

  it("rechecks Save-Data when the timer fires, not only when intent began", () => {
    const { instance, clock, calls, connection } = prefetcher();

    instance.intent("/media", "pointer");
    connection.saveData = true;
    clock.fire();

    expect(calls?.media).not.toHaveBeenCalled();
    expect(instance.started()).toEqual([]);
  });

  it("suppresses every optional prefetch when the browser asks to save data", () => {
    const { instance, clock, calls } = prefetcher({ saveData: true });

    instance.intent("/media", "pointer");
    instance.intent("/activity", "activation");
    clock.fire();

    expect(clock.pendingCount()).toBe(0);
    expect(
      Object.values(calls ?? {}).filter((call) => call.mock.calls.length > 0),
    ).toHaveLength(0);
  });

  it("prefetches normally when the browser exposes no connection information", () => {
    const clock = scheduler();
    const { loaders, calls } = modules();
    const instance = createRoutePrefetcher({
      modules: loaders,
      schedule: clock.schedule,
      cancelScheduled: clock.cancelScheduled,
      navigator: {} as Navigator,
    });

    instance.intent("/activity", "pointer");
    clock.fire();

    expect(calls.activity).toHaveBeenCalledTimes(1);
  });
});

describe("Save-Data detection", () => {
  it("reads the connection hint when the browser exposes it", () => {
    expect(
      saveDataRequested({ connection: { saveData: true } } as unknown as Navigator),
    ).toBe(true);
    expect(
      saveDataRequested({ connection: { saveData: false } } as unknown as Navigator),
    ).toBe(false);
  });

});
