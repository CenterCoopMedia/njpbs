import { liveProductionEnabled } from "../lib/live-production-access";
import { adminPerf, type RouteCategory } from "../lib/perf-receipts";
import { routeCategoryForPath } from "../lib/routes";

const loadAccountSettingsRoute = () => import("./AccountSettingsRoute");
const loadPremiereConnectRoute = loadAccountSettingsRoute;
const loadProfileRoutes = () => import("./profile-chunk");
const loadAuthorProfileRoute = loadProfileRoutes;
const loadAuthorProfilesRoute = loadProfileRoutes;
const loadAdminSettingsRoute = () => import("./AdminSettingsRoute");
const loadCostLedgerRoute = loadAdminSettingsRoute;
const loadDeskRoutes = () => import("./desk-chunk");
const loadAnalyticsRoute = loadDeskRoutes;
const loadActivityRoute = loadDeskRoutes;
const loadContentLayout = () => import("./ContentLayout");
const loadPostTemplatesRoute = () => import("./PostTemplatesRoute");
const loadContentWorkspace = () => import("../components/ContentTab");
const loadDashboardRoute = () => import("./DashboardRoute");
const loadMediaRoute = () => import("./MediaRoute");
const loadNotFoundRoute = () => import("./NotFound");
const loadQueueRoute = () => import("./QueueRoute");
const loadReportsRoute = loadDeskRoutes;
const loadGuideResourceRoutes = () => import("./guide-resource-chunk");
const loadGuideRoute = loadGuideResourceRoutes;
const loadResourcesRoute = loadGuideResourceRoutes;
const loadScheduleRoute = loadDeskRoutes;
const loadStaffRoute = () => import("./StaffRoute");

export const adminRouteModules = {
  accountSettings: loadAccountSettingsRoute,
  premiereConnect: loadPremiereConnectRoute,
  accountProfile: loadAuthorProfileRoute,
  authorProfiles: loadAuthorProfilesRoute,
  adminSettings: loadAdminSettingsRoute,
  costs: loadCostLedgerRoute,
  activity: loadActivityRoute,
  analytics: loadAnalyticsRoute,
  content: loadContentLayout,
  open: () => import("./OpenContentRoute"),
  postTemplates: loadPostTemplatesRoute,
  cuez: () => import("./cuez-storydesk"),
  dashboard: loadDashboardRoute,
  media: loadMediaRoute,
  voiceovers: loadMediaRoute,
  notFound: loadNotFoundRoute,
  queue: loadQueueRoute,
  reports: loadReportsRoute,
  guide: loadGuideRoute,
  resources: loadResourcesRoute,
  schedule: loadScheduleRoute,
  liveProduction: () => liveProductionEnabled() ? import("./LiveProductionRoute") : loadNotFoundRoute(),
  staff: loadStaffRoute,
};

export interface InitialRoutePreloaders {
  accountSettings: () => Promise<unknown>;
  premiereConnect: () => Promise<unknown>;
  accountProfile: () => Promise<unknown>;
  authorProfiles: () => Promise<unknown>;
  adminSettings: () => Promise<unknown>;
  costs: () => Promise<unknown>;
  activity: () => Promise<unknown>;
  analytics: () => Promise<unknown>;
  content: () => Promise<unknown>;
  open: () => Promise<unknown>;
  postTemplates: () => Promise<unknown>;
  cuez: () => Promise<unknown>;
  dashboard: () => Promise<unknown>;
  media: () => Promise<unknown>;
  voiceovers: () => Promise<unknown>;
  notFound: () => Promise<unknown>;
  queue: () => Promise<unknown>;
  reports: () => Promise<unknown>;
  guide: () => Promise<unknown>;
  resources: () => Promise<unknown>;
  schedule: () => Promise<unknown>;
  liveProduction: () => Promise<unknown>;
  staff: () => Promise<unknown>;
}

// The loader map every speculative start uses: `adminRouteModules` with one deliberate
// difference. ContentLayout is the small routed boundary, so starting it alone leaves the
// heaviest graph -- the editor workspace and the rich-text family behind it -- for after the
// click. Starting both in parallel is what makes a content destination worth preloading at all,
// on the addressed startup path (#998) and on an intent prefetch (#1065) alike.
export const adminRoutePreloaders: InitialRoutePreloaders = {
  ...adminRouteModules,
  content: () => Promise.all([loadContentLayout(), loadContentWorkspace()]),
};

// The one route-to-import map. A key here names a loader in `adminRouteModules`, and the map
// below is the only place a path becomes one of those names, so the initial addressed preload
// and the intent prefetch (#1065) start the same module rather than keeping two registries that
// can drift.
export type RouteModuleKey = keyof typeof adminRouteModules;

const MODULE_KEY_FOR_ROUTE_CATEGORY: Record<RouteCategory, RouteModuleKey> = {
  cuez: "cuez",
  dashboard: "dashboard",
  content: "content",
  open: "open",
  "post-templates": "postTemplates",
  activity: "activity",
  analytics: "analytics",
  media: "media",
  voiceovers: "voiceovers",
  queue: "queue",
  reports: "reports",
  guide: "guide",
  resources: "resources",
  schedule: "schedule",
  "live-production": "liveProduction",
  "account-settings": "accountSettings",
  "premiere-connect": "premiereConnect",
  "account-profile": "accountProfile",
  "author-profiles": "authorProfiles",
  "admin-settings": "adminSettings",
  costs: "costs",
  "staff-access": "staff",
  "not-found": "notFound",
};

// Which module a pathname needs. Built on the receipt's route category rather than a second
// chain of path comparisons: the category split is already the addressed-route split, so a new
// route is named once in `routes.ts` and reaches both call sites. An address outside the known
// vocabulary resolves to the not-found module, exactly as navigation would.
export function routeModuleKeyForPath(pathname: string): RouteModuleKey {
  return MODULE_KEY_FOR_ROUTE_CATEGORY[routeCategoryForPath(pathname)];
}

// Start only the public JavaScript graph for the addressed route. This does not
// create a router, render the shell, or read user data. App keeps all three behind
// the existing admission and confirmed-profile boundary.
//
// The download is timed as its own boundary in the performance receipt (#1064), by route
// category rather than by address, so a slow session can be separated into route download
// and everything else without recording which page or record was open.
export async function preloadInitialRoute(
  pathname: string,
  modules: InitialRoutePreloaders = adminRoutePreloaders,
): Promise<void> {
  const operation = adminPerf.begin("route-load", {
    route: routeCategoryForPath(pathname),
  });
  try {
    await startAddressedModule(pathname, modules);
    operation.end({ outcome: "ok" });
  } catch (error) {
    operation.end({ outcome: "error" });
    throw error;
  }
}

async function startAddressedModule(
  path: string,
  modules: InitialRoutePreloaders,
): Promise<void> {
  await modules[routeModuleKeyForPath(path)]();
}

