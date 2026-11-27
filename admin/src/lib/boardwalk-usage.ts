import config from "../../../functions/lib/boardwalk-usage-config.json";
import { parseContentPath, routeCategoryForPath, ROUTE_PATHS } from "./routes";

export { config as boardwalkUsageConfig };
export type UsageScreen = keyof typeof config.screens;
export type UsageAction = keyof typeof config.actions;
type UsageObjectType = "record" | "page";
// offsetMs: how long before its batch was sent the event happened.
export type UsageEvent = { screen: UsageScreen; offsetMs?: number } & (
  | { name: "screen.view" }
  | { name: "screen.duration"; durationMs: number }
  | { name: UsageAction; objectType?: UsageObjectType; objectId?: string }
);
export interface UsageReport {
  days: number;
  analyticsEnabled: boolean;
  generatedAt: string;
  firstCollectedDate: string | null;
  easternFromDate: string | null;
  timezone: "America/New_York";
  daily: { date: string; timezone: "UTC" | "America/New_York"; activeUsers: number }[];
  weekly: { week: string; timezone: "UTC" | "America/New_York"; activeUsers: number }[];
  screens: { id: string; label: string; views: number; visibleMs: number }[];
  actions: { id: string; label: string; count: number }[];
  history: { status: "ready" | "unavailable"; start: string; end: string;
    actions: { id: string; label: string; count: number }[] };
}

const under = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

export function usageScreen(pathname: string): UsageScreen | null {
  const content = parseContentPath(pathname);
  if (content.kind === "page-list") return "pages-list";
  if (content.kind === "edit-page") return "pages-editor";
  if (content.kind === "record-list" && content.type === "post") return "posts-list";
  if ((content.kind === "edit-record" || content.kind === "create-record") && content.type === "post") return "posts-editor";
  if (under(pathname, ROUTE_PATHS.mediaFavorites)) return "media-favorites";
  if (under(pathname, ROUTE_PATHS.mediaCollections)) return "media-collections";
  if (under(pathname, ROUTE_PATHS.mediaSubmissions)) return "media-submissions";
  if (pathname === ROUTE_PATHS.mediaImages) return "images";
  if (pathname === ROUTE_PATHS.mediaVideos || pathname.startsWith(`${ROUTE_PATHS.mediaVideos}/`)) return "videos";
  if (pathname === ROUTE_PATHS.mediaVoiceovers) return "voiceovers";
  const category = routeCategoryForPath(pathname);
  const screen = ({ media: "media-landing", pages: "pages-list", posts: "posts-list" } as Record<string, string>)[category] ?? category;
  return Object.hasOwn(config.screens, screen) ? screen as UsageScreen : null;
}

type ActionSink = (name: UsageAction, objectType?: UsageObjectType, objectId?: string) => void;
let actionSink: ActionSink | null = null;

// Capture the current analytics scope; a late call cannot attach to a later sign-in.
export function usageActionCollector(): ActionSink {
  const sink = actionSink;
  return (name, objectType, objectId) => {
    try { sink?.(name, objectType, objectId); } catch { /* Best-effort measurement. */ }
  };
}

type OutcomeActions = { sent?: UsageAction; ok?: UsageAction; failed?: UsageAction };

// Uploads are measured where one person's upload succeeds or fails (after automatic retries).
// A video upload starts when its session starts; each transfer attempt then finishes or fails.
export const IMAGE_UPLOAD_ACTIONS: OutcomeActions = { sent: "media.upload.start", ok: "media.upload.finish", failed: "media.upload.failure" };
export const VIDEO_TRANSFER_ACTIONS: OutcomeActions = { ok: "media.upload.finish", failed: "media.upload.failure" };

// Actions measured at the shared Functions transport, so every caller of these endpoints is counted.
const ENDPOINT_ACTIONS: Partial<Record<string, OutcomeActions>> = {
  cmsStartSourceMediaUpload: { sent: "media.upload.start", failed: "media.upload.failure" },
  cmsSaveContent: { failed: "content.save.failure" },
  cmsRequestVideoTranscript: { sent: "media.transcript.request" },
  cmsRequestByokVideoTranscript: { sent: "media.transcript.request" },
  cmsRequestVideoClip: { sent: "media.clip.request" },
};

export function measureEndpointUsage<T>(endpoint: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return measureUsage(ENDPOINT_ACTIONS[endpoint], signal, run);
}

// signal must be the person's own cancel signal, so a cancellation is not counted as a failure.
export async function measureUsage<T>(actions: OutcomeActions | undefined, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!actions) return run();
  const record = usageActionCollector();
  if (actions.sent) record(actions.sent);
  try {
    const result = await run();
    if (actions.ok) record(actions.ok);
    return result;
  } catch (error) {
    // A cancelled request is the person's choice, not a failure.
    if (actions.failed && !signal?.aborted) record(actions.failed);
    throw error;
  }
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
  let queue: { event: UsageEvent; at: number }[] = [];
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
    pending = true;
    lastSentAt = now();
    const events = queue.map(({ event, at }) => ({ ...event, offsetMs: Math.min(600_000, Math.max(0, Math.round(lastSentAt - at))) }));
    queue = [];
    // Token acquisition, App Check and network errors all drop this batch.
    void Promise.resolve().then(() => send({ batchId: crypto.randomUUID(), events }, controller.signal))
      .catch(() => undefined).finally(() => { pending = false; });
  }
  function add(event: UsageEvent) {
    if (stopped || queue.length >= 20) return;
    queue.push({ event, at: now() });
    flushTimer ??= setTimeout(flush, 5_000);
  }
  function duration() {
    const current = now();
    const durationMs = Math.min(60_000, Math.max(0, Math.round(current - last)));
    if (screen && visible && durationMs > 0) add({ name: "screen.duration", screen, durationMs });
    last = current;
  }
  const sink: ActionSink = (name, objectType, objectId) => {
    if (!screen) return;
    if (objectType === undefined && objectId === undefined) add({ name, screen });
    else if (objectType && objectId && /^[a-zA-Z0-9_-]{1,128}$/.test(objectId)) add({ name, screen, objectType, objectId });
  };
  actionSink = sink;
  // Count a search, never its text, once typing in any search box pauses for a second with text in it.
  const searchTimers = new Map<HTMLInputElement, ReturnType<typeof setTimeout>>();
  function searched(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "search") return;
    clearTimeout(searchTimers.get(target));
    searchTimers.set(target, setTimeout(() => {
      searchTimers.delete(target);
      if (target.value.trim()) sink("search");
    }, 1_000));
  }
  page.addEventListener("input", searched, true);
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
      page.removeEventListener("input", searched, true);
      for (const searchTimer of searchTimers.values()) clearTimeout(searchTimer);
      if (actionSink === sink) actionSink = null;
    },
  };
}
