import { EditorTextHistoryProvider } from "./EditorTextHistory";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type Dispatch, type SetStateAction } from "react";
import { readLayoutDisclosure, writeLayoutDisclosure } from "../lib/layout-preferences";
import { readStoredInspectorWidth, rootFontSize, type InspectorWidthBounds } from "../lib/inspector-width";
import { useStoredState } from "../lib/use-stored-state";

export type EditorKind = "page" | "post";
export type EditorDetailsTab = "document" | "selection";
type Pane = "outline" | "details";

interface EditorWorkspaceView {
  arranging: boolean;
  setArranging: Dispatch<SetStateAction<boolean>>;
  focusWriting: boolean;
  setFocusWriting: (value: boolean) => void;
  historyOpen: boolean;
  setHistoryOpen: (value: boolean) => void;
  historyAvailable: boolean;
  setHistoryAvailable: (value: boolean) => void;
  historyTarget: HTMLDivElement | null;
  setHistoryTarget: (target: HTMLDivElement | null) => void;
  formattingTarget: HTMLDivElement | null;
  setFormattingTarget: (target: HTMLDivElement | null) => void;
  specialSelection: "home-hero" | null;
  setSpecialSelection: (value: "home-hero" | null) => void;
  kind: EditorKind | null;
  setDocumentIdentity: (identity: string) => void;
  phone: boolean;
  workspaceWidth: number;
  outlineWidth: number;
  detailsWidth: number;
  outlineWidthBounds: InspectorWidthBounds;
  detailsWidthBounds: InspectorWidthBounds;
  setOutlineWidth: (width: number, persist?: boolean) => void;
  setDetailsWidth: (width: number, persist?: boolean) => void;
  outlineOpen: boolean;
  detailsOpen: boolean;
  detailsTab: EditorDetailsTab;
  setDetailsTab: (tab: EditorDetailsTab) => void;
  openPane: (pane: Pane, tab?: EditorDetailsTab) => void;
  closePane: (pane: Pane, returnFocus?: boolean) => void;
  togglePane: (pane: Pane) => void;
  retainPane: (pane: Pane) => () => void;
  outlineTrigger: RefObject<HTMLButtonElement>;
  detailsTrigger: RefObject<HTMLButtonElement>;
  outlineTarget: HTMLDivElement | null;
  documentTarget: HTMLDivElement | null;
  selectionTarget: HTMLDivElement | null;
  editingTarget: HTMLDivElement | null;
  setOutlineTarget: (target: HTMLDivElement | null) => void;
  setDocumentTarget: (target: HTMLDivElement | null) => void;
  setSelectionTarget: (target: HTMLDivElement | null) => void;
  setEditingTarget: (target: HTMLDivElement | null) => void;
  setWorkspaceElement: (target: HTMLDivElement | null) => void;
  setChromeElement: (target: HTMLDivElement | null) => void;
}

const Context = createContext<EditorWorkspaceView | null>(null);
const serializeWidth = (width: number) => String(width);
const DETAILS_WIDTH = { min: 18, max: 28, defaultWidth: 19 };
const OUTLINE_WIDTH = { min: 12, max: 22, defaultWidth: 13 };
const POST_OUTLINE_WIDTH = { ...OUTLINE_WIDTH, defaultWidth: 12.25 };
const readDetailsWidth = (raw: string | null) => readStoredInspectorWidth(raw, DETAILS_WIDTH);
const readOutlineWidth = (raw: string | null) => readStoredInspectorWidth(raw, OUTLINE_WIDTH);
const readPostOutlineWidth = (raw: string | null) => readStoredInspectorWidth(raw, POST_OUTLINE_WIDTH);

/** View state stays above the route outlet. Pane changes never own document state. */
export function EditorWorkspaceViewProvider({ kind, children }: { kind: EditorKind | null; children: ReactNode }) {
  const [documentIdentity, setDocumentIdentity] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  const [focusWriting, setFocusWriting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyAvailable, setHistoryAvailable] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<HTMLDivElement | null>(null);
  const [formattingTarget, setFormattingTarget] = useState<HTMLDivElement | null>(null);
  const [specialSelection, setSpecialSelection] = useState<"home-hero" | null>(null);
  useLayoutEffect(() => { setArranging(false); setFocusWriting(false); setHistoryOpen(false); setSpecialSelection(null); }, [kind, documentIdentity]);
  const [workspace, setWorkspaceElement] = useState<HTMLDivElement | null>(null);
  const [chrome, setChromeElement] = useState<HTMLDivElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => Math.max(0, window.innerWidth - 60));
  const [remPixels, setRemPixels] = useState(rootFontSize);
  const [preferredOutlineWidth, setOutlineWidth] = useStoredState(`cms.inspector.editor-${kind}.outline.width`, kind === "post" ? readPostOutlineWidth : readOutlineWidth, serializeWidth);
  const [preferredDetailsWidth, setDetailsWidth] = useStoredState(`cms.inspector.editor-${kind}.details.width`, readDetailsWidth, serializeWidth);
  const phone = workspaceWidth < 720;
  const [requested, setRequested] = useState(() => ({
    outline: window.innerWidth - 60 >= 720 && !readLayoutDisclosure("outline", undefined, false),
    details: window.innerWidth - 60 >= 720 && !readLayoutDisclosure("inspector"),
  }));
  const [lastPane, setLastPane] = useState<Pane>("details");
  const retainedPanes = useRef({ outline: 0, details: 0 });
  const retainPane = useCallback((pane: Pane) => {
    retainedPanes.current[pane] += 1;
    return () => { retainedPanes.current[pane] -= 1; };
  }, []);
  const [detailsTab, setDetailsTab] = useState<EditorDetailsTab>(kind === "post" ? "document" : "selection");
  useLayoutEffect(() => { setArranging(false); setDetailsTab(kind === "post" ? "document" : "selection"); }, [kind, documentIdentity]);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const [outlineTarget, setOutlineTarget] = useState<HTMLDivElement | null>(null);
  const [documentTarget, setDocumentTarget] = useState<HTMLDivElement | null>(null);
  const [selectionTarget, setSelectionTarget] = useState<HTMLDivElement | null>(null);
  const [editingTarget, setEditingTarget] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!workspace || !chrome || !kind) return;
    let measuredWidth = -1;
    let measuredHeight = -1;
    const measure = () => {
      const width = workspace.getBoundingClientRect().width;
      const height = chrome.getBoundingClientRect().height;
      setRemPixels(rootFontSize());
      if (width > 0 && width !== measuredWidth) { measuredWidth = width; setWorkspaceWidth(width); }
      if (height !== measuredHeight) {
        measuredHeight = height;
        workspace.style.setProperty("--editor-chrome-height", `${height}px`);
        document.documentElement.style.setProperty("--editor-chrome-height", `${height}px`);
      }
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(workspace);
    observer?.observe(chrome);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      workspace.style.removeProperty("--editor-chrome-height");
      document.documentElement.style.removeProperty("--editor-chrome-height");
    };
  }, [workspace, chrome, kind]);

  const previousPhone = useRef(phone);
  useLayoutEffect(() => {
    if (previousPhone.current !== phone) {
      const held = retainedPanes.current.details ? "details" : retainedPanes.current.outline ? "outline" : null;
      setRequested(current => ({ ...(phone ? { outline: false, details: false } : {
        outline: !readLayoutDisclosure("outline", undefined, false),
        details: !readLayoutDisclosure("inspector"),
      }), ...(held ? { [held]: current[held] } : {}) }));
      if (held) setLastPane(held);
      previousPhone.current = phone;
    }
  }, [phone]);

  const bothFit = !phone && workspaceWidth >= Math.max(kind === "post" ? 1220 : 1240, (OUTLINE_WIDTH.min + DETAILS_WIDTH.min) * remPixels + 640);
  const outlineOpen = Boolean(kind && !focusWriting && !arranging && requested.outline && (bothFit || !requested.details || lastPane === "outline"));
  const detailsOpen = Boolean(kind && !focusWriting && requested.details && (bothFit || !requested.outline || lastPane === "details"));
  // Keep the saved preference when a smaller workspace temporarily limits the pane.
  const paneBudget = Math.floor(((workspaceWidth - 640) / remPixels) * 4) / 4;
  const outlineWidth = Math.min(preferredOutlineWidth, Math.max(OUTLINE_WIDTH.min, paneBudget - (detailsOpen ? DETAILS_WIDTH.min : 0)));
  const detailsWidth = Math.min(preferredDetailsWidth, Math.max(DETAILS_WIDTH.min, paneBudget - (outlineOpen ? outlineWidth : 0)));
  const outlineWidthBounds = useMemo(() => ({ ...OUTLINE_WIDTH, defaultWidth: kind === "post" ? POST_OUTLINE_WIDTH.defaultWidth : OUTLINE_WIDTH.defaultWidth,
    max: Math.max(OUTLINE_WIDTH.min, Math.min(OUTLINE_WIDTH.max, paneBudget - (detailsOpen ? detailsWidth : 0))),
  }), [detailsOpen, detailsWidth, kind, paneBudget]);
  const detailsWidthBounds = useMemo(() => ({ ...DETAILS_WIDTH,
    max: Math.max(DETAILS_WIDTH.min, Math.min(DETAILS_WIDTH.max, paneBudget - (outlineOpen ? outlineWidth : 0))),
  }), [outlineOpen, outlineWidth, paneBudget]);

  useLayoutEffect(() => {
    if (!workspace) return;
    workspace.style.setProperty("--editor-outline-width", `${outlineWidth}rem`);
    workspace.style.setProperty("--editor-details-width", `${detailsWidth}rem`);
    return () => {
      workspace.style.removeProperty("--editor-outline-width");
      workspace.style.removeProperty("--editor-details-width");
    };
  }, [workspace, outlineWidth, detailsWidth]);
  const openPane = useCallback((pane: Pane, tab?: EditorDetailsTab) => {
    if (pane === "outline") setArranging(false);
    setFocusWriting(false);
    setHistoryOpen(false);
    setRequested(current => ({ ...current, [pane]: true }));
    setLastPane(pane);
    if (tab) setDetailsTab(tab);
    writeLayoutDisclosure(pane === "details" ? "inspector" : "outline", false);
  }, []);
  const closePane = useCallback((pane: Pane, returnFocus = true) => {
    setRequested(current => ({ ...current, [pane]: false }));
    writeLayoutDisclosure(pane === "details" ? "inspector" : "outline", true);
    if (returnFocus) requestAnimationFrame(() => (pane === "outline" ? outlineTrigger : detailsTrigger).current?.focus({ preventScroll: true }));
  }, []);
  const togglePane = useCallback((pane: Pane) => {
    if (pane === "outline" ? outlineOpen : detailsOpen) closePane(pane);
    else openPane(pane);
  }, [outlineOpen, detailsOpen, closePane, openPane]);

  const value = useMemo<EditorWorkspaceView>(() => ({
    arranging, setArranging, focusWriting, setFocusWriting, historyOpen, setHistoryOpen, historyAvailable, setHistoryAvailable, historyTarget, setHistoryTarget, formattingTarget, setFormattingTarget, specialSelection, setSpecialSelection,
    kind, setDocumentIdentity, phone, workspaceWidth, outlineWidth, detailsWidth, outlineWidthBounds, detailsWidthBounds, setOutlineWidth, setDetailsWidth, outlineOpen, detailsOpen, detailsTab, setDetailsTab,
    openPane, closePane, togglePane, retainPane, outlineTrigger, detailsTrigger,
    outlineTarget, documentTarget, selectionTarget, editingTarget,
    setOutlineTarget, setDocumentTarget, setSelectionTarget, setEditingTarget,
    setWorkspaceElement, setChromeElement,
  }), [arranging, focusWriting, historyOpen, historyAvailable, historyTarget, formattingTarget, specialSelection, kind, phone, workspaceWidth, outlineWidth, detailsWidth, outlineWidthBounds, detailsWidthBounds, setOutlineWidth, setDetailsWidth, outlineOpen, detailsOpen, detailsTab, openPane, closePane, togglePane, retainPane,
    outlineTarget, documentTarget, selectionTarget, editingTarget]);
  return <EditorTextHistoryProvider><Context.Provider value={value}>{children}</Context.Provider></EditorTextHistoryProvider>;
}

export function useEditorWorkspaceView() { return useContext(Context); }
