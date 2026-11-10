// The Admin performance receipt: one privacy-safe User Timing surface that separates an
// Admin delay into authentication, admission, confirmed profile, route download, CMS
// transport, editor render, and save-transaction time (#1064).
//
// Two rules make this safe to leave switched on in production.
//
// 1. Names are frozen. Every mark and measure name comes from the two inventories below,
//    so nothing an editor typed, no record id, and no address can reach a timeline entry
//    name. Callers pass a category, never a value.
// 2. Details are allowlisted and fail closed. sanitizePerfDetail keeps only the six
//    accepted keys, and only when the value is inside its closed vocabulary or matches its
//    exact pattern. An unknown key, a free-text value, an email, a token, a uid, or an
//    address is dropped rather than truncated or hashed.
//
// The only cross-boundary identifier here is the CMS edge's existing `X-NJPBS-Request-ID`
// response header, read as an opaque UUID. This module does not mint a second trace id;
// correlation across the edge, Function, audit, queue, and workflow boundary stays governed
// by #973.
//
// Nothing here caches, bypasses, or reorders identity, admission, profile confirmation,
// authorization, Firestore rules, version checks, persistence, or audit evidence. It only
// observes when those boundaries started and finished.

export const PERF_RECEIPT_SCHEMA_VERSION = 1;

const PREFIX = "njpbs.admin.";

// Every timeline mark this app may emit. Ordered as the session runs.
export const PERF_MARKS = {
  bootstrap: `${PREFIX}bootstrap`,
  authResolved: `${PREFIX}auth-resolved`,
  // The first answer that carries a session. On a restored session it lands with
  // `auth-resolved`; on an interactive sign-in it lands whenever the person finished typing,
  // which is why admission is measured from here and not from the signed-out answer.
  sessionSignedIn: `${PREFIX}session-signed-in`,
  admissionComplete: `${PREFIX}admission-complete`,
  profileConfirmed: `${PREFIX}profile-confirmed`,
  routeLoadStart: `${PREFIX}route-load.start`,
  routeLoadEnd: `${PREFIX}route-load.end`,
  cmsRequestStart: `${PREFIX}cms-request.start`,
  cmsRequestEnd: `${PREFIX}cms-request.end`,
  editorMounted: `${PREFIX}editor-mounted`,
  editorReady: `${PREFIX}editor-ready`,
  saveStart: `${PREFIX}save.start`,
  saveCommitted: `${PREFIX}save.committed`,
} as const;

// Every measure this app may emit, and the boundary each one answers for.
export const PERF_MEASURES = {
  auth: `${PREFIX}measure.auth`,
  admission: `${PREFIX}measure.admission`,
  profile: `${PREFIX}measure.profile`,
  routeLoad: `${PREFIX}measure.route-load`,
  cmsTransport: `${PREFIX}measure.cms-transport`,
  editorRender: `${PREFIX}measure.editor-render`,
  saveTransaction: `${PREFIX}measure.save-transaction`,
  workspaceReady: `${PREFIX}measure.workspace-ready`,
} as const;

export type PerfPhase = keyof typeof PERF_MARKS;

export const ROUTE_CATEGORIES = [
  "cuez",
  "dashboard",
  "content",
  "post-templates",
  "activity",
  "analytics",
  "media",
  "voiceovers",
  "queue",
  "reports",
  "guide",
  "resources",
  "schedule",
  "live-production",
  "account-settings",
  "premiere-connect",
  "account-profile",
  "author-profiles",
  "admin-settings",
  "costs",
  "staff-access",
  "open",
  "not-found",
] as const;
export type RouteCategory = (typeof ROUTE_CATEGORIES)[number];

export const OPERATION_CATEGORIES = [
  "admission",
  "account",
  "content-read",
  "content-list",
  "content-write",
  "revision-read",
  "revision-write",
  "schedule-read",
  "media-read",
  "media-write",
  "voiceover-read",
  "voiceover-write",
  "publish",
  "settings-read",
  "settings-write",
  "staff-admin",
  "report-read",
  "report-write",
  "other",
] as const;
export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

export const PERF_OUTCOMES = [
  "ok",
  "error",
  "conflict",
  "denied",
  "aborted",
] as const;
export type PerfOutcome = (typeof PERF_OUTCOMES)[number];

export const PERF_STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;
export type PerfStatusClass = (typeof PERF_STATUS_CLASSES)[number];

export interface PerfDetail {
  route?: RouteCategory;
  operation?: OperationCategory;
  outcome?: PerfOutcome;
  statusClass?: PerfStatusClass;
  // The CMS edge's own request receipt (#973). Accepted only as an opaque UUID.
  requestId?: string;
  // The build the sample came from, so a receipt can be attributed to a revision.
  build?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILD_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function inVocabulary<T extends string>(
  vocabulary: readonly T[],
  value: unknown,
): value is T {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value);
}

// Fail-closed detail filter. Every emitted detail passes through here, so a caller cannot
// widen the boundary by accident and a future call site cannot smuggle a value in a key
// this contract never named.
export function sanitizePerfDetail(detail: unknown): PerfDetail {
  if (typeof detail !== "object" || detail === null) return {};
  const input = detail as Record<string, unknown>;
  const safe: PerfDetail = {};
  if (inVocabulary(ROUTE_CATEGORIES, input.route)) safe.route = input.route;
  if (inVocabulary(OPERATION_CATEGORIES, input.operation))
    safe.operation = input.operation;
  if (inVocabulary(PERF_OUTCOMES, input.outcome)) safe.outcome = input.outcome;
  if (inVocabulary(PERF_STATUS_CLASSES, input.statusClass))
    safe.statusClass = input.statusClass;
  if (typeof input.requestId === "string" && UUID.test(input.requestId))
    safe.requestId = input.requestId;
  if (
    typeof input.build === "string" &&
    BUILD_TOKEN.test(input.build) &&
    !UUID.test(input.build)
  )
    safe.build = input.build;
  return safe;
}

// A CMS call's category, never its endpoint name or body. Classification is exhaustive:
// an endpoint this contract has not seen reports as `other` rather than leaking its name.
export function operationCategoryForEndpoint(
  endpoint: string,
): OperationCategory {
  if (
    endpoint === "cmsListBugReports" ||
    endpoint === "cmsGetBugReport" ||
    endpoint === "cmsGetBugReportEvidence" ||
    endpoint === "cmsListGithubIssues" ||
    endpoint === "cmsGetGithubIssue"
  )
    return "report-read";
  if (endpoint === "cmsSubmitBugReport" || endpoint === "cmsNudgeBugReport")
    return "report-write";
  if (endpoint === "registerStaffProfile") return "admission";
  if (
    endpoint === "submitStaffAccessRequest" ||
    endpoint === "getStaffAccessStatus" ||
    endpoint === "cmsSetNavigationPreferences" ||
    endpoint === "requestStaffPasswordReset"
  )
    return "account";
  if (
    endpoint === "listStaffAccessRequests" ||
    endpoint === "decideStaffAccessRequest" ||
    endpoint === "deactivateStaff" ||
    endpoint === "reactivateStaff" ||
    endpoint === "grantRole" ||
    endpoint === "setStaffAccessLevel" ||
    endpoint === "revokeRole"
  )
    return "staff-admin";
  if (endpoint === "cmsRestoreRevision") return "revision-write";
  if (endpoint === "cmsListRevisions" || endpoint === "cmsGetRevision")
    return "revision-read";
  if (endpoint === "cmsPublish" || endpoint === "cmsTransitionContent" || endpoint === "cmsRecheckPublication")
    return "publish";
  if (endpoint === "cmsSaveSettings" || endpoint === "cmsPublishSettings")
    return "settings-write";
  // cmsCostLedger's wrapper supplies its action-aware category. Keep the endpoint named
  // here as a fail-closed default for a future direct transport call.
  if (endpoint === "cmsCostLedger") return "settings-read";
  if (endpoint === "cmsGetBroadcastSchedule") return "schedule-read";
  if (
    endpoint === "cmsGetSettings" ||
    endpoint === "cmsGetCoverageLabels" ||
    endpoint === "cmsGetNewsroomBanner"
  )
    return "settings-read";
  if (
    endpoint === "cmsListMedia" ||
    endpoint === "cmsListMediaCategories" ||
    endpoint === "cmsListMediaFavorites" ||
    endpoint === "cmsListMediaCollections" ||
    endpoint === "cmsListMediaCollectionItems" ||
    endpoint === "cmsListBinnedMedia" ||
    endpoint === "cmsCreateMediaDownload"
  )
    return "media-read";
  if (endpoint === "cmsGetVoiceoverAudio") return "voiceover-read";
  if (endpoint === "cmsVoiceoverReview") return "voiceover-write";
  if (
    endpoint === "cmsUploadMedia" ||
    endpoint === "cmsReplaceMediaBinary" ||
    endpoint === "cmsUpdateMediaMetadata" ||
    endpoint === "cmsMutateMediaCategory" ||
    endpoint === "cmsSetMediaFavorite" ||
    endpoint === "cmsSetMediaFavorites" ||
    endpoint === "cmsMutateMediaCollection" ||
    endpoint === "cmsSetMediaCollectionItems" ||
    endpoint === "cmsRestoreMedia"
  )
    return "media-write";
  if (endpoint === "cmsSaveContent" || endpoint === "cmsBulkArchiveContent" || endpoint === "cmsPostTemplates")
    return "content-write";
  if (endpoint === "cmsAssignContent") return "content-write";
  if (endpoint === "cmsListContent" || endpoint === "cmsListAudit")
    return "content-list";
  // The wire names, not the wrapper names: cmsRequestPagePreview and cmsLoadPagePreviewStatus
  // are the exported functions, while what reaches the transport is cmsPreview and
  // cmsPreviewStatus. A drift test reads the real strings out of the transport module so this
  // cannot silently fall back to `other` again.
  if (
    endpoint === "cmsGetContent" ||
    endpoint === "cmsPreview" ||
    endpoint === "cmsPreviewStatus"
  )
    return "content-read";
  if (
    endpoint === "cmsGetAuthorProfile" ||
    endpoint === "cmsListAuthorProfiles" ||
    endpoint === "cmsListBylineAuthors" ||
    endpoint === "cmsListAuthorPagePosts"
  )
    return "content-read";
  if (
    endpoint === "cmsUpdateAuthorProfile" ||
    endpoint === "cmsAdminUpdateAuthorProfile" ||
    endpoint === "cmsSetAuthorProfileVisibility"
  )
    return "content-write";
  return "other";
}

// The HTTP status as a class, so a receipt reports "a 4xx happened" without carrying a
// server message.
export function statusClassFor(status: number | null | undefined): PerfStatusClass {
  if (typeof status !== "number" || !Number.isFinite(status)) return "none";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

export interface TimingSink {
  now(): number;
  mark(name: string, options?: { detail?: unknown; startTime?: number }): void;
  measure(
    name: string,
    options: { start?: number; end?: number; detail?: unknown },
  ): void;
}

export type PerfOperationKind = "route-load" | "cms-request" | "save";

export interface PerfOperation {
  end(detail?: PerfDetail): void;
}

export interface PerfReceiptEntry {
  name: string;
  detail: PerfDetail;
}

export interface PerfReceiptMark extends PerfReceiptEntry {
  startTime: number;
}

export interface PerfReceiptMeasure extends PerfReceiptEntry {
  durationMs: number;
}

export interface PerfReceiptCounts {
  marks: number;
  // Operations that started and have not finished. A benchmark run settles on this: a start
  // without its end is the slow-operation regression the receipt exists to expose, so a
  // sample must not be written while one is still outstanding.
  open: number;
  routeLoad: number;
  cmsRequest: number;
  save: number;
  byOperation: Record<string, number>;
  byRoute: Record<string, number>;
}

export interface AdminPerfReceipt {
  schemaVersion: number;
  build: string | null;
  marks: PerfReceiptMark[];
  measures: PerfReceiptMeasure[];
  counts: PerfReceiptCounts;
}

export interface PerfRecorder {
  phase(phase: PerfPhase, detail?: PerfDetail): void;
  begin(kind: PerfOperationKind, detail?: PerfDetail): PerfOperation;
  receipt(): AdminPerfReceipt;
}

type EditorLeaseRelease = () => Promise<boolean>;

let editorLeaseRelease: EditorLeaseRelease | null = null;

export function registerAdminPerfEditorLeaseRelease(
  release: EditorLeaseRelease,
): () => void {
  editorLeaseRelease = release;
  return () => {
    if (editorLeaseRelease === release) editorLeaseRelease = null;
  };
}

const OPERATION_MARKS: Record<
  PerfOperationKind,
  { start: string; end: string; measure: string }
> = {
  "route-load": {
    start: PERF_MARKS.routeLoadStart,
    end: PERF_MARKS.routeLoadEnd,
    measure: PERF_MEASURES.routeLoad,
  },
  "cms-request": {
    start: PERF_MARKS.cmsRequestStart,
    end: PERF_MARKS.cmsRequestEnd,
    measure: PERF_MEASURES.cmsTransport,
  },
  save: {
    start: PERF_MARKS.saveStart,
    end: PERF_MARKS.saveCommitted,
    measure: PERF_MEASURES.saveTransaction,
  },
};

// Which phase pair closes which boundary measure. Each fires once, when its closing phase
// is first marked, so the receipt reports the session's real ordering rather than a
// re-measured average.
const PHASE_MEASURES: Array<{
  from: PerfPhase;
  to: PerfPhase;
  measure: string;
}> = [
  { from: "bootstrap", to: "authResolved", measure: PERF_MEASURES.auth },
  // From the session, not from the signed-out answer: the interval between them is a person
  // typing credentials, which is not admission latency and must not be reported as it.
  {
    from: "sessionSignedIn",
    to: "admissionComplete",
    measure: PERF_MEASURES.admission,
  },
  {
    from: "admissionComplete",
    to: "profileConfirmed",
    measure: PERF_MEASURES.profile,
  },
  {
    from: "editorMounted",
    to: "editorReady",
    measure: PERF_MEASURES.editorRender,
  },
  {
    from: "bootstrap",
    to: "editorReady",
    measure: PERF_MEASURES.workspaceReady,
  },
];

const ONCE_ONLY: readonly PerfPhase[] = [
  "bootstrap",
  "authResolved",
  "sessionSignedIn",
  "admissionComplete",
  "profileConfirmed",
  "editorMounted",
  "editorReady",
];

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// A newsroom session stays open for hours. Keep the entry list bounded so an all-day editor
// does not accumulate an unbounded array; the counts keep counting past the cap, so a
// long session still reports how much work it did.
const MAX_RETAINED_ENTRIES = 500;

function retain<T>(entries: T[], entry: T): void {
  entries.push(entry);
  if (entries.length > MAX_RETAINED_ENTRIES) entries.shift();
}

// The report contract accepts at most ten IDs. Copy only safe CMS request IDs,
// newest first, without free text, URLs, or console messages.
export function reportCorrelationIds(receipt: AdminPerfReceipt): string[] {
  const ids = new Set<string>();
  for (const measure of [...receipt.measures].reverse()) {
    if (measure.name !== PERF_MEASURES.cmsTransport) continue;
    const id = sanitizePerfDetail(measure.detail).requestId;
    if (id) ids.add(id.toLowerCase());
    if (ids.size === 10) break;
  }
  return [...ids];
}

// Build a recorder over an injected timing sink. The sink is the seam every test uses; in
// the browser it is `performance`. A runtime without User Timing still counts operations,
// so a receipt is never partly true: it reports zero measures rather than dropped ones.
export function createPerfRecorder(
  sink: TimingSink | null | undefined,
  options: { build?: string | null } = {},
): PerfRecorder {
  const build = sanitizePerfDetail({ build: options.build ?? undefined }).build ?? null;
  const phaseTimes = new Map<PerfPhase, number>();
  const marks: PerfReceiptMark[] = [];
  const measures: PerfReceiptMeasure[] = [];
  const counts: PerfReceiptCounts = {
    marks: 0,
    open: 0,
    routeLoad: 0,
    cmsRequest: 0,
    save: 0,
    byOperation: {},
    byRoute: {},
  };
  const now = () => (sink ? sink.now() : 0);

  function countDetail(detail: PerfDetail): void {
    if (detail.operation) {
      counts.byOperation[detail.operation] =
        (counts.byOperation[detail.operation] ?? 0) + 1;
    }
    if (detail.route) {
      counts.byRoute[detail.route] = (counts.byRoute[detail.route] ?? 0) + 1;
    }
  }

  function record(
    name: string,
    start: number,
    end: number,
    detail: PerfDetail,
  ): void {
    // Without a clock a duration would be a fabricated zero. Count the operation, report no
    // measure: an absent number is honest, an invented one is not.
    if (!sink) return;
    retain(measures, { name, detail, durationMs: round(end - start) });
    sink.measure(name, { start, end, detail });
  }

  function phase(phaseName: PerfPhase, detail: PerfDetail = {}): void {
    if (ONCE_ONLY.includes(phaseName) && phaseTimes.has(phaseName)) return;
    const safe = sanitizePerfDetail(detail);
    const at = now();
    phaseTimes.set(phaseName, at);
    retain(marks, {
      name: PERF_MARKS[phaseName],
      detail: safe,
      startTime: round(at),
    });
    counts.marks += 1;
    countDetail(safe);
    sink?.mark(PERF_MARKS[phaseName], { detail: safe });
    for (const boundary of PHASE_MEASURES) {
      if (boundary.to !== phaseName) continue;
      const start = phaseTimes.get(boundary.from);
      if (start === undefined) continue;
      record(boundary.measure, start, at, safe);
    }
  }

  function begin(
    kind: PerfOperationKind,
    detail: PerfDetail = {},
  ): PerfOperation {
    const names = OPERATION_MARKS[kind];
    const openDetail = sanitizePerfDetail(detail);
    const start = now();
    retain(marks, {
      name: names.start,
      detail: openDetail,
      startTime: round(start),
    });
    counts.marks += 1;
    if (kind === "route-load") counts.routeLoad += 1;
    else if (kind === "cms-request") counts.cmsRequest += 1;
    else counts.save += 1;
    counts.open += 1;
    countDetail(openDetail);
    sink?.mark(names.start, { detail: openDetail });
    let closed = false;
    return {
      end(endDetail: PerfDetail = {}) {
        if (closed) return;
        closed = true;
        counts.open -= 1;
        const safe = { ...openDetail, ...sanitizePerfDetail(endDetail) };
        const at = now();
        retain(marks, { name: names.end, detail: safe, startTime: round(at) });
        counts.marks += 1;
        sink?.mark(names.end, { detail: safe });
        record(names.measure, start, at, safe);
      },
    };
  }

  return {
    phase,
    begin,
    receipt: () => ({
      schemaVersion: PERF_RECEIPT_SCHEMA_VERSION,
      build,
      marks: marks.map((mark) => ({ ...mark })),
      measures: measures.map((measure) => ({ ...measure })),
      counts: {
        ...counts,
        byOperation: { ...counts.byOperation },
        byRoute: { ...counts.byRoute },
      },
    }),
  };
}

function browserSink(): TimingSink | null {
  const timing = globalThis.performance;
  if (!timing || typeof timing.mark !== "function") return null;
  return {
    now: () => timing.now(),
    mark: (name, options) => {
      try {
        timing.mark(name, options as PerformanceMarkOptions);
      } catch {
        // A timeline that refuses an entry must never break an editing session.
      }
    },
    measure: (name, options) => {
      try {
        timing.measure(name, options as PerformanceMeasureOptions);
      } catch {
        // Same: measurement is evidence, not behavior.
      }
    },
  };
}

// The build this bundle was produced from, injected by vite.config.ts as one defined constant
// (the reviewed status manifest's revision, else the checked-out commit, else null). It is a
// constant and not an environment read on purpose: an optional `import.meta.env?.X` read
// defeats Vite's per-key replacement and serializes the whole environment object into the
// client bundle, which the admin public environment boundary forbids. `typeof` keeps a runtime
// that never saw the define -- a bare unit test, a future embedding -- working unchanged.
declare const __ADMIN_BUILD_REVISION__: string | null | undefined;

const buildRevision =
  typeof __ADMIN_BUILD_REVISION__ === "string" ? __ADMIN_BUILD_REVISION__ : null;

// The one recorder the app instruments against.
export const adminPerf: PerfRecorder = createPerfRecorder(browserSink(), {
  build: buildRevision,
});

// Bootstrap is marked here rather than in the entry's body because this module is evaluated
// before any code that could be instrumented -- the entry's own statements run only after its
// whole import graph, including the route preload App starts, has been evaluated. Marking in
// the entry body therefore put `bootstrap` after marks it is supposed to precede.
adminPerf.phase("bootstrap");

// Publish the sanitized receipt and the one lifecycle control the capture harness needs. The
// control can only release this tab's courtesy editor lease; it cannot read or change content.
export function publishPerfProbe(
  target: Record<string, unknown> = globalThis as unknown as Record<
    string,
    unknown
  >,
  recorder: PerfRecorder = adminPerf,
): void {
  target.__njpbsAdminPerf = {
    schemaVersion: PERF_RECEIPT_SCHEMA_VERSION,
    receipt: () => recorder.receipt(),
    releaseEditorLease: () => editorLeaseRelease?.() ?? Promise.resolve(false),
  };
}

