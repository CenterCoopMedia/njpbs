import { EditorActionSlot } from "./EditorActions";
import { useEffect, useId, useRef, useState } from "react";
import type { PreviewStatusResponse, PreviewStatusWaitOptions, SavedPreviewRequestResponse } from "../lib/functions";
import { createSavedPreviewOperation, PreviewOperationError, type PreviewJob, type PreviewTarget } from "../lib/saved-preview-operation";
import { createPreviewProgressDocument, previewRendererUpdatingMessage, previewContextRefreshingMessage } from "./SavedPreviewProgress";
import { WorkspaceFeedback } from "./WorkspaceActions";
import { AsyncActionButton, InlineMessage } from "./ui/Primitives";

export interface SavedPreviewProps {
  collection: PreviewTarget["collection"];
  documentId: string;
  enabled: boolean;
  disabledReason?: string;
  preparePreview(signal: AbortSignal): Promise<PreviewTarget>;
  prepareSession?(): Promise<void>;
  requestPreview(target: PreviewTarget): Promise<SavedPreviewRequestResponse>;
  loadPreviewStatus(queueId: string, options?: PreviewStatusWaitOptions): Promise<PreviewStatusResponse>;
}

function job(receipt: SavedPreviewRequestResponse | PreviewStatusResponse): PreviewJob {
  // Do not fill missing deployment metadata with editor props: the coordinator
  // validates the server's complete addressed receipt before opening anything.
  return {
    collection: receipt.collection as PreviewTarget["collection"],
    documentId: receipt.pageId, sourceVersion: receipt.sourceVersion,
    queueId: receipt.queueId, rendererSha: receipt.rendererSha as string,
    status: receipt.status, previewUrl: receipt.previewUrl ?? null,
    pagePath: receipt.pagePath as string,
    contextRefreshing: "contextRefreshing" in receipt && receipt.contextRefreshing === true,
    failureReason: "failureReason" in receipt ? receipt.failureReason : undefined,
  };
}

// Only the idempotent exact acceptance and addressed reads retry. An uncertain
// content save is never replayed here; its existing save owner preserves it.
async function previewTransport<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw signal.reason;
    try { return await read(); }
    catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      const transient = error instanceof TypeError || [408, 429, 500, 502, 503, 504].includes(status as number);
      if (!transient || attempt >= 2 || signal.aborted) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 750 * (attempt + 1));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
}

function isPreviewRendererUpdating(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; data?: unknown };
  if (candidate.status !== 503 || typeof candidate.data !== "object" || candidate.data === null) return false;
  return (candidate.data as { code?: unknown }).code === "preview-renderer-updating";
}

/** The existing save owner prepares one exact target; no idle exports or refresh modes. */
export function SavedPreview(props: SavedPreviewProps) {
  const reasonId = useId();
  const disabledReason = props.enabled ? undefined : props.disabledReason ?? "Preview is not available for this draft yet.";
  const current = useRef(props);
  current.current = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<{
    operation: ReturnType<typeof createSavedPreviewOperation>;
    popup: Window;
    ownsTab(): boolean;
    timer: ReturnType<typeof setInterval>;
  } | null>(null);

  useEffect(() => {
    setBusy(false); setError(null);
    return () => {
      const running = active.current;
      active.current = null;
      if (!running) return;
      clearInterval(running.timer);
      running.operation.dispose();
      // A completed preview is detached from this owner and is never closed here.
      try { if (running.ownsTab()) running.popup.close(); } catch { /* The tab has left our origin. */ }
    };
  }, [props.collection, props.documentId]);

  function openPreview() {
    if (active.current || !current.current.enabled) return;
    // This must happen synchronously inside the click, before a save or token read.
    const popup = window.open("", "_blank");
    if (!popup) {
      setError("Allow pop-ups for this CMS, then select Preview again. Your edits have not changed.");
      return;
    }
    popup.opener = null;
    let progress: ReturnType<typeof createPreviewProgressDocument>;
    try { progress = createPreviewProgressDocument(popup); }
    catch { popup.close(); setError("Preview could not open. Your edits remain in the editor."); return; }
    const ownedDocument = popup.document;
    const ownsTab = () => {
      try { return !popup.closed && popup.document === ownedDocument; } catch { return false; }
    };
    const { collection, documentId } = current.current;
    const stillOwnsOperation = () => {
      if (!ownsTab() || current.current.collection !== collection || current.current.documentId !== documentId) {
        throw new Error("Preview owner changed");
      }
    };
    const preparation = new AbortController();
    let prepared: Promise<PreviewTarget>;
    const operation = createSavedPreviewOperation({
      onProgress: state => { if (ownsTab()) progress.update(state); },
      ensureSaved: async signal => {
        stillOwnsOperation();
        if (signal.aborted) preparation.abort();
        signal.addEventListener("abort", () => preparation.abort(), { once: true });
        const target = await prepared;
        if (target.collection !== collection || target.documentId !== documentId) {
          throw new Error("The preview editor identity changed");
        }
        return target;
      },
      request: async (target, signal) => job(await previewTransport(signal, () => {
        stillOwnsOperation(); return current.current.requestPreview(target);
      })),
      read: async (queueId, signal, observedStatus) => job(await previewTransport(signal, () => {
        stillOwnsOperation(); return current.current.loadPreviewStatus(queueId, { signal, waitMs: 5000, observedStatus });
      })),
    });
    const timer = setInterval(() => { if (!ownsTab()) operation.dispose(); }, 250);
    const running = { operation, popup, timer, ownsTab };
    active.current = running;
    // Capture the draft inside this click, after popup admission and ownership.
    try { prepared = Promise.resolve(current.current.preparePreview(preparation.signal)); }
    catch (reason) { prepared = Promise.reject(reason); }
    void prepared.catch(() => {});
    const prepareSession = current.current.prepareSession;
    const session = Promise.resolve().then(() => prepareSession?.()).catch(() => {});
    setBusy(true); setError(null);
    void operation.run().then(async outcome => {
      if (active.current !== running || !ownsTab() || outcome.status === "cancelled") return;
      // Both ready reuse and polled completion need the private cookie before
      // navigation. Keep save, acceptance and polling running alongside it.
      progress.update("opening");
      await session;
      if (active.current !== running || !ownsTab()) return;
      popup.location.replace(outcome.url);
    }).catch(reason => {
      if (active.current !== running || !ownsTab()) return;
      const rendererUpdating = isPreviewRendererUpdating(reason);
      const contextRefreshing = reason instanceof PreviewOperationError && reason.code === "refreshing";
      let message = "Preview is temporarily unavailable. Your edits remain in the editor.";
      let state: "updating" | "refresh-failed" | "error" = "error";
      if (rendererUpdating) { message = previewRendererUpdatingMessage.editor; state = "updating"; }
      else if (contextRefreshing) { message = previewContextRefreshingMessage.error; state = "refresh-failed"; }
      setError(message);
      try { progress.update(state); }
      catch { /* Do not write to a tab that navigated away while the request ran. */ }
    }).finally(() => {
      clearInterval(timer);
      operation.dispose();
      preparation.abort();
      if (active.current === running) { active.current = null; setBusy(false); }
    });
  }

  return (
    <div className="page-preview">
      <EditorActionSlot group="preview">
        <span className="disabled-action-shell" role={disabledReason ? "group" : undefined}
          aria-label={disabledReason ? `Preview unavailable: ${disabledReason}` : undefined}
          title={disabledReason} tabIndex={disabledReason ? 0 : undefined}>
          <AsyncActionButton variant="ghost" icon="monitor" reserveLabel="Preview" disabled={!props.enabled} label="Preview" onClick={openPreview}
            aria-describedby={disabledReason ? reasonId : undefined}
            pending={busy} pendingLabel="Preparing preview…" pendingAnnouncement="Preparing your preview in a new tab." />
        </span>
        {disabledReason ? <span className="sr-only" id={reasonId}>{disabledReason}</span> : null}
      </EditorActionSlot>
      <p>Preview opens your current draft in a new tab without publishing it.</p>
      <WorkspaceFeedback>
        {busy ? <p>Your preview will open automatically in its new tab.</p> : null}
        {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      </WorkspaceFeedback>
    </div>
  );
}
