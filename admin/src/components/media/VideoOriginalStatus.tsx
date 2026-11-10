import { useEffect, useRef, useState } from "react";
import { sourceMediaOriginal, originalStatusLabel, originalAvailableUntil, originalRestoreNotices, dismissOriginalRestoreNotice,
  type OriginalRestoreNotice, type OriginalAvailability } from "../../lib/video-original";
import type { SourceMediaAssetSummary } from "../../lib/source-media";
import { HttpError } from "../../lib/functions";
import { Button, InlineMessage, StatusBadge } from "../ui/Primitives";

export function useVideoOriginalStatus(asset: SourceMediaAssetSummary, getIdToken: () => Promise<string>, canManageVideo: boolean) {
  const [original, setOriginal] = useState<OriginalAvailability | undefined>(asset.original);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<"status" | "restore">("status");
  const [error, setError] = useState("");
  const [noticeShown, setNoticeShown] = useState(false);
  const checkButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    setOriginal(asset.original);
    setError("");
    setNoticeShown(false);
    setBusy(true);
    setPendingAction("status");
    inFlight.current = true;
    getIdToken().then(token => current === generation.current
      ? sourceMediaOriginal(token, asset.sourceId, asset.id, "status") : null)
      .then(result => {
        if (current !== generation.current || !result) return;
        setOriginal(result);
        if (["archived", "restoring"].includes(result.state)) setNoticeShown(true);
      }).catch(() => {
        if (current !== generation.current) return;
        setNoticeShown(true);
        setError("Original status could not be checked. Try again.");
      })
      .finally(() => { if (current === generation.current) { setBusy(false); inFlight.current = false; } });
    return () => { generation.current++; };
  }, [asset.id, asset.sourceId, asset.fileVersion, getIdToken]);

  useEffect(() => {
    if (!busy && returnFocus.current) {
      returnFocus.current = false;
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) checkButton.current?.focus();
    }
  }, [busy, original]);

  async function request(action: "status" | "restore") {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setBusy(true);
    setPendingAction(action);
    setError("");
    if (action === "restore") setNoticeShown(true);
    try {
      const result = await sourceMediaOriginal(await getIdToken(), asset.sourceId, asset.id, action);
      if (current !== generation.current) return;
      setOriginal(result);
      if (["archived", "restoring"].includes(result.state)) setNoticeShown(true);
    } catch (failure) {
      if (current !== generation.current) return;
      setNoticeShown(true);
      setError(failure instanceof HttpError && failure.status >= 400 && failure.status < 500
        ? failure.message : action === "restore"
        ? "The restore request could not be confirmed. Check status before trying again."
        : "Original status could not be checked. Try again.");
    } finally {
      if (current === generation.current) { returnFocus.current = true; setBusy(false); inFlight.current = false; }
    }
  }
  return { original, busy, pendingAction, error, noticeShown, checkButton, request, canManageVideo };
}

export function VideoOriginalStatus({ controls }: { controls: ReturnType<typeof useVideoOriginalStatus> }) {
  const { original, busy, pendingAction, error, checkButton, request, canManageVideo } = controls;
  const archived = original?.state === "archived";
  // Only Intelligent-Tiering originals report an archive tier. The server refuses the others for this account.
  const askManager = archived && original.archiveTier === null && !canManageVideo;
  const restoring = original?.state === "restoring";
  const availableUntil = originalAvailableUntil(original);
  if (!archived && !restoring) return <div className="button-row">
    <StatusBadge>{originalStatusLabel(original)}</StatusBadge>
    {availableUntil ? <time dateTime={original?.availableUntil}>Available until {availableUntil}</time> : null}
    <Button ref={checkButton} disabled={busy} onClick={() => void request("status")}>{busy ? "Checking original" : "Check original status"}</Button>
    {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
  </div>;
  return <InlineMessage tone="warning" title={originalStatusLabel(original)}>
    {archived ? <p>{askManager ? "Ask a person who manages video to restore this original before you download it or make an export that needs it."
      : "Restore the original before downloading it or making an export that needs it."} Standard retrieval can take up to 12 hours. A restored original stays ready for at least 7 days.</p> : null}
    {restoring ? <p>Restore is in progress. Standard retrieval can take up to 12 hours. A restored original stays ready for at least 7 days. If you requested this restore in Boardwalk, a notice will appear on your next visit to Videos after it finishes. The viewing copy and saved transcripts remain available.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {archived && !askManager ? <Button disabled={busy} onClick={() => void request("restore")}>{busy && pendingAction === "restore" ? "Requesting restore" : "Restore original"}</Button> : null}
    <Button ref={checkButton} disabled={busy} onClick={() => void request("status")}>{busy && pendingAction === "status" ? "Checking original" : "Check original status"}</Button>
  </InlineMessage>;
}

export function VideoOriginalNotices({ sourceId, getIdToken, onOpen, onDismissed }: {
  sourceId: string;
  getIdToken: () => Promise<string>;
  onOpen: (assetId: string) => void;
  onDismissed?: () => void;
}) {
  const region = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);
  const [notices, setNotices] = useState<OriginalRestoreNotice[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let current = true;
    setNotices([]);
    async function check() {
      try {
        const result = await originalRestoreNotices(await getIdToken(), sourceId);
        if (current) setNotices(result.notices);
      } catch { /* The original controls still provide a manual status check. */ }
    }
    void check();
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { current = false; document.removeEventListener("visibilitychange", onVisible); };
  }, [sourceId, getIdToken]);
  useEffect(() => {
    if (!busy && returnFocus.current) {
      returnFocus.current = false;
      const next = region.current?.querySelector<HTMLButtonElement>("button");
      if (next) next.focus(); else onDismissed?.();
    }
  }, [busy, notices, onDismissed]);
  async function dismiss(id: string) {
    setBusy(id);
    setError("");
    try {
      await dismissOriginalRestoreNotice(await getIdToken(), sourceId, id);
      returnFocus.current = true;
      setNotices(previous => previous.filter(notice => notice.id !== id));
    } catch { setError("The notice could not be dismissed. Try again."); }
    finally { setBusy(undefined); }
  }
  return <div ref={region}>
    {notices.map(notice => <InlineMessage key={notice.id} tone={notice.outcome === "restored" ? "success" : "warning"}
      title={notice.outcome === "restored" ? "Original restored" : "Original restore needs attention"}>
      <p>{notice.name}: {notice.outcome === "restored" ? "The original is ready to use." : notice.outcome === "stale"
        ? "The video changed or was removed during restore. Reopen it to check its current original."
        : "Restore was not confirmed. Check the original status or ask a CMS administrator for help."}</p>
      <Button onClick={() => onOpen(notice.assetId)}>Open video</Button>
      <Button disabled={busy === notice.id} onClick={() => void dismiss(notice.id)}>Dismiss</Button>
    </InlineMessage>)}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
