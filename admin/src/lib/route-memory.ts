// The Admin destination memory: what makes a refresh land back on the route the person was
// already using (#1031).
//
// The router already honors window.location, so a deep link and a reload that keeps its address
// both resolve correctly with nothing here involved. If a refresh lands at the bare origin,
// there is no destination left in the URL to honor.
// This module remembers the tab's current destination and, when a load lands on the default
// route with a different destination remembered, restores it.
//
// Two rules keep that from becoming a second, competing source of truth for where the user is:
//
//  1. A surviving address always wins. The restore only fires when the load landed on the bare
//     default route, so a real deep link, a bookmark, or a reload whose address survived is
//     never overridden.
//  2. Authorization is re-derived every load. The stored value is an address, never a grant:
//     canOpenAdminPath answers from the principal this load resolved, and the routes themselves
//     still run their own capability gates. A remembered route the current account cannot open
//     falls back to the default destination, so nothing here can widen access.
//
// Storage is per tab (sessionStorage), which is the same scope as the question being answered:
// "where was THIS tab before it reloaded". A new tab starts with no memory and boots wherever
// its address points.
import {
  canAccessAdmin,
  canBrowseContentPages,
  canManageAuthorProfiles,
  canManageSettings,
  canUseContentStudio,
  canAccessMediaWorkspace,
  canViewAudit,
  canViewAnalytics,
  canViewReports,
  canViewQueue,
  canViewUsers,
} from "./access";
import {
  dashboardPath,
  parseContentPath,
  parseMediaWorkspacePath,
  ROUTE_PATHS,
} from "./routes";
import type { Principal } from "../../../packages/content-core/src/rbac";

export const ADMIN_DESTINATION_KEY = "njpbs.admin.destination";

// A stored address is bounded: a remembered destination is a path this app built, and an
// oversized value is either corruption or someone else's write.
const MAX_DESTINATION_LENGTH = 2048;

// The path half of a destination, without the query or fragment.
function pathnameOf(destination: string): string {
  return destination.split(/[?#]/, 1)[0] ?? "";
}

function stripTrailingSlash(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Whether a value is an address inside this app. It must be root-relative and single-slashed:
 * `//host` and `/\host` are both browser-honored ways to leave the origin, and a scheme is not
 * an in-app path at all. A restore navigates to whatever this admits, so it is the boundary that
 * keeps a tampered storage value from becoming an open redirect.
 */
export function isInAppDestination(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_DESTINATION_LENGTH) return false;
  if (!value.startsWith("/")) return false;
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  // Whitespace and control characters never appear in a path this app builds, and a browser
  // strips some of them before resolving, so "/\n/host" could still leave the origin.
  return !/[\s\u0000-\u001f]/.test(value);
}

/**
 * Whether this principal may open an Admin path. It mirrors, one destination at a time, the
 * capability gate each route runs for itself, so a remembered or linked address is judged by the
 * same rule that decides what the route renders. An unknown or malformed path is refused rather
 * than guessed at.
 */
export function canOpenAdminPath(principal: Principal, pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  const path = stripTrailingSlash(pathname);

  // Every admitted account has a home and its own account pages.
  if (path === ROUTE_PATHS.root) return true;
  if (path === ROUTE_PATHS.legacyDashboard) return true;
  if (path === ROUTE_PATHS.accountSettings) return true;
  if (path === ROUTE_PATHS.accountProfile) return true;
  if (path === ROUTE_PATHS.schedule) return true;
  if (path === ROUTE_PATHS.open) return canAccessAdmin(principal);
  if (path === ROUTE_PATHS.politicsResource) return canAccessAdmin(principal);
  if (path === ROUTE_PATHS.guide || /^\/guide\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path)) return true;

  if (path === ROUTE_PATHS.adminSettings) return canManageSettings(principal);
  if (path === ROUTE_PATHS.adminCosts) return canManageSettings(principal);
  if (path === ROUTE_PATHS.reports || path.startsWith(`${ROUTE_PATHS.reports}/`)) return canViewReports(principal);
  if (path === ROUTE_PATHS.analytics) return canViewAnalytics(principal);
  if (path === ROUTE_PATHS.activity) return canViewAudit(principal);
  if (parseMediaWorkspacePath(path).kind !== "not-found") return canAccessMediaWorkspace(principal);
  if (path === ROUTE_PATHS.publishQueue) return canViewQueue(principal);
  if (path === ROUTE_PATHS.staffAccess) return canViewUsers(principal);
  if (path === ROUTE_PATHS.authorProfiles) return canManageAuthorProfiles(principal);

  if (path === ROUTE_PATHS.postTemplates || /^\/post-templates\/[^/]+$/.test(path)) return canUseContentStudio(principal);

  if (path === ROUTE_PATHS.content || path.startsWith(`${ROUTE_PATHS.content}/`)) {
    const route = parseContentPath(path);
    if (route.kind === "not-found") return false;
    if (!canUseContentStudio(principal)) return false;
    if (route.kind === "page-list" && !canBrowseContentPages(principal)) return false;
    return true;
  }

  return false;
}

/**
 * The destination a load should restore, or null to leave the address alone.
 *
 * `current` is the address this load actually arrived at, as a root-relative string; `remembered`
 * is what this tab last recorded. A restore happens only when the current address is the bare
 * default route and the memory names something else, which is exactly the shape of a destination
 * that was lost on the way back.
 */
export function destinationToRestore(
  current: string,
  remembered: string | null,
): string | null {
  if (!remembered || !isInAppDestination(remembered)) return null;
  if (current !== dashboardPath()) return null;
  if (remembered === dashboardPath()) return null;
  return remembered;
}

/**
 * The remembered destination for this account, or null.
 *
 * The record carries the uid it was written for, and a read for any other account answers null
 * and drops the entry. A tab is shared hardware: someone signs out and a colleague signs in on
 * the same one, and the previous session's address must not travel to them. Clearing the memory
 * when a session ends is the first line of that (see the auth provider); this is the check that
 * holds even if a session ended in a way that never ran the clear.
 *
 * Every read is defensive: a private window, a browser configured to block site data, a value
 * left by an older build, and a hand-edited one all have to boot the app rather than break it.
 */
export function readRememberedDestination(
  storage: Storage | null,
  uid: string,
): string | null {
  if (!storage || !uid) return null;
  try {
    const raw = storage.getItem(ADMIN_DESTINATION_KEY);
    if (raw === null) return null;

    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      // An older build stored a bare path with no account on it. It cannot be attributed, so it
      // is discarded rather than handed to whoever is signed in now.
      forgetDestination(storage);
      return null;
    }

    const stored =
      typeof record === "object" && record !== null
        ? (record as { uid?: unknown; path?: unknown })
        : null;
    if (!stored || typeof stored.uid !== "string" || typeof stored.path !== "string") {
      forgetDestination(storage);
      return null;
    }
    if (stored.uid !== uid) {
      forgetDestination(storage);
      return null;
    }
    return isInAppDestination(stored.path) ? stored.path : null;
  } catch {
    return null;
  }
}

export function rememberDestination(
  storage: Storage | null,
  uid: string,
  destination: string,
): void {
  if (!storage || !uid || !isInAppDestination(destination)) return;
  try {
    storage.setItem(
      ADMIN_DESTINATION_KEY,
      JSON.stringify({ uid, path: destination }),
    );
  } catch {
    // A tab that cannot store its destination simply keeps the old behavior.
  }
}

export function forgetDestination(storage: Storage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(ADMIN_DESTINATION_KEY);
  } catch {
    // Nothing to do: the memory is an optimization, never a correctness requirement.
  }
}

/**
 * The session storage this app records into, or null where it cannot be reached. Accessing the
 * accessor itself throws in some privacy modes, so even the lookup is guarded.
 */
export function adminDestinationStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export { pathnameOf as destinationPathname };
