import { parseMediaWorkspacePath, type MediaWorkspaceRoute } from "./routes";

// The media tab each account last opened in this browser, so /media reopens it.
// Blocked or cleared storage reads as no tab, and nothing here is sent anywhere.

const LAST_TAB_PREFIX = "njpbs-admin:media-last-tab:";
const TAB_KINDS = new Set<MediaWorkspaceRoute["kind"]>(["images", "videos", "voiceovers", "submissions"]);

export function lastMediaTabKey(userId: string): string {
  return `${LAST_TAB_PREFIX}${userId}`;
}

function browserStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored tab path when it is still a tab route the account may open; otherwise null. */
export function readLastMediaTab(
  userId: string,
  canOpen: (route: MediaWorkspaceRoute) => boolean,
  store: Storage | null = browserStore(),
): string | null {
  if (!store || !userId) return null;
  try {
    const path = store.getItem(lastMediaTabKey(userId));
    if (!path) return null;
    const route = parseMediaWorkspacePath(path);
    return TAB_KINDS.has(route.kind) && canOpen(route) ? path : null;
  } catch {
    return null;
  }
}

export function writeLastMediaTab(userId: string, pathname: string, store: Storage | null = browserStore()): void {
  if (!store || !userId || !TAB_KINDS.has(parseMediaWorkspacePath(pathname).kind)) return;
  try {
    store.setItem(lastMediaTabKey(userId), pathname);
  } catch {
    // Storage is full or blocked; /media then opens the default tab.
  }
}
