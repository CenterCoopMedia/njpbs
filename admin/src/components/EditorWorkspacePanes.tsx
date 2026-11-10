import { useLayoutEffect, useRef } from "react";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { ActionControl } from "./ui/ActionControl";
import { InspectorResizeHandle } from "./ui/InspectorResizeHandle";
import { Menu } from "./ui/Menu";
import { clampInspectorWidth } from "../lib/inspector-width";
import { Button, Tabs } from "./ui/Primitives";

/** One retained host per pane: changing widths or tabs only changes visibility. */
export function EditorWorkspacePane({ pane }: { pane: "outline" | "details" }) {
  const view = useEditorWorkspaceView();
  const dialog = useRef<HTMLDialogElement>(null);
  const modalState = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const visible = Boolean(view && (pane === "outline" ? view.outlineOpen : view.detailsOpen));
  const modal = Boolean(view?.phone && visible);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const wasModal = modalState.current;
    const active = element.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    if (wasModal && !modal) element.close();
    if (modal && !wasModal) {
      if (element.open) element.close();
      element.showModal();
      heading.current?.focus({ preventScroll: true });
    } else if (!modal) element.open = visible;
    if (wasModal && !modal && active) {
      if (visible) active.focus({ preventScroll: true });
      else (pane === "outline" ? view?.outlineTrigger : view?.detailsTrigger)?.current?.focus({ preventScroll: true });
    }
    modalState.current = modal;
  }, [visible, modal, pane, view?.outlineTrigger, view?.detailsTrigger]);
  if (!view) return null;
  const documentLabel = view.kind === "post" ? "Post" : "Page";
  const selectionLabel = view.kind === "post" ? "Block" : "Section";
  const label = pane === "outline" ? view.kind === "post" ? "On this post" : "On this page" : "Details";
  const width = pane === "outline" ? view.outlineWidth : view.detailsWidth;
  const bounds = pane === "outline" ? view.outlineWidthBounds : view.detailsWidthBounds;
  const setWidth = pane === "outline" ? view.setOutlineWidth : view.setDetailsWidth;
  const paneName = pane === "outline" ? "outline" : "details";
  return <dialog
    ref={dialog}
    className={`editor-workspace-pane editor-workspace-pane-${pane}`}
    id={`editor-${pane}-pane`}
    data-phone={view.phone || undefined}
    role={view.phone ? "dialog" : "presentation"}
    aria-label={view.phone ? label : undefined}
    aria-modal={modal || undefined}
    hidden={!visible}
    onCancel={event => { event.preventDefault(); view.closePane(pane); }}
    onClick={event => { if (modal && event.target === event.currentTarget) {
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) view.closePane(pane);
    } }}
  >
    {visible && !view.phone ? <InspectorResizeHandle controls={`editor-${pane}-content`} label={`Resize ${paneName}`} edge={pane === "outline" ? "right" : "left"} width={width} bounds={bounds} onChange={setWidth} /> : null}
    <section className="editor-workspace-pane-content" aria-label={label} id={`editor-${pane}-content`}>
      <div className="editor-workspace-pane-heading">
        <h2 ref={heading} tabIndex={-1}>{label}</h2>
        {!view.phone ? <Menu label={`${pane === "outline" ? "Outline" : "Details"} width`} tooltip={`${pane === "outline" ? "Outline" : "Details"} width`} icon="resize" items={[
          { key: "narrower", label: "Narrower", disabledReason: width <= bounds.min ? "Minimum width" : undefined, onSelect: () => setWidth(clampInspectorWidth(width - 1, bounds)) },
          { key: "wider", label: "Wider", disabledReason: width >= bounds.max ? "Maximum width for this workspace" : undefined, onSelect: () => setWidth(clampInspectorWidth(width + 1, bounds)) },
          { key: "reset", label: "Reset width", onSelect: () => setWidth(bounds.defaultWidth) },
        ]} /> : null}
        <ActionControl action="close" size="compact" label={`Close ${label.toLowerCase()}`} onClick={() => view.closePane(pane)} />
      </div>
      {pane === "outline" ? <div ref={view.setOutlineTarget} /> : <>
        <div hidden={view.historyOpen}>
        <Tabs
          id="editor-details"
          label="Details scope"
          value={view.detailsTab}
          onChange={value => view.setDetailsTab(value as "document" | "selection")}
          options={(view.kind === "post" ? ["document", "selection"] : ["selection", "document"]).map(value => ({
            value,
            label: value === "document" ? documentLabel : selectionLabel,
            panelId: `editor-details-${value}-panel`,
          }))}
        />
        <div ref={view.setDocumentTarget} role="tabpanel" id="editor-details-document-panel" aria-labelledby="editor-details-tab-document" hidden={view.detailsTab !== "document"} />
        <div ref={view.setSelectionTarget} role="tabpanel" id="editor-details-selection-panel" aria-labelledby="editor-details-tab-selection" hidden={view.detailsTab !== "selection"} />
        </div>
        <div hidden={!view.historyOpen}><Button variant="ghost" size="compact" onClick={() => view.setHistoryOpen(false)}>Back to details</Button><div ref={view.setHistoryTarget} /></div>
      </>}
    </section>
  </dialog>;
}
