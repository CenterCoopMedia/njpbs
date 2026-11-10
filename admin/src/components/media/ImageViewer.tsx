import { focusMediaDialogNavigation, mediaDialogNavigation } from "./MediaViewerNavigation";
import { AudioPlayback, AudioDownload, type AudioToken } from "./AudioMedia";
import { MediaDialogNotice } from "../../context/MediaDialogContext";
import { ActionControl } from "../ui/ActionControl";
import { Menu } from "../ui/Menu";
import { MediaPreviewHeaderActions, type MediaPreviewHeaderActionsProps } from "./MediaPreviewHeaderActions";
import { mediaPermalink } from "../../lib/media-permalink";
import { mediaImagesPath, mediaVoiceoversPath } from "../../lib/routes";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ComponentEditorDialog } from "../ComponentEditorDialog";
import { Icon } from "../ui/Icon";
import { ImageViewingSurface } from "./ImageViewingSurface";
import { Button, InlineMessage } from "../ui/Primitives";
import { formatMediaBytes } from "../../lib/media-display";
import {
  stepPosition,
  stepTarget,
  viewerKeyAction,
  type StepDirection,
} from "../../lib/media-step";
import { cmsCreateMediaDownload, type MediaAssetSummary } from "../../lib/functions";
import { MediaInspector, type MediaInspectorProps } from "./MediaInspector";
import "./ImageViewer.css";

export interface ImageViewerProps extends Omit<
  MediaInspectorProps,
  "asset" | "docked" | "onClose" | "onOpenFullSize" | "onDirtyChange" | "onSavingChange" | "favoriteControl"
> {
  favorite?: MediaPreviewHeaderActionsProps["favorite"];
  asset: MediaAssetSummary;
  steppingOrder: readonly MediaAssetSummary[];
  onStep: (asset: MediaAssetSummary) => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  reloadBusy?: boolean;
  reloadError?: string;
  navigationPrompt?: ReactNode;
}

export interface ImageViewerBodyProps extends Omit<
  ImageViewerProps,
  "steppingOrder" | "onStep" | "onClose" | "onDirtyChange" | "onSavingChange" | "favoriteControl"
> {
  onDirtyChange: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
  closePrompt?: ReactNode;
  navigationPrompt?: ReactNode;
  reloadError?: string;
}

function NonImagePreview({ asset, getIdToken }: { asset: MediaAssetSummary; getIdToken?: AudioToken }) {
  if (asset.kind === "audio") return <AudioPlayback asset={asset} getIdToken={getIdToken} />;
  return <div className="image-viewer-document">
    <span aria-hidden="true" className="image-viewer-document-mark"><Icon name="file" /><strong>PDF</strong></span>
    <p>A preview is not available for this PDF.</p>
    <a href={asset.url} rel="noreferrer" target="_blank">Open original <Icon name="external-link" /></a>
  </div>;
}

// The public media domain serves files inline, and a browser ignores the download attribute on a
// cross-origin link. The server signs a short read that answers with an attachment
// Content-Disposition, so the browser saves the file under its original name and the page stays.
function LibraryFileDownload({ asset, getIdToken }: { asset: MediaAssetSummary; getIdToken?: AudioToken }) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function download(variant?: "original" | "web") {
    if (state === "busy") return;
    setState("busy");
    try {
      if (!getIdToken) throw new Error("Sign in again to download.");
      const result = variant
        ? await cmsCreateMediaDownload(await getIdToken(), asset.id, variant)
        : await cmsCreateMediaDownload(await getIdToken(), asset.id);
      if (!mounted.current) return;
      const link = document.createElement("a");
      link.href = result.url;
      link.rel = "noreferrer";
      link.download = result.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setState("idle");
    } catch {
      if (mounted.current) setState("error");
    }
  }
  return <>
    <Menu label="Download" icon="download" variant="primary" disabled={state === "busy"} items={asset.kind === "image" && asset.originalAvailable ? [
      { key: "original", label: `Original (${asset.originalFormat ? `${asset.originalFormat}, ` : ""}full quality)`, onSelect: () => void download("original") },
      { key: "web", label: `Web copy (${asset.mimeType === "image/webp" ? "WebP" : asset.mimeType.split("/")[1].toUpperCase()})`, description: formatMediaBytes(asset.sizeBytes), onSelect: () => void download("web") },
    ] : [
      { key: "original", label: "Original", description: formatMediaBytes(asset.sizeBytes), onSelect: () => void download() },
    ]}>Download</Menu>
    {state === "error" ? <InlineMessage tone="error" title="The file could not be downloaded">Try again.</InlineMessage> : null}
  </>;
}

// Built-in site images have no stored object, only a public site URL, so no signed read exists.
// They keep the earlier behavior and open the file.
function SiteFileDownload({ asset }: { asset: MediaAssetSummary }) {
  function open() {
    const link = document.createElement("a");
    link.href = asset.url;
    link.rel = "noreferrer";
    link.target = "_blank";
    link.download = asset.originalName;
    document.body.append(link);
    link.click();
    link.remove();
  }
  return <Menu label="Download" icon="download" variant="primary" items={[
    { key: "original", label: "Original", description: formatMediaBytes(asset.sizeBytes), onSelect: open },
  ]}>Download</Menu>;
}

export function ImageDownload({ asset, getIdToken }: { asset: MediaAssetSummary; getIdToken?: AudioToken }) {
  if (asset.source === "voiceover") return <AudioDownload asset={asset} getIdToken={getIdToken} />;
  if (asset.source === "site_seed") return <SiteFileDownload asset={asset} />;
  return <LibraryFileDownload key={asset.id} asset={asset} getIdToken={getIdToken} />;
}

export function ImageViewerBody({
  asset,
  getIdToken,
  closePrompt,
  navigationPrompt,
  reloadError,
  reloadBusy = false,
  onDirtyChange,
  onSavingChange,
  ...inspectorProps
}: ImageViewerBodyProps) {
  const inspector = <MediaInspector
    {...inspectorProps}
    asset={asset}
    getIdToken={getIdToken}
    docked
    locked={reloadBusy}
    onDirtyChange={onDirtyChange}
    onSavingChange={onSavingChange}
  />;
  if (asset.kind === "image") return <>
    {closePrompt}
    <MediaDialogNotice>{navigationPrompt}{reloadError ? <InlineMessage tone="error" title="Reload failed">{reloadError}</InlineMessage> : null}</MediaDialogNotice>
    <ImageViewingSurface asset={asset} inspector={inspector} />
  </>;
  return <>
    <div className="component-editor-dialog-content image-viewer-content">
      {closePrompt}
      {reloadError ? <InlineMessage tone="error" title="Reload failed">{reloadError}</InlineMessage> : null}
      <NonImagePreview asset={asset} getIdToken={getIdToken} />
    </div>
    <aside className="component-editor-dialog-settings image-viewer-settings" role="none">
      {navigationPrompt}{inspector}
    </aside>
  </>;
}

export function imageViewerFacts(asset: MediaAssetSummary): string {
  const created = asset.createdAt ? new Date(asset.createdAt) : null;
  return [
    asset.mimeType.split("/").pop()?.replace(/\+xml$/i, "").toUpperCase() || asset.mimeType,
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : null,
    formatMediaBytes(asset.sizeBytes),
    created && Number.isFinite(created.getTime())
      ? created.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : null,
  ].filter(Boolean).join(" · ");
}

export function ImageViewerHeaderActions({
  asset,
  getIdToken,
  favorite,
}: {
  asset: MediaAssetSummary;
  getIdToken?: AudioToken;
  favorite?: MediaPreviewHeaderActionsProps["favorite"];
}) {
  return <MediaPreviewHeaderActions
    downloads={<ImageDownload asset={asset} getIdToken={getIdToken} />}
    favorite={favorite}
    copyLink={mediaPermalink(asset.kind === "audio" ? mediaVoiceoversPath() : mediaImagesPath(), asset.id)}
  />;
}

export function ImageViewer({
  asset,
  onClose,
  onDirtyChange,
  onSavingChange,
  onStep,
  steppingOrder,
  reloadBusy = false,
  reloadError,
  navigationPrompt,
  favorite,
  ...bodyProps
}: ImageViewerProps) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"close" | StepDirection>();
  const [footerTarget, setFooterTarget] = useState<HTMLDivElement | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const promptOpener = useRef<HTMLElement | null>(null);
  const pendingStepFocus = useRef<StepDirection>();
  const orderIds = useMemo(() => steppingOrder.map((item) => item.id), [steppingOrder]);
  const previousId = stepTarget(orderIds, asset.id, "previous");
  const nextId = stepTarget(orderIds, asset.id, "next");
  const position = stepPosition(orderIds, asset.id);
  const facts = imageViewerFacts(asset);

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onSavingChange(busy);
    return () => onSavingChange(false);
  }, [busy, onSavingChange]);
  useEffect(() => {
    if (!dirty) setConfirmAction(undefined);
  }, [dirty]);
  useEffect(() => {
    if (navigationPrompt) setConfirmAction(undefined);
  }, [navigationPrompt]);
  useEffect(() => {
    if (confirmAction) keepEditing.current?.focus();
  }, [confirmAction]);
  useEffect(() => {
    const direction = pendingStepFocus.current;
    if (!direction) return;
    pendingStepFocus.current = undefined;
    const frame = requestAnimationFrame(() => {
      focusMediaDialogNavigation(direction, previousButton.current, nextButton.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [asset.id, nextId, previousId]);

  function finish(action: "close" | StepDirection) {
    setConfirmAction(undefined);
    if (action === "close") {
      onClose();
      return;
    }
    const targetId = stepTarget(orderIds, asset.id, action);
    const target = steppingOrder.find((item) => item.id === targetId);
    if (!target) return;
    pendingStepFocus.current = action;
    onStep(target);
  }

  function request(action: "close" | StepDirection, opener?: HTMLElement) {
    if (busy || reloadBusy || navigationPrompt) return;
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

  const closePrompt = confirmAction && !navigationPrompt ? (
    <InlineMessage tone="warning" title={`Unsaved ${asset.kind} changes`}>
      <p>
        {confirmAction === "close"
          ? "Close without saving your changes?"
          : `Open the ${confirmAction} item without saving your changes?`}
      </p>
      <Button disabled={busy || reloadBusy} onClick={() => finish(confirmAction)}>Discard changes</Button>
      <Button ref={keepEditing} disabled={busy || reloadBusy} onClick={keepCurrentItem}>Keep editing</Button>
    </InlineMessage>
  ) : null;

  const navigation = mediaDialogNavigation({
    position, previousRef: previousButton, nextRef: nextButton,
    previousAvailable: Boolean(previousId), nextAvailable: Boolean(nextId),
    blocked: busy || reloadBusy || Boolean(navigationPrompt), request: (direction, opener) => request(direction, opener),
  });

  return (
    <ComponentEditorDialog
      open
      layout="video"
      title={asset.name}
      onClose={() => request("close")}
      closeDisabled={busy || reloadBusy || Boolean(navigationPrompt)}
      footerNote="Details save to the library record, not the file."
      closeLabel="Close"
      closeVariant="secondary"
      headerNavigation={navigation}
      variant="media"
      headerFacts={facts}
      headerActions={<ImageViewerHeaderActions getIdToken={bodyProps.getIdToken} key={asset.id} asset={asset} favorite={favorite} />}
      footerActions={<div className="media-viewer-footer-slot" ref={setFooterTarget} />}
      onFrameKeyDown={(event) => {
        if (navigationPrompt) return;
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
        }, { previous: Boolean(previousId), next: Boolean(nextId) });
        if (action !== "previous" && action !== "next" && action !== "close") return;
        event.preventDefault();
        event.stopPropagation();
        request(action, event.target instanceof HTMLElement ? event.target : event.currentTarget);
      }}
      body={(
        <ImageViewerBody
          key={asset.id}
          {...bodyProps}
          asset={asset}
          footerTarget={footerTarget}
          onDirtyChange={setDirty}
          onSavingChange={setBusy}
          closePrompt={<MediaDialogNotice>{closePrompt}</MediaDialogNotice>}
          navigationPrompt={navigationPrompt}
          reloadBusy={reloadBusy}
          reloadError={reloadError}
        />
      )}
    />
  );
}
