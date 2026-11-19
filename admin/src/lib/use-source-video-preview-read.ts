import { useEffect, useRef, useState } from "react";
import type { SourceMediaAssetSummary, SourceMediaRead } from "./source-media";
import { canPlayInBrowser, createVersionedSourceMediaRead, SourceMediaFileChangedError } from "./source-media-read";
import { originalAccessMessage } from "./video-original";

interface SourceVideoPreviewReadOptions {
  asset: SourceMediaAssetSummary;
  getIdToken: () => Promise<string>;
  rememberPlayback: () => void;
  setError: (error: string) => void;
  setCanRefreshPreview: (canRefresh: boolean) => void;
  onRequestIdentity: (identity: string) => void;
  onRead: (result: SourceMediaRead, identity: string) => void;
}

export function useSourceVideoPreviewRead({
  asset,
  getIdToken,
  rememberPlayback,
  setError,
  setCanRefreshPreview,
  onRequestIdentity,
  onRead,
}: SourceVideoPreviewReadOptions) {
  const [attempt, setAttempt] = useState(0);
  const [renewing, setRenewing] = useState(false);
  const renewalStarted = useRef(false);

  function refreshPreview(showProgress = false) {
    if (renewalStarted.current) return;
    renewalStarted.current = true;
    rememberPlayback();
    setError("");
    setCanRefreshPreview(false);
    // Healthy expiry renewal stays silent; an explicit retry needs visible progress.
    setRenewing(showProgress);
    setAttempt(value => value + 1);
  }

  useEffect(() => {
    if (!canPlayInBrowser(asset)) return;
    let current = true;
    rememberPlayback();
    setError("");
    setCanRefreshPreview(false);
    const identity = `${asset.sourceId}/${asset.id}/${asset.fileVersion ?? ""}`;
    onRequestIdentity(identity);
    getIdToken().then(token => current ? createVersionedSourceMediaRead(token, asset, "preview") : undefined)
      .then(result => {
        if (!current || !result) return;
        renewalStarted.current = false;
        onRead(result, identity);
        setRenewing(false);
      })
      .catch(cause => { if (current) {
        renewalStarted.current = false;
        setRenewing(false);
        const originalMessage = cause instanceof SourceMediaFileChangedError ? cause.message : originalAccessMessage(cause);
        setCanRefreshPreview(!originalMessage);
        setError(originalMessage ?? "The preview could not be opened. Try again or download the original file.");
      } });
    return () => { current = false; };
  }, [asset.id, asset.sourceId, asset.fileVersion, asset.preview, asset.viewingCopy?.state, attempt, getIdToken]);

  return { renewing, refreshPreview };
}
