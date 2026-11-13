import { COVERAGE_LABELS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings";
import { STORY_CTAS_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings";
import { usageActionCollector } from "./boardwalk-usage";
import { projectCoverageLabels, type CoverageLabelsBuildData } from "../../../packages/content-core/src/coverage-labels";
import { invalidateMediaLists, markMediaTabCountsStale, type MediaTabCounts } from "./media-session-cache";
import {
  recordReportRequest,
  type BrowserDiagnostics,
} from "./report-diagnostics";
import { auth, firebaseConfig, getRequiredAppCheckToken } from "./firebase";
import { isSessionRejection, reportRefusedToken, SESSION_ENDED_MESSAGE } from "./session-ended";
import { createInstalledReaderTransport, isInstalledReaderEndpoint } from "./installed-reader-transport";
import {
  adminPerf,
  type OperationCategory,
  operationCategoryForEndpoint,
  statusClassFor,
} from "./perf-receipts";
import type { LibrarySelection } from "./content-library";
import type { BroadcastSchedule } from "../data/broadcast-schedule";
import type { AccessTier, Role } from "../../../packages/content-core/src/rbac";
import type { NavigationPreferences } from "./navigation-preferences";
import { PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID,
  SITE_NAVIGATION_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID } from "../../../packages/content-core/src/cms-settings";

export interface RoleRequest {
  targetUid?: string;
  targetEmail?: string;
  role: Role;
  sections?: string[];
  siteWide?: boolean;
}

export interface NewsroomBannerResponse {
  success: true;
  heading: string;
  milestoneNumber: number;
  source: "default" | "saved";
  version: number | null;
}

export interface BroadcastScheduleResponse extends BroadcastSchedule {
  success: true;
}

export interface RoleResponse {
  success: true;
  uid: string;
}

const emulatorMode =
  import.meta.env.DEV || import.meta.env.VITE_USE_EMULATORS === "true";

const baseUrl = emulatorMode
  ? `http://127.0.0.1:5001/${firebaseConfig.projectId}/us-central1`
  : import.meta.env.VITE_FUNCTIONS_BASE_URL;

if (import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development" &&
    baseUrl !== "https://dev-api.example.org") {
  throw new Error("Dev API build target was refused");
}

const emulatorEdgeHeaders: Record<string, string> = emulatorMode
  ? { "X-NJPBS-CMS-Edge": "local-cms-edge-only" }
  : {};

// Configuration is read only for an adopted endpoint. A malformed enabled
// manifest refuses that request and leaves the rest of Boardwalk available.
let installedReader: ReturnType<typeof createInstalledReaderTransport> | undefined;
function installedReaderFor(endpoint: string) {
  if (import.meta.env.VITE_CMS_READER_BRIDGE_ENABLED !== "true" || !isInstalledReaderEndpoint(endpoint)) return null;
  installedReader ??= createInstalledReaderTransport({
    enabled: import.meta.env.VITE_CMS_READER_BRIDGE_ENABLED,
    manifest: import.meta.env.VITE_CMS_READER_BRIDGE_MANIFEST,
    origin: baseUrl ?? "",
    storage: sessionStorage,
  });
  return installedReader;
}

// A function call that came back non-2xx. It carries the status alongside the server's
// message because callers have to branch on *which* failure this was: a save conflict
// (409) offers the editor a choice, while every other failure is just an error to show.
// The message is server copy and will be reworded, so matching on its text would be a
// silent trap -- the status is the contract.
export class HttpError extends Error {
  readonly status: number;
  readonly data: Record<string, unknown>;
  // A client decision, separate from the unchanged server payload. Admission
  // must surface this failed request rather than wait for a sign-out event.
  readonly sessionContinues: boolean;

  constructor(
    status: number,
    message: string,
    data: Record<string, unknown> = {},
    sessionContinues = false,
  ) {
    super(isSessionRejection(status, data) && !sessionContinues ? SESSION_ENDED_MESSAGE : message);
    this.name = "HttpError";
    this.status = status;
    this.data = data;
    this.sessionContinues = sessionContinues;
  }
}

function responseError(status: number, message: string, data: Record<string, unknown>, idToken: string | null): HttpError {
  const refusal = isSessionRejection(status, data) ? reportRefusedToken(idToken, data) : undefined;
  const sessionContinues = refusal === "obsolete_token";
  return new HttpError(status, sessionContinues ? "This request expired. Try the action again." : message, data, sessionContinues);
}

// The request stopped before fetch could dispatch it. Callers that retain an idempotency
// marker can safely clear a first-attempt marker for this error. Network and response errors
// do not use this type because the server may already have received those requests.
export class RequestNotDispatchedError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "The request could not start.",
    );
    this.name = "RequestNotDispatchedError";
    this.cause = cause;
  }
}

// This 409 means the public deployment fence stopped publication, not that another editor
// changed the record. Keep it separate so the UI can preserve the actionable error instead
// of reloading the same saved version and erasing the message.
export function isPublicationUnavailableError(error: unknown): boolean {
  if (!(
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 409
  )) {
    return false;
  }
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === "media_publication_unavailable"
  );
}

export function didPublicationCommitBeforeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { publicationCommitted?: unknown }).publicationCommitted === true
  );
}

// True when a save was refused because it was composed against a document that has since
// changed (#530). Read structurally rather than with `instanceof` so a caller is not
// coupled to this module's class identity, which a bundle boundary or a re-thrown error
// can break without any type error to warn about.
export function isConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 409 &&
    !isPublicationUnavailableError(error) &&
    (error as { data?: { code?: unknown } }).data?.code !== "live_blog_presentation_unavailable" &&
    (error as { data?: { code?: unknown } }).data?.code !== "live_blog_follow_ups_unavailable"
  );
}

export function settingsPublicationRefusalMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null ||
      (error as { status?: unknown }).status !== 409) return null;
  const code = (error as { data?: { code?: unknown } }).data?.code;
  if (code !== "settings_publication_client_outdated" && code !== "settings_publication_unavailable") return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message ? message
    : code === "settings_publication_client_outdated"
      ? "Boardwalk was updated. Reload this page, then publish again."
      : "Settings publication is unavailable. Try again shortly.";
}

// True when an author-profile request was refused because the signed-in CMS account is
// deactivated. Every self endpoint refuses one, reads included, so this is the difference
// between "your profile could not be opened, try again" and "this account is closed" --
// two states that need different copy and different controls. Read structurally, and by
// the server's `code` rather than its wording, for the same reasons isConflictError is.
export function isInactiveAccountError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { status?: unknown }).status !== 403
  ) {
    return false;
  }
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: unknown }).code === "account_inactive"
  );
}

// A lost create response can be replayed after another editor has already advanced the
// record that first request made. The API names that exact conflict and returns the immutable
// record id, so the create form can offer a deliberate handoff to the stored record instead of
// retrying the same nonce forever or treating the stale draft as safe to overwrite.
export function createReplayConflictRecordId(error: unknown): string | null {
  if (!isConflictError(error)) return null;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return null;
  const conflict = (data as Record<string, unknown>).conflict;
  const recordId = (data as Record<string, unknown>).recordId;
  return conflict === "create-replay-advanced" &&
    typeof recordId === "string" &&
    recordId.length > 0
    ? recordId
    : null;
}

function reportRequestNow(): number {
  try {
    return globalThis.performance?.now?.() ?? 0;
  } catch {
    return 0;
  }
}

// POST a JSON body to a callable HTTPS function with the caller's Firebase id token, and
// return the parsed JSON. A non-2xx response is turned into an HttpError carrying the
// server's `error` string when it sent one, so the UI shows the real reason (a role
// refusal, a validation message) rather than a bare status code.
//
// Every call is timed as CMS transport in the performance receipt (#1064). The receipt gets
// the endpoint's operation category, the outcome, the status class, and the CMS edge's own
// `X-NJPBS-Request-ID` when it sent one -- never the endpoint's body, the server's message,
// the id token, or any record identity. No second trace id is minted here (#973).
export async function postFunction<T>(
  endpoint: string,
  idToken: string | null,
  body: unknown,
  requestHeaders: Record<string, string> = {},
  options: {
    // "unless-automation" is only for the transcript and video search reads (#4950): when no
    // App Check token can be had, the read goes without one and only a server-marked
    // automation account is admitted. Everyone else sees the same refusal as before.
    appCheck?: boolean | "unless-automation";
    signal?: AbortSignal;
    operation?: OperationCategory;
  } = {},
): Promise<T> {
  if (!baseUrl) {
    throw new Error("Functions base URL is not configured");
  }

  // App Check is acquired before the measure opens. It is its own boundary, it can refuse, and
  // a refusal after the start mark would leave an operation that never closes: a phantom
  // request in the counts and something the benchmark harness would wait forever to settle.
  let appCheckToken: string | null = null;
  let appCheckFailure: unknown = null;
  if (options.appCheck) {
    try {
      appCheckToken = await getRequiredAppCheckToken();
    } catch (error) {
      if (options.appCheck !== "unless-automation") throw new RequestNotDispatchedError(error);
      appCheckFailure = error;
    }
  }
  options.signal?.throwIfAborted();

  // Transport only. A write's category already separates it from a read here; the save
  // transaction is a wider boundary and is timed where the editor owns it, because one save
  // can be several requests and is not committed until the last of them lands.
  const transport = adminPerf.begin("cms-request", {
    operation: options.operation ?? operationCategoryForEndpoint(endpoint),
  });

  const reportStartedAt = reportRequestNow();
  let response: Response;
  let responseToken = idToken;
  try {
    const reader = installedReaderFor(endpoint);
    if (reader) {
      const result = await reader.send({ endpoint, body, token: idToken ?? "",
        principalId: auth.currentUser?.uid ?? "", appCheckToken, signal: options.signal });
      response = result.response;
      responseToken = result.token;
    } else {
      response = await fetch(`${baseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          ...requestHeaders,
          ...(appCheckToken ? { "X-Firebase-AppCheck": appCheckToken } : {}),
          ...emulatorEdgeHeaders,
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
  } catch (error) {
    recordReportRequest(endpoint, 0, reportRequestNow() - reportStartedAt);
    transport.end({ outcome: "aborted", statusClass: "none" });
    throw error;
  }
  recordReportRequest(endpoint, response.status, reportRequestNow() - reportStartedAt);

  // Read the edge's receipt defensively: measurement must never be the reason a CMS call
  // fails, and not every transport (a local emulator, a test double) exposes headers.
  const requestId = response.headers?.get?.("x-njpbs-request-id") ?? undefined;
  const statusClass = statusClassFor(response.status);
  transport.end({
    outcome: response.ok
      ? "ok"
      : response.status === 409
        ? "conflict"
        : response.status === 401 || response.status === 403
          ? "denied"
          : "error",
    statusClass,
    requestId,
  });

  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    let data: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        data = parsed as Record<string, unknown>;
      }
      if (typeof data.error === "string") message = data.error;
    } catch {
      message = response.statusText || message;
    }
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
      data = { ...data, retryAfterSeconds: retryAfter };
    }
    if (response.status === 503 && [
      "CMS publication is paused for a serializer handoff",
      "Cloud publication is paused or owned by another release",
    ].includes(message)) {
      message = "Publishing is paused for a short update. Try again in a few minutes.";
    }
    // Without a marked automation account, the missing-token refusal shows staff the same
    // browser verification message as an undispatched request.
    if (appCheckFailure && response.status === 401 && !isSessionRejection(response.status, data)) {
      throw new RequestNotDispatchedError(appCheckFailure);
    }
    throw responseError(response.status, message, data, responseToken);
  }

  return (await response.json()) as T;
}

// The ledger keeps reads and writes behind one audited Function. Its action decides the
// receipt category, while the shared transport still owns App Check and error handling.
export function cmsCostLedger<T>(
  idToken: string,
  body: { action: string; period?: string },
  signal?: AbortSignal,
): Promise<T> {
  return postFunction<T>("cmsCostLedger", idToken, body, {}, {
    appCheck: true,
    signal,
    operation: body.action === "view" ? "settings-read" : "settings-write",
  });
}

// Voiceover review keeps its list and save actions behind one endpoint. Their body action is
// allowed to choose the receipt category here, while the shared JSON transport continues to own
// Firebase authentication, emulator handling, error shaping, and request receipts.
export function cmsListVoiceoverReviews<T>(
  idToken: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return postFunction<T>("cmsVoiceoverReview", idToken, body, {}, {
    signal,
    operation: "voiceover-read",
  });
}

export function cmsSaveVoiceoverReview<T>(
  idToken: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return postFunction<T>("cmsVoiceoverReview", idToken, body, {}, {
    signal,
    operation: "voiceover-write",
  });
}

// The private audio endpoint returns WAV bytes rather than JSON. Keep the same transport
// boundary as postFunction so a binary response cannot quietly omit the CMS edge header,
// request receipts, or HttpError handling.
export async function cmsGetVoiceoverAudioResponse(
  idToken: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  if (!baseUrl) throw new Error("Functions base URL is not configured");
  const transport = adminPerf.begin("cms-request", {
    operation: "voiceover-read",
  });
  const reportStartedAt = reportRequestNow();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/cmsGetVoiceoverAudio`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        ...emulatorEdgeHeaders,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    recordReportRequest(
      "cmsGetVoiceoverAudio",
      0,
      reportRequestNow() - reportStartedAt,
    );
    transport.end({ outcome: "aborted", statusClass: "none" });
    throw error;
  }
  recordReportRequest(
    "cmsGetVoiceoverAudio",
    response.status,
    reportRequestNow() - reportStartedAt,
  );
  transport.end({
    outcome: response.ok
      ? "ok"
      : response.status === 409
        ? "conflict"
        : response.status === 401 || response.status === 403
          ? "denied"
          : "error",
    statusClass: statusClassFor(response.status),
    requestId: response.headers?.get?.("x-njpbs-request-id") ?? undefined,
  });
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    let data: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        data = parsed as Record<string, unknown>;
      }
      if (typeof data.error === "string") message = data.error;
    } catch {
      message = response.statusText || message;
    }
    throw responseError(response.status, message, data, idToken);
  }
  return response;
}

async function postMultipartFunction<T>(
  endpoint: string,
  idToken: string,
  body: FormData,
): Promise<T> {
  if (!baseUrl) throw new Error("Functions base URL is not configured");
  const transport = adminPerf.begin("cms-request", {
    operation: operationCategoryForEndpoint(endpoint),
  });
  const reportStartedAt = reportRequestNow();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...emulatorEdgeHeaders,
      },
      body,
    });
  } catch (error) {
    recordReportRequest(endpoint, 0, reportRequestNow() - reportStartedAt);
    transport.end({ outcome: "aborted", statusClass: "none" });
    throw error;
  }
  recordReportRequest(endpoint, response.status, reportRequestNow() - reportStartedAt);
  const requestId = response.headers?.get?.("x-njpbs-request-id") ?? undefined;
  transport.end({
    outcome: response.ok
      ? "ok"
      : response.status === 409
        ? "conflict"
        : response.status === 401 || response.status === 403
          ? "denied"
          : "error",
    statusClass: statusClassFor(response.status),
    requestId,
  });
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    let data: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        data = parsed as Record<string, unknown>;
      }
      if (typeof data.error === "string") message = data.error;
    } catch {
      message = response.statusText || message;
    }
    throw responseError(response.status, message, data, idToken);
  }
  return (await response.json()) as T;
}

export type BugReportSeverity = "blocker" | "work_impaired" | "minor";
export type BugReportArea =
  | "sign_in_access"
  | "content_editing"
  | "save_revision"
  | "review_publish"
  | "media"
  | "navigation_ui"
  | "other";
export type BugReportCategory = "bug" | "suggestion" | "question";

export type BugReportStatus =
  | "open"
  | "acknowledged"
  | "in_progress"
  | "blocked"
  | "resolved"
  | "dismissed";

export interface BugReportResolution {
  immediateSafeAction: string;
  likelyCause: {
    certainty: "confirmed" | "suspected" | "unknown";
    summary: string;
  };
  recommendedResolution: string[];
  verification: string;
  fallback: string;
  needsAdminInput: string;
  missingEvidence: string[];
}

export interface BugReportProgress {
  stage?: "received" | "investigating" | "fixing" | "review" | "awaiting_live" | "closed";
  phase: "received" | "acknowledged" | "queued" | "in_progress" | "ready_for_review" | "changes_requested" | "checks_failed" | "merged" | "closed" | "resolved" | "dismissed" | "blocked" | "needs_attention" | "reopened";
  label: string;
  detail: string;
  active: boolean;
  updatedAt: string | null;
  lastSyncedAt: string | null;
  syncState: "not_linked" | "current" | "pending" | "stale" | "unavailable";
  issues: Array<{ number: number; state: "open" | "closed" | "unavailable" }>;
  pullRequests: Array<{
    number: number;
    state: "open" | "closed" | "unavailable";
    draft: boolean;
    merged: boolean;
    reviewState: "approved" | "changes_requested" | "pending" | "none";
    checksState: "success" | "failure" | "pending" | "none";
  }>;
  deployment: "unverified";
}

export interface BugReportRecord {
  shared?: false;
  nudge?: BugReportNudge;
  apiVersion: number;
  id: string;
  category?: BugReportCategory;
  severity: BugReportSeverity;
  area: BugReportArea;
  tryingToDo: string;
  happened: string;
  expected: string;
  steps: string | null;
  workaround: string | null;
  consoleLogs?: Array<{
    level: "log" | "info" | "warn" | "error" | "debug";
    message: string;
    timestamp: string;
  }>;
  route: { path: string; url: string | null } | null;
  affectedRecord: {
    kind: string;
    id: string;
    lifecycle: string | null;
    version: number | null;
  } | null;
  reporter: { uid: string; email?: string; role: string };
  evidence: {
    screenshot: {
      id: string;
      mimeType: string;
      sizeBytes: number;
      width: number;
      height: number;
      sha256: string;
      expiresAt: string;
    } | null;
  };
  environment: {
    buildRevision: string;
    deploymentEnvironment: string;
    browser?: string;
    operatingSystem?: string;
    viewport?: { width: number; height: number };
    online?: boolean;
    timeZone?: string;
    diagnostics?: BrowserDiagnostics;
    native?: {
      source: "premiere";
      mode: "manual" | "automatic";
      pluginVersion: string;
      premiereVersion: string;
      uxpVersion: string;
      pluginRevision?: string;
      platform: "win32" | "darwin" | "unknown";
      view: "connection" | "library" | "detail" | "return" | "settings";
    };
  };
  automatic?: {
    fingerprint: string;
    repeatCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    windowExpiresAt: string;
  };
  correlationIds: string[];
  status: BugReportStatus;
  progress?: BugReportProgress;
  actionableResolution: BugReportResolution;
  acknowledgedAt: string | null;
  assignedAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  ownerUid?: string | null;
  acknowledgedBy?: string | null;
  resolvedBy?: string | null;
  dismissedBy?: string | null;
  deliveryStatus?: string;
  githubDelivery?: {
    state:
      | "not_linked"
      | "pending"
      | "synced"
      | "retryable_failed"
      | "unknown"
      | "terminal_failed";
    attemptCount: number;
    lastAttemptAt: string | null;
    lastError: string | null;
    lastOperation:
      | "create_issue"
      | "create_issue_and_fix"
      | "attach_issue"
      | "attach_pull_request"
      | "sync"
      | null;
    lastTargetNumber: number | null;
    lastSyncedAt: string | null;
    fixRequestedAt: string | null;
    fixStatus:
      | "not_requested"
      | "pending"
      | "running"
      | "draft_pr_open"
      | "investigation_only"
      | "failed";
    fixSessionName: string | null;
    fixPullRequestUrl: string | null;
  };
  links?: {
    relatedReportIds: string[];
    githubIssueNumbers: number[];
    pullRequestNumbers: number[];
    discoveredPullRequestNumbers?: number[];
    discoveryObservedAt?: string;
    workflowRunUrls: string[];
    deploymentRunUrls: string[];
    githubIssues?: Array<{
      number: number;
      url: string;
      title: string;
      state: "open" | "closed";
      updatedAt: string;
    }>;
    pullRequests?: Array<{
      number: number;
      url: string;
      title: string;
      state: "open" | "closed";
      draft: boolean;
      merged: boolean;
      headSha: string;
      reviewState: "approved" | "changes_requested" | "pending" | "none";
      checksState: "success" | "failure" | "pending" | "none";
      deploymentState: "success" | "failure" | "pending" | "none";
      updatedAt: string;
    }>;
  };
}

export interface BugReportSubmission {
  category?: BugReportCategory;
  severity: BugReportSeverity;
  area: BugReportArea;
  tryingToDo: string;
  happened: string;
  expected: string;
  steps?: string;
  workaround?: string;
  consoleLogs: Array<{
    level: "log" | "info" | "warn" | "error" | "debug";
    message: string;
    timestamp: string;
  }>;
  route: string;
  affectedRecord?: {
    kind: string;
    id: string;
    lifecycle?: string;
    version?: number;
  };
  clientContext: {
    browser: string;
    operatingSystem: string;
    viewport: { width: number; height: number };
    online: boolean;
    timeZone: string;
    diagnostics?: BrowserDiagnostics;
  };
  correlationIds: string[];
}

// Use the full source SHA; the performance receipt's build revision is shortened.
declare const __ADMIN_SOURCE_REVISION__: string | null | undefined;

export function cmsSubmitBugReport(
  idToken: string,
  submission: BugReportSubmission,
  clientRequestId: string,
  screenshot: File | null,
): Promise<{ success: true; created: boolean; report: BugReportRecord }> {
  const form = new FormData();
  // Keep the newest evidence within the multipart field limit after JSON escaping.
  const report = { ...submission, consoleLogs: [...submission.consoleLogs] };
  let serialized = JSON.stringify(report);
  while (new TextEncoder().encode(serialized).byteLength > 120 * 1024 && report.consoleLogs.length) {
    report.consoleLogs.shift();
    serialized = JSON.stringify(report);
  }
  form.set("report", serialized);
  form.set("clientRequestId", clientRequestId);
  form.set("website", "");
  if (import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development") {
    form.set("adminBuildRevision", typeof __ADMIN_SOURCE_REVISION__ === "string" ? __ADMIN_SOURCE_REVISION__ : "");
  }
  if (screenshot) form.set("screenshot", screenshot, screenshot.name);
  return postMultipartFunction("cmsSubmitBugReport", idToken, form);
}

export interface BugReportNudge {
  version: number;
  eligible: boolean;
  eligibleAt: string | null;
  progressAt: string | null;
  requestedAt: string | null;
  history: Array<{ requestedAt: string; deliveredAt?: string | null; delivery: "pending" | "delivered" | "unknown" | "terminal_failed" | "cancelled"; decision: "approved" | "ignored" | null; decidedAt: string | null }>;
  historyTruncated: boolean;
}
export type BugReportSummary = Pick<BugReportRecord, "id" | "category" | "severity" | "status" | "createdAt" | "tryingToDo" | "happened" | "progress" | "nudge">;
export type SharedBugReport = Omit<BugReportSummary, "nudge"> & { shared: true; nudge?: never };
export function cmsNudgeBugReport(idToken: string, reportId: string, mutationId: string): Promise<{ success: true; nudge: BugReportNudge; replayed: boolean }> {
  return postFunction("cmsNudgeBugReport", idToken, { reportId, mutationId });
}

export function cmsListBugReports(
  idToken: string,
  view: "mine" | "all" = "mine",
  limit = 100,
): Promise<{
  success: true;
  view: "mine" | "all";
  repository?: string;
  reports: BugReportSummary[];
  truncated: boolean;
  sharedReportsActive: boolean;
}> {
  return postFunction("cmsListBugReports", idToken, { view, limit });
}

export interface BugReportAuditEntry {
  id: string;
  action: string;
  actorUid: string | null;
  actorEmail: string | null;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export function cmsGetBugReport(
  idToken: string,
  reportId: string,
): Promise<{
  success: true;
  report: BugReportRecord | SharedBugReport;
  audit: BugReportAuditEntry[];
  auditTruncated: boolean;
  canAdminister: boolean;
}> {
  return postFunction("cmsGetBugReport", idToken, { reportId });
}

export function cmsGetBugReportEvidence(
  idToken: string,
  reportId: string,
): Promise<{
  success: true;
  mimeType: "image/webp";
  base64: string;
  width: number;
  height: number;
}> {
  return postFunction("cmsGetBugReportEvidence", idToken, { reportId });
}

export type GithubIssueStateFilter = "open" | "closed" | "all";

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  htmlUrl: string;
  updatedAt: string;
  createdAt: string;
  commentCount: number;
  labels: string[];
  author: string;
}

export interface GithubIssueComment {
  id: number;
  author: string;
  createdAt: string;
  body: string;
}

export interface GithubIssueRecord extends GithubIssueSummary {
  body: string;
  comments: GithubIssueComment[];
  commentsTruncated: boolean;
}

export function cmsListGithubIssues(
  idToken: string,
  state: GithubIssueStateFilter = "open",
  page = 1,
): Promise<{
  success: true;
  state: GithubIssueStateFilter;
  repository: string;
  issues: GithubIssueSummary[];
  truncated: boolean;
}> {
  return postFunction("cmsListGithubIssues", idToken, { state, page });
}

export function cmsGetGithubIssue(
  idToken: string,
  number: number,
): Promise<{
  success: true;
  issue: GithubIssueRecord;
}> {
  return postFunction("cmsGetGithubIssue", idToken, { number });
}

export function grantRole(
  idToken: string,
  body: RoleRequest,
): Promise<RoleResponse> {
  return postFunction<RoleResponse>("grantRole", idToken, body);
}

export function revokeRole(
  idToken: string,
  body: RoleRequest,
): Promise<RoleResponse> {
  return postFunction<RoleResponse>("revokeRole", idToken, body);
}

export interface StaffAccessLevelRequest {
  targetUid: string;
  accessTier: AccessTier;
  expectedAccess: string;
}

export function setStaffAccessLevel(idToken: string, body: StaffAccessLevelRequest) {
  return postFunction<RoleResponse & { accessTier: AccessTier; changed: boolean }>(
    "setStaffAccessLevel", idToken, body,
  );
}

export function cmsGetNewsroomBanner(
  idToken: string,
): Promise<NewsroomBannerResponse> {
  return postFunction<NewsroomBannerResponse>(
    "cmsGetNewsroomBanner",
    idToken,
    {},
  );
}

export function cmsGetBroadcastSchedule(
  idToken: string,
): Promise<BroadcastScheduleResponse> {
  return postFunction<BroadcastScheduleResponse>(
    "cmsGetBroadcastSchedule",
    idToken,
    {},
  );
}

export interface DeactivateStaffResponse {
  success: true;
  uid: string;
  alreadyInactive: boolean;
  authUserMissing: boolean;
}

// Remove one staff account through the server-owned offboarding boundary. The function
// clears CMS authority and audit state before disabling Firebase Auth and revoking active
// sessions; callers may safely retry the same uid after a partial Auth failure.
export function deactivateStaff(
  idToken: string,
  targetUid: string,
): Promise<DeactivateStaffResponse> {
  return postFunction<DeactivateStaffResponse>("deactivateStaff", idToken, {
    targetUid,
  });
}

export interface ReactivateStaffRequest {
  targetUid: string;
  accessTier: AccessTier;
}

// Restore one inactive staff account at one chosen whole-site level. Sign-in is
// enabled after the audited Firestore change; after a partial Auth failure, retry
// the same uid and level to finish it.
export function reactivateStaff(idToken: string, body: ReactivateStaffRequest) {
  return postFunction<RoleResponse & { accessTier: AccessTier; alreadyActive: boolean }>(
    "reactivateStaff", idToken, body,
  );
}

export interface RegisterStaffProfileResponse {
  success: true;
  uid: string;
  created: boolean;
}

// Ask the trusted server boundary to validate the current approved staff
// session. Account requests do not create a profile. The approval transaction
// creates the profile and grants together.
export function registerStaffProfile(
  idToken: string,
): Promise<RegisterStaffProfileResponse> {
  return postFunction<RegisterStaffProfileResponse>(
    "registerStaffProfile",
    idToken,
    {},
  );
}

export type StaffAccessState =
  | "not_requested"
  | "email_verification"
  | "pending"
  | "denied"
  | "expired"
  | "ready";

export interface StaffAccessStatus {
  state: StaffAccessState;
  requestVersion: number | null;
  reference: string | null;
  role: "staff" | "editor" | "contributor" | null;
  requestedAt: string | null;
  decidedAt: string | null;
  emailVerified: boolean;
}

export type StaffAccessMailState =
  | "not_queued"
  | "sent"
  | "pending"
  | "suppressed"
  | "preparing"
  | "failed"
  | "unknown"
  | "skipped";

export interface StaffAccessResponse {
  success: true;
  request: StaffAccessStatus;
  mailState: StaffAccessMailState;
}

export interface StaffPasswordResetResponse {
  success: true;
}

export function requestStaffPasswordReset(
  email: string,
): Promise<StaffPasswordResetResponse> {
  return postFunction<StaffPasswordResetResponse>(
    "requestStaffPasswordReset",
    null,
    { email },
    {},
    { appCheck: true },
  );
}

export function submitStaffAccessRequest(
  idToken: string,
  reason: string,
): Promise<StaffAccessResponse> {
  return postFunction<StaffAccessResponse>(
    "submitStaffAccessRequest",
    idToken,
    { reason },
    {},
    { appCheck: true },
  );
}

export function getStaffAccessStatus(
  idToken: string,
): Promise<StaffAccessResponse> {
  return postFunction<StaffAccessResponse>(
    "getStaffAccessStatus",
    idToken,
    {},
    {},
    { appCheck: true },
  );
}

export interface PendingStaffAccessRequest {
  uid: string;
  email: string;
  displayName: string | null;
  reason: string;
  requestVersion: number;
  reference: string;
  requestedAt: string | null;
  state: "pending";
}

export interface ListStaffAccessRequestsResponse {
  success: true;
  requests: PendingStaffAccessRequest[];
}

export function listStaffAccessRequests(
  idToken: string,
): Promise<ListStaffAccessRequestsResponse> {
  return postFunction<ListStaffAccessRequestsResponse>(
    "listStaffAccessRequests",
    idToken,
    {},
    {},
    { appCheck: true },
  );
}

export interface DecideStaffAccessRequest {
  targetUid: string;
  requestVersion: number;
  decision: "approve" | "deny";
  role?: "staff" | "editor" | "contributor";
}

export function decideStaffAccessRequest(
  idToken: string,
  body: DecideStaffAccessRequest,
): Promise<StaffAccessResponse> {
  return postFunction<StaffAccessResponse>(
    "decideStaffAccessRequest",
    idToken,
    body,
    {},
    { appCheck: true },
  );
}

// The collections cmsSaveContent writes: a page document keyed by public page id, or a
// record whose canonical id the server mints on create.
export type SaveCollection = "cmsPages" | "cmsPosts";
export type PublishCollection = SaveCollection | "cmsSettings";

export type PostTemplateMode = "layout" | "content";
export interface PostTemplateSummary {
  id: string;
  name: string;
  description: string;
  mode: PostTemplateMode;
  version: number;
  retired: boolean;
  sourceId: string;
  sourceVersion: number;
  section: string | null;
  counts: Record<string, number>;
  canManage: boolean;
}
export interface CapturePostTemplateRequest {
  sourceId: string;
  sourceVersion: number;
  name: string;
  description: string;
  mode: PostTemplateMode;
  idempotencyKey: string;
}
export interface PostTemplateReceipt {
  success: true;
  template: PostTemplateSummary;
  removed: boolean;
  replayed: boolean;
}
export interface PostTemplateContent {
  success: true;
  template: PostTemplateSummary;
  document: Record<string, unknown>;
  mediaWarning: string | null;
}
export interface PostTemplateList {
  success: true;
  templates: PostTemplateSummary[];
  hasMore?: boolean;
  nextCursor?: string;
}
export function cmsListPostTemplates(idToken: string, cursor?: string) {
  return postFunction<PostTemplateList>("cmsPostTemplates", idToken, { action: "list", ...(cursor ? { cursor } : {}) });
}
export function cmsGetPostTemplate(idToken: string, id: string) {
  return postFunction<PostTemplateContent>("cmsPostTemplates", idToken, { action: "get", id });
}
export function cmsCapturePostTemplate(idToken: string, body: CapturePostTemplateRequest) {
  return postFunction<PostTemplateReceipt>("cmsPostTemplates", idToken, { ...body, action: "capture" });
}
export function cmsChangePostTemplate(idToken: string, body: {
  action: "update" | "remove";
  id: string;
  baseVersion: number;
  idempotencyKey: string;
  name?: string;
  description?: string;
  retired?: boolean;
  document?: Record<string, unknown>;
}) {
  return postFunction<PostTemplateReceipt>("cmsPostTemplates", idToken, body);
}

export function cmsResolveEditorTarget(idToken: string, input: { path: string } | { type: string; id: string }) {
  return postFunction<{ success: true; target: import("../../../packages/content-core/src/boardwalk-edit").BoardwalkEditTarget }>(
    "cmsGetContent", idToken, { action: "resolveEditor", ...input },
  );
}

export interface GetContentRequest {
  collection: SaveCollection;
  id: string;
}

export type GetContentResponse =
  | {
      success: true;
      found: true;
      document: Record<string, unknown>;
    }
  | {
      success: true;
      found: false;
      document: null;
    };

// Hydrate one addressed page or record through the same authenticated,
// capability-aware server boundary that authorizes content saves. An absent
// canonical page is a successful `found: false` response; unreadable, absent,
// or deleted records are deliberately distinguished only by the endpoint's
// 403/404 contract so the browser never becomes an existence probe.
export function cmsGetContent(
  idToken: string,
  body: GetContentRequest,
): Promise<GetContentResponse> {
  return postFunction<GetContentResponse>("cmsGetContent", idToken, body);
}

export interface ContentPublicationMetadata {
  recordPublication?: {
    queueId: string; sourceVersion: number; withdrawal: boolean;
    status: "pending" | "success" | "failed"; missingConsumers: string[]; warning?: string;
  };
  libraryCardPublication?: {
    queueId: string; sourceVersion: number; action: "approve" | "unpublish" | "archive";
    withdrawal: boolean; status: "pending" | "success" | "failed"; missingConsumers: string[]; warning?: string;
  } | null;
  workingVersion: number | null;
  contentVersion?: number | null;
  publishedContentVersion?: number | null;
  workingStatus: string;
  publishedSourceVersion: number | null;
  publicSourceVersion: number | null;
  publiclyVisible: boolean;
  publicUpdatePending: boolean;
  publicBuildQueueId: string | null;
  queueStatus: string | null;
  canResumeReservation?: boolean;
  homeWarning?: string;
  withdrawalBuildPending?: boolean;
  postServingConfirmed?: boolean;
  postProofStatus?: "pending" | "failed" | "verified";
  postProofPending?: boolean;
  postProofWarning?: string;
  postProofQueueId?: string;
  recheckQueueId?: string;
  pageReceipt?: { operationId: string; sourceVersion: number; visible: boolean };
  publicationTransport?: "page-no-build-v1";
  // Present while a build-free Page queue is pending: the live public check state.
  pageConfirmation?: { checking: boolean; attempts: number; nextAttemptAt: number | null };
}

export function cmsGetPublicationStatus(idToken: string, body: GetContentRequest, signal?: AbortSignal) {
  return postFunction<{ success: true; found: boolean; publication: ContentPublicationMetadata }>(
    "cmsGetContent", idToken, { ...body, publicationOnly: true }, {}, { signal },
  );
}

export interface RevisionSummary {
  id: string;
  action: string;
  actorUid: string | null;
  actorEmail: string | null;
  at: string;
  contentVersion?: number | null;
  beforeVersion: number | null;
  version: number | null;
  beforeStatus: string | null;
  status: string | null;
  beforeBlockCount: number | null;
  blockCount: number | null;
  mediaReferenceCount: number;
  mediaReferencesAdded: number | null;
  mediaReferencesRemoved: number | null;
  beforeTruncated: boolean;
  diffAvailable: boolean;
  changedFields: string[];
  changedFieldCount: number | null;
  changedFieldsTruncated: boolean;
}

export interface ListRevisionsRequest {
  collection: SaveCollection;
  id: string;
  cursor?: string;
}

export interface ListRevisionsResponse {
  success: true;
  entries: RevisionSummary[];
  nextCursor: string | null;
}

export interface GetRevisionRequest {
  collection: SaveCollection;
  id: string;
  revisionId: string;
}

export interface RevisionDetail {
  id: string;
  collection: SaveCollection;
  documentId: string;
  action: string;
  actorUid: string | null;
  actorEmail: string | null;
  at: string;
  before: unknown;
  after: unknown;
  beforeTruncated: boolean;
}

export interface GetRevisionResponse {
  success: true;
  revision: RevisionDetail;
}

// Load only bounded metadata for the revision timeline. Full before/after
// snapshots stay behind cmsGetRevision until the person selects one row.
export function cmsListRevisions(
  idToken: string,
  body: ListRevisionsRequest,
): Promise<ListRevisionsResponse> {
  return postFunction<ListRevisionsResponse>("cmsListRevisions", idToken, body);
}

// Load one immutable revision row after the server re-authorizes the caller
// against the current content record.
export function cmsGetRevision(
  idToken: string,
  body: GetRevisionRequest,
): Promise<GetRevisionResponse> {
  return postFunction<GetRevisionResponse>("cmsGetRevision", idToken, body);
}

export interface RestoreRevisionRequest {
  collection: SaveCollection;
  id: string;
  revisionId: string;
  baseVersion: number;
}

export interface RestoreRevisionResponse {
  success: true;
  collection: SaveCollection;
  id: string;
  // The new immutable history row created by the restore.
  revisionId: string;
  sourceRevisionId: string;
  sourceVersion: number | null;
  version: number;
  document: Record<string, unknown>;
}

// Restore one server-read immutable snapshot onto the exact current version.
// The server preserves workflow, routing, assignment, approval, scheduling,
// and published state, then records the restored working copy as a new version.
export function cmsRestoreRevision(
  idToken: string,
  body: RestoreRevisionRequest,
): Promise<RestoreRevisionResponse> {
  return postFunction<RestoreRevisionResponse>(
    "cmsRestoreRevision",
    idToken,
    body,
  );
}

export type LifecycleAction =
  | "edit"
  | "submit"
  | "sendBack"
  | "approve"
  | "reopen"
  | "revise"
  | "unschedule"
  | "unpublish"
  | "archive"
  | "restore";

export interface TransitionContentRequest {
  collection: SaveCollection;
  id: string;
  action: LifecycleAction;
  baseVersion: number;
  comment?: string;
}

export interface HomeAffectedSection {
  blockId: string;
  section: string;
  title: string;
  refreshable: boolean;
}

export interface TransitionContentResponse {
  publication?: { status: "queued" | "failed"; queueId: string | null;
    cardPublication?: boolean;
    homeFullBuildQueueId?: string | null;
    affectedHomeSections?: HomeAffectedSection[]; warnings?: string[] };
  success: true;
  collection: SaveCollection;
  id: string;
  action: LifecycleAction;
  fromStatus: string;
  toStatus: string;
  version: number;
  document: Record<string, unknown>;
}

// Move content through the dedicated optimistic lifecycle boundary. Ordinary
// saves cannot replace an explicit review or publication decision.
export function cmsTransitionContent(
  idToken: string,
  body: TransitionContentRequest,
): Promise<TransitionContentResponse> {
  return postFunction<TransitionContentResponse>(
    "cmsTransitionContent",
    idToken,
    body,
  );
}

export interface SaveContentRequest {
  /** Creates an independent draft from this exact template version. Retry the same request key. */
  postTemplate?: { id: string; version: number };
  /** Duplicates this exact saved Post as an independent draft. Retry the same request key. */
  postSource?: { id: string; version: number };
  /** Requested local URL slug; the server reserves it and retains old redirects. */
  slug?: string;
  collection: SaveCollection;
  // The doc key. A page requires its canonical public page id. A record omits this to create (the
  // server mints the id) and sends the server id only to update an existing record (#515).
  id?: string;
  // The `version` of the document this edit was composed against (#530). The server takes
  // it as a claim about what the editor could see, and refuses the save with 409 when the
  // stored document has moved on -- so a second editor is told rather than silently
  // overruled. Required for existing documents. True creates omit it; a never-created
  // Page uses `createOnly` below instead (#567). A missing claim never permits an overwrite.
  baseVersion?: number;
  saveGroupId?: string;
  // The page-id document did not exist when the editor loaded. The server turns this into an
  // insert-conflict guard: if another editor creates it first, this save receives 409 and must
  // reload instead of silently replacing a page this editor never saw (#567).
  createOnly?: boolean;
  // On the first save of a page split from the former template-keyed singleton, the server
  // reads this legacy source in the same transaction and carries its metadata forward. The
  // source is registry-validated and its version is checked when available; clients never send
  // the server-owned metadata itself.
  seedFromLegacyPage?: { id: string; version?: number };
  // A nonce for one record-create attempt, reused across every retry of that same attempt
  // (#542). The server derives the new record's id from it, so a retry sent after the first
  // response was lost lands on the document that attempt already created instead of minting a
  // second copy. Send it only when creating, alongside an omitted `id`, and mint a fresh one
  // per create attempt rather than per save. The address is bound to the payload too, so a
  // reused nonce over different fields creates its own record rather than replaying the first
  // one; the case to avoid is a nonce reused over a payload that happens to be identical, where
  // a second new record would come back as the first one.
  idempotencyKey?: string;
  // Explicit Home draft conversion, not an ordinary block save. Supply one stable
  // request key (8–200 characters), cmsPages/home, exact baseVersion, and only
  // document.blocks with the seven proposed regions. The server retains the
  // existing manual shelf. No other request flags or metadata are accepted.
  convertHome?: string;
  // Explicit saved v1-to-v2 draft conversion. The server derives the proposal
  // from its stored blocks using the editorial preset; a published v1 becomes
  // a working draft while its live snapshot is retained. Send an empty
  // document, exact baseVersion and one
  // stable request key. No content replacement or publication flags.
  convertHomeV2?: string;
  // The editorial desk this record belongs to, for section-scoped grants (#619). Sent on
  // a record create only, and only from the section registry: the server validates it
  // against that registry inside the save transaction and fixes it on the document, so an
  // ordinary save cannot move the record afterwards. A new custom Page requires this
  // registered editing group; built-in Pages use their fixed public-page area and omit it.
  // Not the page-builder section id.
  section?: string;
  // Freeze and publish the exact approved stored version. The document overlay
  // must be empty and baseVersion must identify that version; reviewed content
  // is reopened before any further edit.
  publish?: boolean;
  // With publish, publish only these live blog entries and coverage state on a
  // published live blog Post. Editor access is enough; the document must hold
  // only liveBlog, and any other Post change still needs review and approval.
  liveBlogUpdate?: boolean;
  // Schedule the exact approved stored version at this UTC instant. The document
  // overlay must be empty; the server rejects past times and review bypasses.
  scheduleAt?: string;
  // The content fields to persist. Omitted fields keep their stored value; `blocks` is
  // validated and id-minted server-side, so the client sends its working blocks and adopts
  // the returned canonical ids.
  document: Record<string, unknown>;
}

export interface SaveContentResponse {
  success: true;
  warnings?: string[];
  collection: SaveCollection;
  // The doc id the write landed on: the public page id, or the record id (server-minted on create).
  id: string;
  created: boolean;
  // True when the exact record create or Home conversion already committed and
  // remains current. The saved record returns without writes. `created` is true
  // only for a record create. Older deployments can omit this field.
  replayed?: boolean;
  // The explicit identity receipt for blocks whose client id was replaced. The key is the
  // unique non-empty id sent by the editor and the value is its server-owned canonical id.
  // Consumers must use this map instead of assuming the returned block array kept its order.
  mintedIds: Record<string, string>;
  // The persisted document, including each block's server-owned canonical id.
  document: Record<string, unknown>;
  // Serializer deployments create this queue in the same transaction as the
  // published snapshot. Older and GitHub-transport deployments omit it.
  publication?: {
    queueId: string;
    dispatched: false;
    status: "pending";
    transport: "serializer" | "post-no-build-v1" | "page-no-build-v1" | "public-context-no-build-v1" | "release-pair-publication-v2";
    message?: string;
    affectedHomeSections?: HomeAffectedSection[];
    homeFullBuildQueueId?: string | null;
    warnings?: string[];
  };
}

export interface PublishQueuedResponse {
  success: true;
  queueId: string;
  dispatched: boolean;
  status: "pending" | "publishing" | "success" | "failed";
  transport?: "github" | "serializer" | "post-no-build-v1" | "page-no-build-v1" | "public-context-no-build-v1" | "release-pair-publication-v2";
  message: string;
  publicReceipt?: PublicRuntimeReceipt;
  existingBuild?: boolean;
}

export interface PublishRuntimeResponse {
  success: true;
  queueId: null;
  dispatched: false;
  status: "runtime_confirmed";
  transport: "runtime";
  message: string;
  publicReceipt: PublicRuntimeReceipt & { status: "confirmed" };
}

export type PublishBuildResponse =
  | PublishQueuedResponse
  | PublishRuntimeResponse;

export function cmsRetryPublication(idToken: string, request: {
  collection: SaveCollection;
  id: string;
  sourceVersion: number;
  baseVersion: number;
  operation?: "withdraw";
}) {
  const { baseVersion, ...change } = request;
  return postFunction<PublishQueuedResponse>("cmsPublish", idToken, {
    changes: [change], retry: true, baseVersion,
  });
}

export interface PublicationRecheckResult {
  success: true;
  queueId: string;
  outcome: "confirmed_late" | "superseded" | "failed";
  message: string;
}

export function cmsRecheckPublication(idToken: string, queueId: string) {
  return postFunction<PublicationRecheckResult>("cmsRecheckPublication", idToken, { queueId });
}

export interface PublicRuntimeReceipt {
  collection: PublishCollection;
  id: string;
  sourceVersion: number;
  status: "confirmed" | "unconfirmed";
  label: string;
}

export function cmsPublish(
  idToken: string,
  changes: Array<{
    collection: PublishCollection;
    id: string;
    sourceVersion: number;
  }>,
): Promise<PublishQueuedResponse>;
export function cmsPublish(
  idToken: string,
  changes: Array<{
    collection: PublishCollection;
    id: string;
    sourceVersion: number;
  }>,
  options: { runtimeFirst: true },
): Promise<PublishBuildResponse>;
export function cmsPublish(
  idToken: string,
  changes: Array<{
    collection: PublishCollection;
    id: string;
    sourceVersion: number;
  }>,
  options: { runtimeFirst?: boolean } = {},
): Promise<PublishBuildResponse> {
  return postFunction<PublishBuildResponse>("cmsPublish", idToken, {
    changes,
    ...(options.runtimeFirst === true ? { runtimeFirst: true } : {}),
  });
}

type SaveContentWireResponse = Omit<SaveContentResponse, "mintedIds"> & {
  // Additive since #538. An older deployed function omits it during a rolling deployment.
  mintedIds?: unknown;
};

function stringIdMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

// Compatibility for the short interval in which a new admin bundle may call a function
// deployed before the additive mintedIds receipt. That function preserved block order, so
// derive the former positional mapping only when the field is absent. Current responses use
// the explicit map even when it is empty and never infer identity from array position (#900).
function legacyPositionalMintedIds(
  body: SaveContentRequest,
  response: SaveContentWireResponse,
): Record<string, string> {
  const sent = body.document.blocks;
  const persisted = response.document.blocks;
  if (!Array.isArray(sent) || !Array.isArray(persisted)) return {};

  const entries: Array<[string, string]> = [];
  for (let index = 0; index < sent.length; index += 1) {
    const sentBlock = sent[index];
    const persistedBlock = persisted[index];
    if (
      typeof sentBlock === "object" &&
      sentBlock !== null &&
      !Array.isArray(sentBlock) &&
      typeof sentBlock.id === "string" &&
      typeof persistedBlock === "object" &&
      persistedBlock !== null &&
      !Array.isArray(persistedBlock) &&
      typeof persistedBlock.id === "string"
    ) {
      entries.push([sentBlock.id, persistedBlock.id]);
    }
  }
  // Object.fromEntries defines keys such as __proto__ instead of invoking a plain object's
  // prototype setter.
  return Object.fromEntries(entries);
}

// Persist a page or record through the server-owned save half of the publishing model
// (ADR 0012). Save is decoupled from publish: it writes the content doc and its version and
// audit rows, it never triggers a build.
//
// Rejects with an HttpError on a 409, which means this edit was composed against a document
// that has since changed (#530). Nothing was written, and the caller's unsaved work is still
// its own; the editor offers reload and, only when the caller had loaded the stored document,
// an informed overwrite (#563/#567).
// Branch on `isConflictError`, not on the message text.
// `public` on a video block is server-owned (#2751); the server strips it too. Kept local
// so this eagerly loaded module does not pull the content-core validators into a shared chunk.
function withoutPublicVideoData(blocks: unknown[]): unknown[] {
  return blocks.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const { type, data } = block as { type?: unknown; data?: unknown };
    if (type !== "video" || typeof data !== "object" || data === null || !("public" in data)) return block;
    const { public: _server, ...rest } = data as Record<string, unknown>;
    return { ...block, data: rest };
  });
}

export async function cmsSaveContent(
  idToken: string,
  body: SaveContentRequest,
): Promise<SaveContentResponse> {
  const blocks = body.document?.blocks;
  const request = Array.isArray(blocks)
    ? { ...body, document: { ...body.document, blocks: withoutPublicVideoData(blocks) } }
    : body;
  const response = await postFunction<SaveContentWireResponse>(
    "cmsSaveContent",
    idToken,
    request,
  );
  const mintedIds =
    response.mintedIds === undefined
      ? legacyPositionalMintedIds(body, response)
      : stringIdMap(response.mintedIds);
  return { ...response, mintedIds };
}

export interface ListContentResponse extends LibrarySelection {
  success: true;
}

// Resolve the combined library, typed record lists, and newsroom home on the authenticated
// server boundary. `query` is the same canonical, versioned query string stored in the URL;
// the server validates it independently and returns one addressed page plus authoritative counts.
export function cmsListContent(
  idToken: string,
  query: string,
): Promise<ListContentResponse> {
  return postFunction<ListContentResponse>("cmsListContent", idToken, {
    query,
  });
}

export interface PageDirectoryEntry {
  id: string;
  title: string;
  path: string;
  thumbnailUrl?: string;
  section?: string;
  status?: string;
  published?: boolean;
  livePath?: string;
  liveTitle?: string;
  contentLinkDomain?: string;
  version?: number;
  contentVersion?: number;
  publishedContentVersion?: number;
  publishedSourceVersion?: number;
  liveSourceVersion?: number;
  publicUpdatePending?: boolean;
  publicBuildQueueId?: string | null;
  pendingSourceVersion?: number;
  pageReceipt?: ContentPublicationMetadata["pageReceipt"];
  publicationTransport?: "page-no-build-v1";
}

export function cmsListPages(idToken: string): Promise<{success: true; pages: PageDirectoryEntry[]}> {
  return postFunction("cmsListContent", idToken, { view: "pages" });
}

export function cmsPublishedVocabulary(idToken: string) {
  return postFunction<import("../../../packages/content-core/src/published-vocabulary").PublishedVocabulary>(
    "cmsListContent", idToken, { view: "published-vocabulary" });
}

export function cmsSetNavigationPreferences(
  idToken: string,
  navigation: NavigationPreferences | null,
  sharedItemIds?: readonly string[],
): Promise<{ success: true }> {
  const body = navigation === null
    ? { action: "reset" }
    : sharedItemIds === undefined
      ? { action: "save", navigation }
      : { action: "save", navigation, sharedItemIds };
  return postFunction("cmsSetNavigationPreferences", idToken, body, {}, { appCheck: true });
}

/** Share one stored plank or span. The server reads navigation and does not write it. */
export function cmsShareNavigationItem(
  idToken: string,
  itemId: string,
  shared: boolean,
): Promise<{ success: true }> {
  return postFunction("cmsSetNavigationPreferences", idToken, {
    action: "share",
    itemId,
    shared,
  }, {}, { appCheck: true });
}

/** The kinds the Images tab lists and filters. */
export type MediaKind = "image" | "document" | "audio";
/** Every stored media library kind. Audio appears only on the Audio tab. */
export type MediaAssetKind = MediaKind | "audio";
export type MediaSortField = "updatedAt" | "createdAt" | "name" | "sizeBytes";
export type MediaSortDirection = "asc" | "desc";

export interface MediaCategoryDefinition {
  id: string;
  label: string;
  description: string;
  order: number;
  active: boolean;
  reserved: boolean;
  version: number;
  etag: string;
  canUpload: boolean;
  canManage: boolean;
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ListMediaCategoriesResponse {
  success: true;
  categories: MediaCategoryDefinition[];
}

export type MutateMediaCategoryRequest =
  | {
      action: "create";
      category: {
        id: string;
        label: string;
        description: string;
        order: number;
      };
    }
  | {
      action: "update";
      id: string;
      changes: Partial<
        Pick<MediaCategoryDefinition, "label" | "description" | "order">
      >;
    }
  | { action: "archive" | "restore"; id: string };

export interface MutateMediaCategoryResponse {
  success: true;
  changed: boolean;
  category: MediaCategoryDefinition;
}

export interface MediaAssetSummary {
  id: string;
  name: string;
  originalName: string;
  category: string;
  categories: string[];
  tags: string[];
  description: string | null;
  altText: string | null;
  /** True when the nightly sweep wrote the alt text and no person has changed it. */
  altTextGenerated?: boolean;
  metadataUpdateRequested?: boolean;
  license: string | null;
  credit: string | null;
  mimeType: string;
  kind: MediaAssetKind;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  thumbnails?: { url: string; width: number; height: number }[];
  /** True when the stored file has more than one frame. Absent means unclassified. */
  animated?: boolean;
  /** A retained private original is recorded; availability is rechecked on download. */
  originalAvailable?: boolean;
  /** The retained original's file format, shown in the Download menu. */
  originalFormat?: "JPG" | "PNG";
  source?: "upload" | "site_seed" | "voiceover" | null;
  voiceoverTakeId?: string;
  voiceover?: import("./voiceovers").VoiceoverTake & { manifestVersion: number; performer_name: string };
  lifecycle: "active";
  version: number;
  etag: string;
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ListMediaRequest {
  q?: string;
  assetIds?: string[];
  categories?: string[];
  kinds?: MediaAssetKind[];
  sort?: MediaSortField;
  direction?: MediaSortDirection;
  page?: number;
  /** Omit to keep the 30-row library page. The maximum is the active-library scan cap. */
  pageSize?: number;
  /** Opaque indexed-library continuation. Exact-id and self-profile reads stay on legacy paging. */
  paging?: "cursor";
  cursor?: string;
}

export interface BinnedMediaAsset extends Omit<MediaAssetSummary, "lifecycle"> {
  lifecycle: "tombstoned" | "purging";
  purgeAfter: string;
  tombstonedAt: string | null;
  tombstonedByName: string | null;
}

export interface ListBinnedMediaResponse {
  success: true;
  records: BinnedMediaAsset[];
  total: number;
  page: number;
  pageCount: number;
}

export function cmsListBinnedMedia(
  idToken: string,
  body: { page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<ListBinnedMediaResponse> {
  return postFunction("cmsListBinnedMedia", idToken, body, {}, { signal });
}

export async function cmsRestoreMedia(idToken: string, asset: BinnedMediaAsset) {
  const result = await invalidateAfterWrite(postFunction<{
    success: true;
    changed: boolean;
    asset: { id: string; lifecycle: "active"; version: number; etag: string };
  }>("cmsRestoreMedia", idToken, { assetId: asset.id }, { "If-Match": asset.etag }));
  markMediaTabCountsStale();
  return result;
}

/** The Images tab's query. Its Type filter offers only the Images tab's kinds. */
export type MediaListQuery = Required<
  Omit<ListMediaRequest, "assetIds" | "pageSize" | "paging" | "cursor" | "kinds">
> & { kinds: MediaKind[] } & Pick<ListMediaRequest, "assetIds" | "pageSize" | "paging" | "cursor">;

export interface SelfProfilePhotoListMediaRequest extends ListMediaRequest {
  /** Narrow self-service view: only this caller's staff profile images. */
  profilePhotoScope: "self";
}

interface ListMediaResponseBase {
  success: true;
  records: MediaAssetSummary[];
  page: number;
  /** Present only when the request asked with `counts: true`; never cached with the list. */
  counts?: MediaTabCounts;
  /** Favorite states for `records`, only when asked with `favorites: true`; never cached with the list. */
  favoriteStates?: { ref: { backend: "r2"; id: string }; favorite: boolean }[];
}

export type ListMediaResponse = ListMediaResponseBase & (
  | {
      paging?: undefined;
      total: number;
      allCount: number;
      pageCount: number;
      categoryCounts: Record<string, number>;
      kindCounts: Partial<Record<MediaKind, number>>;
      nextCursor?: undefined;
    }
  | {
      paging: "cursor";
      nextCursor: string | null;
      /** Exact only after the indexed scan reaches its terminal page. */
      total: number | null;
      /** Exact only for a terminal, unfiltered indexed scan. */
      allCount: number | null;
      pageCount: null;
      categoryCounts: null;
      kindCounts: null;
    }
);

export interface MediaCorpusRequest {
  cursor?: string;
  limit?: number;
}

export interface MediaCorpusResponse {
  success: true;
  records: MediaAssetSummary[];
  nextCursor: string | null;
}

export function cmsListMediaCorpus(
  idToken: string,
  body: MediaCorpusRequest,
  signal?: AbortSignal,
): Promise<MediaCorpusResponse> {
  return postFunction("cmsListMedia", idToken, { ...body, corpus: true }, {}, { signal });
}

export interface UpdateMediaMetadata {
  originalName?: string;
  name?: string;
  description?: string | null;
  altText?: string | null;
  altTextGenerated?: true;
  metadataUpdateRequested?: boolean;
  license?: string | null;
  credit?: string | null;
  tags?: string[];
  categories?: string[];
}

export interface UpdateMediaMetadataResponse {
  success: true;
  changed: boolean;
  asset: MediaAssetSummary;
}

export interface DeleteMediaResponse {
  success: true;
  changed: true;
  deleted: true;
  asset: {
    id: string;
    lifecycle: "tombstoned";
    version: number;
    etag: string;
  };
}

export interface UploadMediaMetadata {
  metadataUpdateRequested?: boolean;
  name?: string;
  category: string;
  categories?: string[];
  description?: string;
  altText?: string;
  license?: string;
  credit?: string;
  tags?: string[];
  imageProcessing?: "webp";
}

export interface UploadMediaResponse {
  success: true;
  asset: MediaAssetSummary;
  /** Set by the Admin when a duplicate upload resolved to the existing file. */
  reusedDuplicate?: boolean;
}

export function cmsListMedia(
  idToken: string,
  body: ListMediaRequest | SelfProfilePhotoListMediaRequest,
  signal?: AbortSignal,
  options: { counts?: boolean; favorites?: boolean } = {},
): Promise<ListMediaResponse> {
  // The tab-count and favorites flags ride on the request body only; they never enter MediaListQuery.
  const indexedBrowse = body.assetIds === undefined && !("profilePhotoScope" in body);
  const request = {
    ...body,
    ...(indexedBrowse ? { paging: "cursor" as const } : {}),
    ...(options.counts ? { counts: true } : {}),
    ...(options.favorites ? { favorites: true } : {}),
  };
  return postFunction<ListMediaResponse>("cmsListMedia", idToken, request, {}, { signal });
}

export function cmsListMediaCategories(
  idToken: string,
): Promise<ListMediaCategoriesResponse> {
  return postFunction<ListMediaCategoriesResponse>(
    "cmsListMediaCategories",
    idToken,
    {},
  );
}

// Every successful media write clears cached media lists, whichever screen made it.
async function invalidateAfterWrite<T>(request: Promise<T>): Promise<T> {
  const result = await request;
  invalidateMediaLists();
  return result;
}

export function cmsMutateMediaCategory(
  idToken: string,
  request: MutateMediaCategoryRequest,
  etag?: string,
): Promise<MutateMediaCategoryResponse> {
  return invalidateAfterWrite(postFunction<MutateMediaCategoryResponse>(
    "cmsMutateMediaCategory",
    idToken,
    request,
    etag ? { "If-Match": etag } : undefined,
  ));
}

export function cmsUpdateMediaMetadata(
  idToken: string,
  asset: MediaAssetSummary,
  metadata: UpdateMediaMetadata,
): Promise<UpdateMediaMetadataResponse> {
  return invalidateAfterWrite(postFunction<UpdateMediaMetadataResponse>(
    "cmsUpdateMediaMetadata",
    idToken,
    { assetId: asset.id, metadata },
    { "If-Match": asset.etag },
  ));
}

export interface MediaDownloadResponse {
  success: true;
  url: string;
  fileName: string;
  expiresAt: string;
}

/** A short signed read that the browser saves as an attachment with the original filename. */
export function cmsCreateMediaDownload(
  idToken: string,
  assetId: string,
  variant?: "original" | "web",
): Promise<MediaDownloadResponse> {
  return postFunction<MediaDownloadResponse>("cmsCreateMediaDownload", idToken, {
    assetId, ...(variant ? { variant } : {}),
  });
}

/** Remove an unused asset from the active media library without deleting its binary. */
export async function cmsDeleteMedia(
  idToken: string,
  asset: MediaAssetSummary,
): Promise<DeleteMediaResponse> {
  const result = await invalidateAfterWrite(postFunction<DeleteMediaResponse>(
    "cmsUpdateMediaMetadata",
    idToken,
    { assetId: asset.id, action: "delete" },
    { "If-Match": asset.etag },
  ));
  markMediaTabCountsStale();
  return result;
}

export function cmsUploadMedia(
  idToken: string,
  file: File,
  metadata: UploadMediaMetadata,
  signal?: AbortSignal,
): Promise<UploadMediaResponse> {
  return postMediaFile("cmsUploadMedia", idToken, file, { ...metadata }, {}, signal);
}

export interface ReplaceMediaResponse {
  success: true;
  changed: boolean;
  asset: MediaAssetSummary;
}

export function cmsReplaceMediaBinary(
  idToken: string,
  asset: MediaAssetSummary,
  file: File,
  optimize: boolean,
  signal?: AbortSignal,
): Promise<ReplaceMediaResponse> {
  return postMediaFile("cmsReplaceMediaBinary", idToken, file, {
    assetId: asset.id,
    ...(optimize && asset.category !== "staff-profile" &&
      (file.type === "image/jpeg" || file.type === "image/png")
      ? { imageProcessing: "webp" } : {}),
  }, { "If-Match": asset.etag }, signal);
}

async function postMediaFile<T>(
  endpoint: "cmsUploadMedia" | "cmsReplaceMediaBinary",
  idToken: string,
  file: File,
  metadata: Record<string, string | string[] | boolean | undefined>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  if (!baseUrl) {
    throw new Error("Functions base URL is not configured");
  }
  const body = new FormData();
  body.append("file", file, file.name);
  for (const [field, value] of Object.entries(metadata)) {
    if (value === undefined || value === "") continue;
    body.append(field, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const timeout = globalThis.setTimeout(cancel, 130_000);
  // The upload posts multipart directly rather than through postFunction, so it needs its own
  // transport measure -- and it is the slowest CMS call there is, which makes it the one that
  // least deserves to be missing from the receipt (#1064). A cancel or a timeout closes the
  // measure as `aborted` rather than leaving it open.
  const transport = adminPerf.begin("cms-request", {
    operation: operationCategoryForEndpoint(endpoint),
  });
  const reportStartedAt = reportRequestNow();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        ...emulatorEdgeHeaders,
        ...headers,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    recordReportRequest(
      endpoint,
      0,
      reportRequestNow() - reportStartedAt,
    );
    transport.end({
      outcome: controller.signal.aborted ? "aborted" : "error",
      statusClass: "none",
    });
    if (controller.signal.aborted) {
      throw new Error(
        signal?.aborted
          ? "The upload was canceled."
          : "The upload took too long. Try again.",
      );
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }

  recordReportRequest(
    endpoint,
    response.status,
    reportRequestNow() - reportStartedAt,
  );

  transport.end({
    outcome: response.ok
      ? "ok"
      : response.status === 401 || response.status === 403
        ? "denied"
        : "error",
    statusClass: statusClassFor(response.status),
    requestId: response.headers?.get?.("x-njpbs-request-id") ?? undefined,
  });
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    let data: Record<string, unknown> = {};
    try {
      const parsed = (await response.json()) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        data = parsed as Record<string, unknown>;
      }
      if (typeof data.error === "string") message = data.error;
    } catch {
      message = response.statusText || message;
    }
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
      data = { ...data, retryAfterSeconds: retryAfter };
    }
    throw responseError(response.status, message, data, idToken);
  }
  const uploaded = (await response.json()) as T;
  invalidateMediaLists();
  // The list reload that follows an upload asks for fresh tab counts.
  if (endpoint === "cmsUploadMedia") markMediaTabCountsStale();
  return uploaded;
}

// The readable half of an activity row (#1038). The server joins it at read time
// from the current directory, so a renamed account reads correctly without any
// stored audit row being rewritten, and it omits account fields the signed-in
// capability may not see. It is optional because a browser can be talking to a
// server that predates the join; the surface falls back to the stored fields.
export type ActivityActorStatus =
  "active" | "deactivated" | "deleted" | "system" | "unknown";

export type ActivityTargetStatus =
  "found" | "deactivated" | "deleted" | "none" | "unknown";

export interface ResolvedActivity {
  action: { code: string | null; label: string; known: boolean };
  actor: {
    label: string;
    status: ActivityActorStatus;
    email: string | null;
    uid: string | null;
  };
  target: {
    label: string;
    type: string;
    status: ActivityTargetStatus;
    id: string | null;
  };
  source: { label: string; detail: string | null };
}

export interface AuditEntry {
  id: string;
  actorUid: string | null;
  actorEmail: string | null;
  action: string;
  target: unknown;
  before: unknown;
  after: unknown;
  source: unknown;
  at: string | null;
  /** Present on a content API change: the staff request and the reviewed plan digest. */
  automation?: { requestReference: string; planDigest: string };
  resolved?: ResolvedActivity;
}

export interface ListAuditResponse {
  success: true;
  entries: AuditEntry[];
  nextCursor: string | null;
}

// Read one bounded newest-first page of the append-only administrative activity stream. The
// cursor is opaque to the browser and names the exact server sort position for the next page.
export function cmsListAudit(
  idToken: string,
  cursor?: string,
): Promise<ListAuditResponse> {
  return postFunction<ListAuditResponse>("cmsListAudit", idToken, {
    ...(cursor ? { cursor } : {}),
  });
}

export interface BulkArchiveItem {
  id: string;
  // Required rather than optional: bulk archive never offers a force path. A row without a
  // trustworthy version must be reopened and saved before it can join the operation.
  baseVersion: number;
}

export type BulkArchiveOutcomeStatus =
  "archived" | "already_archived" | "conflict" | "missing" | "failed";

export interface BulkArchiveOutcome {
  id: string;
  status: BulkArchiveOutcomeStatus;
  message?: string;
  version?: number;
  publication?: { status: "queued" | "failed"; queueId: string | null;
    homeFullBuildQueueId?: string | null;
    affectedHomeSections?: HomeAffectedSection[]; warnings?: string[] };
}

export interface BulkArchiveResponse {
  success: true;
  outcomes: BulkArchiveOutcome[];
  counts: Record<BulkArchiveOutcomeStatus, number>;
}

// Archive one current library page through independent version-guarded transactions. The server
// returns an outcome for every requested id, so a conflict stays visible without rolling back
// unrelated records that were still current.
export function cmsBulkArchiveContent(
  idToken: string,
  items: BulkArchiveItem[],
): Promise<BulkArchiveResponse> {
  return postFunction<BulkArchiveResponse>("cmsBulkArchiveContent", idToken, {
    items,
  });
}

export interface AssignContentRequest {
  id: string;
  baseVersion: number;
  assignee: string | null;
}

export interface AssignContentResponse {
  success: true;
  id: string;
  changed: boolean;
  document: Record<string, unknown>;
}

// Assignment has its own version-guarded mutation boundary. It is deliberately separate from a
// content save so the workflow owner cannot be forged through the editable document payload or
// confused with updatedBy, which continues to mean the actor behind the most recent mutation.
export function cmsAssignContent(
  idToken: string,
  body: AssignContentRequest,
): Promise<AssignContentResponse> {
  return postFunction<AssignContentResponse>("cmsAssignContent", idToken, body);
}

export type PreviewBuildStatus =
  "pending" | "building" | "ready" | "failed" | "expired";

export interface PreviewRequestResponse {
  success: true;
  queueId: string;
  pageId: string;
  sourceVersion: number;
  dispatched: boolean;
  status: "pending" | "building";
  // Legacy deployments may omit these until the matched Functions release lands.
  rendererSha?: string;
  collection?: SaveCollection;
  pagePath?: string;
  previewUrl?: null;
}

export interface PreviewStatusResponse {
  success: true;
  queueId: string;
  status: PreviewBuildStatus;
  contextRefreshing?: boolean;
  failureReason?: "preview_context_refreshing";
  pageId: string;
  sourceVersion: number;
  previewUrl: string | null;
  error: string | null;
  requestedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  collection?: SaveCollection;
  pagePath?: string;
  rendererSha?: string;
  persistent?: boolean;
}

export type SavedPreviewRequestResponse = PreviewRequestResponse | (PreviewStatusResponse & {
  reused: true;
  retryAfterMs: number;
});

export function cmsRequestSavedPreview(
  idToken: string,
  collection: SaveCollection,
  pageId: string,
  sourceVersion: number,
): Promise<SavedPreviewRequestResponse> {
  const recordUsageAction = usageActionCollector();
  recordUsageAction("preview.request", collection === "cmsPosts" ? "record" : "page", pageId);
  return postFunction<SavedPreviewRequestResponse>("cmsPreview", idToken, {
    collection, pageId, persistent: false, sourceVersion,
  });
}

// Capture and build one exact saved page revision. The function copies the
// renderer-owned fields into an immutable queue row before dispatching, so a
// save made while the build runs cannot change the review artifact.
export function cmsRequestPagePreview(
  idToken: string,
  pageId: string,
): Promise<PreviewRequestResponse> {
  return postFunction<PreviewRequestResponse>("cmsPreview", idToken, {
    pageId,
  });
}

// Poll through the authenticated function boundary. The response deliberately
// omits the captured document and exposes the deployment URL only after the
// workflow has recorded a terminal ready result.
export interface PreviewStatusWaitOptions {
  signal: AbortSignal;
  waitMs: number;
  observedStatus: "pending" | "building";
}

export function cmsLoadPagePreviewStatus(
  idToken: string,
  queueId: string,
  options?: PreviewStatusWaitOptions,
): Promise<PreviewStatusResponse> {
  return postFunction<PreviewStatusResponse>("cmsPreviewStatus", idToken, {
    queueId,
    ...(options ? { waitMs: options.waitMs, observedStatus: options.observedStatus } : {}),
  }, {}, { signal: options?.signal });
}

export interface CmsSettingsPublishedSnapshot<TValues = unknown> {
  schemaVersion: number;
  values: TValues;
  sourceVersion: number;
  publishedAt: string;
}

export interface CmsSettingsDocument<TValues = unknown> {
  schemaVersion: number;
  values: TValues;
  version: number;
  published?: CmsSettingsPublishedSnapshot<TValues>;
}

export interface SettingsPublicationReceipt {
  queueId: string;
  originalOperationId: string;
  transport: "public-context-no-build-v1" | "release-pair-publication-v2";
  sourceVersion: number;
  rendererSha: string;
  contextRevision: number;
  contextDigest: string;
  status: "pending" | "success" | "failed";
  missingConsumers: string[];
  warning?: string;
}

export type GetSettingsResponse<TValues = unknown> =
  | { success: true; found: false; id: string }
  | {
      success: true;
      found: true;
      id: string;
      settings: CmsSettingsDocument<TValues>;
      publication?: SettingsPublicationReceipt;
    };

export type SaveSettingsRequest<TValues = unknown> =
  | { id: string; values: TValues; createOnly: true; baseVersion?: never }
  | { id: string; values: TValues; baseVersion: number; createOnly?: never };

export interface PublishSettingsRequest {
  id: string;
  baseVersion: number;
}

export interface MutateSettingsResponse<TValues = unknown> {
  success: true;
  id: string;
  changed: boolean;
  settings: CmsSettingsDocument<TValues>;
  publication?: SettingsPublicationReceipt;
}

export async function cmsGetCoverageLabels(idToken: string, signal?: AbortSignal): Promise<CoverageLabelsBuildData | undefined> {
  const response = await postFunction<{ success: true; id: string; found: boolean; published?: unknown }>(
    "cmsGetCoverageLabels", idToken, { id: COVERAGE_LABELS_SETTINGS_ID }, {}, { signal });
  if (response.success !== true || response.id !== COVERAGE_LABELS_SETTINGS_ID || typeof response.found !== "boolean") throw new Error("Coverage labels could not be read.");
  if (!response.found) return undefined;
  const sourceVersion = response.published && typeof response.published === "object" && "sourceVersion" in response.published
    ? response.published.sourceVersion : undefined;
  const projected = projectCoverageLabels({ version: sourceVersion, published: response.published });
  if (!projected) throw new Error("Published coverage labels are invalid.");
  return projected.data;
}

export function cmsGetSettings<TValues = unknown>(
  idToken: string,
  body: { id: string },
): Promise<GetSettingsResponse<TValues>> {
  return postFunction<GetSettingsResponse<TValues>>(
    "cmsGetSettings",
    idToken,
    body,
  );
}

export function cmsSaveSettings<TValues = unknown>(
  idToken: string,
  body: SaveSettingsRequest<TValues>,
): Promise<MutateSettingsResponse<TValues>> {
  return postFunction<MutateSettingsResponse<TValues>>(
    "cmsSaveSettings",
    idToken,
    body,
  );
}

export function cmsPublishSettings<TValues = unknown>(
  idToken: string,
  body: PublishSettingsRequest,
): Promise<MutateSettingsResponse<TValues>> {
  return postFunction<MutateSettingsResponse<TValues>>(
    "cmsPublishSettings",
    idToken,
    [STORY_CTAS_SETTINGS_ID, COVERAGE_LABELS_SETTINGS_ID, PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID, PUBLIC_SITE_CHROME_SETTINGS_ID, SITE_NAVIGATION_SETTINGS_ID, NJ_DECIDES_SETTINGS_ID].some(id => id === body.id)
      ? { ...body, publicationTransport: "public-context-no-build-v1" }
      : body,
  );
}

// -- author profiles (#1044) -------------------------------------------------
//
// Typed wrappers for the author-profile callables. The profile UI lands in
// the next lane; these exist now so the boundary has one client contract rather
// than a screen inventing its own request shapes later.
//
// Note what is NOT in these types: no email, no uid on the self view, no CMS
// role or grants anywhere. The server builds both views field by field, and
// mirroring that here keeps a component from reaching for a field that will
// never arrive.

export type AuthorSocialPlatform = "x" | "bluesky" | "linkedin";

export interface AuthorSocialLink {
  handle: string;
  url: string;
}

export type AuthorSocialLinks = Partial<
  Record<AuthorSocialPlatform, AuthorSocialLink>
>;

export type AuthorProfileVisibility = "private" | "published";

export type AuthorPhotoRightsBasis =
  "own-photo" | "station-photo" | "licensed-photo";

/**
 * A stored profile photograph as the server returns it. The reference plus what
 * is needed to draw the 1:1 crop, and the rights basis the form shows back. The
 * attesting uid is deliberately absent: the audit log records who attested, and
 * a byline editor has no use for another account's identifier.
 */
export interface AuthorPhotoThumbnail {
  url: string;
  width: number;
  height: number;
}

export interface AuthorPhoto {
  assetId: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  focalX: number;
  focalY: number;
  credit: string | null;
  rightsBasis: AuthorPhotoRightsBasis;
  attestedAt: string;
  thumbnails?: readonly AuthorPhotoThumbnail[];
}

/**
 * What a save may say about a photograph. Everything else -- the address, the
 * dimensions, the size -- is read from the media library by the server, so a
 * client cannot state its way past the minimum dimensions.
 */
export interface AuthorPhotoRequest {
  assetId: string;
  focalX: number;
  focalY: number;
  credit?: string | null;
  rightsBasis: AuthorPhotoRightsBasis;
}

/** The signed-in author's own working profile. */
export interface SelfAuthorProfile {
  authorId: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  photo: AuthorPhoto | null;
  links: AuthorSocialLinks;
  pinnedPostId: string | null;
  hiddenPostIds: string[];
  visibility: AuthorProfileVisibility;
  slug: string | null;
  previousSlugs: string[];
  publishedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: "owner" | "admin" | "deactivation" | "archive" | null;
  version: number;
  updatedAt: string;
  staffStatus: "active" | "inactive" | null;
  publicPath: string | null;
}

/** The admin view adds private account linkage and archive lifecycle state. */
export interface AdminAuthorProfile extends SelfAuthorProfile {
  uid: string | null;
  lifecycle: "active" | "archived";
  archivedAt: string | null;
}

export interface LinkableAuthorUser {
  uid: string;
  displayName: string;
  email: string | null;
}

export interface AuthorProfileResponse {
  apiVersion: number;
  success: true;
  created?: boolean;
  profile: SelfAuthorProfile;
}

export interface AdminAuthorProfileResponse {
  apiVersion: number;
  success: true;
  profile: AdminAuthorProfile;
}

export interface DeletedAuthorProfileResponse {
  apiVersion: number;
  success: true;
  deletedAuthorId: string;
}

export interface AuthorProfileListResponse {
  apiVersion: number;
  success: true;
  profiles: AdminAuthorProfile[];
  linkableUsers: LinkableAuthorUser[];
  nextCursor: string | null;
}

export function cmsCreateAuthorProfile(
  idToken: string,
  body: { displayName: string },
): Promise<AdminAuthorProfileResponse> {
  return postFunction<AdminAuthorProfileResponse>(
    "cmsAdminUpdateAuthorProfile",
    idToken,
    { action: "create", ...body },
  );
}

/** The editable half of a profile. Every field beyond the name is optional. */
export interface AuthorProfileDraft {
  displayName: string;
  jobTitle?: string | null;
  bio?: string | null;
  /**
   * Omitting this key preserves the stored photograph; sending null clears it.
   * A form that does not render the photo section therefore cannot take
   * someone's photograph down by leaving the field out.
   */
  photo?: AuthorPhotoRequest | null;
  links?: AuthorSocialLinks;
  /**
   * The author-page controls. Both follow the photograph's rule: omitting the
   * key preserves what is stored, so a form that does not render these controls
   * cannot silently discard someone's pin or their hidden list.
   */
  pinnedPostId?: string | null;
  hiddenPostIds?: string[];
  /**
   * The version the form was opened against. Required, not advisory: the server
   * rejects a mutation that does not name one, because without it a slow edit
   * silently overwrites a change made in another tab instead of returning the
   * 409 the UI needs to offer the author a choice.
   */
  expectedVersion: number;
}

/**
 * Read the signed-in author's own profile, creating the private record on first
 * use. Safe to call on every visit -- it is verify-or-create, not create. A
 * deactivated account is refused with 403 `account_inactive` rather than handed
 * a fresh empty profile it could never publish.
 */
export function cmsGetAuthorProfile(
  idToken: string,
): Promise<AuthorProfileResponse> {
  return postFunction<AuthorProfileResponse>(
    "cmsGetAuthorProfile",
    idToken,
    {},
  );
}

/** Save the signed-in author's own working profile. */
export function cmsUpdateAuthorProfile(
  idToken: string,
  body: AuthorProfileDraft,
): Promise<AuthorProfileResponse> {
  return postFunction<AuthorProfileResponse>(
    "cmsUpdateAuthorProfile",
    idToken,
    body,
  );
}

/**
 * Owner Publish and Unpublish. Validation runs server-side, so a rejection here
 * is the real gate rather than a duplicate of a client-side check.
 */
export function cmsSetAuthorProfileVisibility(
  idToken: string,
  body: { visibility: AuthorProfileVisibility; expectedVersion: number },
): Promise<AuthorProfileResponse> {
  return postFunction<AuthorProfileResponse>(
    "cmsSetAuthorProfileVisibility",
    idToken,
    body,
  );
}

/** A safe published Post summary for one author-page picker. */
export interface AuthorPagePostSummary {
  id: string;
  headline: string;
  publishDate: string;
  noindex?: true;
}

export interface AuthorPagePostsResponse {
  apiVersion: number;
  success: true;
  posts: AuthorPagePostSummary[];
  nextCursor: string | null;
}

/**
 * Published Posts credited to one stable byline identity (#1097). The server
 * confines ordinary staff to their own authorId; profiles.manage may request any.
 */
export function cmsListAuthorPagePosts(
  idToken: string,
  body: {
    authorId?: string;
    limit?: number;
    startAfter?: string | null;
  } = {},
): Promise<AuthorPagePostsResponse> {
  return postFunction<AuthorPagePostsResponse>(
    "cmsListAuthorPagePosts",
    idToken,
    body,
  );
}

/** One row in the byline picker: a person an editor may credit on a story. */
export interface BylineAuthorOption {
  authorId: string;
  displayName: string;
  jobTitle: string | null;
  /** Optional while an older Functions reader is still deployed. No profile text. */
  profileReadiness?: {
    hasPhoto: boolean;
    hasJobTitle: boolean;
    hasBio: boolean;
    published: boolean;
  };
}

export interface BylineAuthorsResponse {
  apiVersion: number;
  success: true;
  authors: BylineAuthorOption[];
  nextCursor: string | null;
  /**
   * The signed-in account's own author identity, or null when it has none or is
   * deactivated. A new post defaults its byline to this and to nothing else
   * (#1040) -- never to a name guessed from the account.
   */
  selfAuthorId: string | null;
}

/**
 * The byline picker's feed (#1040). Open to any approved active CMS account,
 * unlike the admin roster below: crediting a colleague is ordinary editorial
 * work. Returns names and stable opaque ids only, never uids or emails.
 */
export function cmsListBylineAuthors(
  idToken: string,
  body: { limit?: number; startAfter?: string | null } = {},
): Promise<BylineAuthorsResponse> {
  return postFunction<BylineAuthorsResponse>(
    "cmsListBylineAuthors",
    idToken,
    body,
  );
}

/** Admin listing of every author profile. Requires the profiles.manage capability. */
export function cmsListAuthorProfiles(
  idToken: string,
  body: { limit?: number; startAfter?: string | null; authorId?: string } = {},
): Promise<AuthorProfileListResponse> {
  return postFunction<AuthorProfileListResponse>(
    "cmsListAuthorProfiles",
    idToken,
    body,
  );
}

/**
 * Admin edit, withdrawal, or slug rename of any profile. None of these change
 * the author's CMS role or grants: withdrawing a public profile is a publishing
 * decision, not an access one.
 */
export type AdminAuthorProfileRequest =
  | { action: "create"; displayName: string }
  | ({ authorId: string; action: "edit"; expectedVersion: number } & Omit<
      AuthorProfileDraft,
      "expectedVersion"
    >)
  | { authorId: string; action: "withdraw"; expectedVersion: number }
  | { authorId: string; action: "publish"; expectedVersion: number }
  | { authorId: string; action: "link"; uid: string; expectedVersion: number }
  | { authorId: string; action: "archive"; expectedVersion: number }
  | { authorId: string; action: "delete"; expectedVersion: number }
  | {
      authorId: string;
      action: "rename";
      slug: string;
      expectedVersion: number;
    };

export function cmsAdminUpdateAuthorProfile(
  idToken: string,
  body: Exclude<AdminAuthorProfileRequest, { action: "delete" }>,
): Promise<AdminAuthorProfileResponse>;
export function cmsAdminUpdateAuthorProfile(
  idToken: string,
  body: Extract<AdminAuthorProfileRequest, { action: "delete" }>,
): Promise<DeletedAuthorProfileResponse>;
export function cmsAdminUpdateAuthorProfile(
  idToken: string,
  body: AdminAuthorProfileRequest,
): Promise<AdminAuthorProfileResponse | DeletedAuthorProfileResponse> {
  return postFunction<
    AdminAuthorProfileResponse | DeletedAuthorProfileResponse
  >("cmsAdminUpdateAuthorProfile", idToken, body);
}
