import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, InlineMessage, Textarea, TextInput } from "./ui/Primitives";
import { Icon } from "./ui/Icon";
import { VideoRightsFields } from "./media/VideoRightsFields";
import { UploadTray, type UploadTrayRow } from "./media/UploadTray";
import { startVideoUpload, cancelVideoUpload, transferVideo, UploadFileMismatchError, VideoUploadValidationError, type VideoUploadMetadata, type VideoUploadSession } from "../lib/source-media-upload";
import { clearRejectedUploads, registerVideoUpload, routeChosenFiles, uploadRouterSnapshot } from "../lib/upload-router";
import { UNSUPPORTED_UPLOAD_MESSAGE, UNIVERSAL_UPLOAD_ACCEPT } from "../lib/upload-destination";
import { HttpError, RequestNotDispatchedError } from "../lib/functions";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import { formatVideoBytes } from "../lib/media-format";
import { invalidateVideoSearchCorpus } from "../lib/video-search-session-cache";
import "./VideoUploadPanel.css";

interface TransferDraft {
  name: string;
  description: string;
  credit: string;
  license: string;
  tags: string;
  metadataUpdateRequested: boolean;
  metadataRequestOverridden?: boolean;
  nameOverridden?: boolean;
  descriptionOverridden?: boolean;
  rightsStatus: "pending" | "complete";
}
interface Transfer {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  draft?: TransferDraft;
  queued?: boolean;
  startRequested?: boolean;
  session?: VideoUploadSession;
}
type Phase = "checking" | "uploading" | "finishing" | "paused" | "error" | "ready";
const MAX_TRANSFERS = 20;
const MAX_ACTIVE_TRANSFERS = 2;
function defaultDraft(fileName: string): TransferDraft {
  return {
    name: fileName.replace(/\.[^.]+$/, ""),
    description: "",
    credit: "",
    license: "",
    tags: "",
    metadataUpdateRequested: false,
    nameOverridden: false,
    descriptionOverridden: false,
    rightsStatus: "pending",
  };
}
function restoredDraft(value: unknown, fileName: string): TransferDraft {
  const fallback = defaultDraft(fileName);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Partial<Record<keyof TransferDraft, unknown>>;
  return {
    name: typeof candidate.name === "string" && candidate.name.length <= 500 ? candidate.name : fallback.name,
    description: typeof candidate.description === "string" && candidate.description.length <= 2_000 ? candidate.description : "",
    credit: typeof candidate.credit === "string" && candidate.credit.length <= 500 ? candidate.credit : "",
    license: typeof candidate.license === "string" && candidate.license.length <= 500 ? candidate.license : "",
    tags: typeof candidate.tags === "string" && candidate.tags.length <= 2_429 ? candidate.tags : "",
    metadataUpdateRequested: candidate.metadataUpdateRequested === true,
    metadataRequestOverridden: candidate.metadataRequestOverridden === true,
    nameOverridden: candidate.nameOverridden !== false,
    descriptionOverridden: candidate.descriptionOverridden !== false,
    rightsStatus: candidate.rightsStatus === "complete" ? "complete" : "pending",
  };
}
function draftFor(transfer: Transfer): TransferDraft {
  return transfer.draft ?? defaultDraft(transfer.name);
}
function metadataFor(transfer: Transfer): VideoUploadMetadata {
  const draft = draftFor(transfer);
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of draft.tags.split(",")) {
    const tag = part.trim();
    const key = tag.toLocaleLowerCase("en-US");
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  const description = draft.description.trim();
  const credit = draft.credit.trim();
  const license = draft.license.trim();
  return {
    name: draft.name.trim(),
    ...(draft.metadataUpdateRequested ? { metadataUpdateRequested: true } : {}),
    ...(description ? { description } : {}),
    ...(credit ? { credit } : {}),
    ...(license ? { license } : {}),
    ...(tags.length ? { tags } : {}),
    rightsStatus: draft.rightsStatus,
  };
}
function metadataErrorFor(transfer: Transfer): string | undefined {
  const metadata = metadataFor(transfer);
  if (!metadata.name) return "Enter a title before uploading.";
  if ((metadata.tags?.length ?? 0) > 30) return "Enter no more than 30 tags.";
  if (metadata.tags?.some(tag => tag.length > 80)) return "Keep each tag at 80 characters or fewer.";
  return undefined;
}
function savedTransfers(key: string): Transfer[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Transfer => item && typeof item.id === "string" && typeof item.name === "string" && Number.isSafeInteger(item.size) && item.size > 0 && Number.isFinite(item.lastModified) && (!item.session || typeof item.session.sessionId === "string"))
      .slice(0, MAX_TRANSFERS)
      .map(item => ({ ...item, queued: false, draft: restoredDraft(item.draft, item.name) }));
  } catch { return []; }
}

export function VideoUploadPanel({ sourceId, userId, getIdToken, onUploaded, onActiveChange, onDefaultsDirtyChange, onMoreWork, onTransferStarted, onTransferStopped, onCanceled, onAdmissionFailed, onOwnershipUnavailable, onIntakeChange, onOpenSheet, onTrayEmptyFocus, openSheetBlockedReason, presentation = "inline", rejectedFiles, trayTarget }: {
  sourceId: string; userId: string; getIdToken: () => Promise<string>; onUploaded: (asset: SourceMediaAssetSummary) => void;
  onActiveChange?: (active: boolean) => void;
  onDefaultsDirtyChange?: (dirty: boolean) => void;
  /** True when another transfer is active or about to start. Called immediately before a result. */
  onMoreWork?: (more: boolean) => void;
  /** Staff approved a start, so a route-owned sheet can yield the library. */
  onTransferStarted?: () => void;
  /** A transfer failed and stayed resumable, or stopped, after onMoreWork. */
  onTransferStopped?: (note?: string) => void;
  /** A final canceled row needs a visible result outside a closed sheet. */
  onCanceled?: (message: string) => void;
  /** The batch did not fit, so the routed session should end and the message should remain. */
  onAdmissionFailed?: (message: string) => void;
  /** This browser cannot own the queue, so a routed file needs a visible recovery path. */
  onOwnershipUnavailable?: () => void;
  /** Coarse route signal. Transfer progress stays inside this owner. */
  onIntakeChange?: (available: boolean) => void;
  onOpenSheet?: () => void;
  onTrayEmptyFocus?: () => void;
  openSheetBlockedReason?: string;
  presentation?: "inline" | "sheet";
  rejectedFiles?: readonly string[];
  trayTarget?: Element | null;
}) {
  const storageKey = `boardwalk-video-transfers:${userId}:${sourceId}`;
  const ownerKey = `${storageKey}:owner`;
  const [transfers, setTransfers] = useState<Transfer[]>(() => savedTransfers(storageKey));
  const [assignment, setAssignment] = useState({ name: "", description: "", metadataUpdateRequested: false });
  const assignmentRef = useRef(assignment);
  const rows = useRef(transfers);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const busy = useRef(new Set<string>());
  const clearing = useRef(false);
  const operations = useRef(new Map<string, Promise<void>>());
  const cancellations = useRef(new Map<string, Promise<boolean>>());
  const pendingMutations = useRef(new Set<Promise<unknown>>());
  const alive = useRef(true);
  const [active, setActive] = useState<string[]>([]);
  const [cancelingIds, setCancelingIds] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, { phase: Phase; bytes: number; error?: string }>>({});
  const [notice, setNotice] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const reselect = useRef<string>();
  const [dragging, setDragging] = useState(false);
  const [ownsQueue, setOwnsQueue] = useState(false);
  const [ownershipUnavailable, setOwnershipUnavailable] = useState(false);
  const [trayCollapsed, setTrayCollapsed] = useState(false);
  const ownsQueueRef = useRef(false);
  const onOwnershipUnavailableRef = useRef(onOwnershipUnavailable);
  onOwnershipUnavailableRef.current = onOwnershipUnavailable;
  const onIntakeChangeRef = useRef(onIntakeChange);
  onIntakeChangeRef.current = onIntakeChange;
  const onTrayEmptyFocusRef = useRef(onTrayEmptyFocus);
  onTrayEmptyFocusRef.current = onTrayEmptyFocus;
  const hadTrayRows = useRef(transfers.length > 0);
  const trayFocusLost = useRef(false);
  const sheetRowFocusLost = useRef(false);
  useLayoutEffect(() => {
    const hadRows = hadTrayRows.current;
    hadTrayRows.current = transfers.length > 0;
    if (!hadRows || transfers.length > 0) return;
    if (trayFocusLost.current) {
      trayFocusLost.current = false;
      onTrayEmptyFocusRef.current?.();
    } else if (sheetRowFocusLost.current) {
      sheetRowFocusLost.current = false;
      uploadButton.current?.focus();
    }
  }, [transfers.length]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; for (const controller of controllers.current.values()) controller.abort(); };
  }, []);
  useEffect(() => {
    let mounted = true;
    let releaseLock: (() => void) | undefined;
    const abort = new AbortController();
    function setOwner(value: boolean, unavailable = false) {
      ownsQueueRef.current = value;
      if (mounted) {
        setOwnsQueue(value);
        setOwnershipUnavailable(unavailable);
      }
      if (unavailable) onOwnershipUnavailableRef.current?.();
      if (!value) for (const controller of controllers.current.values()) controller.abort();
    }
    function restoreAndOwn() {
      const restored = savedTransfers(storageKey);
      rows.current = restored;
      if (mounted) setTransfers(restored);
      setOwner(true);
    }
    if (!navigator.locks) {
      setOwner(false, true);
      return () => { mounted = false; ownsQueueRef.current = false; };
    }
    void navigator.locks.request(ownerKey, { mode: "exclusive", signal: abort.signal }, async () => {
      if (!mounted) return;
      restoreAndOwn();
      await new Promise<void>(resolve => { releaseLock = resolve; });
    }).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setOwner(false, true);
    });
    return () => {
      mounted = false;
      abort.abort();
      ownsQueueRef.current = false;
      for (const controller of controllers.current.values()) controller.abort();
      void Promise.allSettled([...pendingMutations.current]).then(() => releaseLock?.());
    };
  }, [ownerKey, storageKey]);
  const hasPreparedFile = transfers.some(row =>
    !row.session && row.startRequested === false && files.current.has(row.id));
  const hasBatchDefaults = assignment.name !== "" || assignment.description !== "" || assignment.metadataUpdateRequested;
  const hasTransfers = active.length > 0 || hasPreparedFile;
  const hasLocalWork = hasTransfers || hasBatchDefaults;
  useEffect(() => {
    onActiveChange?.(hasTransfers);
  }, [hasTransfers, onActiveChange]);
  useEffect(() => {
    onDefaultsDirtyChange?.(hasBatchDefaults);
  }, [hasBatchDefaults, onDefaultsDirtyChange]);
  const routedIds = useRef(new Set<string>());
  const lastNote = useRef("");
  const onMoreWorkRef = useRef(onMoreWork);
  const onUploadedRef = useRef(onUploaded);
  const onTransferStoppedRef = useRef(onTransferStopped);
  const onCanceledRef = useRef(onCanceled);
  onMoreWorkRef.current = onMoreWork;
  onUploadedRef.current = onUploaded;
  onTransferStoppedRef.current = onTransferStopped;
  onCanceledRef.current = onCanceled;
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  useEffect(() => () => onDefaultsDirtyChange?.(false), [onDefaultsDirtyChange]);
  useEffect(() => {
    if (!hasLocalWork) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [hasLocalWork]);

  function store(next: Transfer[]) {
    if (rows.current.length > 0 && next.length === 0 && document.activeElement) {
      if (trayTarget?.contains(document.activeElement)) trayFocusLost.current = true;
      else if (document.activeElement.closest(".video-upload-panel li")) sheetRowFocusLost.current = true;
    }
    rows.current = next;
    if (alive.current) setTransfers(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { if (alive.current) setNotice("Browser storage is unavailable. Keep this page open to retain upload progress."); }
  }
  function update(id: string, phase: Phase, transferred = 0, error?: string) {
    if (alive.current) setStates(previous => ({ ...previous, [id]: { phase, bytes: transferred, error } }));
  }
  function clearStates(ids: ReadonlySet<string>) {
    setStates(previous => {
      if (![...ids].some(id => previous[id])) return previous;
      const next = { ...previous };
      for (const id of ids) delete next[id];
      return next;
    });
  }
  function updateDraft(id: string, patch: Partial<TransferDraft>) {
    store(rows.current.map(item => item.id === id
      ? { ...item, draft: { ...draftFor(item), ...patch } }
      : item));
    clearStates(new Set([id]));
  }
  function updateAssignment(next: typeof assignment) {
    const previous = assignmentRef.current;
    assignmentRef.current = next;
    setAssignment(next);
    store(rows.current.map(item => {
      if (item.session || item.queued || item.startRequested !== false || busy.current.has(item.id)) return item;
      const draft = draftFor(item);
      return { ...item, draft: { ...draft,
        ...(next.name !== previous.name && !draft.nameOverridden ? { name: next.name.trim() ? next.name : defaultDraft(item.name).name } : {}),
        ...(next.description !== previous.description && !draft.descriptionOverridden ? { description: next.description } : {}),
        ...(next.metadataUpdateRequested !== previous.metadataUpdateRequested && !draft.metadataRequestOverridden ? { metadataUpdateRequested: next.metadataUpdateRequested } : {}),
      } };
    }));
  }
  function trackMutation<T>(operation: Promise<T>) {
    pendingMutations.current.add(operation);
    void operation.then(
      () => pendingMutations.current.delete(operation),
      () => pendingMutations.current.delete(operation),
    );
    return operation;
  }
  async function run(row: Transfer, file: File) {
    if (busy.current.has(row.id) || busy.current.size >= MAX_ACTIVE_TRANSFERS) return;
    busy.current.add(row.id);
    setActive([...busy.current]);
    const controller = new AbortController();
    controllers.current.set(row.id, controller);
    let phase: Phase = "checking";
    let transferred = 0;
    let session = row.session;
    const firstStart = row.startRequested === false;
    update(row.id, phase);
    try {
      if (!session) {
        if (row.startRequested === false) {
          store(rows.current.map(item => item.id === row.id
            ? { ...item, queued: false, startRequested: true }
            : item));
        }
        session = (await startVideoUpload(getIdToken, sourceId, row,
          metadataFor(row),
          { requestId: row.id, signal: controller.signal })).upload;
        store(rows.current.map(item => item.id === row.id ? { ...item, session } : item));
      }
      const asset = await transferVideo({ file, sourceId, session, getIdToken, signal: controller.signal,
        onProgress: value => { transferred = value; update(row.id, phase, value); },
        onPhase: value => { phase = value; update(row.id, value, transferred); },
        onSession: value => {
          const clean: VideoUploadSession = { sessionId: value.sessionId, assetId: value.assetId, partSize: value.partSize, totalParts: value.totalParts, expiresAt: value.expiresAt, version: value.version };
          store(rows.current.map(item => item.id === row.id ? { ...item, session: clean } : item));
        },
      });
      invalidateVideoSearchCorpus(sourceId);
      store(rows.current.filter(item => item.id !== row.id));
      files.current.delete(row.id);
      routedIds.current.delete(row.id);
      const routedLeft = rows.current.some(item => routedIds.current.has(item.id))
        || [...busy.current].some(id => id !== row.id);
      onMoreWorkRef.current?.(routedLeft);
      if (alive.current) { setNotice(`${row.name} is ready in the video library.`); onUploadedRef.current(asset); }
    } catch (error) {
      if (!session && firstStart && (error instanceof RequestNotDispatchedError ||
          error instanceof VideoUploadValidationError ||
          (error instanceof HttpError && [400, 403, 404, 413].includes(error.status)))) {
        store(rows.current.map(item => item.id === row.id
          ? { ...item, queued: false, startRequested: false }
          : item));
      }
      if (error instanceof UploadFileMismatchError) files.current.delete(row.id);
      const routedLeft = rows.current.some(item => routedIds.current.has(item.id))
        || [...busy.current].some(id => id !== row.id);
      onMoreWorkRef.current?.(routedLeft);
      onTransferStoppedRef.current?.();
      update(row.id, controller.signal.aborted ? "paused" : "error", transferred,
        controller.signal.aborted ? undefined : error instanceof Error ? error.message : "The transfer stopped. Resume to try again.");
    } finally {
      busy.current.delete(row.id);
      controllers.current.delete(row.id);
      if (alive.current) {
        setActive([...busy.current]);
      }
      drainQueue();
    }
  }
  function launch(row: Transfer, file: File, staffInitiated = false) {
    if (!ownsQueueRef.current || clearing.current || busy.current.has(row.id) || busy.current.size >= MAX_ACTIVE_TRANSFERS) return;
    if (!row.session) {
      const error = metadataErrorFor(row);
      if (error) {
        update(row.id, "error", 0, error);
        return;
      }
    }
    if (staffInitiated) onTransferStarted?.();
    const operation = trackMutation(run(row, file));
    operations.current.set(row.id, operation);
    void operation.finally(() => { if (operations.current.get(row.id) === operation) operations.current.delete(row.id); });
  }
  function drainQueue() {
    if (!ownsQueueRef.current || clearing.current) return;
    for (const row of rows.current) {
      if (busy.current.size >= MAX_ACTIVE_TRANSFERS) return;
      if (!row.queued || busy.current.has(row.id)) continue;
      const file = files.current.get(row.id);
      if (file) launch(row, file);
    }
  }
  function withAssignment(row: Transfer): Transfer {
    const draft = draftFor(row);
    return { ...row, draft: { ...draft,
      name: draft.name.trim() ? draft.name : assignmentRef.current.name,
      description: draft.description.trim() ? draft.description : assignmentRef.current.description,
    } };
  }
  function requestStart(row: Transfer, file: File) {
    if (!row.session && row.startRequested === false) {
      const approved = row.queued ? row : withAssignment(row);
      const error = metadataErrorFor(approved);
      if (error) {
        update(row.id, "error", 0, error);
        return;
      }
      clearStates(new Set([row.id]));
      if (!row.queued) {
        store(rows.current.map(item => item.id === row.id ? { ...approved, queued: true } : item));
      }
      onTransferStarted?.();
      drainQueue();
      return;
    }
    launch(row, file, true);
  }
  function resume(row: Transfer) {
    if (!ownsQueueRef.current || clearing.current || (!row.session && row.startRequested === undefined)) return;
    const file = files.current.get(row.id);
    if (file) requestStart(row, file);
    else { reselect.current = row.id; input.current?.click(); }
  }
  function startPreparedBatch() {
    const prepared = rows.current
      .filter(row => !row.session && row.startRequested === false && !row.queued && files.current.has(row.id));
    const ids = new Set(prepared.map(row => row.id));
    if (ids.size < 2) return;
    for (const row of prepared) {
      const error = metadataErrorFor(withAssignment(row));
      if (error) {
        update(row.id, "error", 0, error);
        return;
      }
    }
    clearStates(ids);
    store(rows.current.map(row => ids.has(row.id) ? { ...withAssignment(row), queued: true } : row));
    onTransferStarted?.();
    drainQueue();
  }
  async function cancel(row: Transfer): Promise<boolean> {
    if (!ownsQueueRef.current) return false;
    if (busy.current.has(row.id)) {
      const operation = operations.current.get(row.id);
      if (!operation) return false;
      controllers.current.get(row.id)?.abort();
      await operation;
      const current = rows.current.find(item => item.id === row.id);
      if (!current) return true;
      row = current;
    }
    if (busy.current.has(row.id)) return false;
    busy.current.add(row.id);
    setActive([...busy.current]);
    update(row.id, "finishing");
    try {
      let session = row.session;
      if (!session && row.startRequested === undefined) {
        store(rows.current.filter(item => item.id !== row.id));
        files.current.delete(row.id);
        lastNote.current = lastNote.current
          ? `${lastNote.current} Saved transfer removed from this browser. Server cancellation could not be confirmed.`
          : "Saved transfer removed from this browser. Server cancellation could not be confirmed. The upload session expires after 24 hours; incomplete S3 parts are cleaned up after seven days.";
        if (alive.current) setNotice(lastNote.current);
        if (alive.current && rows.current.length === 0) onCanceledRef.current?.(lastNote.current);
        return true;
      }
      if (!session && row.startRequested) {
        session = (await startVideoUpload(getIdToken, sourceId, row,
          metadataFor(row),
          { requestId: row.id })).upload;
        store(rows.current.map(item => item.id === row.id ? { ...item, session } : item));
      }
      if (session) {
        try { await cancelVideoUpload(getIdToken, sourceId, session); }
        catch (error) {
          if (error instanceof HttpError && error.status === 409 && error.data.code === "upload_completed") {
            const completed = `${row.name} is already in the video library. Refresh the library to see it.`;
            lastNote.current = lastNote.current ? `${lastNote.current} ${completed}` : completed;
            if (alive.current) setNotice(lastNote.current);
          } else if (!(error instanceof HttpError) || ![404, 410].includes(error.status)) throw error;
        }
      }
      store(rows.current.filter(item => item.id !== row.id));
      files.current.delete(row.id);
      const message = lastNote.current || `${row.name} was canceled.`;
      if (alive.current) setNotice(message);
      if (alive.current && rows.current.length === 0) onCanceledRef.current?.(message);
      return true;
    } catch (error) {
      update(row.id, "error", 0, error instanceof Error ? error.message : "Cancellation failed. Try again.");
      return false;
    } finally {
      busy.current.delete(row.id);
      if (alive.current) setActive([...busy.current]);
      const routedLeft = rows.current.some(item => routedIds.current.has(item.id))
        || busy.current.size > 0;
      onMoreWorkRef.current?.(routedLeft);
      if (!routedLeft) {
        const note = lastNote.current;
        lastNote.current = "";
        onTransferStoppedRef.current?.(note);
      }
      drainQueue();
    }
  }
  function beginCancellation(row: Transfer): Promise<boolean> {
    const existing = cancellations.current.get(row.id);
    if (existing) return existing;
    setCancelingIds(previous => [...previous, row.id]);
    const operation = trackMutation(cancel(row));
    cancellations.current.set(row.id, operation);
    void operation.finally(() => {
      if (cancellations.current.get(row.id) === operation) cancellations.current.delete(row.id);
      if (alive.current) setCancelingIds(previous => previous.filter(id => id !== row.id));
    });
    return operation;
  }
  function startCancel(row: Transfer) {
    if (!ownsQueueRef.current || clearing.current) return;
    void beginCancellation(row);
  }
  function clearQueue() {
    if (!ownsQueueRef.current || clearing.current || rows.current.length === 0) return;
    clearing.current = true;
    setIsClearing(true);
    const operation = (async () => {
      for (const saved of [...rows.current]) {
        const existing = cancellations.current.get(saved.id);
        if (existing) {
          if (!(await existing)) {
            if (alive.current) setNotice("Some transfers could not be canceled. Try Clear queue again.");
            break;
          }
          continue;
        }
        const row = rows.current.find(item => item.id === saved.id);
        if (row && !row.session && row.startRequested === undefined) {
          if (alive.current) setNotice("Older saved transfers need individual removal. Select Remove saved transfer for each one; server cancellation cannot be confirmed.");
          break;
        }
        if (row && !(await beginCancellation(row))) {
          if (alive.current) setNotice("Some transfers could not be canceled. Try Clear queue again.");
          break;
        }
      }
    })().finally(() => {
      if (rows.current.some(row => row.queued)) {
        store(rows.current.map(row => row.queued ? { ...row, queued: false } : row));
      }
      clearing.current = false;
      if (alive.current) setIsClearing(false);
    });
    void trackMutation(operation);
  }
  const chooseLatest = useRef<(files: readonly File[], routed: boolean) => void>(() => {});
  function choose(selected: FileList | readonly File[] | null, routed = false) {
    if (!ownsQueueRef.current || clearing.current || !selected?.length) return;
    const retryId = reselect.current;
    reselect.current = undefined;
    if (retryId) {
      const row = rows.current.find(item => item.id === retryId);
      if (row) { files.current.set(row.id, selected[0]); requestStart(row, selected[0]); }
      return;
    }
    const available = MAX_TRANSFERS - rows.current.length;
    if (selected.length > available) {
      const message = `Add up to ${available} more files to this transfer list.`;
      setNotice(message);
      if (routed || rows.current.length === 0 || presentation === "sheet") onAdmissionFailed?.(message);
      return;
    }
    const additions = Array.from(selected).map(file => {
      const row = { id: crypto.randomUUID(), name: file.name, size: file.size, lastModified: file.lastModified, draft: { ...defaultDraft(file.name), ...(assignmentRef.current.name.trim() ? { name: assignmentRef.current.name } : {}), description: assignmentRef.current.description, metadataUpdateRequested: assignmentRef.current.metadataUpdateRequested }, startRequested: false };
      files.current.set(row.id, file);
      return row;
    });
    store([...rows.current, ...additions]);
  }
  chooseLatest.current = choose;
  // The tab can accept videos only after it owns the transfer lock. Files chosen earlier wait.
  useEffect(() => {
    if (!ownsQueue) return;
    let initialBatch = uploadRouterSnapshot().video.length > 0;
    return registerVideoUpload((picked) => {
      reselect.current = undefined;
      const before = new Set(rows.current.map(item => item.id));
      try {
        chooseLatest.current(picked, initialBatch);
      } finally {
        initialBatch = false;
        for (const item of rows.current) {
          if (!before.has(item.id)) routedIds.current.add(item.id);
        }
      }
    });
  }, [ownsQueue]);
  const acceptsFiles = ownsQueue && !isClearing && transfers.length < MAX_TRANSFERS;
  useEffect(() => { onIntakeChangeRef.current?.(acceptsFiles); }, [acceptsFiles]);
  useEffect(() => () => onIntakeChangeRef.current?.(false), []);
  const trayRows: readonly UploadTrayRow[] = transfers.map(row => {
    const state = states[row.id];
    const running = active.includes(row.id);
    const cancelingRow = cancelingIds.includes(row.id);
    const legacyRow = !row.session && row.startRequested === undefined;
    const phase = state?.phase ?? (row.session ? "paused" : "ready");
    const prepared = !row.session && row.startRequested === false && !row.queued;
    const queued = !row.session && row.startRequested === false && Boolean(row.queued);
    const titleMissing = prepared && !metadataFor(withAssignment(row)).name;
    const reviewsInSheet = Boolean(prepared && onOpenSheet);
    const reviewBlocked = reviewsInSheet && Boolean(openSheetBlockedReason);
    const progress = Math.min(100, Math.floor((state?.bytes ?? 0) / row.size * 100));
    const actionDisabled = !ownsQueue || isClearing || cancelingRow;
    let actions: Partial<UploadTrayRow>;
    if (legacyRow) {
      actions = {
        onClear: () => startCancel(row),
        clearDisabled: actionDisabled,
        clearLabel: `Remove saved transfer ${row.name}`,
        clearText: "Remove",
      };
    } else if (running) {
      actions = {
        onPause: () => controllers.current.get(row.id)?.abort(),
        pauseDisabled: actionDisabled,
        onCancel: () => startCancel(row),
        cancelDisabled: actionDisabled,
      };
    } else if (phase === "error" && prepared && onOpenSheet) {
      actions = {
        onResume: onOpenSheet,
        resumeDisabled: actionDisabled || reviewBlocked,
        resumeLabel: `Review details for ${row.name}`,
        resumeText: "Review details",
        onCancel: () => startCancel(row),
        cancelDisabled: actionDisabled,
      };
    } else if (phase === "error") {
      actions = {
        onRetry: () => resume(row),
        retryDisabled: actionDisabled || active.length >= MAX_ACTIVE_TRANSFERS,
        onCancel: () => startCancel(row),
        cancelDisabled: actionDisabled,
      };
    } else if (queued) {
      actions = {
        onCancel: () => startCancel(row),
        cancelDisabled: actionDisabled,
      };
    } else {
      actions = {
        onResume: prepared && onOpenSheet ? onOpenSheet : () => resume(row),
        resumeDisabled: reviewsInSheet
          ? actionDisabled || reviewBlocked
          : actionDisabled || (!prepared && active.length >= MAX_ACTIVE_TRANSFERS) || titleMissing,
        ...(prepared ? onOpenSheet
          ? { resumeLabel: `Review details for ${row.name}`, resumeText: "Review details" }
          : { resumeLabel: `Start upload ${row.name}`, resumeText: "Start upload" }
          : {}),
        onCancel: () => startCancel(row),
        cancelDisabled: actionDisabled,
      };
    }
    return {
      id: row.id,
      name: row.name,
      status: cancelingRow || running ? "uploading"
        : phase === "error" ? "failed"
          : phase === "paused" ? "paused"
            : prepared ? "ready"
              : "waiting",
      ...(phase === "uploading" || phase === "paused" ? { progress } : {}),
      ...(state?.error ? { message: state.error }
        : legacyRow ? { message: "Saved by an older version. Clear this browser record, then add the file again." }
          : cancelingRow ? { message: "Canceling upload." }
            : queued ? { message: "Approved and waiting for an upload slot." } : {}),
      ...actions,
    };
  });
  const activeIndex = transfers.findIndex(row => active.includes(row.id));
  const failedCount = trayRows.filter(row => row.status === "failed").length;
  const pausedCount = trayRows.filter(row => row.status === "paused").length;
  const readyCount = trayRows.filter(row => row.status === "ready").length;
  const queuedCount = transfers.filter(row => row.queued).length;
  const traySummary = activeIndex >= 0
    ? `Uploading ${activeIndex + 1} of ${transfers.length}`
    : failedCount > 0
      ? `${failedCount} of ${transfers.length} needs attention`
      : pausedCount > 0
        ? `${pausedCount} of ${transfers.length} paused`
        : readyCount > 0
          ? `${readyCount} ${readyCount === 1 ? "video" : "videos"} ready to start`
          : queuedCount > 0
            ? `${queuedCount} ${queuedCount === 1 ? "video" : "videos"} queued`
            : `${transfers.length} video transfers`;
  const preparedRows = transfers.filter(row =>
    !row.session && row.startRequested === false && !row.queued && files.current.has(row.id));
  const startAllDisabled = preparedRows.some(row => !metadataFor(withAssignment(row)).name);
  return <section className="video-upload-panel" aria-label="Video transfers" data-presentation={presentation} data-dragging={dragging || undefined} data-disabled={!acceptsFiles || undefined}
    onDragOver={event => { if (!event.dataTransfer.types || event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = acceptsFiles ? "copy" : "none"; if (acceptsFiles) setDragging(true); } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { if (event.dataTransfer.types && !event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDragging(false); if (!acceptsFiles) return; reselect.current = undefined; routeChosenFiles(event.dataTransfer.files); }}>
    <header><h3>{presentation === "sheet" ? "Transfer queue" : "Upload"}</h3><div className="video-upload-header-actions">
      <Button variant="danger-quiet" disabled={!ownsQueue || isClearing || transfers.length === 0} onClick={clearQueue}>{isClearing ? "Clearing queue…" : "Clear queue"}</Button>
      <Button ref={uploadButton} disabled={!ownsQueue || isClearing || transfers.length >= MAX_TRANSFERS} aria-label="Upload media" title="Upload images, PDFs, WAV audio, or videos" onClick={() => { reselect.current = undefined; input.current?.click(); }}><Icon name="upload" /></Button>
    </div></header>
    <input ref={input} type="file" disabled={!ownsQueue || isClearing} accept={UNIVERSAL_UPLOAD_ACCEPT} multiple hidden onChange={event => { if (reselect.current) choose(event.target.files); else routeChosenFiles(event.target.files ?? []); event.target.value = ""; }} />
    <p>{presentation === "sheet" ? "Choose images, PDFs, WAV audio, or videos. Each file goes to the matching library." : "Drop images, PDFs, WAV audio, or videos. Each file goes to the matching library."} After reopening Boardwalk, select the original video to resume a transfer.</p>
    {!ownsQueue ? <p role="status">{ownershipUnavailable
      ? "Uploads are unavailable in this browser. You can still view and download videos."
      : "Video transfers are open in another Boardwalk tab. Clear queue, Resume, Cancel, and Upload media are disabled here. Close the video library in the other tab; controls activate here automatically."}</p> : null}
    {presentation === "sheet" && rejectedFiles?.length ? <InlineMessage tone="error" title="Some files were not added">
      <ul>{rejectedFiles.map((name, index) => <li key={`${name}-${index}`}><strong>{name}</strong>: {UNSUPPORTED_UPLOAD_MESSAGE}</li>)}</ul>
      <Button onClick={clearRejectedUploads}>Dismiss</Button>
    </InlineMessage> : null}
    <fieldset className="video-upload-metadata" disabled={!ownsQueue || isClearing}>
      <legend>Batch assignment</legend>
      <p>Applies to new videos and videos waiting to start without their own values.</p>
      <label>Batch title default<TextInput maxLength={500} value={assignment.name} onChange={event => updateAssignment({ ...assignment, name: event.target.value })} /></label>
      <label>Batch description default<Textarea maxLength={2_000} rows={2} value={assignment.description} onChange={event => updateAssignment({ ...assignment, description: event.target.value })} /></label>
      <label><input type="checkbox" checked={assignment.metadataUpdateRequested} onChange={event => updateAssignment({ ...assignment, metadataUpdateRequested: event.target.checked })} /> Request metadata update for the batch</label>
    </fieldset>
    {notice ? <p role="status">{notice}</p> : null}
    <ul>{transfers.map(row => {
      const state = states[row.id];
      const running = active.includes(row.id);
      const cancelingRow = cancelingIds.includes(row.id);
      const legacyRow = !row.session && row.startRequested === undefined;
      const phase = state?.phase ?? (row.session ? "paused" : "ready");
      const prepared = !row.session && row.startRequested === false && !row.queued;
      const queued = !row.session && row.startRequested === false && Boolean(row.queued);
      const draft = draftFor(row);
      const metadataDisabled = !ownsQueue || isClearing || cancelingRow || running || !prepared;
      const percent = Math.min(100, Math.floor((state?.bytes ?? 0) / row.size * 100));
      return <li key={row.id}>
        <div className="video-upload-name"><Icon name="file" /><strong>{row.name}</strong></div>
        {!legacyRow && !row.session ? <fieldset className="video-upload-metadata" disabled={metadataDisabled}>
          <legend>Details before upload: {row.name}</legend>
          <label>Title<TextInput required maxLength={500} placeholder={assignment.name || undefined} value={draft.name}
            onChange={event => updateDraft(row.id, { name: event.target.value, nameOverridden: Boolean(event.target.value.trim()) })} /></label>
          <label>Description<Textarea maxLength={2_000} rows={2} placeholder={assignment.description || undefined} value={draft.description}
            onChange={event => updateDraft(row.id, { description: event.target.value, descriptionOverridden: Boolean(event.target.value.trim()) })} /></label>
          <label><input type="checkbox" checked={draft.metadataUpdateRequested} onChange={event => updateDraft(row.id, { metadataUpdateRequested: event.target.checked, metadataRequestOverridden: true })} /> Request metadata update</label>
          <VideoRightsFields values={draft} disabled={metadataDisabled} onChange={values => updateDraft(row.id, values)} />
          <label>Tags<TextInput maxLength={2_429} placeholder="interview, politics" value={draft.tags}
            onChange={event => updateDraft(row.id, { tags: event.target.value })} /></label>
          {prepared ? <p>Review these details, then start the upload. You can keep using the video library while the transfer runs.</p>
            : queued ? <p>These details are approved. The upload will start when a transfer slot is available.</p>
              : <p>These details were set when the upload started. Edit them from the video library after processing.</p>}
        </fieldset> : null}
        <progress value={state?.bytes ?? 0} max={row.size} aria-label={`Upload progress for ${row.name}`} />
        <span role="status">{cancelingRow ? "Canceling upload" : phase === "checking" ? "Checking file" : phase === "finishing" ? "Verifying upload" : phase === "paused" ? "Paused" : phase === "ready" ? queued ? "Queued to upload" : prepared ? "Ready to start" : "Ready to resume" : phase === "error" ? "Transfer interrupted" : `${percent}%`} · {formatVideoBytes(state?.bytes ?? 0)} of {formatVideoBytes(row.size)}</span>
        {legacyRow ? <p className="video-upload-legacy-note">Saved by an older version without a recoverable session. Check the library, then remove this browser record and add the file again if needed. Server cancellation cannot be confirmed.</p> : null}
        {state?.error ? <InlineMessage tone="error" title="Upload needs attention">{state.error}</InlineMessage> : null}
        <div className="video-upload-actions">
          {legacyRow ? null : running ? <Button disabled={!ownsQueue || isClearing || cancelingRow} aria-label={`Pause ${row.name}`} title="Pause upload" onClick={() => controllers.current.get(row.id)?.abort()}><Icon name="pause" /></Button>
            : prepared ? <Button variant="primary" disabled={!ownsQueue || isClearing || cancelingRow || !metadataFor(withAssignment(row)).name} aria-label={`Start upload ${row.name}`} onClick={() => resume(row)}>Start upload</Button>
              : queued ? <Button disabled aria-label={`${row.name} queued for upload`}>Queued</Button>
              : <Button disabled={!ownsQueue || isClearing || cancelingRow || active.length >= MAX_ACTIVE_TRANSFERS} aria-label={`Resume ${row.name}`} title="Resume upload" onClick={() => resume(row)}><Icon name="play" /></Button>}
          {legacyRow
            ? <Button variant="danger-quiet" disabled={!ownsQueue || isClearing || cancelingRow} aria-label={`Remove saved transfer ${row.name}`} onClick={() => startCancel(row)}>Remove saved transfer</Button>
            : <Button disabled={!ownsQueue || isClearing || cancelingRow} aria-label={`Cancel ${row.name}`} title="Cancel upload" onClick={() => startCancel(row)}><Icon name="close" /></Button>}
        </div>
      </li>;
    })}</ul>
    {preparedRows.length > 1 ? <div className="video-upload-actions">
      <Button variant="primary" disabled={!ownsQueue || isClearing || startAllDisabled} onClick={startPreparedBatch}>Start all uploads</Button>
    </div> : null}
    {trayTarget && onOpenSheet && trayRows.length > 0 ? createPortal(
      <UploadTray
        announcement={notice || traySummary}
        collapsed={trayCollapsed}
        onCollapsedChange={setTrayCollapsed}
        onOpen={onOpenSheet}
        openLockedReason={openSheetBlockedReason}
        rows={trayRows}
        summary={traySummary}
      />,
      trayTarget,
    ) : null}
  </section>;
}
