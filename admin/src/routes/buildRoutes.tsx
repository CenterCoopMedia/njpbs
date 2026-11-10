import { liveProductionEnabled } from "../lib/live-production-access";
import { Navigate, type RouteObject } from "react-router";
import { ShellLayout } from "./ShellLayout";
import { RouteErrorBoundary } from "./RouteError";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { bootstrapPhase } from "../lib/bootstrap-phases";
import { dashboardPath, ROUTE_PATHS } from "../lib/routes";
import { adminRouteModules } from "./routeModules";

// A route's title and header description, read by the shell to fill the page heading and its
// supporting line, and the title by the focus manager to announce the destination on navigation
// (#587). Carried on the route's `handle` so it travels with the match rather than being
// re-derived from the pathname in the shell.
export interface RouteHandle {
  title: string;
  description: string;
}

// The route definitions are relative segments, but every path a link or a redirect builds comes
// from ROUTE_PATHS (absolute). Deriving the segments from the same constants keeps the tree and
// the path builders from drifting: a path named once is a path routed once.
function segment(path: string): string {
  return path.replace(/^\//, "");
}

// Destination components are dynamic imports on purpose. The shell stays eager and mounted,
// while each work surface loads only when its route is entered; mapping the existing named
// exports to React Router's Component key lets tests and the design gallery keep importing the
// same component names without creating route-only wrapper modules (#614).
const lazyDashboardRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.dashboard()).DashboardRoute,
});
const lazyContentLayout: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.content()).ContentLayout,
});
const lazyPostTemplatesRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.postTemplates()).PostTemplatesRoute,
});
const lazyQueueRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.queue()).QueueRoute,
});
const lazyReportsRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.reports()).ReportsRoute,
});
const lazyGuideRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.guide()).BoardwalkGuideRoute,
});
const lazyResourcesRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.resources()).PoliticsResourceRoute,
});
const lazyScheduleRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.schedule()).ScheduleRoute,
});
const lazyAnalyticsRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.analytics()).AnalyticsRoute,
});
const lazyActivityRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.activity()).ActivityRoute,
});
const lazyMediaRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.media()).MediaRoute,
});
const lazyVoiceoverLibraryRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.voiceovers()).VoiceoverMediaRoute,
});
const lazyStaffRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.staff()).StaffRoute,
});
const lazyAccountSettingsRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.accountSettings()).AccountSettingsRoute,
});
const lazyAuthorProfileRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.accountProfile()).AuthorProfileRoute,
});
const lazyAuthorProfilesRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.authorProfiles()).AuthorProfilesRoute,
});
const lazyAdminSettingsRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.adminSettings()).AdminSettingsRoute,
});
const lazyCostLedgerRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.costs()).CostLedgerRoute,
});
const lazyNotFoundRoute: RouteObject["lazy"] = async () => ({
  Component: (await adminRouteModules.notFound()).NotFoundRoute,
});

// The initial route wait, rendered in the shell's outlet while the addressed route's code
// arrives. It is the last bootstrap phase, so it shows that phase's own detail lines.
function RouteLoading() {
  return (
    <div className="route-loading">
      <LoadingIndicator
        label="Opening this workspace"
        layout="stack"
        stages={bootstrapPhase("workspace").details}
      />
    </div>
  );
}

// The admin route tree. Kept as a factory (not a prebuilt router) so App can wrap it in a
// browser router while tests wrap the same tree in a memory router, both under one ShellProvider.
// The shell is the layout for every route, so its sidebar, header, and focus manager stay mounted
// across navigation; only the outlet content changes.
//
// `/content/*` is a splat, not a set of nested child routes, so the content layout stays mounted
// while the user moves between editor surfaces and keeps the editor's drafts, baselines, and
// save signal across those moves (#579/#595). The layout parses the sub-path itself.
export function buildRoutes(): RouteObject[] {
  return [
    // The studio show screen renders outside the shell: no rail, header or menus. It shares the
    // live production module, so the feature flag and capability gate are the same.
    ...(liveProductionEnabled() ? [{
      path: ROUTE_PATHS.liveProductionStudio,
      lazy: async () => {
        const module = await adminRouteModules.liveProduction();
        return { Component: "LiveProductionStudioRoute" in module ? module.LiveProductionStudioRoute : module.NotFoundRoute };
      },
      errorElement: <RouteErrorBoundary />,
      hydrateFallbackElement: <RouteLoading />,
      handle: { title: "Studio", description: "Full-screen show controls for Overlay 1." } satisfies RouteHandle,
    }] : []),
    {
      path: "/",
      element: <ShellLayout />,
      // The shell itself gets the last-resort boundary: if ShellLayout is what threw, there is no
      // shell left to degrade into and a full-surface fallback is the only honest option.
      errorElement: <RouteErrorBoundary />,
      children: [
        {
          // Pathless, so it adds no segment and every route below is still matched by its own
          // path. It exists only to own an errorElement one level *inside* the shell: a throw in
          // any surface below is replaced here, in the shell's outlet, leaving the sidebar,
          // header, and heading mounted. Declaring this on the shell route instead would replace
          // the shell (#626).
          errorElement: <RouteErrorBoundary />,
          children: [
            {
              path: segment(ROUTE_PATHS.cuez),
              lazy: async () => ({ Component: (await adminRouteModules.cuez()).CuezStorydeskRoute }),
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "StoryDesk", description: "Selected transfers between Boardwalk and StoryDesk." } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.open),
              lazy: async () => ({ Component: (await adminRouteModules.open()).OpenContentRoute }),
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "Edit in Boardwalk", description: "Open the editor for a public page." } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.premiereConnect),
              lazy: async () => ({ Component: (await adminRouteModules.premiereConnect()).PremiereConnectRoute }),
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "Connect Premiere", description: "Approve your Premiere computer's access to Videos in the media library." } satisfies RouteHandle,
            },
            {
              index: true,
              lazy: lazyDashboardRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Home",
                description:
                  "Recent editorial work and the next task that needs attention.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.legacyDashboard),
              element: <Navigate to={dashboardPath()} replace />,
            },
            ...(liveProductionEnabled() ? [{
              path: segment(ROUTE_PATHS.liveProduction),
              lazy: async () => {
                const module = await adminRouteModules.liveProduction();
                return { Component: "LiveProductionRoute" in module ? module.LiveProductionRoute : module.NotFoundRoute };
              },
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "Live production", description: "Prepare banners and deliberately control Overlay 1." } satisfies RouteHandle,
            }] : []),
            {
              path: segment(ROUTE_PATHS.schedule),
              lazy: lazyScheduleRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Broadcast schedule",
                description: "Review the verified weekly broadcast plan across partner stations.",
              } satisfies RouteHandle,
            },
            {
              path: `${segment(ROUTE_PATHS.content)}/*`,
              lazy: lazyContentLayout,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Content studio",
                description: "Edit pages and records.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.postTemplates),
              lazy: lazyPostTemplatesRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "Post templates", description: "Reusable starting points for Posts." } satisfies RouteHandle,
            },
            {
              path: `${segment(ROUTE_PATHS.postTemplates)}/:templateId`,
              lazy: lazyPostTemplatesRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "Edit post template", description: "Edit a reusable starting point for Posts." } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.analytics),
              lazy: lazyAnalyticsRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: { title: "Analytics", description: "Site audience, traffic, and delivery performance." } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.activity),
              lazy: lazyActivityRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Activity",
                description:
                  "Review administrative content and access changes.",
              } satisfies RouteHandle,
            },
            {
              path: `${segment(ROUTE_PATHS.mediaLibrary)}/*`,
              lazy: lazyMediaRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Media library",
                description:
                  "Find images, documents, videos, and audio.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.voiceovers),
              lazy: lazyVoiceoverLibraryRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Media library",
                description: "Find images, documents, videos, and audio.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.publishQueue),
              lazy: lazyQueueRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Editorial queue",
                description:
                  "Review submitted content; administrators can also inspect deployment activity.",
              } satisfies RouteHandle,
            },
            {
              path: `${segment(ROUTE_PATHS.reports)}/*`,
              lazy: lazyReportsRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Reports",
                description:
                  "Follow your problem reports.",
              } satisfies RouteHandle,
            },
            {
              path: `${segment(ROUTE_PATHS.guide)}/:slug?`,
              lazy: lazyGuideRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Boardwalk guide",
                description: "Instructions for creating, reviewing, and maintaining NJ PBS content.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.politicsResource),
              lazy: lazyResourcesRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Resources",
                description: "Staff reference for people, districts, and sources.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.adminCosts),
              lazy: lazyCostLedgerRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Costs",
                description: "Track current costs, snapshots, and published platform comparisons.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.adminSettings),
              lazy: lazyAdminSettingsRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Admin settings",
                description: "Configure global Boardwalk settings.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.accountSettings),
              lazy: lazyAccountSettingsRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Account settings",
                description: "Set your personal CMS display preferences.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.accountProfile),
              lazy: lazyAuthorProfileRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Your profile",
                description:
                  "Prepare the byline and biography for your public profile.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.authorProfiles),
              lazy: lazyAuthorProfilesRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Staff profiles",
                description:
                  "Review, correct, or withdraw a staff member's profile data.",
              } satisfies RouteHandle,
            },
            {
              path: segment(ROUTE_PATHS.staffAccess),
              lazy: lazyStaffRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Staff access",
                description: "Review staff roles and area grants.",
              } satisfies RouteHandle,
            },
            {
              path: "*",
              lazy: lazyNotFoundRoute,
              hydrateFallbackElement: <RouteLoading />,
              handle: {
                title: "Page not found",
                description:
                  "The address you followed isn't part of Boardwalk.",
              } satisfies RouteHandle,
            },
          ],
        },
      ],
    },
  ];
}

