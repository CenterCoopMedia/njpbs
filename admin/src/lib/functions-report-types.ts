import type { BrowserDiagnostics } from "./report-diagnostics";

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
  stage?: "received" | "investigating" | "fixing" | "review" | "awaiting_live" | "live" | "closed";
  phase: "received" | "acknowledged" | "queued" | "in_progress" | "ready_for_review" | "changes_requested" | "checks_failed" | "merged" | "live" | "closed" | "resolved" | "dismissed" | "blocked" | "needs_attention" | "reopened";
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
    live: boolean;
    reviewState: "approved" | "changes_requested" | "pending" | "none";
    checksState: "success" | "failure" | "pending" | "none";
  }>;
  deployment: "verified" | "unverified";
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
  resolutionNote?: string;
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

export interface BugReportAuditEntry {
  id: string;
  action: string;
  actorUid: string | null;
  actorEmail: string | null;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
