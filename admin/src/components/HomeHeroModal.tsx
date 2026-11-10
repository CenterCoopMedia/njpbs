import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { RetainedEditorHost } from "./RetainedEditorHost";
import { EditorFrameHeader } from "./EditorFrameHeader";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import "./home-canvas.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { parseHomeHero } from "../../../packages/content-core/src/home-hero";
import { ComponentEditorDialog } from "./ComponentEditorDialog";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";

/** Presentation only: RecordForm retains the hero draft and save owner. */
export function HomeHeroModal({ value, readOnly = false, revealRequest = 0, focusTargetId, fallback, children, preview }: {
  value: unknown; readOnly?: boolean; revealRequest?: number; focusTargetId?: string; fallback?: ReactNode; children: ReactNode; preview?: ReactNode;
}) {
  const view = useEditorWorkspaceView();
  useEffect(() => () => view?.setSpecialSelection(null), [view?.setSpecialSelection]);
  const [dialogTarget, setDialogTarget] = useState<HTMLDivElement | null>(null);
  const selected = view?.specialSelection === "home-hero";
  const target = view?.kind && selected ? view.selectionTarget : dialogTarget;
  function inspect() {
    if (readOnly) return;
    if (view?.kind) { view.setSpecialSelection("home-hero"); view.openPane("details", "selection"); }
    else setOpen(true);
  }
  const [open, setOpen] = useState(false);
  const handledRequest = useRef(0);
  useEffect(() => {
    const requested = revealRequest > handledRequest.current;
    handledRequest.current = revealRequest;
    if (readOnly) setOpen(false);
    else if (requested) {
      if (view?.kind) {
        view.setSpecialSelection("home-hero"); view.openPane("details", "selection");
        requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(focusTargetId ?? "")?.focus()));
      } else setOpen(true);
    }
  }, [revealRequest, readOnly, view?.kind, view?.setSpecialSelection, view?.openPane, focusTargetId]);
  let summary: ReactNode = fallback ?? <p>Current Home fallback</p>;
  try {
    const hero = parseHomeHero(value);
    if (hero?.mode === "manual") summary = hero.items?.length
      ? <><p>{hero.presentation === "editorial" ? "Lead story and headlines" : "Rotating hero"}</p><ol>{hero.items.map((item, index) => <li key={item.itemId}><strong>{item.title || "Untitled slide"}</strong>{hero.presentation === "editorial" ? <small> · {index === 0 ? "Lead" : index <= (hero.supportingCount ?? 3) ? "Supporting headline" : "More stories"}</small> : null}{item.summary ? <p>{item.summary}</p> : null}</li>)}</ol></>
      : <p>{hero.presentation === "editorial" ? "No stories selected" : "No slides selected"}</p>;
    else if (hero) {
      const selection = hero.mode === "tag" ? (hero.values ?? (hero.value ? [hero.value] : [])).join(", ") : hero.value;
      const labels = hero.values && selection && selection.length > 120 ? `${selection.slice(0, 117)}…` : selection;
      const pinSummary = hero.pins?.length ? `${hero.pins.length} pinned · Automatic stories from` : "Featured story from";
      summary = view?.kind ? <div className="editor-hero-summary"><span aria-hidden="true"><Icon name="image" /></span><div><p>{pinSummary} {hero.source === "cms_posts" ? "NJ PBS posts" : hero.source}</p><small>{hero.mode === "tag" ? "Posts tagged" : "Category"} “{labels || "No selection"}”</small></div></div> : <p>{hero.pins?.length ? `${hero.pins.length} pinned · ` : ""}{hero.mode === "tag" ? "Tag" : "Category"}: {labels || "No selection"} · {hero.source}</p>;
    }
  } catch { summary = <p>Some hero settings need attention. Open the editor to correct them.</p>; }
  return <section className="home-canvas-section" data-editor-frame={view?.kind ?? undefined} data-selected={selected || undefined} id="home-hero-frame" tabIndex={-1} aria-label="Home hero" onFocusCapture={view?.kind ? () => { view.setSpecialSelection("home-hero"); view.setDetailsTab("selection"); } : undefined}>
    {view?.kind ? <EditorFrameHeader scope="block" title="Home hero" leading={<Icon name="image" />} actions={<ControlSizingProvider size="compact"><span className="editor-fixed-tag"><Icon name="lock" />Fixed</span><ActionControl action="settings" graphic={<Icon name="pencil" />} label="Edit Home hero" disabled={readOnly} onClick={inspect} /></ControlSizingProvider>} /> :
    <header className="home-canvas-section-bar"><h3>Home hero</h3>
      <ActionControl action="settings" graphic={<Icon name="pencil" />} label="Edit Home hero" aria-haspopup="dialog" aria-expanded={open} disabled={readOnly} onClick={() => setOpen(true)} />
    </header>}
    <div className="block-preview">{summary}</div>
    <ComponentEditorDialog focusTargetId={focusTargetId} open={open} disabled={readOnly} title="Home hero" description="Home › Hero" onClose={() => setOpen(false)} preview={preview}>
      <div ref={setDialogTarget} />
    </ComponentEditorDialog>
    <RetainedEditorHost target={target} overlayOwner={view?.kind && !view.phone ? null : undefined}>{children}</RetainedEditorHost>
  </section>;
}
