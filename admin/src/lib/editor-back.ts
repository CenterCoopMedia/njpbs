// Where an open editor's Back action goes, and what it says.
//
// Every editor offers one visible way back to the list it belongs to (#1037). The default is the
// editor's own list: a post goes to Posts, a page goes to the page directory. When the editor was
// opened from a list, that list's exact address — filters, sort and paging included — is carried
// on the navigation and preferred here, so Back returns to the view the person was reading rather
// than to an unfiltered list they then have to rebuild.
//
// Pure: no React and no router import, so the rule is testable on its own and the editor holds a
// single call rather than its own origin parsing.
import {
  contentLibraryPath,
  contentPagesPath,
  dashboardPath,
  parseContentPath,
  publishQueuePath,
  recordListPath,
  stripTrailingSlash,
} from "./routes";
import type { RecordKind } from "../../../packages/content-core/src/editor-admin";

export interface BackDestination {
  to: string;
  label: string;
  shortLabel: string;
}

// What a list link puts on the navigation it starts, and how an editor reads it back. Both sides
// name the same key here so a list never hand-writes the shape the editor parses. It rides on
// history state, so it survives a reload of the editor's own address and travels with Back and
// Forward, while a direct link simply carries nothing and takes the default destination.
export interface ListOriginState {
  from: string;
}

export function listOriginState(location: {
  pathname: string;
  search: string;
}): ListOriginState {
  return { from: `${location.pathname}${location.search}` };
}

export function readListOrigin(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const from = (state as { from?: unknown }).from;
  return typeof from === "string" ? from : null;
}

export interface BackDestinationInput {
  surface: { kind: "record"; record: RecordKind } | { kind: "page" };
  // The record collection's display label ("Posts"), used verbatim in the link text so the editor
  // keeps one source for what a record kind is called.
  listLabel?: string;
  // The list address the editor was opened from, as recorded on the navigation. Absent for a
  // direct link, a refresh that lost it, or an editor opened from anywhere else.
  origin?: string | null;
}

// Split a recorded origin into its pathname and the query/hash that must survive with it. Only an
// in-app absolute path is accepted: a protocol-relative or absolute URL would send Back off the
// admin entirely, so it is refused rather than parsed.
function splitOrigin(origin: string | null | undefined): { pathname: string; suffix: string } | null {
  if (typeof origin !== "string") return null;
  if (!origin.startsWith("/") || origin.startsWith("//")) return null;
  const cut = origin.search(/[?#]/);
  return cut === -1
    ? { pathname: origin, suffix: "" }
    : { pathname: origin.slice(0, cut), suffix: origin.slice(cut) };
}

// The work lists that live outside `/content/**` and still open editors: the editorial queue a
// reviewer works through, and newsroom home, whose recent work and homepage action are the first
// editor most people open in a session. Both list pages and records together, so either editor can
// honestly return to them. Without this the canonical path's last stage lands on a list the person
// never chose, and getting back to the queue they were working costs a second navigation — the
// wrong turn and recovery action the task-flow criterion is written to catch (#1036).
const WORK_LIST_ORIGINS: ReadonlyArray<{ path: string; label: string; shortLabel: string }> = [
  { path: publishQueuePath(), label: "Back to editorial queue", shortLabel: "Editorial queue" },
  { path: dashboardPath(), label: "Back to newsroom home", shortLabel: "Home" },
];

export function editorBackDestination(input: BackDestinationInput): BackDestination {
  const fallback: BackDestination =
    input.surface.kind === "record"
      ? {
          to: recordListPath(input.surface.record),
          label: `Back to ${(input.listLabel ?? "").toLowerCase()} list`,
          shortLabel: input.surface.record === "post" ? "Posts" : input.listLabel ?? "",
        }
      : { to: contentPagesPath(), label: "Back to pages", shortLabel: "Pages" };

  const origin = splitOrigin(input.origin);
  if (!origin) return fallback;

  // Matched on the whole normalized pathname, never as a prefix: a trailing slash is the same
  // route and must not recreate the wrong turn, while a sub-path is some other surface entirely
  // and sending Back there would be a destination that cannot show this document.
  const normalized = stripTrailingSlash(origin.pathname);
  const workList = WORK_LIST_ORIGINS.find(
    (candidate) => candidate.path === normalized,
  );
  if (workList) {
    return { to: `${workList.path}${origin.suffix}`, label: workList.label, shortLabel: workList.shortLabel };
  }

  const route = parseContentPath(origin.pathname);

  // The combined library lists both pages and records, so either editor can return to it.
  if (route.kind === "library") {
    return { to: `${contentLibraryPath()}${origin.suffix}`, label: "Back to All content", shortLabel: "All content" };
  }
  if (input.surface.kind === "record") {
    // A list of some other record kind cannot show this record, so it is not an honest Back.
    if (route.kind === "record-list" && route.type === input.surface.record) {
      return { to: `${recordListPath(route.type)}${origin.suffix}`, label: fallback.label, shortLabel: fallback.shortLabel };
    }
    return fallback;
  }
  if (route.kind === "page-list") {
    return { to: contentPagesPath(), label: "Back to pages", shortLabel: "Pages" };
  }
  return fallback;
}
