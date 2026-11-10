import config from "../../../functions/lib/boardwalk-usage-config.json";
import { parseContentPath, routeCategoryForPath, ROUTE_PATHS } from "./routes";

export { config as boardwalkUsageConfig };
export type UsageScreen = keyof typeof config.screens;
export type UsageAction = keyof typeof config.actions;
export type UsageEvent = { screen: UsageScreen } & (
  | { name: "screen.view" }
  | { name: "screen.duration"; durationMs: number }
  | { name: UsageAction; objectType: "record" | "page"; objectId: string }
);
export interface UsageReport {
  days: number;
  analyticsEnabled: boolean;
  generatedAt: string;
  firstCollectedDate: string | null;
  timezone: "UTC";
  daily: { date: string; activeUsers: number }[];
  weekly: { week: string; activeUsers: number }[];
  screens: { id: string; label: string; views: number; visibleMs: number }[];
  actions: { id: string; label: string; count: number }[];
  history: { status: "ready" | "unavailable"; start: string; end: string;
    actions: { id: string; label: string; count: number }[] };
}

export function usageScreen(pathname: string): UsageScreen | null {
  const content = parseContentPath(pathname);
  if (content.kind === "page-list" || content.kind === "edit-page") return "pages";
  if ((content.kind === "record-list" || content.kind === "edit-record" || content.kind === "create-record") && content.type === "post") return "posts";
  if (pathname === ROUTE_PATHS.mediaImages) return "images";
  if (pathname === ROUTE_PATHS.mediaVideos || pathname.startsWith(`${ROUTE_PATHS.mediaVideos}/`)) return "videos";
  if (pathname === ROUTE_PATHS.mediaVoiceovers) return "voiceovers";
  const category = routeCategoryForPath(pathname);
  return Object.hasOwn(config.screens, category) ? category as UsageScreen : null;
}

let actionSink: ((name: UsageAction, objectType: "record" | "page", objectId: string) => void) | null = null;

// Capture the current analytics scope; a late call cannot attach to a later sign-in.
export function usageActionCollector() {
  const sink = actionSink;
  return (name: UsageAction, objectType: "record" | "page", objectId: string) => {
    try { sink?.(name, objectType, objectId); } catch { /* Best-effort measurement. */ }
  };
}

export function startUsageAnalytics({ enabled, send, pathname, page = document, now = () => performance.now() }: {
  enabled: boolean;
  send: (batch: { batchId: string; events: UsageEvent[] }, signal: AbortSignal) => Promise<unknown>;
  pathname: string;
  page?: Document;
  now?: () => number;
}) {
  if (!enabled) return { navigate: (_path: string) => {}, stop: () => {} };
  let screen = usageScreen(pathname);
  let last = now();
  let visible = page.visibilityState === "visible";
  let viewed = visible;
  let queue: UsageEvent[] = [];
  let pending = false;
  let stopped = false;
  let lastSentAt = -Infinity;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  function flush() {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!queue.length || stopped) return;
    if (pending) { queue = []; return; }
    const remaining = 5_000 - (now() - lastSentAt);
    if (remaining > 0) { flushTimer = setTimeout(flush, remaining); return; }
    const events = queue;
    queue = [];
    pending = true;
    lastSentAt = now();
    // Token acquisition, App Check and network errors all drop this batch.
    void Promise.resolve().then(() => send({ batchId: crypto.randomUUID(), events }, controller.signal))
      .catch(() => undefined).finally(() => { pending = false; });
  }
  function add(event: UsageEvent) {
    if (stopped || queue.length >= 20) return;
    queue.push(event);
    flushTimer ??= setTimeout(flush, 5_000);
  }
  function duration() {
    const current = now();
    const durationMs = Math.min(60_000, Math.max(0, Math.round(current - last)));
    if (screen && visible && durationMs > 0) add({ name: "screen.duration", screen, durationMs });
    last = current;
  }
  const sink: NonNullable<typeof actionSink> = (name, objectType, objectId) => {
    if (screen && /^[a-zA-Z0-9_-]{1,128}$/.test(objectId)) add({ name, screen, objectType, objectId });
  };
  actionSink = sink;
  function visibilityChanged() {
    duration();
    visible = page.visibilityState === "visible";
    if (screen && visible && !viewed) { add({ name: "screen.view", screen }); viewed = true; }
    flush();
  }
  page.addEventListener("visibilitychange", visibilityChanged);
  const timer = setInterval(() => { duration(); flush(); }, 60_000);
  if (screen && visible) add({ name: "screen.view", screen });
  return {
    navigate(path: string) {
      duration();
      screen = usageScreen(path);
      viewed = visible;
      if (screen && visible) add({ name: "screen.view", screen });
    },
    stop() {
      stopped = true;
      queue = [];
      controller.abort();
      clearTimeout(flushTimer);
      clearInterval(timer);
      page.removeEventListener("visibilitychange", visibilityChanged);
      if (actionSink === sink) actionSink = null;
    },
  };
}
