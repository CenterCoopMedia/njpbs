import { canUseLiveProduction } from "./live-production-access";
import { canUseCuez } from "./cuez-access";
import type { IconName } from "../components/ui/Icon";
import {
  can,
  hasCapability,
  type Principal,
} from "../../../packages/content-core/src/rbac";
import {
  canBrowseContentPages,
  canManageAuthorProfiles,
  canManageSettings,
  canUseContentStudio,
  canAccessAdmin,
  canAccessMediaWorkspace,
  canViewAudit,
  canViewAnalytics,
  canViewReports,
  canViewEditorialQueue,
  canViewUsers,
  isGuideOnly,
} from "./access";
import type { OrganizableDestination } from "./navigation-preferences";
import {
  activityPath,
  cuezPath,
  analyticsPath,
  adminCostsPath,
  adminSettingsPath,
  authorProfilesPath,
  contentLibraryPath,
  contentPagesPath,
  createRecordPath,
  dashboardPath,
  editPagePath,
  mediaLibraryPath,
  parseContentPath,
  politicsResourcePath,
  publishQueuePath,
  reportsPath,
  recordListPath,
  schedulePath,
  liveProductionPath,
  staffAccessPath,
  stripTrailingSlash,
  voiceoversPath,
} from "./routes";

export interface NavSubitemDef {
  id: string;
  label: string;
  to: string;
  external?: boolean;
  visible?: (principal: Principal) => boolean;
}

/**
 * One destination the primary navigation rail can offer, in the approved default order below.
 *
 * `visible` is the capability boundary: an account that fails it never sees the destination and
 * cannot arrange it. `required` marks destinations an account may reorder but never hide.
 * `activeFor` exists for the content destinations, whose current-section state is wider than one
 * URL — a page editor is still "Pages" — and is what the rail uses instead of a NavLink match.
 * `subitems` are contextual shortcuts inside an already-authorized destination. A shortcut may
 * add a narrower visibility check, but it can never widen the parent destination's boundary.
 */
export interface NavDestinationDef extends OrganizableDestination {
  id: string;
  label: string;
  icon: IconName;
  to: string;
  /** An absolute address opened in a new tab, not a Boardwalk route. */
  external?: boolean;
  customItem?: import("./custom-navigation").CustomNavItem;
  sectionOnly?: boolean;
  required?: boolean;
  visible: (principal: Principal) => boolean;
  activeFor?: (pathname: string) => boolean;
  subitems?: readonly NavSubitemDef[];
  group?: "Content" | "Workflow" | "Team" | "Administration";
}

function contentSection(
  pathname: string,
  section: "pages" | "posts" | "library",
): boolean {
  const route = parseContentPath(pathname);
  const isRecordRoute =
    route.kind === "record-list" ||
    route.kind === "create-record" ||
    route.kind === "edit-record";
  if (section === "pages") {
    return route.kind === "page-list" || route.kind === "edit-page";
  }
  if (section === "posts") {
    return isRecordRoute && route.type === "post";
  }
  return route.kind === "library" || (isRecordRoute && route.type !== "post");
}

/**
 * The rail's catalog. The order here is the approved default: it is what an account sees before it
 * arranges anything, what a reset returns to, and where a newly added destination lands for an
 * account that arranged the rail before it existed (#1045).
 *
 * Required destinations protect a signed-in workflow or recovery surface for each account that can
 * see them. The account's own destinations (Profile, Settings, Sign out) are not in this catalog at
 * all: they live in the account menu at the foot of the rail and are always present.
 */
export const NAV_DESTINATIONS: readonly NavDestinationDef[] = [
  {
    id: "home",
    label: "Home",
    icon: "dashboard",
    to: dashboardPath(),
    required: true,
    visible: (principal) => !isGuideOnly(principal),
  },
  {
    id: "pages",
    group: "Content",
    label: "Pages",
    icon: "page",
    to: contentPagesPath(),
    visible: canBrowseContentPages,
    activeFor: (pathname) => contentSection(pathname, "pages"),
    subitems: [
      { id: "all-pages", label: "All pages", to: contentPagesPath() },
      {
        id: "edit-home",
        label: "Edit home page",
        to: editPagePath("home"),
        visible: (principal) =>
          can(principal, "content.edit.any", { section: "station" }),
      },
    ],
  },
  {
    id: "posts",
    group: "Content",
    label: "Posts",
    icon: "pen-square",
    to: recordListPath("post"),
    visible: canUseContentStudio,
    activeFor: (pathname) => contentSection(pathname, "posts"),
    subitems: [
      { id: "all-posts", label: "All posts", to: recordListPath("post") },
      { id: "add-post", label: "Add new post", to: createRecordPath("post"), visible: (principal) => hasCapability(principal, "content.create") },
    ],
  },
  {
    id: "library",
    group: "Content",
    label: "All content",
    icon: "stack",
    to: contentLibraryPath(),
    visible: canUseContentStudio,
    activeFor: (pathname) => contentSection(pathname, "library"),
    subitems: [
      { id: "all-content", label: "Browse all content", to: contentLibraryPath() },
      { id: "all-programs", label: "Programs", to: recordListPath("program") },
      { id: "all-events", label: "Events", to: recordListPath("event") },
      { id: "all-sponsors", label: "Sponsors", to: recordListPath("sponsor") },
      { id: "all-newsletters", label: "Newsletters", to: recordListPath("newsletter") },
    ],
  },
  {
    id: "media",
    group: "Content",
    label: "Media library",
    icon: "media",
    to: mediaLibraryPath(),
    visible: canAccessMediaWorkspace,
    activeFor: (pathname) => {
      const path = stripTrailingSlash(pathname);
      return path === mediaLibraryPath() || path.startsWith(`${mediaLibraryPath()}/`) || path === voiceoversPath();
    },
  },
  {
    id: "editorial-queue",
    group: "Workflow",
    label: "Editorial queue",
    icon: "queue",
    to: publishQueuePath(),
    visible: canViewEditorialQueue,
  },
  {
    id: "cuez-storydesk", group: "Workflow", label: "StoryDesk",
    icon: "external-link", to: cuezPath(), visible: canUseCuez,
  },
  {
    id: "activity",
    group: "Workflow",
    label: "Activity",
    icon: "history",
    to: activityPath(),
    visible: canViewAudit,
  },
  {
    id: "schedule",
    group: "Workflow",
    label: "Broadcast schedule",
    icon: "calendar",
    to: schedulePath(),
    required: true,
    visible: () => true,
  },
  {
    id: "live-production", group: "Workflow", label: "Live production",
    icon: "media", to: liveProductionPath(), visible: canUseLiveProduction,
  },
  {
    id: "resources",
    group: "Team",
    label: "Resources",
    icon: "book",
    to: politicsResourcePath(),
    visible: canAccessAdmin,
  },
  {
    id: "staff-profiles",
    group: "Team",
    label: "Staff profiles",
    icon: "users",
    to: authorProfilesPath(),
    visible: canManageAuthorProfiles,
  },
  {
    id: "staff-access",
    group: "Team",
    label: "Staff access",
    icon: "users",
    to: staffAccessPath(),
    visible: canViewUsers,
  },
  {
    id: "analytics",
    group: "Administration",
    label: "Analytics",
    icon: "chart",
    to: analyticsPath(),
    visible: canViewAnalytics,
  },
  {
    id: "reports",
    group: "Administration",
    label: "Reports",
    icon: "flag",
    to: reportsPath(),
    visible: canViewReports,
  },
  {
    id: "admin-settings",
    group: "Administration",
    label: "Admin settings",
    icon: "settings",
    to: adminSettingsPath(),
    required: true,
    visible: canManageSettings,
    activeFor: (pathname) => {
      const path = stripTrailingSlash(pathname);
      return path === adminSettingsPath() || path.startsWith(`${adminSettingsPath()}/`);
    },
    subitems: [
      { id: "costs", label: "Costs", to: adminCostsPath() },
    ],
  },
  {
    id: "around-nj",
    label: "Around NJ",
    icon: "external-link",
    to: "https://centercoopmedia.github.io/around-nj/",
    external: true,
    visible: () => true,
  },
];

/**
 * The destinations this principal may see, in approved default order. This is the only place a
 * capability decides what the rail can contain; arrangement never widens it, and hiding a
 * destination never narrows what the account is authorized to open.
 */
export function eligibleNavDestinations(
  principal: Principal,
): NavDestinationDef[] {
  const dev = import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development";
  const devDestinations = new Set([
    "home", "pages", "posts", "library", "media", "editorial-queue",
    "activity", "admin-settings", "live-production",
  ]);
  return NAV_DESTINATIONS.filter((destination) =>
    destination.visible(principal) && (!dev || devDestinations.has(destination.id)),
  ).map((destination) => {
    if (!destination.subitems) return destination;

    const subitems = destination.subitems.filter(
      (subitem) => (!dev || subitem.id !== "costs") && (subitem.visible?.(principal) ?? true),
    );
    return subitems.length === destination.subitems.length
      ? destination
      : { ...destination, subitems };
  });
}
