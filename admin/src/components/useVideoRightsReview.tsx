import { useRef, useState, type MouseEvent } from "react";
import { deferEditor } from "./DeferredEditor";

const VideoRightsDialog = deferEditor(() => import("./VideoRightsDialog").then(module => module.VideoRightsDialog), "Video rights").Editor;

/** Keep the dialog mounted when its warning and Review trigger disappear after save. */
export function useVideoRightsReview(assetId: string, onDirtyChange?: (dirty: boolean) => void) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const fallback = useRef<HTMLElement | null>(null);
  return {
    open(event: MouseEvent<HTMLButtonElement>) {
      trigger.current = event.currentTarget;
      fallback.current = event.currentTarget.closest<HTMLElement>(".block-card, .video-block-editor");
      setOpen(true);
    },
    dialog: open && assetId ? <VideoRightsDialog key={assetId} assetId={assetId} onDirtyChange={onDirtyChange} onClose={() => {
      setOpen(false);
      (trigger.current?.isConnected ? trigger.current : fallback.current)?.focus({ preventScroll: true });
    }} /> : null,
  };
}
