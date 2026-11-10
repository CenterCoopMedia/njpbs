// The project-owned path builder and content-path parser. Every navigation in the admin goes
// through a function here rather than a hand-written string, so the URL contract lives in one
// module and a later router swap does not hunt for scattered paths. Routes address records by
// their immutable id, never a slug (#541 slug behavior stays out of route identity), so a
// rename never changes where a record lives.
//
// Pure: no React and no router import, so the same functions build links, parse a location in
// the content layout, and back the tests. The route-tree wiring that consumes these lives in
// src/routes/.
import { isRecordKind } from "./content-vocab";
import type { RouteCategory } from "./perf-receipts";
import { encodeContentQuery, type ContentQuery } from "./content-query";
import type { RecordKind, SectionId } from "../../../packages/content-core/src/editor-admin";
import {
  isPublicPageId,
  publicPage,
  type PublicPageId,
} from "../../../packages/content-core/src/public-pages";

// The top-level route paths, the fixed vocabulary the shell nav and the Cloudflare _redirects
// file both depend on. Kept as one object so a path is named once.
export const ROUTE_PATHS = {
  root: "/",
  adminSettings: "/admin/settings",
  adminCosts: "/admin/settings/costs",
  accountSettings: "/account/settings",
  premiereConnect: "/premiere/connect",
  accountProfile: "/account/profile",
  dashboard: "/",
  legacyDashboard: "/dashboard",
  content: "/content",
  open: "/open",
  postTemplates: "/post-templates",
  cuez: "/cuez-storydesk",
  activity: "/activity",
  analytics: "/analytics",
  mediaLibrary: "/media",
  mediaImages: "/media/images",
  mediaVideos: "/media/videos",
  mediaFavorites: "/media/favorites",
  mediaCollections: "/media/collections",
  mediaVoiceovers: "/media/voiceovers",
  mediaSubmissions: "/media/submissions",
  voiceovers: "/voiceovers",
  publishQueue: "/publish-queue",
  reports: "/reports",
  guide: "/guide",
  politicsResource: "/resources/nj-politics",
  schedule: "/schedule",
  liveProduction: "/live-production",
  liveProductionStudio: "/live-production/studio",
  staffAccess: "/staff-access",
  authorProfiles: "/staff-profiles",
} as const;

// A route's category for the performance receipt (#1064): the kind of surface, never its
// address. It lives here because it reads the same path vocabulary every builder below does,
// and it mirrors the addressed-route preload split, so a receipt says "content" for every
// editor surface without recording which page or record was open.
export function routeCategoryForPath(pathname: string): RouteCategory {
  const path = pathname.replace(/\/+$/, "") || ROUTE_PATHS.root;
  if (path === ROUTE_PATHS.root || path === ROUTE_PATHS.legacyDashboard)
    return "dashboard";
  if (path === ROUTE_PATHS.open) return "open";
  if (path === ROUTE_PATHS.content || path.startsWith(`${ROUTE_PATHS.content}/`))
    return "content";
  if (path === ROUTE_PATHS.postTemplates || path.startsWith(`${ROUTE_PATHS.postTemplates}/`)) return "post-templates";
  if (path === ROUTE_PATHS.cuez) return "cuez";
  if (path === ROUTE_PATHS.analytics) return "analytics";
  if (path === ROUTE_PATHS.activity) return "activity";
  if (path === ROUTE_PATHS.mediaLibrary || path.startsWith(`${ROUTE_PATHS.mediaLibrary}/`)) return "media";
  if (path === ROUTE_PATHS.voiceovers) return "voiceovers";
  if (path === ROUTE_PATHS.publishQueue) return "queue";
  if (path === ROUTE_PATHS.reports || path.startsWith(`${ROUTE_PATHS.reports}/`))
    return "reports";
  if (path === ROUTE_PATHS.guide || path.startsWith(`${ROUTE_PATHS.guide}/`))
    return "guide";
  if (path === ROUTE_PATHS.politicsResource) return "resources";
  if (path === ROUTE_PATHS.schedule) return "schedule";
  if (path === ROUTE_PATHS.liveProduction || path === ROUTE_PATHS.liveProductionStudio) return "live-production";
  if (path === ROUTE_PATHS.accountSettings) return "account-settings";
  if (path === ROUTE_PATHS.premiereConnect) return "premiere-connect";
  if (path === ROUTE_PATHS.accountProfile) return "account-profile";
  if (path === ROUTE_PATHS.authorProfiles) return "author-profiles";
  if (path === ROUTE_PATHS.adminCosts) return "costs";
  if (path === ROUTE_PATHS.adminSettings) return "admin-settings";
  if (path === ROUTE_PATHS.staffAccess) return "staff-access";
  return "not-found";
}

export function adminSettingsPath(): string {
  return ROUTE_PATHS.adminSettings;
}

export function adminCostsPath(): string {
  return ROUTE_PATHS.adminCosts;
}

export function accountSettingsPath(): string {
  return ROUTE_PATHS.accountSettings;
}

// The signed-in person's own author profile: the byline readers see. Kept separate from
// account settings, which holds CMS display preferences and nothing public.
export function accountProfilePath(): string {
  return ROUTE_PATHS.accountProfile;
}

// The admin roster of author profiles, gated by the staff-account capability.
export function authorProfilesPath(): string {
  return ROUTE_PATHS.authorProfiles;
}

export function dashboardPath(): string {
  return ROUTE_PATHS.root;
}

export function activityPath(): string {
  return ROUTE_PATHS.activity;
}

export function mediaLibraryPath(): string {
  return ROUTE_PATHS.mediaLibrary;
}

export function mediaImagesPath(): string {
  return ROUTE_PATHS.mediaImages;
}

export function mediaVideosPath(sourceId?: string): string {
  return sourceId === undefined
    ? ROUTE_PATHS.mediaVideos
    : `${ROUTE_PATHS.mediaVideos}/${encodeURIComponent(sourceId)}`;
}

export function mediaFavoritesPath(): string {
  return ROUTE_PATHS.mediaFavorites;
}

export function mediaCollectionsPath(collectionId?: string): string {
  return collectionId === undefined
    ? ROUTE_PATHS.mediaCollections
    : `${ROUTE_PATHS.mediaCollections}/${encodeURIComponent(collectionId)}`;
}

export function mediaVoiceoversPath(): string {
  return ROUTE_PATHS.mediaVoiceovers;
}

export function mediaSubmissionsPath(): string {
  return ROUTE_PATHS.mediaSubmissions;
}

export function voiceoversPath(): string {
  return ROUTE_PATHS.voiceovers;
}

export type MediaWorkspaceRoute =
  | { kind: "entry" }
  | { kind: "images" }
  | { kind: "videos"; sourceId: string | null }
  | { kind: "favorites" }
  | { kind: "collections"; collectionId: string | null }
  | { kind: "voiceovers" }
  | { kind: "submissions" }
  | { kind: "not-found" };

export function parseMediaWorkspacePath(pathname: string): MediaWorkspaceRoute {
  const path = stripTrailingSlash(pathname);
  if (path === ROUTE_PATHS.mediaLibrary) return { kind: "entry" };
  if (path === ROUTE_PATHS.mediaImages) return { kind: "images" };
  if (path === ROUTE_PATHS.mediaVideos) return { kind: "videos", sourceId: null };
  if (path === ROUTE_PATHS.mediaFavorites) return { kind: "favorites" };
  if (path === ROUTE_PATHS.mediaCollections) return { kind: "collections", collectionId: null };
  if (path === ROUTE_PATHS.mediaVoiceovers) return { kind: "voiceovers" };
  if (path === ROUTE_PATHS.mediaSubmissions) return { kind: "submissions" };

  const prefixes = [
    [ROUTE_PATHS.mediaVideos, "videos"],
    [ROUTE_PATHS.mediaCollections, "collections"],
  ] as const;
  const match = prefixes.find(([base]) => path.startsWith(`${base}/`));
  if (!match) return { kind: "not-found" };
  const encodedId = path.slice(match[0].length + 1);
  if (!encodedId || encodedId.includes("/")) return { kind: "not-found" };
  try {
    const id = decodeURIComponent(encodedId);
    if (!id || id.includes("/")) return { kind: "not-found" };
    if (match[1] === "collections" && !/^[a-f0-9]{64}$/.test(id)) {
      return { kind: "not-found" };
    }
    return match[1] === "videos"
      ? { kind: "videos", sourceId: id }
      : { kind: "collections", collectionId: id };
  } catch {
    return { kind: "not-found" };
  }
}

// The page directory is the CMS front door: editors start with the public page they intend to
// change, while reusable structured records live in the secondary library route below.
export function contentPagesPath(): string {
  return ROUTE_PATHS.content;
}

export function postTemplatesPath(id?: string): string {
  return id === undefined ? ROUTE_PATHS.postTemplates : `${ROUTE_PATHS.postTemplates}/${encodeURIComponent(id)}`;
}

// The combined reusable-content library. Filter, sort, and paging state ride in the query string
// through the domain codec, so a link to a filtered library is reproducible.
export function contentLibraryPath(query?: ContentQuery): string {
  const path = `${ROUTE_PATHS.content}/library`;
  if (!query) return path;
  const encoded = encodeContentQuery(query);
  return encoded ? `${path}?${encoded}` : path;
}

// Browse one structured record collection. This is the intentionally small list surface that
// makes saved records reopenable (#540/#566); the combined library's search, saved views, status
// counts, and paging remain at /content/library (#593).
export function recordListPath(type: RecordKind): string {
  return `${ROUTE_PATHS.content}/${type}`;
}

// Create a record of a known type. The trailing "+" segment is the create marker; after the
// server mints an id the caller replaces this URL with editRecordPath so the id, not "+",
// becomes the address.
export function createRecordPath(type: RecordKind): string {
  return `${ROUTE_PATHS.content}/${type}/+`;
}

// Edit a record by its immutable id. The id is encoded so an identifier format that later
// includes reserved characters cannot break the path.
export function editRecordPath(type: RecordKind, id: string): string {
  return `${ROUTE_PATHS.content}/${type}/${encodeURIComponent(id)}/edit`;
}

// Edit one canonical public page by its real page id. The page registry separately maps that id
// to a block-editor template, so pages that share a template never share an address or document.
export function editPagePath(pageId: PublicPageId): string {
  return `${ROUTE_PATHS.content}/pages/${pageId}/edit`;
}

export function publishQueuePath(): string {
  return ROUTE_PATHS.publishQueue;
}

export function reportsPath(reportId?: string): string {
  return reportId
    ? `${ROUTE_PATHS.reports}/${encodeURIComponent(reportId)}`
    : ROUTE_PATHS.reports;
}

export function guidePath(slug?: string): string {
  return slug === undefined
    ? ROUTE_PATHS.guide
    : `${ROUTE_PATHS.guide}/${encodeURIComponent(slug)}`;
}

export function politicsResourcePath(): string {
  return ROUTE_PATHS.politicsResource;
}

export function schedulePath(): string {
  return ROUTE_PATHS.schedule;
}

export function staffAccessPath(): string {
  return ROUTE_PATHS.staffAccess;
}

// The result of parsing a `/content/**` location into what the content layout should show.
// Every shape the layout can render, plus an explicit not-found for a malformed sub-path so
// the layout routes to the in-app not-found rather than guessing.
export type ContentRoute =
  | { kind: "page-list" }
  | { kind: "library" }
  | { kind: "record-list"; type: RecordKind }
  | { kind: "create-record"; type: RecordKind }
  | { kind: "edit-record"; type: RecordKind; id: string }
  | { kind: "edit-page"; pageId: PublicPageId }
  | { kind: "not-found" };

// The editor surface a content route resolves to, structurally identical to EditorWorkspace's
// own Surface so the layout can hand it straight to the editor. Every valid route, including the
// library, resolves to a surface; only not-found resolves to none.
//
// A record surface carries the addressed id: `null` is the create route (/content/:type/+), a
// string is an edit-by-id route (/content/:type/:id/edit). The id travels with the surface so a
// deep link to an existing record is not collapsed into a blank create form (dropping it would
// seed the create form and let a save mint a duplicate instead of editing the addressed record).
export type EditorSurface =
  | { kind: "page-list" }
  | { kind: "library" }
  | { kind: "record-list"; record: RecordKind }
  | { kind: "record"; record: RecordKind; id: string | null }
  | { kind: "page"; pageId: PublicPageId; section: SectionId };

// One rule for the trailing slash a hand-typed, copied or redirected address can carry. The route
// is the same either way, so every comparison against a known path normalizes through here rather
// than each caller inventing its own spelling. Exported because the Back decision compares work
// lists outside `/content/**`, which parseContentPath never sees.
export function stripTrailingSlash(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

// Parse a location's pathname into a ContentRoute. Validates every dynamic segment against the
// closed vocabularies, so an unknown record type, public page id, or malformed shape
// yields not-found rather than a route the editor cannot honor. The "pages" segment is
// reserved for the page route and never collides with a record type, since no RecordKind is
// "pages".
export function parseContentPath(pathname: string): ContentRoute {
  const path = stripTrailingSlash(pathname);
  if (path === ROUTE_PATHS.content) return { kind: "page-list" };
  if (path === `${ROUTE_PATHS.content}/library`) return { kind: "library" };
  const prefix = `${ROUTE_PATHS.content}/`;
  if (!path.startsWith(prefix)) return { kind: "not-found" };

  const segments = path
    .slice(prefix.length)
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A malformed escape sequence is treated as a non-matching segment rather than
        // throwing, so a hostile URL degrades to not-found.
        return segment;
      }
    });

  // /content/:type
  if (segments.length === 1) {
    const type = segments[0];
    return isRecordKind(type) ? { kind: "record-list", type } : { kind: "not-found" };
  }

  // /content/pages/:pageId/edit
  if (segments.length === 3 && segments[0] === "pages" && segments[2] === "edit") {
    const pageId = segments[1];
    return isPublicPageId(pageId) ? { kind: "edit-page", pageId } : { kind: "not-found" };
  }

  // /content/:type/+
  if (segments.length === 2 && segments[1] === "+") {
    const type = segments[0];
    return isRecordKind(type) ? { kind: "create-record", type } : { kind: "not-found" };
  }

  // /content/:type/:id/edit
  if (segments.length === 3 && segments[2] === "edit") {
    const type = segments[0];
    const id = segments[1];
    if (isRecordKind(type) && id !== "" && id !== "+") {
      return { kind: "edit-record", type, id };
    }
    return { kind: "not-found" };
  }

  return { kind: "not-found" };
}

// Map a parsed content route to the workspace surface it should mount, or null for a not-found
// sub-path.
export function surfaceForContentRoute(route: ContentRoute): EditorSurface | null {
  switch (route.kind) {
    case "page-list":
      return { kind: "page-list" };
    case "library":
      return { kind: "library" };
    case "record-list":
      return { kind: "record-list", record: route.type };
    case "create-record":
      return { kind: "record", record: route.type, id: null };
    case "edit-record":
      return { kind: "record", record: route.type, id: route.id };
    case "edit-page": {
      const page = publicPage(route.pageId);
      return page
        ? { kind: "page", pageId: route.pageId, section: page.editorTemplate }
        : null;
    }
    case "not-found":
      return null;
  }
}

// Resolve a parsed content route to the surface the persistent content workspace mounts, or null
// for a malformed path. The combined library is a real workspace surface now, so moving between
// it and an editor keeps the same EditorWorkspace instance and its in-memory draft map (#593).
export function mountedSurfaceForRoute(route: ContentRoute): EditorSurface | null {
  return surfaceForContentRoute(route);
}

// Whether a pathname resolves to a state that keeps the content editor mounted: a valid page,
// record, page-directory, or library surface. A malformed `/content/**` sub-path parses to
// not-found, and any path outside the content subtree parses to not-found too, so both return
// false. The dirty-leave guard reads this to tell staying in the mounted editor (free while dirty)
// from leaving it (confirmed while dirty): a destination that would render the not-found branch,
// even one still under `/content/`, counts as leaving and must be confirmed before its draft is
// dropped. Built from parseContentPath and mountedSurfaceForRoute so it can never diverge from the
// layout's own render decision.
export function keepsEditorMounted(pathname: string): boolean {
  return mountedSurfaceForRoute(parseContentPath(pathname)) !== null;
}

export function analyticsPath(): string { return ROUTE_PATHS.analytics; }


export function liveProductionPath(): string { return ROUTE_PATHS.liveProduction; }
export function cuezPath(): string { return ROUTE_PATHS.cuez; }
// The full-screen iPad show screen; same module, sign-in and capability as the Boardwalk page.
export function liveProductionStudioPath(): string { return ROUTE_PATHS.liveProductionStudio; }
