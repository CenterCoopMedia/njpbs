import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  preloadInitialRoute,
  type InitialRoutePreloaders,
} from "../src/routes/routeModules";

const adminRoot = process.cwd();
const appSource = readFileSync(resolve(adminRoot, "src/App.tsx"), "utf8");
const contentLayoutSource = readFileSync(
  resolve(adminRoot, "src/routes/ContentLayout.tsx"),
  "utf8",
);

function preloaders(): {
  loaders: InitialRoutePreloaders;
  calls: Record<keyof InitialRoutePreloaders, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    adminSettings: vi.fn(async () => undefined),
    costs: vi.fn(async () => undefined),
    accountSettings: vi.fn(async () => undefined),
    premiereConnect: vi.fn(async () => undefined),
    accountProfile: vi.fn(async () => undefined),
    authorProfiles: vi.fn(async () => undefined),
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

describe("initial Admin route preload", () => {
  it("starts the addressed workspace before router construction", () => {
    const preloadPosition = appSource.indexOf(
      "preloadInitialRoute(window.location.pathname)",
    );
    const routerPosition = appSource.indexOf(
      "const appRouter = createBrowserRouter(buildRoutes())",
    );

    expect(preloadPosition).toBeGreaterThan(-1);
    expect(routerPosition).toBeGreaterThan(preloadPosition);
    expect(appSource).toContain("catch(() => undefined)");
    expect(contentLayoutSource).toContain('import("../components/ContentTab")');
    expect(contentLayoutSource).toContain('label="Opening the editor."');
  });

  it.each([
    "/content",
    "/content/library",
    "/content/pages/home/edit",
    "/content/article/story-17/edit",
  ])(
    "starts the shared content graph for %s before admission finishes",
    async (path) => {
      const { loaders, calls } = preloaders();

      await preloadInitialRoute(path, loaders);

      expect(calls.content).toHaveBeenCalledTimes(1);
      expect(
        Object.values(calls).filter((call) => call.mock.calls.length > 0),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["/", "dashboard"],
    ["/cuez-storydesk", "cuez"],
    ["/premiere/connect", "premiereConnect"],
    ["/dashboard", "dashboard"],
    ["/activity", "activity"],
    ["/media", "media"],
    ["/media/images", "media"],
    ["/media/videos/archive-originals", "media"],
    ["/media/favorites", "media"],
    ["/media/collections", "media"],
    [`/media/collections/${"a".repeat(64)}`, "media"],
    ["/media/voiceovers", "media"],
    ["/voiceovers", "voiceovers"],
    ["/publish-queue", "queue"],
    ["/reports", "reports"],
    ["/guide/overview", "guide"],
    ["/resources/nj-politics", "resources"],
    ["/resources/nj-politics/", "resources"],
    ["/schedule", "schedule"],
    ["/admin/settings", "adminSettings"],
    ["/admin/settings/costs", "costs"],
    ["/account/settings", "accountSettings"],
    ["/account/profile", "accountProfile"],
    ["/staff-profiles", "authorProfiles"],
    ["/staff-access", "staff"],
    ["/not-a-cms-route", "notFound"],
  ] as const)(
    "preloads only the addressed %s route",
    async (path, expected) => {
      const { loaders, calls } = preloaders();

      await preloadInitialRoute(path, loaders);

      expect(calls[expected]).toHaveBeenCalledTimes(1);
      expect(
        Object.values(calls).filter((call) => call.mock.calls.length > 0),
      ).toHaveLength(1);
    },
  );
});

