import { ControlSizingProvider, useControlSize } from "../context/ControlSizingContext";
import { MediaDialogContext, type MediaDialogNavigation } from "../context/MediaDialogContext";
import { MediaViewerNavigation } from "./media/MediaViewerNavigation";
import { useEffect, useId, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { Button } from "./ui/Primitives";
import { Icon } from "./ui/Icon";
import { ActionControl } from "./ui/ActionControl";
import { EditorOverlayOwner } from "./EditorOverlayOwner";
export { useOverlayOwner } from "./EditorOverlayOwner";
import "./ComponentEditorDialog.css";
import "./ComponentPhonePreview.css";

function focusedElement(): HTMLElement | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active instanceof HTMLElement ? active : null;
}


function FloatingPreview({ children, open, visible, onClose }: { children: ReactNode; open: boolean; visible: boolean; onClose: () => void }) {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 1120);
  const [collapsed, setCollapsed] = useState(() => window.innerWidth <= 1120);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number }>();
  const contentId = useId();
  function move(left: number, top: number) {
    const bounds = panel.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) return;
    const next = { left: Math.max(8, Math.min(left, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) };
    setPosition(current => current?.left === next.left && current.top === next.top ? current : next);
  }
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth <= 1120;
      setNarrow(next);
      if (next) setCollapsed(true);
      if (position) move(position.left, position.top);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [position]);
  useEffect(() => {
    const element = panel.current;
    if (!element || !open || !visible || narrow || !position) return;
    let frame: number | null = null;
    const fit = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        move(position.left, position.top);
      });
    };
    // A new phone size can make a previously dragged panel taller.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(element);
    fit();
    return () => {
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [collapsed, narrow, open, visible, position?.left, position?.top]);
  return <aside ref={panel} hidden={!visible} className="component-phone-preview" aria-label="Component phone preview"
    data-collapsed={collapsed || undefined} data-inline={narrow || undefined}
    style={!narrow && position ? { left: position.left, top: position.top, right: "auto" } : undefined}>
    <header className="component-phone-preview-header">
      {!narrow ? <Button className="component-phone-preview-move" aria-label="Move component preview" title="Drag or use arrow keys"
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          const bounds = panel.current!.getBoundingClientRect();
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const start = drag.current;
          if (start?.pointerId === event.pointerId) move(start.left + event.clientX - start.x, start.top + event.clientY - start.y);
        }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}
        onKeyDown={event => {
          const offsets: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
          const offset = offsets[event.key];
          if (!offset) return;
          event.preventDefault();
          const bounds = panel.current!.getBoundingClientRect();
          const distance = event.shiftKey ? 40 : 10;
          move(bounds.left + offset[0] * distance, bounds.top + offset[1] * distance);
        }}><Icon name="grip" /></Button> : null}
      <strong>Phone preview</strong>
      <Button aria-label={collapsed ? "Expand component preview" : "Collapse component preview"}
        aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed(value => !value)}>
        <Icon name={collapsed ? "chevron-down" : "chevron-up"} />
      </Button>
      <Button aria-label="Close component preview" onClick={onClose}><Icon name="close" /></Button>
    </header>
    <div id={contentId} hidden={collapsed}>{open && visible && !collapsed ? children : null}</div>
  </aside>;
}

export function ComponentEditorDialog(props: Parameters<typeof ComponentEditorDialogContent>[0]) {
  const inheritedSize = useControlSize();
  return <ControlSizingProvider size={props.variant === "media" ? "standard" : inheritedSize ?? "legacy"}>
    <ComponentEditorDialogContent {...props} />
  </ControlSizingProvider>;
}

function ComponentEditorDialogContent({
  open, onClose, title, description, children, body, settings, sections, layout, preview, disabled = false, focusTargetId, footerNote = "Changes stay in this draft. Save when ready.", closeLabel = "Done", closeActionLabel, className, closeVariant, settingsLabel, closeDisabled = false, footerActions, headerActions, headerFacts, headerSteps, headerNavigation, onFrameKeyDown, variant,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  /** Replaces the standard content/settings slots while keeping this dialog mounted. */
  body?: ReactNode;
  settings?: ReactNode;
  sections?: ReactNode;
  layout?: "video";
  preview?: ReactNode;
  disabled?: boolean;
  focusTargetId?: string;
  footerNote?: string | null;
  closeLabel?: string;
  closeActionLabel?: string;
  className?: string;
  closeVariant?: "primary" | "secondary";
  closeDisabled?: boolean;
  settingsLabel?: string;
  footerActions?: ReactNode;
  headerActions?: ReactNode;
  variant?: "media" | "content";
  headerFacts?: ReactNode;
  headerSteps?: ReactNode;
  headerNavigation?: MediaDialogNavigation;
  onFrameKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const [noticeTarget, setNoticeTarget] = useState<HTMLDivElement | null>(null);
  const [contextActionsTarget, setContextActionsTarget] = useState<HTMLDivElement | null>(null);
  const [commandsTarget, setCommandsTarget] = useState<HTMLDivElement | null>(null);
  const [compactActions, setCompactActions] = useState(() => window.innerWidth <= 780);
  useEffect(() => {
    const update = () => setCompactActions(window.innerWidth <= 780);
    window.addEventListener("resize", update);
    update();
    return () => window.removeEventListener("resize", update);
  }, []);
  const [previewVisible, setPreviewVisible] = useState(true);
  const previewToggle = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!dialog) return;
    if (open && !disabled && !dialog.closest("[inert]")) {
      if (!dialog.open) {
        opener.current = focusedElement();
        const target = document.getElementById(focusTargetId ?? (variant === "media" ? titleId : ""));
        if (variant === "media" && target && dialog.contains(target)) target.setAttribute("autofocus", "");
        dialog.showModal();
        if (target instanceof HTMLElement && dialog.contains(target)) target.focus();
      } else if (typeof CSS !== "undefined" && CSS.supports?.("selector(:modal)") && !dialog.matches(":modal")) {
        // Moving a row's existing DOM host removes its dialog from the top layer
        // without clearing `open`. Restore modality without replacing the editor.
        const innerFocus = dialog.contains(document.activeElement) ? focusedElement() : null;
        dialog.close();
        dialog.showModal();
        if (innerFocus?.isConnected) innerFocus.focus({ preventScroll: true });
      }
    } else if (dialog.open) {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  });

  useEffect(() => () => {
    if (opener.current?.isConnected) opener.current.focus();
  }, []);

  return (
    <dialog
      ref={setDialog}
      className={["component-editor-dialog", className].filter(Boolean).join(" ")}
      data-framing={variant}
      data-layout={layout}
      data-preview={preview && previewVisible ? "true" : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      data-viewer-keys={onFrameKeyDown ? "on" : undefined}
      onKeyDown={onFrameKeyDown}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (!closeDisabled) onClose();
      }}
      onClose={(event) => {
        if (!open || !closeDisabled || disabled) return;
        const closedDialog = event.currentTarget;
        queueMicrotask(() => {
          if (closedDialog.isConnected && !closedDialog.open && !closedDialog.closest("[inert]")) {
            closedDialog.showModal();
          }
        });
      }}
    >
      <MediaDialogContext.Provider value={{ actionsInHeader: variant === "media", noticeTarget, contextActionsTarget, commandsTarget, navigation: headerNavigation, compactActions }}>
      <EditorOverlayOwner.Provider value={dialog}>
        <header className="component-editor-dialog-header" data-media-preview={variant === "media" ? "true" : undefined}>
          <div>
            <h2 id={titleId} title={variant === "media" ? title : undefined} tabIndex={variant === "media" ? -1 : undefined} className={variant === "media" ? "programmatic-focus-target" : undefined}>{title}</h2>
            {headerSteps && variant !== "media" ? <div className="media-preview-header-position">{headerSteps}</div> : null}
            {description ? <p id={descriptionId}>{description}</p> : null}
            {headerFacts ? <div className="media-preview-header-facts">{headerFacts}</div> : null}
          </div>
          {variant === "media" && (headerNavigation || headerSteps) ? <div className="media-preview-header-position">{headerNavigation ? <MediaViewerNavigation navigation={headerNavigation} announcePosition={!compactActions} /> : headerSteps}</div> : null}
          {variant === "media" && compactActions && headerNavigation ? <span className="sr-only" role="status" aria-atomic="true">{headerNavigation.position}</span> : null}
          {variant === "media" ? <div className="media-frame-context-actions" ref={setContextActionsTarget} /> : null}
          {variant === "media" && footerActions ? <div className="component-editor-dialog-save-actions">{footerActions}</div> : null}
          {variant === "media" ? <div className="media-frame-commands" ref={setCommandsTarget} /> : null}
          {headerActions ? <div className="component-editor-dialog-header-actions">{headerActions}</div> : null}
          <ActionControl action="close" className={variant === "media" ? "media-preview-close" : undefined} label={closeActionLabel ?? (variant === "media" ? "Close" : `Close ${title}`)} disabled={closeDisabled} onClick={onClose} />
        </header>
        {variant === "media" ? <div className="media-dialog-notices" data-viewer-keys="off" ref={setNoticeTarget} /> : null}
        <div className="component-editor-dialog-body" data-settings={settings || body ? "true" : undefined}>
          {body ?? <>
            <div className="component-editor-dialog-content">{children}</div>
            {settings ? <aside className="component-editor-dialog-settings" role={layout === "video" ? "none" : undefined}
              aria-label={layout === "video" ? undefined : settingsLabel ?? `${title} settings`}>{settings}</aside> : null}
            {sections ? <div className="component-editor-dialog-sections">{sections}</div> : null}
          </>}
          {preview ? <FloatingPreview visible={previewVisible} open={open && !disabled} onClose={() => { setPreviewVisible(false); previewToggle.current?.focus(); }}>{preview}</FloatingPreview> : null}
        </div>
        <footer className="component-editor-dialog-footer">
          {footerNote ? <p>{footerNote}</p> : null}
          {preview ? <Button ref={previewToggle} aria-expanded={previewVisible} onClick={() => setPreviewVisible(value => !value)}>Phone preview</Button> : null}
          {variant !== "media" ? <>{footerActions}
            <Button onClick={onClose} disabled={closeDisabled} variant={closeVariant ?? (footerActions ? undefined : "primary")}>{closeLabel}</Button>
          </> : null}
        </footer>
      </EditorOverlayOwner.Provider>
      </MediaDialogContext.Provider>
    </dialog>
  );
}
