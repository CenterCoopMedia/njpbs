// Pure availability-window and HLS-selection policy for Media Manager playback.
// Given an already-fetched asset, a resolved viewer and an explicit time, return
// a playable rendition, a membership denial or an unavailable result. The caller
// owns credentialed fetches, identity resolution and rendering. assetToGateInput
// maps the API shape into this policy without network, DOM or clock access.

import type {
  AssetAttributes,
  AssetAvailabilityWindow,
} from "./media-manager-catalog";
import type { Entitlement } from "./mvault-entitlement";

/** What the player should do with an asset for a given viewer. */
export type GateVerdict = "render" | "deny" | "unavailable";

/** Audience tiers, least to most privileged. */
export type ViewerTier = "public" | "all_members" | "station_members";
export type ResolvedWindow = ViewerTier | "unavailable";

/** Machine reason tags keep missing, upcoming and expired windows distinct. */
export const GATE_REASON = {
  playable: "playable",
  notEntitled: "not-entitled",
  noWindow: "no-availability-window",
  beforeWindow: "before-window",
  afterWindow: "after-window",
  noHls: "no-hls-rendition",
  nonUrsHls: "non-urs-rendition",
  unreadableWindow: "unreadable-window",
  unreadableClock: "unreadable-clock",
  unreadableEntitlement: "unreadable-entitlement",
  unreadableTier: "unreadable-tier",
  unreadableAvailabilityWindow: "unreadable-availability-window",
  unreadablePlayableWindow: "unreadable-playable-window",
} as const;

export type GateReason = (typeof GATE_REASON)[keyof typeof GATE_REASON];

/** A playback rendition mapped from Media Manager at the credentialed boundary.
 * Only fields used by this policy are modeled. */
export interface AssetVideoRendition {
  /** Rendition profile, e.g. "hls-16x9-1080p", "hls-4x3-720p", or a source mp4. */
  profile?: string | null;
  url?: string | null;
}

/** Playback renditions keyed by the availability window that protects them. */
export type WindowedRenditions = Partial<
  Record<ViewerTier, readonly AssetVideoRendition[] | null>
>;

/**
 * The asset projection this gate decides on. `availabilities` is the exact
 * catalog shape (`media-manager-catalog.ts`), reused so the two never drift;
 * `renditions` preserves Media Manager's window keys, so selecting one window
 * can never accidentally return another window's otherwise-valid URS URL.
 */
export interface MediaManagerGateAsset {
  availabilities?: AssetAttributes["availabilities"];
  renditions?: WindowedRenditions | null;
  /** Media Manager's per-viewer schedule decision; never recomputed here. */
  availabilityWindow?: ResolvedWindow;
  /** Media Manager's per-viewer rendition decision; never recomputed here. */
  playableWindow?: ResolvedWindow;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapWindow(value: unknown): AssetAvailabilityWindow | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const hasStart = Object.prototype.hasOwnProperty.call(value, "start");
  const hasEnd = Object.prototype.hasOwnProperty.call(value, "end");
  // An open window must still be explicit (`start: null`, `end: null`, or
  // either bound on its own). Otherwise an unrelated object such as
  // `{ updated_at: "..." }` would be normalized to `{}` and grant playback.
  if (!hasStart && !hasEnd) return undefined;
  const start = value.start;
  const end = value.end;
  const mapped: AssetAvailabilityWindow = {};
  if (hasStart) {
    if (start !== null && typeof start !== "string") return undefined;
    mapped.start = start;
  }
  if (hasEnd) {
    if (end !== null && typeof end !== "string") return undefined;
    mapped.end = end;
  }
  return mapped;
}

function mapAvailabilities(
  value: unknown,
): AssetAttributes["availabilities"] {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const mapped: NonNullable<AssetAttributes["availabilities"]> = {};
  for (const tier of ["public", "all_members", "station_members"] as const) {
    const window = mapWindow(value[tier]);
    if (window !== undefined) mapped[tier] = window;
  }
  return mapped;
}

function mapRendition(value: unknown): AssetVideoRendition | null {
  if (!isRecord(value)) return null;
  const profile = value.profile;
  const url = value.url;
  if (
    profile !== undefined &&
    profile !== null &&
    typeof profile !== "string"
  ) {
    return null;
  }
  if (url !== undefined && url !== null && typeof url !== "string") {
    return null;
  }
  return {
    ...(profile !== undefined ? { profile } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function mapWindowedRenditions(
  value: unknown,
): WindowedRenditions | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const mapped: WindowedRenditions = {};
  for (const tier of ["public", "all_members", "station_members"] as const) {
    const raw = value[tier];
    if (raw === null) {
      mapped[tier] = null;
      continue;
    }
    if (!Array.isArray(raw)) continue;
    mapped[tier] = raw
      .map(mapRendition)
      .filter(
        (rendition): rendition is AssetVideoRendition => rendition !== null,
      );
  }
  return mapped;
}

function mapResolvedWindow(value: unknown): ResolvedWindow | undefined {
  return value === "public" ||
    value === "all_members" ||
    value === "station_members" ||
    value === "unavailable"
    ? value
    : undefined;
}

/**
 * Map one Media Manager JSON:API asset resource into the pure gate input.
 *
 * The live response is untrusted JSON, so malformed windows or rendition lists
 * are omitted and fail closed in the gate. Only the documented audience keys,
 * window bounds, rendition profiles, and rendition URLs cross this boundary;
 * the returned objects and arrays are new values, leaving the source untouched.
 */
export function assetToGateInput(resource: unknown): MediaManagerGateAsset {
  if (!isRecord(resource) || !isRecord(resource.attributes)) return {};
  return {
    availabilities: mapAvailabilities(resource.attributes.availabilities),
    renditions: mapWindowedRenditions(resource.attributes.videos),
    availabilityWindow: mapResolvedWindow(
      resource.attributes.availability_window,
    ),
    playableWindow: mapResolvedWindow(resource.attributes.playable_window),
  };
}

export interface MediaManagerGateViewer {
  entitlement: Entitlement;
  /** The highest audience tier this viewer belongs to. */
  tier: ViewerTier;
}

export interface MediaManagerGate {
  verdict: GateVerdict;
  reason: GateReason;
  /** Selected playback URL; null unless the verdict is `render`. */
  hls: string | null;
}

// HLS profile preference preserves 16:9 before 4:3 and includes legacy profiles.
// Unknown names never match. Every selected file must still pass the exact URS
// host and m3u8 checks; a source MP4 is never returned. DRM-only profiles are
// excluded because they require a DRM-capable player.
export const HLS_PROFILE_LADDER = [
  "hls-16x9-1080p",
  "hls-1080p-16x9",
  "hls-16x9-720p",
  "hls-2500k-16x9",
  "hls-1200k-16x9",
  "hls-400-2500k-16x9",
  "hls-800k-16x9",
  "ipad-16x9",
  "iphone-16x9",
  "hls-4x3-1080p",
  "hls-1080p-4x3",
  "hls-4x3-720p",
  "hls-2500k-4x3",
  "hls-1200k-4x3",
  "hls-400-2500k-4x3",
  "hls-800k-4x3",
  "ipad-4x3",
  "iphone-4x3",
] as const;

// Only URS HLS URLs may be played: source MP4s and non-URS manifests bypass
// availability rights, geographic restrictions and sponsorship enforcement.
// Check both extension and exact host; a matching suffix is insufficient.
const URS_HOST = "urs.pbs.org";

const TIER_LEVEL: Record<ViewerTier, number> = {
  public: 0,
  all_members: 1,
  station_members: 2,
};

/**
 * Whether a tier string is one this core knows. Takes a bare `string` for the same
 * runtime-boundary reason as `isStreamingState` below: `viewer.tier` is resolved
 * from PIDS/Media Manager audience data at the credentialed boundary, so at runtime it can
 * be a value the `ViewerTier` union does not list. An unknown tier must fail
 * closed, never be treated as the most privileged one.
 */
function isViewerTier(value: string): value is ViewerTier {
  return Object.prototype.hasOwnProperty.call(TIER_LEVEL, value);
}

/**
 * Validate a strict ISO calendar date (YYYY-MM-DD) and return it canonical, or
 * null when it is not a real date-only calendar date. Mirrors
 * `mvault-entitlement.ts` so the window math stays in the calendar-date domain
 * and the two cores never disagree by a day. The regex alone accepts impossible
 * dates ("2026-02-31"), so the digits are round-tripped through a UTC Date.
 */
function validCalendarDate(value: string): string | null {
  const trimmed = value.trim();
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

/**
 * The New Jersey (America/New_York) calendar date of an instant, as YYYY-MM-DD.
 * Kept local and dependency-free, mirroring `easternDate` in
 * `mvault-entitlement.ts` and the schedule feed, so
 * a UTC host does not flip a day boundary at 8pm ET.
 */
function easternDate(epochMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

type WindowBound =
  | { kind: "open" }
  | { kind: "day"; day: string }
  | { kind: "instant"; ms: number }
  | { kind: "bad" };

/**
 * Preserve the granularity of a window bound. Missing or null means open; an
 * empty or unparseable value fails closed. A date-only bound is an inclusive
 * New Jersey calendar day, matching mvault-entitlement.ts. A timestamp remains
 * an instant: reducing it to a day could admit a premiere early or extend an
 * expiry.
 */
function parseWindowBound(bound: string | null | undefined): WindowBound {
  if (bound === null || bound === undefined) return { kind: "open" };
  const trimmed = bound.trim();
  if (trimmed === "") return { kind: "bad" };
  const dateOnly = validCalendarDate(trimmed);
  if (dateOnly !== null) return { kind: "day", day: dateOnly };
  const t = Date.parse(trimmed);
  if (Number.isFinite(t)) return { kind: "instant", ms: t };
  return { kind: "bad" };
}

/**
 * Whether a url is a URS-protected HTTPS HLS stream. Parsed, not
 * pattern-matched, so a lookalike host (`urs.pbs.org.evil.test`) and a plaintext
 * `http:` url are both rejected on structure rather than on a substring. Media
 * Manager documents both `.m3u8` paths and URS redirects with
 * `?format=m3u8`, so either form can identify the manifest.
 */
function isUrsHlsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname.toLowerCase() !== URS_HOST) return false;
  const pathname = parsed.pathname.toLowerCase();
  // An explicit source file is never HLS, even if a malformed or adversarial
  // query string claims `format=m3u8`.
  if (pathname.endsWith(".mp4")) return false;
  const pathIsHls = pathname.endsWith(".m3u8");
  const formatIsHls =
    parsed.searchParams.get("format")?.trim().toLowerCase() === "m3u8";
  return pathIsHls || formatIsHls;
}

type HlsPick =
  | { kind: "url"; url: string }
  | { kind: "rejected" }
  | { kind: "none" };

/**
 * Select the first playable HLS rendition in HLS_PROFILE_LADDER order, requiring
 * the exact URS host and manifest extension. The caller supplies only renditions
 * for the selected window; this function cannot cross audience windows.
 * Distinguish a rejected host from an absent rendition so diagnostics preserve
 * the reason a candidate was unavailable.
 */
function selectHls(
  renditions: readonly AssetVideoRendition[] | null | undefined,
): HlsPick {
  if (!Array.isArray(renditions)) return { kind: "none" };
  let rejected = false;
  for (const profile of HLS_PROFILE_LADDER) {
    for (const rendition of renditions) {
      if (rendition?.profile !== profile) continue;
      if (typeof rendition.url !== "string") continue;
      const url = rendition.url.trim();
      if (url === "") continue;
      if (!isUrsHlsUrl(url)) {
        rejected = true;
        continue;
      }
      return { kind: "url", url };
    }
  }
  return rejected ? { kind: "rejected" } : { kind: "none" };
}

/**
 * Whether an entitlement state is one of the two that stream. Takes a bare
 * `string`, not the `Entitlement` union's `state`, because the value reaches this
 * core mapped from live MVault JSON at a credentialed boundary the type system
 * does not reach: at runtime `state` can be a string the union does not list, and
 * a narrower parameter would let a caller's narrowing make this look redundant and
 * invite its removal. Mirrors `isStreamingState` in `member-gated-playback.ts`
 * so the two entitlement gates never disagree.
 */
function isStreamingState(state: string): boolean {
  return state === "active" || state === "grace";
}

/**
 * Whether a non-streaming state is a genuine membership lapse the viewer can act on
 * by renewing, as opposed to an unreadable record they cannot. Only `expired` and
 * `inactive` earn the renew prompt; `malformed` and any state this core does not
 * recognize are a data defect and fail closed to `unavailable`, matching
 * `member-gated-playback.ts`'s state switch so a possibly-active member is
 * never told to renew over a backend or clock problem. Takes a bare `string` for
 * the same runtime-boundary reason as `isStreamingState`.
 */
function isLapsedState(state: string): boolean {
  return state === "expired" || state === "inactive";
}

function gate(verdict: GateVerdict, reason: GateReason, hls: string | null = null): MediaManagerGate {
  return { verdict, reason, hls };
}

/**
 * Decide the player's action for `asset` and `viewer` at `now`. Pure: same inputs
 * always yield the same output, with no clock, network, or DOM access.
 *
 * Order of decisions matters. Scheduling (window) is resolved before entitlement
 * so an expired asset reads as `unavailable`, not a membership prompt; entitlement
 * is resolved before rendition selection so a non-entitled member gets the prompt
 * without depending on whether a rendition happens to exist.
 */
export function evaluateMediaManagerGate(
  asset: MediaManagerGateAsset,
  viewer: MediaManagerGateViewer,
  now: Date,
): MediaManagerGate {
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) {
    return gate("unavailable", GATE_REASON.unreadableClock);
  }

  // An unknown tier is a data defect, not "no window for you": say so distinctly
  // instead of letting it read as an ordinary tier miss.
  if (!isViewerTier(viewer.tier)) {
    return gate("unavailable", GATE_REASON.unreadableTier);
  }

  // Media Manager computes both values for the viewer from the request's
  // membership/localized-station CIDs. `availability_window` selects the
  // schedule/entitlement policy while `playable_window` selects the videos
  // bucket; PBS documents valid responses where they differ.
  if (
    asset.availabilityWindow === "unavailable" ||
    asset.playableWindow === "unavailable"
  ) {
    return gate("unavailable", GATE_REASON.noWindow);
  }
  if (
    typeof asset.availabilityWindow !== "string" ||
    !isViewerTier(asset.availabilityWindow)
  ) {
    return gate("unavailable", GATE_REASON.unreadableAvailabilityWindow);
  }
  if (
    typeof asset.playableWindow !== "string" ||
    !isViewerTier(asset.playableWindow)
  ) {
    return gate("unavailable", GATE_REASON.unreadablePlayableWindow);
  }
  const availabilityWindow = asset.availabilityWindow;
  const playableWindow = asset.playableWindow;
  // The API owns window selection, but the independently resolved viewer tier is
  // still a useful fail-closed ceiling. A mismatched adapter response must never
  // promote a public/all-members viewer into a higher-privilege rendition.
  if (TIER_LEVEL[availabilityWindow] > TIER_LEVEL[viewer.tier]) {
    return gate("unavailable", GATE_REASON.unreadableAvailabilityWindow);
  }
  if (TIER_LEVEL[playableWindow] > TIER_LEVEL[viewer.tier]) {
    return gate("unavailable", GATE_REASON.unreadablePlayableWindow);
  }
  const window = asset.availabilities?.[availabilityWindow];
  if (typeof window !== "object" || window === null || Array.isArray(window)) {
    return gate("unavailable", GATE_REASON.noWindow);
  }

  const start = parseWindowBound(window.start);
  const end = parseWindowBound(window.end);
  if (start.kind === "bad" || end.kind === "bad") {
    return gate("unavailable", GATE_REASON.unreadableWindow);
  }

  // Both bounds are inclusive. A date-only bound admits its whole New Jersey day;
  // a time-bearing bound admits up to and including its own instant.
  const today = easternDate(nowMs);
  if (start.kind === "day" && today < start.day) {
    return gate("unavailable", GATE_REASON.beforeWindow);
  }
  if (start.kind === "instant" && nowMs < start.ms) {
    return gate("unavailable", GATE_REASON.beforeWindow);
  }
  if (end.kind === "day" && today > end.day) {
    return gate("unavailable", GATE_REASON.afterWindow);
  }
  if (end.kind === "instant" && nowMs > end.ms) {
    return gate("unavailable", GATE_REASON.afterWindow);
  }

  // Inside the window. A public window is open to everyone; a member-tier window
  // is decided from the entitlement state, not the trusted `entitled` boolean, and
  // every uncertain case fails closed. isStreamingState and isLapsedState carry the
  // why: the value crosses a live MVault JSON boundary the types do not reach.
  if (availabilityWindow !== "public" || playableWindow !== "public") {
    const entitlement = viewer.entitlement;
    const streams = isStreamingState(entitlement.state);
    // Boolean and state disagree: a backend data defect, not a membership answer.
    if (entitlement.entitled !== streams) {
      return gate("unavailable", GATE_REASON.unreadableEntitlement);
    }
    // Not streaming: a genuine lapse renews; an unreadable state fails closed.
    if (!streams) {
      return isLapsedState(entitlement.state)
        ? gate("deny", GATE_REASON.notEntitled)
        : gate("unavailable", GATE_REASON.unreadableEntitlement);
    }
  }

  const hls = selectHls(asset.renditions?.[playableWindow]);
  if (hls.kind === "rejected") {
    return gate("unavailable", GATE_REASON.nonUrsHls);
  }
  if (hls.kind === "none") {
    return gate("unavailable", GATE_REASON.noHls);
  }
  return gate("render", GATE_REASON.playable, hls.url);
}
