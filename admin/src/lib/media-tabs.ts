import {
  mediaCollectionsPath,
  mediaFavoritesPath,
  mediaImagesPath,
  mediaVideosPath,
  mediaVoiceoversPath,
  mediaSubmissionsPath,
  type MediaWorkspaceRoute,
} from "./routes";

// The media tab strip's model: order, current tab,
// click suppression, accessible names and scroll hints. Each tab is its own page; the strip
// only links them.

export type MediaTabIcon = "image" | "video" | "microphone" | "heart" | "folder";

export interface MediaTab {
  id: string;
  label: string;
  path: string;
  icon: MediaTabIcon;
  count?: number;
}

export interface MediaTabSource {
  id: string;
  label: string;
}

const PRIMARY_SOURCE: MediaTabSource = { id: "video-library", label: "Videos" };
const REVEAL_MARGIN = 16;

export function mediaTabs({
  canUseImages,
  canReviewSubmissions = false,
  sources,
  counts = {},
}: {
  canUseImages: boolean;
  canReviewSubmissions?: boolean;
  sources: readonly MediaTabSource[];
  counts?: Readonly<Record<string, number | undefined>>;
}): MediaTab[] {
  const [primary = PRIMARY_SOURCE, ...rest] = sources;
  // Station media leads with Images, Videos, Public submissions, and Audio. The route ids and
  // paths keep their earlier names so saved links and counts keep working.
  const tabs: MediaTab[] = [
    ...(canUseImages ? [{ id: "images", label: "Images", path: mediaImagesPath(), icon: "image" as const }] : []),
    { id: primary.id, label: primary.id === PRIMARY_SOURCE.id ? "Videos" : primary.label, path: mediaVideosPath(), icon: "video" },
    ...rest.map((source) => ({ id: source.id, label: source.label, path: mediaVideosPath(source.id), icon: "video" as const })),
    ...(canReviewSubmissions ? [{ id: "submissions", label: "Public submissions", path: mediaSubmissionsPath(), icon: "folder" as const }] : []),
    { id: "voiceovers", label: "Audio", path: mediaVoiceoversPath(), icon: "microphone" },
    { id: "favorites", label: "Favorites", path: mediaFavoritesPath(), icon: "heart" },
    { id: "collections", label: "Collections", path: mediaCollectionsPath(), icon: "folder" },
  ];
  return tabs.map((tab) => (typeof counts[tab.id] === "number" ? { ...tab, count: counts[tab.id] } : tab));
}

/** The current tab id, from the route kind and source id rather than a path prefix. */
export function currentMediaTabId(route: MediaWorkspaceRoute, sources: readonly MediaTabSource[]): string {
  return route.kind === "videos"
    ? route.sourceId ?? sources[0]?.id ?? PRIMARY_SOURCE.id
    : route.kind;
}

/** Only an unmodified primary click on the page already shown does nothing. */
export function shouldSuppressTabClick(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  tabPath: string,
  pathname: string,
): boolean {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  return tabPath === pathname;
}

export function mediaTabName(label: string, count?: number): string {
  if (typeof count !== "number") return label;
  return `${label} ${count.toLocaleString("en-US")} ${count === 1 ? "item" : "items"}`;
}

export function tabEdgeFade({ scrollLeft, scrollWidth, clientWidth }: { scrollLeft: number; scrollWidth: number; clientWidth: number }): "none" | "start" | "mid" | "end" {
  if (scrollWidth - clientWidth <= 1) return "none";
  const atStart = scrollLeft <= 1;
  const atEnd = scrollLeft + clientWidth >= scrollWidth - 1;
  if (atStart) return "end";
  if (atEnd) return "start";
  return "mid";
}

/** The scroll offset that brings the current tab into view with a margin, or null when it is visible. */
export function tabRevealOffset(
  strip: { scrollLeft: number; clientWidth: number },
  tab: { offsetLeft: number; offsetWidth: number } | null,
): number | null {
  if (!tab) return null;
  const left = tab.offsetLeft - REVEAL_MARGIN;
  const right = tab.offsetLeft + tab.offsetWidth + REVEAL_MARGIN;
  if (left < strip.scrollLeft) return Math.max(0, left);
  if (right > strip.scrollLeft + strip.clientWidth) return right - strip.clientWidth;
  return null;
}
