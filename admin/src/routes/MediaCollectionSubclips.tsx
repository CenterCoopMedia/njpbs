import { useEffect, useRef, useState } from "react";
import type { Principal } from "../../../packages/content-core/src/rbac";
import { AsyncActionButton, Button, InlineMessage } from "../components/ui/Primitives";
import { openMediaCollectionSubclip, type MediaCollectionSubclip, type MediaCollectionSubclipRef } from "../lib/media-collections";
import type { SourceMediaAssetSummary } from "../lib/source-media";
import { videoTime } from "../lib/video-production";
import { VideoPreview } from "./SourceMediaLibrary";

const replacedMessage = "This subclip belongs to a previous video file.";
const unavailableRangeMessage = "This range is unavailable in the current viewing copy.";

export function MediaCollectionSubclips({ items, collectionId, principal, getIdToken, disabled, canRemove, onRemove, onDirtyChange, onSavingChange, onViewerOpenChange, navigationBlocked, onKeepNavigation, onDiscardNavigation }: {
  items: readonly MediaCollectionSubclip[];
  collectionId: string;
  principal: Principal;
  getIdToken: () => Promise<string>;
  disabled: boolean;
  canRemove: boolean;
  onRemove: (ref: MediaCollectionSubclipRef) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  onViewerOpenChange: (open: boolean) => void;
  navigationBlocked: boolean;
  onKeepNavigation: () => void;
  onDiscardNavigation: () => void;
}) {
  const [opened, setOpened] = useState<Awaited<ReturnType<typeof openMediaCollectionSubclip>>>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  const active = useRef<AbortController>();
  useEffect(() => () => active.current?.abort(), []);
  const viewerOpen = Boolean(opened);
  useEffect(() => {
    if (!viewerOpen) return;
    onViewerOpenChange(true);
    return () => onViewerOpenChange(false);
  }, [onViewerOpenChange, viewerOpen]);

  async function open(item: MediaCollectionSubclip) {
    if (active.current || disabled || !item.available || item.subclip.state !== "current") return;
    const controller = new AbortController();
    active.current = controller;
    setPending(item.ref.id);
    setError("");
    try {
      const token = await getIdToken();
      if (controller.signal.aborted) return;
      const result = await openMediaCollectionSubclip(token, collectionId, item.ref.id, controller.signal);
      if (controller.signal.aborted) return;
      setOpened(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "This collection subclip could not be opened.");
    } finally {
      if (!controller.signal.aborted) setPending(undefined);
      active.current = undefined;
    }
  }

  function updateAsset(asset: SourceMediaAssetSummary) {
    if (!opened) return;
    if (asset.fileVersion !== opened.subclip.fileVersion) {
      setError(replacedMessage);
      setOpened(undefined);
    } else if (asset.viewingCopy?.state !== "ready" || Math.floor((asset.viewingCopy.durationSeconds ?? 0) * 1000) < opened.subclip.outMs) {
      setError(unavailableRangeMessage);
      setOpened(undefined);
    } else {
      setOpened({ ...opened, asset });
    }
  }

  return <section className="media-collection-subclips" aria-label="Collection subclips">
    <h4>Subclips</h4>
    {error ? <InlineMessage tone="error" title="Subclip needs attention">{error}</InlineMessage> : null}
    <ul className="video-recent-clips">{items.map(item => {
      const clip = item.available ? item.subclip : null;
      return <li key={item.ref.id}>
        <p><strong>{clip?.name ?? "Unavailable subclip"}</strong>{clip ? <><br />{videoTime(clip.inMs / 1000)} to {videoTime(clip.outMs / 1000)}</> : null}</p>
        {!clip ? <p>The source video for this subclip is no longer available.</p>
          : clip.state === "replaced" ? <p>{replacedMessage}</p>
          : clip.state === "unavailable" ? <p>{unavailableRangeMessage}</p> : null}
        <div className="video-production-buttons">
          {clip?.state === "current" ? <AsyncActionButton label="Open range" aria-label={`Open range for ${clip.name}`}
            pending={pending === item.ref.id} pendingLabel="Opening" disabled={disabled || Boolean(pending)} onClick={() => void open(item)} /> : null}
          {canRemove ? <Button disabled={disabled || Boolean(pending)} aria-label={`Remove ${clip?.name ?? "unavailable subclip"} from collection`}
            onClick={() => onRemove(item.ref)}>Remove</Button> : null}
        </div>
      </li>;
    })}</ul>
    {opened ? <VideoPreview principal={principal} asset={opened.asset} getIdToken={getIdToken}
      initialClipRange={opened.subclip} initialSeek={opened.subclip.inMs / 1000} onClose={() => setOpened(undefined)}
      canEditMetadata={false} canRequestProduction={opened.canRequestProduction} canDelete={false}
      onDeleted={() => setOpened(undefined)} onUpdated={updateAsset}
      onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} navigationBlocked={navigationBlocked}
      onKeepNavigation={onKeepNavigation} onDiscardNavigation={onDiscardNavigation} /> : null}
  </section>;
}
