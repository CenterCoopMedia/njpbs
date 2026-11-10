import { AudioPlayback, type AudioToken } from "./AudioMedia";
import type { MediaAssetSummary } from "../../lib/functions";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/Primitives";
import { Icon } from "../ui/Icon";
import { FOCUSABLE, useOverlayRoot } from "../ui/floating";
import "./QuickLook.css";

export interface QuickLookItem {
  id: string;
  name: string;
  kind: "image" | "video" | "document" | "audio";
  audio?: MediaAssetSummary;
  previewUrl?: string | null;
  originalUrl?: string;
  alt?: string;
}

export interface QuickLookProps {
  getIdToken?: AudioToken;
  item: QuickLookItem;
  /** One-based position in the fixed page order. */
  position: number;
  count: number;
  onStep: (direction: "previous" | "next") => void;
  onClose: (restoreFocus?: boolean) => void;
  onPreviewError?: (item: QuickLookItem) => void;
}

const itemType = {
  audio: "Audio",
  image: "Image",
  video: "Video",
  document: "PDF document",
} as const;

/**
 * A nonmodal preview over the media results. Its callers own source selection, poster reads,
 * page order and focus restoration; this component adds no request and does not prefetch.
 */
export function QuickLook({ getIdToken, item, position, count, onClose, onStep, onPreviewError }: QuickLookProps) {
  const root = useOverlayRoot();
  const [failedPreview, setFailedPreview] = useState("");
  const previewKey = JSON.stringify([item.id, item.previewUrl]);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const previousAvailable = position > 1;
  const nextAvailable = position < count;

  useLayoutEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (!panel || event.composedPath().includes(panel)) return;
      const target = event.target instanceof Element ? event.target : null;
      const label = target?.closest("label");
      const interactive = target?.closest(`${FOCUSABLE}, [data-media-item]`)
        || (label instanceof HTMLLabelElement && label.control?.matches(FOCUSABLE) && !label.control.matches(":disabled"));
      if (!interactive) event.preventDefault();
      close.current(!interactive);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  function closeFromKey(event: KeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
  }

  function step(direction: "previous" | "next") {
    if ((direction === "previous" && position === 2 && document.activeElement === previousRef.current)
      || (direction === "next" && position === count - 1 && document.activeElement === nextRef.current)
      || panelRef.current?.querySelector(".media-quick-look-frame")?.contains(document.activeElement)) {
      closeRef.current?.focus();
    }
    onStep(direction);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const modified = event.metaKey || event.ctrlKey;
    if (event.altKey) return;
    if (event.key === "Escape" || (modified && !event.shiftKey && event.key.toLowerCase() === "y")) {
      closeFromKey(event);
      return;
    }
    if (!modified && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowLeft" && previousAvailable) step("previous");
      if (event.key === "ArrowRight" && nextAvailable) step("next");
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = controls[0];
    const last = controls.at(-1);
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      closeFromKey(event);
    }
  }

  if (!root) return null;

  return createPortal(
    <div
      aria-label={`Quick Look: ${item.name}`}
      aria-modal="false"
      className="media-quick-look"
      onKeyDown={onKeyDown}
      ref={panelRef}
      role="dialog"
    >
      <header className="media-quick-look-head">
        <div>
          <h2>{item.name}</h2>
          <p>{itemType[item.kind]}</p>
        </div>
        <Button
          aria-keyshortcuts="Escape Meta+Y Control+Y"
          aria-label="Close Quick Look"
          className="media-quick-look-close"
          onClick={() => onClose(true)}
          ref={closeRef}
          title="Close · Esc or Cmd/Ctrl+Y"
          variant="ghost"
        >
          <Icon name="close" />
        </Button>
      </header>

      <div className="media-quick-look-frame">
        {item.kind === "audio" && item.audio ? <AudioPlayback asset={item.audio} getIdToken={getIdToken} /> : item.kind === "document" ? (
          <div className="media-quick-look-document">
            <Icon name="file" />
            <strong>PDF</strong>
            {item.originalUrl ? (
              <a className="button button-secondary" href={item.originalUrl} rel="noopener noreferrer" target="_blank">
                <Icon name="external-link" />
                <span className="button-compact-label">Open original</span>
              </a>
            ) : null}
          </div>
        ) : item.previewUrl && failedPreview !== previewKey ? (
          <img alt={item.alt ?? ""} decoding="async" src={item.previewUrl} onError={() => {
            setFailedPreview(previewKey);
            onPreviewError?.(item);
          }} />
        ) : (
          <div className="media-quick-look-placeholder">
            <Icon name={item.kind === "video" ? "video" : "image"} />
            <span>Preview unavailable</span>
          </div>
        )}
      </div>

      <footer className="media-quick-look-foot">
        <Button aria-label="Previous item" disabled={!previousAvailable} onClick={() => step("previous")} ref={previousRef}>
          <Icon name="arrow-left" />
          <span className="button-compact-label">Previous</span>
        </Button>
        <p role="status">
          {position} of {count} <span>· ← → to step</span>
        </p>
        <Button aria-label="Next item" disabled={!nextAvailable} onClick={() => step("next")} ref={nextRef}>
          <span className="button-compact-label">Next</span>
          <Icon name="arrow-right" />
        </Button>
      </footer>
    </div>,
    root,
  );
}
