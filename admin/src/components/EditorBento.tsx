import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { EditorOverlayOwner, useOverlayOwner } from "./EditorOverlayOwner";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { Icon } from "./ui/Icon";
import { Button } from "./ui/Primitives";
import {
  isPanelAllowedInZone,
  defaultBentoLayout,
  movePanel,
  panelsInZone,
  reorderPanel,
  setPanelCollapsed,
  BENTO_ZONES,
  type BentoPanelDef,
  type BentoPanelState,
  type BentoZone,
} from "../lib/editor-bento-layout";
import {
  createLocalBentoStore,
  type BentoLayoutStore,
} from "../lib/editor-bento-store";

import { EDITOR_BENTO_RESET_LAYOUT_EVENT } from "../lib/editor-bento-events";
import { EDITOR_BENTO_PREFERENCES_EVENT } from "../lib/layout-preferences";

export { EDITOR_BENTO_RESET_LAYOUT_EVENT };

// One section of the editor, rendered as a bento card the user can reorder and collapse within its
// allowed zones. `body` is the section's own content with no header of its own — the card supplies
// the header, title, and controls, so a section is headless and the chrome is uniform.
export interface BentoPanel {
  id: string;
  title: string;
  presentation?: "article-title" | "canvas" | "content" | "history";
  outlineLabel?: string;
  toggleLabel?: string;
  subtitle?: string;
  // An optional extra shown in the header, aligned right (e.g. a page's public path chip).
  aside?: ReactNode;
  defaultZone: BentoZone;
  allowedZones?: readonly [BentoZone, ...BentoZone[]];
  defaultCollapsed?: boolean;
  collapsible?: boolean;
  body: ReactNode;
}

interface EditorBentoProps {
  // Namespaces the persisted arrangement (e.g. "page"), so different editor kinds keep their own.
  storageKey: string;
  panels: BentoPanel[];
  ariaLabel?: string;
  revealPanel?: { id: string; request: number; fieldId?: string };
  documentOutline?: {
    heading: string;
    settingsLabel: string;
  };
  // Injected in tests and the gallery; the app uses the shared localStorage-backed store.
  store?: BentoLayoutStore;
}

const ZONE_LABEL: Record<BentoZone, string> = {
  main: "Main area",
  side: "Side panel",
};

const ZONE_TARGET_PHRASE: Record<BentoZone, string> = {
  main: "the main area",
  side: "the side panel",
};

const TEXT_DROP_INPUT_TYPES = new Set([
  "email",
  "number",
  "password",
  "search",
  "tel",
  "text",
  "url",
]);

let sharedStore: BentoLayoutStore | null = null;
function resolveSharedStore(): BentoLayoutStore {
  if (!sharedStore) sharedStore = createLocalBentoStore();
  return sharedStore;
}

function panelDefs(panels: BentoPanel[]): BentoPanelDef[] {
  return panels.map((panel) => ({
    id: panel.id,
    defaultZone: panel.defaultZone,
    allowedZones: panel.allowedZones,
    defaultCollapsed: panel.defaultCollapsed,
  }));
}

function placementSignature(layout: readonly BentoPanelState[]): string {
  return BENTO_ZONES.map((zone) =>
    panelsInZone(layout, zone)
      .map((panel) => panel.id)
      .join("|"),
  ).join("::");
}

type AtomicMoveElement = HTMLElement & {
  moveBefore?: (node: Node, child: Node | null) => void;
};

function moveBodyHost(parent: HTMLElement, host: HTMLElement) {
  // moveBefore is the browser's atomic, state-preserving move. It retains focus, selection, and
  // iframe loading state while a connected panel body changes parents. Older browsers fall back to
  // append: React state and the same DOM nodes still survive there, although browser-owned state
  // can reset during the reparent.
  const atomicParent = parent as AtomicMoveElement;
  if (
    atomicParent.isConnected &&
    host.isConnected &&
    typeof atomicParent.moveBefore === "function"
  ) {
    atomicParent.moveBefore(host, null);
    return;
  }
  parent.append(host);
}

// A two-zone bento of editor sections: a wide main column for the content an editor works in most,
// and a narrow side column for settings they reach into. Cards move only to allowed zones, reorder
// within one, and collapse to their header — by pointer drag or by keyboard-reachable controls —
// and the arrangement persists per browser. The layout logic and persistence are pure modules
// under lib/; this component is their view and the drag/keyboard surface over them.
export function EditorBento({
  storageKey,
  panels,
  ariaLabel,
  revealPanel,
  documentOutline,
  store,
}: EditorBentoProps) {
  const view = useEditorWorkspaceView();
  const inheritedOverlayOwner = useOverlayOwner();
  const preferences = useRef<HTMLDialogElement>(null);
  const preferencesTrigger = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const activeStore = store ?? resolveSharedStore();
  const storeRef = useRef(activeStore);
  storeRef.current = activeStore;

  const defs = useMemo(() => panelDefs(panels), [panels]);
  // The panel catalog can change between renders, so key reconciliation on its persisted defaults
  // and placement rules rather than array identity.
  const panelSignature = useMemo(
    () =>
      JSON.stringify(
        panels.map((panel) => ({
          id: panel.id,
          defaultZone: panel.defaultZone,
          allowedZones: panel.allowedZones,
          defaultCollapsed: panel.defaultCollapsed,
        })),
      ),
    [panels],
  );

  const [layout, setLayout] = useState<BentoPanelState[]>(() =>
    activeStore.load(storageKey, defs),
  );
  const [announcement, setAnnouncement] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{
    id: string;
    after: boolean;
  } | null>(null);
  // Card bodies render through stable portal hosts. Moving a host between card shells keeps the
  // body component mounted, including pending saves and built previews. On browsers with atomic DOM
  // moves, the connected staging path below also retains browser-owned focus and iframe state.
  const bodyHosts = useRef(new Map<string, HTMLDivElement>());
  const bodyStagingRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const collapseRefs = useRef(new Map<string, HTMLButtonElement>());
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusRequest, setFocusRequest] = useState<{ id: string; grip: boolean; fieldId?: string } | null>(null);
  const [activeOutlineId, setActiveOutlineId] = useState(
    () => panels.find((panel) => panel.outlineLabel)?.id ?? "settings",
  );

  useEffect(() => {
    if (!focusRequest) return;
    const refs = focusRequest.grip ? gripRefs : collapseRefs;
    const field = focusRequest.fieldId ? document.getElementById(focusRequest.fieldId) : null;
    (field ?? refs.current.get(focusRequest.id) ?? collapseRefs.current.get(focusRequest.id))?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  // Bring the layout back into agreement when the storage scope or the panel set changes. The store
  // reconciles the saved arrangement against the current defs, so a removed panel drops out and a
  // new one appears at its default without losing the placement of the rest.
  useEffect(() => {
    setLayout(storeRef.current.load(storageKey, defs));
    // defs is derived from panelSignature; depend on the signature so an unrelated re-render that
    // rebuilds the array without changing ids does not reload and clobber an in-progress drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, panelSignature]);

  useEffect(() => {
    const currentPanelIds = new Set(panels.map((panel) => panel.id));
    for (const [id, host] of bodyHosts.current) {
      if (!currentPanelIds.has(id)) {
        host.remove();
        bodyHosts.current.delete(id);
      }
    }
  }, [panelSignature, panels]);

  const panelsById = useMemo(() => {
    const map = new Map<string, BentoPanel>();
    for (const panel of panels) map.set(panel.id, panel);
    return map;
  }, [panels]);

  function canPlaceInZone(id: string, zone: BentoZone): boolean {
    const panel = panelsById.get(id);
    return panel ? isPanelAllowedInZone(panel, zone) : false;
  }

  function commit(next: BentoPanelState[], message?: string) {
    if (placementSignature(layout) !== placementSignature(next)) {
      const staging = bodyStagingRef.current;
      if (staging) {
        // Stage connected bodies before React removes or reorders their card shells. React commits
        // the new shells in the same event turn, whose refs atomically move each host back out.
        for (const host of bodyHosts.current.values()) {
          if (host.isConnected && host.parentElement !== staging) {
            moveBodyHost(staging, host);
          }
        }
      }
    }
    setLayout(next);
    storeRef.current.save(storageKey, next);
    if (message) setAnnouncement(message);
  }

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const showPreferences = (event: Event) => {
      if (!view?.kind) return;
      preferencesTrigger.current = (event as CustomEvent<HTMLElement>).detail ?? document.activeElement as HTMLElement;
      preferences.current?.showModal();
    };
    editor.addEventListener(EDITOR_BENTO_PREFERENCES_EVENT, showPreferences);
    const resetLayout = () => {
      const next = storeRef.current.reset(storageKey, defs);
      if (placementSignature(layout) !== placementSignature(next)) {
        const staging = bodyStagingRef.current;
        if (staging) {
          for (const host of bodyHosts.current.values()) {
            if (host.isConnected && host.parentElement !== staging) {
              moveBodyHost(staging, host);
            }
          }
        }
      }
      setLayout(next);
      setAnnouncement("Section layout restored to the default order.");
    };

    editor.addEventListener(EDITOR_BENTO_RESET_LAYOUT_EVENT, resetLayout);
    return () => {
      editor.removeEventListener(EDITOR_BENTO_RESET_LAYOUT_EVENT, resetLayout);
      editor.removeEventListener(EDITOR_BENTO_PREFERENCES_EVENT, showPreferences);
    };
  }, [defs, layout, storageKey, view?.kind]);

  function bodyHost(id: string): HTMLDivElement {
    const existing = bodyHosts.current.get(id);
    if (existing) return existing;
    const host = document.createElement("div");
    host.className = "editor-bento-card-body-mount";
    bodyHosts.current.set(id, host);
    return host;
  }

  function positionPhrase(
    next: BentoPanelState[],
    id: string,
    zone: BentoZone,
  ): string {
    const inZone = panelsInZone(next, zone);
    const index = inZone.findIndex((panel) => panel.id === id);
    return `position ${index + 1} of ${inZone.length}`;
  }

  function moveToZone(id: string, target: BentoZone) {
    const panel = panelsById.get(id);
    if (!panel || !isPanelAllowedInZone(panel, target)) return;
    const next = movePanel(layout, defs, id, target);
    commit(
      next,
      `${panel.title} moved to ${ZONE_TARGET_PHRASE[target]}, ${positionPhrase(next, id, target)}.`,
    );
    // The card shell is recreated in the other zone; keep keyboard focus on its handle.
    setFocusRequest({ id, grip: true });
  }

  function nudge(id: string, direction: -1 | 1) {
    const title = panelsById.get(id)?.title ?? "Section";
    const entry = layout.find((panel) => panel.id === id);
    if (!entry) return;
    const next = reorderPanel(layout, defs, id, direction);
    if (placementSignature(next) === placementSignature(layout)) return;
    commit(
      next,
      `${title} moved ${direction === -1 ? "up" : "down"}, ${positionPhrase(next, id, entry.zone)}.`,
    );
    setFocusRequest({ id, grip: true });
  }

  function toggleCollapsed(id: string) {
    const entry = layout.find((panel) => panel.id === id);
    if (!entry) return;
    commit(setPanelCollapsed(layout, id, !entry.collapsed));
  }

  function jumpToPanel(id: string, outlineId = id) {
    const entry = layout.find((panel) => panel.id === id);
    if (!entry) return;
    if (view?.kind && entry.zone === "side") view.openPane("details", "document");
    if (entry.collapsed) commit(setPanelCollapsed(layout, id, false));
    setActiveOutlineId(outlineId);
    setFocusRequest({ id, grip: false });
  }

  function markOutlinePanel(panel: BentoPanel, target: HTMLElement) {
    if (!documentOutline) return;
    // Portaled form controls belong to the panel that contains them on screen.
    const owner = target.closest<HTMLElement>("[data-panel-id]");
    panel = panelsById.get(owner?.dataset.panelId ?? "") ?? panel;
    setActiveOutlineId(panel.outlineLabel ? panel.id : "settings");
  }

  const outlinedPanels = panelsInZone(layout, "main")
    .map((entry) => panelsById.get(entry.id))
    .filter((panel): panel is BentoPanel => Boolean(panel?.outlineLabel));
  const settingsPanel =
    panelsInZone(layout, "side")[0] ??
    layout.find((entry) => panelsById.get(entry.id)?.defaultZone === "side");

  useEffect(() => {
    if (!revealPanel) return;
    const entry = layout.find((panel) => panel.id === revealPanel.id);
    if (!entry) return;
    if (view?.kind && entry.zone === "side") view.openPane("details", "document");
    if (entry.collapsed) {
      commit(setPanelCollapsed(layout, entry.id, false));
    }
    setFocusRequest({ id: entry.id, grip: false, fieldId: revealPanel.fieldId });
    // The request counter is the command identity. Layout is deliberately read from the
    // render that received that command; adding it here would repeat a reveal after commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPanel?.request]);

  // --- Pointer drag and drop (a progressive enhancement over the keyboard controls) ---

  function onDragStart(event: DragEvent, id: string) {
    setDraggingId(id);
    event.dataTransfer.effectAllowed = "move";
    // Firefox requires data to be set for a drag to begin.
    event.dataTransfer.setData("text/plain", id);
  }

  function onDragEnd() {
    setDraggingId(null);
    setDropHint(null);
  }

  function shouldHandleSurfaceEvent(event: DragEvent): boolean {
    // Editable descendants keep their native drag/drop behavior unless a bento card is being moved.
    // Other card and zone content still accepts external drops so files and links cannot navigate
    // the editor away.
    const target = event.target;
    const editableControl =
      target instanceof Element &&
      target.closest(
        'input, textarea, [contenteditable]:not([contenteditable="false"])',
      );
    const editableTarget =
      editableControl instanceof HTMLTextAreaElement ||
      (editableControl instanceof HTMLElement &&
        editableControl.matches(
          '[contenteditable]:not([contenteditable="false"])',
        )) ||
      (editableControl instanceof HTMLInputElement &&
        TEXT_DROP_INPUT_TYPES.has(editableControl.type));
    return Boolean(draggingId) || !editableTarget;
  }

  function onCardDragOver(event: DragEvent, targetId: string) {
    if (!shouldHandleSurfaceEvent(event)) return;
    event.preventDefault();
    if (!draggingId || draggingId === targetId) return;
    const target = layout.find((panel) => panel.id === targetId);
    if (!target || !canPlaceInZone(draggingId, target.zone)) {
      event.dataTransfer.dropEffect = "none";
      setDropHint(null);
      return;
    }
    event.dataTransfer.dropEffect = "move";
    // Measure the physical card around a portaled body so its content area uses the same before/
    // after threshold as the card shell.
    const card = event.currentTarget.closest(".editor-bento-card");
    const rect = (card ?? event.currentTarget).getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setDropHint({ id: targetId, after });
  }

  function dropRelativeToCard(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    const target = layout.find((panel) => panel.id === targetId);
    const dragged = panelsById.get(draggingId);
    if (!target || !dragged || !isPanelAllowedInZone(dragged, target.zone)) {
      onDragEnd();
      return;
    }
    const after = dropHint?.id === targetId ? dropHint.after : false;
    const zonePanels = panelsInZone(layout, target.zone).filter(
      (panel) => panel.id !== draggingId,
    );
    let index = zonePanels.findIndex((panel) => panel.id === targetId);
    if (index < 0) index = zonePanels.length;
    if (after) index += 1;
    const next = movePanel(layout, defs, draggingId, target.zone, index);
    commit(
      next,
      `${dragged.title} moved to ${ZONE_TARGET_PHRASE[target.zone]}, ${positionPhrase(next, draggingId, target.zone)}.`,
    );
    onDragEnd();
  }

  function onZoneDragOver(event: DragEvent, zone: BentoZone) {
    if (!shouldHandleSurfaceEvent(event)) return;
    event.preventDefault();
    if (!draggingId) return;
    event.dataTransfer.dropEffect = canPlaceInZone(draggingId, zone)
      ? "move"
      : "none";
  }

  function dropAtZoneEnd(zone: BentoZone) {
    if (!draggingId) return;
    const dragged = panelsById.get(draggingId);
    if (!dragged || !isPanelAllowedInZone(dragged, zone)) {
      onDragEnd();
      return;
    }
    const zonePanels = panelsInZone(layout, zone).filter(
      (panel) => panel.id !== draggingId,
    );
    const next = movePanel(layout, defs, draggingId, zone, zonePanels.length);
    commit(
      next,
      `${dragged.title} moved to ${ZONE_TARGET_PHRASE[zone]}, ${positionPhrase(next, draggingId, zone)}.`,
    );
    onDragEnd();
  }

  return (
    <div
      className="editor-bento"
      data-document-outline={documentOutline ? "true" : undefined}
      role="group"
      aria-label={ariaLabel}
      ref={editorRef}
    >
      <div className="editor-bento-layout-tools" />
      <div className="editor-bento-body-staging" ref={bodyStagingRef} />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <p className="sr-only" id={`${instanceId}-move-help`}>
        Drag to move this section. With the handle focused, use Up or Down to reorder,
        Left to move to the main area, or Right to move to the side panel.
      </p>
      {documentOutline && !view?.kind ? (
        <nav className="editor-document-outline" aria-label="Document sections">
          <h2>{documentOutline.heading}</h2>
          <ol>
            {outlinedPanels.map((panel) => (
              <li key={panel.id}>
                <Button
                  variant="ghost"
                  type="button"
                  aria-current={activeOutlineId === panel.id ? "location" : undefined}
                  onClick={() => jumpToPanel(panel.id)}
                >
                  {panel.outlineLabel}
                </Button>
              </li>
            ))}
            {settingsPanel ? (
              <li>
                <Button
                  variant="ghost"
                  type="button"
                  aria-current={activeOutlineId === "settings" ? "location" : undefined}
                  onClick={() => jumpToPanel(settingsPanel.id, "settings")}
                >
                  {documentOutline.settingsLabel}
                </Button>
              </li>
            ) : null}
          </ol>
        </nav>
      ) : null}
      {BENTO_ZONES.map((zone) => {
        const zonePanels = panelsInZone(layout, zone);
        return (
          <RetainedEditorHost key={zone} target={view?.kind && zone === "side" ? view.documentTarget : null} overlayOwner={view?.kind && !view.phone ? null : undefined}>
          <section
            className="editor-bento-zone"
            data-zone={zone}
            data-empty={zonePanels.length === 0}
            aria-label={ZONE_LABEL[zone]}
            onDragOver={(event) => onZoneDragOver(event, zone)}
            onDrop={(event) => {
              if (!shouldHandleSurfaceEvent(event)) return;
              event.preventDefault();
              dropAtZoneEnd(zone);
            }}
          >
            {documentOutline && zone === "side" ? (
              <h2 className="editor-bento-zone-title">
                {documentOutline.settingsLabel}
              </h2>
            ) : null}
            {zonePanels.map((state) => {
              const panel = panelsById.get(state.id);
              if (!panel) return null;
              const canCollapse = panel.collapsible !== false && !panel.presentation;
              const collapsed = canCollapse && state.collapsed;
              const titleId = `${instanceId}-${state.id}-title`;
              const bodyId = `${instanceId}-${state.id}-body`;
              const Heading = panel.presentation ? "h2" : "h3";
              const movable = BENTO_ZONES.some(candidate => isPanelAllowedInZone(panel, candidate) && (candidate !== zone || zonePanels.length > 1));
              return (
                <article
                  key={state.id}
                  className="editor-bento-card"
                  data-panel-id={state.id}
                  data-presentation={panel.presentation}
                  data-collapsed={collapsed}
                  data-dragging={draggingId === state.id}
                  data-drop={
                    dropHint?.id === state.id
                      ? dropHint.after
                        ? "after"
                        : "before"
                      : undefined
                  }
                  aria-labelledby={titleId}
                  onFocusCapture={event => markOutlinePanel(panel, event.target as HTMLElement)}
                  onDragOver={(event) => onCardDragOver(event, state.id)}
                  onDrop={(event) => {
                    if (!shouldHandleSurfaceEvent(event)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    dropRelativeToCard(state.id);
                  }}
                >
                  <header className="editor-bento-card-header" data-movable={movable}>
                    {movable ? <button
                      type="button"
                      className="editor-bento-grip"
                      aria-label={`Move section: ${panel.title}`}
                      aria-describedby={`${instanceId}-move-help`}
                      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight"
                      title="Drag to move. Use arrow keys when focused."
                      ref={(element) => {
                        if (element) gripRefs.current.set(state.id, element);
                        else gripRefs.current.delete(state.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
                        event.preventDefault();
                        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                          nudge(state.id, event.key === "ArrowUp" ? -1 : 1);
                        } else {
                          const target = event.key === "ArrowLeft" ? "main" : "side";
                          if (target !== zone) moveToZone(state.id, target);
                        }
                      }}
                      draggable
                      onDragStart={(event) => onDragStart(event, state.id)}
                      onDragEnd={onDragEnd}
                    >
                      <Icon name="grip" />
                    </button> : null}
                    <div className="editor-bento-card-heading">
                      <Heading className="editor-bento-card-title" id={titleId}>
                        {!canCollapse ? <span>{panel.title}</span> : <Button
                          variant="ghost"
                          type="button"
                          className="editor-bento-collapse"
                          aria-label={panel.toggleLabel}
                          ref={(element) => {
                            if (element)
                              collapseRefs.current.set(state.id, element);
                            else collapseRefs.current.delete(state.id);
                          }}
                          aria-expanded={!collapsed}
                          aria-controls={bodyId}
                          onClick={() => toggleCollapsed(state.id)}
                        >
                          <Icon
                            name="chevron-down"
                            className="editor-bento-chevron"
                          />
                          <span>{panel.title}</span>
                        </Button>}
                      </Heading>
                      {panel.subtitle && !collapsed ? (
                        <p className="editor-bento-card-subtitle">
                          {panel.subtitle}
                        </p>
                      ) : null}
                    </div>
                    {panel.aside && !collapsed ? (
                      <div className="editor-bento-card-aside">
                        {panel.aside}
                      </div>
                    ) : null}
                  </header>
                  {/* The body stays mounted while collapsed, hidden rather than removed, so a
                      section keeps its state — a built preview link, a focused block, an open
                      palette — across collapse and cross-zone moves instead of resetting to its
                      initial load. A connected staging host lets supporting browsers atomically
                      move it into each new card shell without resetting focus or iframe state. */}
                  <div
                    className="editor-bento-card-body"
                    id={bodyId}
                    hidden={collapsed}
                    ref={(element) => {
                      const host = bodyHost(state.id);
                      if (element && host.parentElement !== element)
                        moveBodyHost(element, host);
                    }}
                  />
                </article>
              );
            })}
            {zonePanels.length === 0 ? (
              <p className="editor-bento-empty" aria-hidden="true">
                Drop a section here
              </p>
            ) : null}
          </section>
          </RetainedEditorHost>
        );
      })}
      <dialog ref={preferences} className="content-picker-dialog editor-workspace-preferences" aria-labelledby={`${instanceId}-preferences-title`}
        onClose={() => preferencesTrigger.current?.focus({ preventScroll: true })}>
        <header className="content-picker-head"><h2 id={`${instanceId}-preferences-title`}>Workspace preferences</h2></header>
        <div className="content-picker-body">
          <p>These preferences change your workspace, not the document.</p>
          {layout.map(state => {
            const panel = panelsById.get(state.id);
            if (!panel) return null;
            const siblings = panelsInZone(layout, state.zone);
            const index = siblings.findIndex(entry => entry.id === state.id);
            return <section key={state.id} className="editor-panel-preference" aria-label={panel.title}>
              <h3>{panel.title}</h3>
              <div className="button-row">
                <Button disabled={index === 0} onClick={() => { nudge(state.id, -1); setFocusRequest(null); }}>Move up</Button>
                <Button disabled={index === siblings.length - 1} onClick={() => { nudge(state.id, 1); setFocusRequest(null); }}>Move down</Button>
                {BENTO_ZONES.filter(zone => zone !== state.zone && isPanelAllowedInZone(panel, zone)).map(zone =>
                  <Button key={zone} onClick={() => { moveToZone(state.id, zone); setFocusRequest(null); }}>Move to {ZONE_LABEL[zone].toLowerCase()}</Button>)}
                {panel.collapsible !== false && !panel.presentation ? <Button aria-pressed={state.collapsed} onClick={() => toggleCollapsed(state.id)}>{state.collapsed ? "Expand" : "Collapse"}</Button> : null}
              </div>
            </section>;
          })}
          <Button onClick={() => editorRef.current?.dispatchEvent(new Event(EDITOR_BENTO_RESET_LAYOUT_EVENT))}>Restore default layout</Button>
        </div>
        <footer className="content-picker-footer"><Button onClick={() => preferences.current?.close()}>Done</Button></footer>
      </dialog>
      {panels.map((panel) =>
        createPortal(
          <EditorOverlayOwner.Provider value={view?.kind && layout.find(state => state.id === panel.id)?.zone === "side"
            ? view.phone ? view.documentTarget?.closest<HTMLDialogElement>("dialog") ?? null : null : inheritedOverlayOwner}>
          <div
            className="editor-bento-card-body-content"
            onFocusCapture={event => markOutlinePanel(panel, event.target as HTMLElement)}
            onDragOver={(event) => onCardDragOver(event, panel.id)}
            onDrop={(event) => {
              if (!shouldHandleSurfaceEvent(event)) return;
              event.preventDefault();
              event.stopPropagation();
              dropRelativeToCard(panel.id);
            }}
          >
            {panel.body}
          </div>
          </EditorOverlayOwner.Provider>,
          bodyHost(panel.id),
          panel.id,
        ),
      )}
    </div>
  );
}
