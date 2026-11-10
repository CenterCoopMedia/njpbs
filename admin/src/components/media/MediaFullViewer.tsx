import { focusMediaDialogNavigation, mediaDialogNavigation } from "./MediaViewerNavigation";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type {
  MediaAssetRef,
  R2MediaAssetRef,
  S3MediaAssetRef,
} from "../../lib/media-identity";
import {
  stepPosition,
  stepTarget,
  viewerKeyAction,
  type StepDirection,
} from "../../lib/media-step";
import { ComponentEditorDialog } from "../ComponentEditorDialog";
import { MediaDialogNotice } from "../../context/MediaDialogContext";
import { Button, InlineMessage } from "../ui/Primitives";
import "./MediaFullViewer.css";

interface MediaFullViewerItemBase {
  name: string;
  facts?: ReactNode;
  /** Use MediaPreviewHeaderActions to join the shared phone command/navigation slots. */
  actions?: ReactNode;
  footerNote?: string | null;
}

export type MediaFullViewerItem =
  | (MediaFullViewerItemBase & {
      ref: R2MediaAssetRef;
      kind: "image" | "document" | "audio";
    })
  | (MediaFullViewerItemBase & {
      ref: S3MediaAssetRef;
      kind: "video";
    });

export interface MediaFullViewerBodyContext {
  item: MediaFullViewerItem;
  /** Put this before the body editor so a dirty close or step remains in the active body. */
  dirtyPrompt?: ReactNode;
  headerActionsTarget: HTMLDivElement | null;
  headerFactsTarget: HTMLSpanElement | null;
  /** Stable dialog header slot for the body's native Save details action. */
  footerActionsTarget: HTMLDivElement | null;
  /** Body owners report their current state and reset it to false when they unmount. */
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  /** Transient requests block this viewer, without marking the route as unsaved. */
  onBusyChange: (busy: boolean) => void;
}

interface MediaFullViewerPropsBase {
  activeRef: MediaAssetRef;
  items: readonly MediaFullViewerItem[];
  onClose: (item: MediaFullViewerItem) => void;
  onStep: (item: MediaFullViewerItem) => void;
  renderBody: (context: MediaFullViewerBodyContext) => ReactNode;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  /** A route-owned prompt can stop the shell while that prompt resolves. */
  navigationBlocked?: boolean;
}

export type MediaFullViewerProps = MediaFullViewerPropsBase & (
  | {
      /** Return true after focusing this visible card. False lets the shell try its fallback order. */
      focusItem: (ref: MediaAssetRef) => boolean;
      focusFallback: () => void;
    }
  | {
      focusItem?: undefined;
      focusFallback?: undefined;
    }
);

export function mediaFullViewerKey(ref: MediaAssetRef): string {
  return ref.backend === "r2" ? `r2:${ref.id}` : `s3:${ref.sourceId}:${ref.id}`;
}

function sameRef(left: MediaAssetRef, right: MediaAssetRef): boolean {
  return mediaFullViewerKey(left) === mediaFullViewerKey(right);
}

/**
 * Focus the item shown at close. If it left the view, scan forward, then backward, before the
 * route's results-heading fallback.
 */
export function restoreMediaFullViewerFocus(
  items: readonly MediaFullViewerItem[],
  activeRef: MediaAssetRef,
  focusItem: (ref: MediaAssetRef) => boolean,
  focusFallback: () => void,
): void {
  const index = items.findIndex(item => sameRef(item.ref, activeRef));
  const candidates = index < 0
    ? []
    : [
        items[index],
        ...items.slice(index + 1),
        ...items.slice(0, index).reverse(),
      ];
  if (!candidates.some(item => focusItem(item.ref))) focusFallback();
}

function bodyLabel(kind: MediaFullViewerItem["kind"]): string {
  if (kind === "audio") return "Audio viewer";
  if (kind === "image") return "Image viewer";
  if (kind === "document") return "Document viewer";
  return "Video viewer";
}

export function MediaFullViewer({
  activeRef,
  focusFallback,
  focusItem,
  items,
  navigationBlocked = false,
  onClose,
  onDirtyChange,
  onSavingChange,
  onStep,
  renderBody,
}: MediaFullViewerProps) {
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null);
  const [footerActionsTarget, setFooterActionsTarget] = useState<HTMLDivElement | null>(null);
  const [headerFactsTarget, setHeaderFactsTarget] = useState<HTMLSpanElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"close" | StepDirection>();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const promptOpener = useRef<HTMLElement | null>(null);
  const pendingStepFocus = useRef<{ direction: StepDirection; targetKey: string }>();
  const lastVisible = useRef<{ key: string; item: MediaFullViewerItem; items: readonly MediaFullViewerItem[] }>();
  const itemKeys = useMemo(() => items.map(item => mediaFullViewerKey(item.ref)), [items]);
  const activeKey = mediaFullViewerKey(activeRef);
  const activeItem = items.find(item => mediaFullViewerKey(item.ref) === activeKey);
  const previousKey = stepTarget(itemKeys, activeKey, "previous");
  const nextKey = stepTarget(itemKeys, activeKey, "next");
  const position = stepPosition(itemKeys, activeKey);

  useEffect(() => {
    if (activeItem) {
      lastVisible.current = { key: activeKey, item: activeItem, items };
      return;
    }
    const previous = lastVisible.current;
    if (!previous || previous.key !== activeKey) return;
    lastVisible.current = undefined;
    onClose(previous.item);
    if (focusItem && focusFallback) {
      requestAnimationFrame(() => restoreMediaFullViewerFocus(previous.items, previous.item.ref, focusItem, focusFallback));
    }
  }, [activeItem, activeKey, focusFallback, focusItem, items, onClose]);

  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onSavingChange?.(saving);
    return () => onSavingChange?.(false);
  }, [onSavingChange, saving]);
  useEffect(() => {
    if (!dirty) setConfirmAction(undefined);
  }, [dirty]);
  useEffect(() => {
    if (navigationBlocked) setConfirmAction(undefined);
  }, [navigationBlocked]);
  useEffect(() => {
    if (confirmAction) keepEditing.current?.focus();
  }, [confirmAction]);
  useEffect(() => {
    const pending = pendingStepFocus.current;
    if (!pending || pending.targetKey !== activeKey) return;
    pendingStepFocus.current = undefined;
    const frame = requestAnimationFrame(() => {
      focusMediaDialogNavigation(pending.direction, previousButton.current, nextButton.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeKey]);

  if (!activeItem) return null;

  function itemForKey(key: string | null): MediaFullViewerItem | undefined {
    return key ? items.find(item => mediaFullViewerKey(item.ref) === key) : undefined;
  }

  function finish(action: "close" | StepDirection) {
    setConfirmAction(undefined);
    if (action === "close") {
      const closingItem = activeItem as MediaFullViewerItem;
      onClose(closingItem);
      if (focusItem && focusFallback) {
        requestAnimationFrame(() => {
          restoreMediaFullViewerFocus(items, closingItem.ref, focusItem, focusFallback);
        });
      }
      return;
    }
    const target = itemForKey(stepTarget(itemKeys, activeKey, action));
    if (!target) return;
    const targetKey = mediaFullViewerKey(target.ref);
    pendingStepFocus.current = { direction: action, targetKey };
    onStep(target);
    requestAnimationFrame(() => {
      if (pendingStepFocus.current?.targetKey === targetKey) pendingStepFocus.current = undefined;
    });
  }

  function request(action: "close" | StepDirection, opener?: HTMLElement) {
    if (saving || busy || navigationBlocked) return;
    if (dirty) {
      promptOpener.current = opener
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setConfirmAction(action);
      return;
    }
    finish(action);
  }

  function keepCurrentItem() {
    const opener = promptOpener.current;
    setConfirmAction(undefined);
    requestAnimationFrame(() => {
      if (opener?.isConnected && (!(opener instanceof HTMLButtonElement) || !opener.disabled)) {
        opener.focus();
      }
    });
  }

  function handleFrameKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>) {
    const keyOwner = event.target instanceof Element
      ? event.target.closest('dialog, [role="dialog"]')
      : null;
    if (keyOwner !== event.currentTarget) return;
    const action = viewerKeyAction({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      defaultPrevented: event.defaultPrevented,
      target: event.target,
    }, { previous: Boolean(previousKey), next: Boolean(nextKey) });
    if (action !== "previous" && action !== "next" && action !== "close") return;
    event.preventDefault();
    event.stopPropagation();
    request(action, event.target instanceof HTMLElement ? event.target : event.currentTarget);
  }

  const dirtyPrompt = confirmAction ? (
    <MediaDialogNotice><InlineMessage tone="warning" title={`Unsaved ${activeItem.kind} changes`}>
      <p>
        {confirmAction === "close"
          ? "Close without saving your changes?"
          : `Open the ${confirmAction} item without saving your changes?`}
      </p>
      <Button disabled={saving || busy} onClick={() => finish(confirmAction)}>Discard changes</Button>
      <Button ref={keepEditing} disabled={saving || busy} onClick={keepCurrentItem}>Keep editing</Button>
    </InlineMessage></MediaDialogNotice>
  ) : undefined;
  const navigation = mediaDialogNavigation({
    position, previousRef: previousButton, nextRef: nextButton,
    previousAvailable: Boolean(previousKey), nextAvailable: Boolean(nextKey),
    blocked: saving || busy || navigationBlocked, request: (direction, opener) => request(direction, opener),
  });

  return (
    <ComponentEditorDialog
      open
      layout="video"
      title={activeItem.name}
      onClose={() => request("close")}
      closeDisabled={saving || busy || navigationBlocked}
      footerNote={activeItem.footerNote === undefined
        ? "Details save to the library record, not the file."
        : activeItem.footerNote}
      closeLabel="Close"
      closeVariant="secondary"
      headerNavigation={navigation}
      variant="media"
      headerFacts={<span ref={setHeaderFactsTarget}>{activeItem.facts}</span>}
      headerActions={(
        <div
          aria-label={`${bodyLabel(activeItem.kind)} tools`}
          className="media-full-viewer-header-actions"
          role="group"
          ref={setHeaderActionsTarget}
        >
          <Fragment key={activeKey}>{activeItem.actions}</Fragment>
        </div>
      )}
      footerActions={<div className="media-viewer-footer-slot" ref={setFooterActionsTarget} />}
      onFrameKeyDown={handleFrameKeyDown}
      body={(
        <div
          aria-label={bodyLabel(activeItem.kind)}
          className="media-full-viewer-body"
          data-media-kind={activeItem.kind}
          key={activeKey}
          role="region"
        >
          {renderBody({
            item: activeItem,
            dirtyPrompt,
            headerActionsTarget,
            headerFactsTarget,
            footerActionsTarget,
            onDirtyChange: setDirty,
            onSavingChange: setSaving,
            onBusyChange: setBusy,
          })}
        </div>
      )}
    />
  );
}
