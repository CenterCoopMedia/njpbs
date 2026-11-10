import { isPublicPageId } from "../../../packages/content-core/src/public-pages";
import { previewPageUrl } from "./preview-url";
import { privatePreviewOrigin } from "./dev-origins";

const MIN_STATUS_REQUEST_INTERVAL_MS = 1_000;

export interface PreviewTarget {
  readonly collection: "cmsPages" | "cmsPosts";
  readonly documentId: string;
  readonly sourceVersion: number;
}

export interface PreviewJob extends PreviewTarget {
  readonly queueId: string;
  readonly rendererSha: string;
  readonly status: "pending" | "building" | "ready" | "failed" | "expired";
  readonly previewUrl: string | null;
  readonly pagePath: string;
  readonly contextRefreshing?: boolean;
  readonly failureReason?: "preview_context_refreshing";
}

export type PreviewOutcome =
  | { readonly status: "ready"; readonly target: PreviewTarget; readonly queueId: string; readonly url: string }
  | { readonly status: "cancelled" };

export type PreviewProgress = "requesting" | "waiting" | "pending" | "building" | "refreshing";

export interface PreviewOperationDependencies {
  // The existing save owner must return an acknowledged snapshot, not mutable props.
  ensureSaved(signal: AbortSignal): Promise<PreviewTarget>;
  // Accept this exact version. A lower-version busy job is an existing blocker only.
  request(target: PreviewTarget, signal: AbortSignal): Promise<PreviewJob>;
  // Read the addressed job, not the latest/ready head. Apply the server timeout policy.
  read(queueId: string, signal: AbortSignal, observedStatus: "pending" | "building"): Promise<PreviewJob>;
  onProgress?(state: PreviewProgress): void;
}

export class PreviewOperationError extends Error {
  readonly code: "protocol" | "unavailable" | "refreshing";
  constructor(code: "protocol" | "unavailable" | "refreshing", message: string) {
    super(message);
    this.name = "PreviewOperationError";
    this.code = code;
  }
}

function requireProtocol(condition: boolean, message: string): asserts condition {
  if (!condition) throw new PreviewOperationError("protocol", message);
}

function snapshotTarget(value: PreviewTarget): PreviewTarget {
  requireProtocol(!!value && (value.collection === "cmsPages" || value.collection === "cmsPosts") &&
    typeof value.documentId === "string" &&
    (value.collection === "cmsPages" ? isPublicPageId(value.documentId) : /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.documentId)) &&
    Number.isSafeInteger(value.sourceVersion) && value.sourceVersion > 0,
  "Preview requires an acknowledged content identity and version");
  return Object.freeze({ collection: value.collection, documentId: value.documentId, sourceVersion: value.sourceVersion });
}

function snapshotJob(value: PreviewJob): PreviewJob {
  const target = snapshotTarget(value);
  requireProtocol(typeof value.queueId === "string" && /^[A-Za-z0-9]{20}$/.test(value.queueId) &&
    typeof value.rendererSha === "string" && /^[a-f0-9]{40}$/i.test(value.rendererSha) &&
    ["pending", "building", "ready", "failed", "expired"].includes(value.status) &&
    typeof value.pagePath === "string" && value.pagePath.startsWith("/"),
  "Preview returned an invalid job receipt");
  return Object.freeze({ ...target, queueId: value.queueId, rendererSha: value.rendererSha,
    status: value.status, previewUrl: value.previewUrl, pagePath: value.pagePath,
    contextRefreshing: value.contextRefreshing === true,
    failureReason: value.failureReason === "preview_context_refreshing" ? value.failureReason : undefined });
}

function busy(job: PreviewJob): boolean {
  return job.status === "pending" || job.status === "building";
}

function sameDocument(left: PreviewTarget, right: PreviewTarget): boolean {
  return left.collection === right.collection && left.documentId === right.documentId;
}

// Settle cancellation even when a transport ignores AbortSignal. A save already
// accepted by the server is not rolled back; its owner retains recovery duties.
function interruptible<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    void Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return start();
    }).then(value => {
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else resolve(value);
    }, reason => { cleanup(); reject(reason); });
  });
}

function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One instance belongs to one mounted editor. Not a second queue or save owner. */
export function createSavedPreviewOperation(dependencies: PreviewOperationDependencies) {
  let disposed = false;
  let active: { controller: AbortController; promise: Promise<PreviewOutcome> } | null = null;

  async function execute(signal: AbortSignal): Promise<PreviewOutcome> {
    try {
      const target = snapshotTarget(await interruptible(signal, () => dependencies.ensureSaved(signal)));
      const completedBlockers = new Set<string>();
      for (;;) {
        dependencies.onProgress?.("requesting");
        let current = snapshotJob(await interruptible(signal, () => dependencies.request(target, signal)));
        requireProtocol(sameDocument(current, target), "Preview request changed the content identity");
        const older = current.sourceVersion < target.sourceVersion;
        requireProtocol(current.sourceVersion === target.sourceVersion || (older && busy(current)),
          "Preview request substituted a different content version");
        requireProtocol(!completedBlockers.has(current.queueId), "Preview reused an already completed blocking job");
        const accepted = current;
        while (busy(current)) {
          let progress: PreviewProgress = current.status as "pending" | "building";
          if (older) progress = "waiting";
          else if (current.contextRefreshing) progress = "refreshing";
          dependencies.onProgress?.(progress);
          const observedStatus = current.status as "pending" | "building";
          const startedAt = performance.now();
          current = snapshotJob(await interruptible(signal, () => dependencies.read(accepted.queueId, signal, observedStatus)));
          requireProtocol(sameDocument(current, accepted) && current.queueId === accepted.queueId &&
            current.sourceVersion === accepted.sourceVersion && current.rendererSha === accepted.rendererSha &&
            current.pagePath === accepted.pagePath,
          "Preview status changed the accepted job identity");
          // Current servers hold unchanged reads. Keep a client floor for an older
          // server that returns the same state immediately, without adding a gap
          // after a real server wait or a state change.
          const remainingDelay = MIN_STATUS_REQUEST_INTERVAL_MS - (performance.now() - startedAt);
          if (busy(current) && current.status === observedStatus && remainingDelay > 0) {
            await waitForPoll(signal, remainingDelay);
          }
        }
        if (older) {
          // Finish waiting for existing work, then automatically request our target.
          // Never expose its ready URL, even when that older work succeeded.
          completedBlockers.add(accepted.queueId);
          continue;
        }
        if (current.status !== "ready") {
          if (current.status === "failed" && current.failureReason === "preview_context_refreshing") {
            throw new PreviewOperationError("refreshing", "Previews are refreshing after a recent publish. Try again in a minute.");
          }
          throw new PreviewOperationError("unavailable", `The addressed preview is ${current.status}`);
        }
        requireProtocol(typeof current.previewUrl === "string" && typeof current.pagePath === "string" &&
          current.pagePath.startsWith("/") && current.pagePath.length > 0,
        "Ready preview is missing its private route");
        let url: string;
        try {
          // Interactive previews use immutable expiring artifacts, not replaceable saved heads.
          const base = new URL(current.previewUrl!);
          requireProtocol(base.origin === privatePreviewOrigin && base.pathname === `/p/${current.queueId}/`,
            "Ready preview is not an immutable private export");
          url = previewPageUrl(current.previewUrl!, current.pagePath, current.queueId);
        } catch {
          throw new PreviewOperationError("protocol", "Ready preview returned an invalid private URL");
        }
        return { status: "ready", target, queueId: current.queueId, url };
      }
    } catch (reason) {
      if (signal.aborted) return { status: "cancelled" };
      throw reason;
    }
  }

  return {
    run(): Promise<PreviewOutcome> {
      if (disposed) return Promise.resolve({ status: "cancelled" });
      if (active) return active.promise;
      const controller = new AbortController();
      // Publish single-flight ownership before invoking any dependency callback.
      const promise = Promise.resolve().then(() => execute(controller.signal));
      active = { controller, promise };
      const clear = () => { if (active?.promise === promise) active = null; };
      void promise.then(clear, clear);
      return promise;
    },
    dispose(): void {
      disposed = true;
      active?.controller.abort();
    },
  };
}
