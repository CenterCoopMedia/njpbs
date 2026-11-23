import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { mediaPermalink } from "../../lib/media-permalink";
import { mediaVideosPath } from "../../lib/routes";
import type { VideoUploadResult } from "../../lib/source-media-upload";
import { useMediaProcessingPoll } from "../../lib/use-media-processing-poll";
import { sourceMediaStatusMatches } from "../../lib/use-source-media-asset-refresh";
import { UploadTrayRows } from "./UploadTray";

// The status endpoint accepts up to 100 asset IDs per read.
const MAX_RECENT_UPLOADS = 100;
const VIDEO_LIBRARY = "video-library";
const VIEWING_COPY_MESSAGES = {
  processing: "Viewing copy processing.",
  ready: "Ready to view.",
  failed: "Viewing copy failed. Open the video to check options for the original.",
  not_prepared: "No viewing copy was prepared. Open the video to check the original.",
};

interface UploadReceipt {
  fileName: string;
  asset: VideoUploadResult;
}

const RecordUpload = createContext<((fileName: string, asset: VideoUploadResult) => void) | null>(null);
export function useRecordVideoUpload() {
  return useContext(RecordUpload);
}

/** Own completed receipts while transfer panels open, close or move between media tabs. */
export function VideoUploadResults({ userId, getIdToken, children }: {
  userId: string;
  getIdToken: () => Promise<string>;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [receipts, setReceipts] = useState<UploadReceipt[]>([]);
  const recordUpload = useCallback((fileName: string, asset: VideoUploadResult) => {
    if (asset.sourceId !== VIDEO_LIBRARY) return;
    setReceipts(previous => [
      { fileName, asset },
      ...previous.filter(receipt => receipt.asset.id !== asset.id),
    ].slice(0, MAX_RECENT_UPLOADS));
  }, []);
  const pending = receipts.filter(({ asset }) => asset.viewingCopy?.state === "processing");
  useMediaProcessingPoll(`upload-results:${userId}`, VIDEO_LIBRARY,
    pending.map(({ asset }) => asset.id), getIdToken, ({ records }, requestedIds) => {
      const currentStatuses = new Map(records.map(status => [status.id, status]));
      const checked = new Set(requestedIds);
      setReceipts(previous => previous.map(receipt => {
        const { asset } = receipt;
        if (!checked.has(asset.id) || asset.viewingCopy?.state !== "processing") return receipt;
        const status = currentStatuses.get(asset.id);
        const viewingCopy = status && sourceMediaStatusMatches(asset, status) ? status.viewingCopy : undefined;
        if (viewingCopy?.state === "processing") return receipt;
        return { ...receipt, asset: { ...asset, viewingCopy } };
      }));
    });

  return <RecordUpload.Provider value={recordUpload}>
    {receipts.length > 0 ? <details className="panel video-upload-results" open>
      <summary>Recent video uploads</summary>
      <div className="video-upload-results-list">
        <UploadTrayRows label="Completed video uploads" rows={receipts.map(({ asset, fileName }) => {
          const state = asset.viewingCopy?.state;
          const viewing = state ? VIEWING_COPY_MESSAGES[state] : "Viewing copy status unavailable.";
          const placement = asset.collectionPlacement === "added" ? " Added to the selected collection."
            : asset.collectionPlacement === "unavailable" ? " The selected collection became unavailable." : "";
          return {
            id: asset.id,
            name: fileName,
            status: "succeeded",
            message: viewing + placement,
            announceMessage: true,
            onViewAsset: state === "processing" ? undefined : () => {
              navigate(mediaPermalink(mediaVideosPath(asset.sourceId), asset.id));
            },
          };
        })} />
      </div>
    </details> : null}
    {children}
  </RecordUpload.Provider>;
}
