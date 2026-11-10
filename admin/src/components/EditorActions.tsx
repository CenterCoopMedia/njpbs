import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEditorWorkspaceView } from "../context/EditorWorkspaceView";
import { PostTemplateActions } from "./PostTemplateActions";
import { WorkspaceActions, WorkspaceSecondaryActions } from "./WorkspaceActions";
import "./EditorActions.css";

type ActionGroup = "save" | "preview" | "workflow" | "publishing" | "routine" | "destructive";
const EditorActionTargets = createContext<Partial<Record<ActionGroup, HTMLElement | null>> | null>(null);

/** Keep action ownership in each editor; only their placement is shared. */
export function EditorActionsProvider({ label, children }: { label: string | null; children: ReactNode }) {
  const view = useEditorWorkspaceView();
  const [save, setSave] = useState<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<HTMLDivElement | null>(null);
  const [workflow, setWorkflow] = useState<HTMLDivElement | null>(null);
  const [publishing, setPublishing] = useState<HTMLDivElement | null>(null);
  const [routine, setRoutine] = useState<HTMLDivElement | null>(null);
  const [destructive, setDestructive] = useState<HTMLDivElement | null>(null);
  const [hasPublishing, setHasPublishing] = useState(false);
  const [hasActions, setHasActions] = useState(false);
  // Portals populate the slots after their targets mount. Observe only these local
  // action lists, so unavailable menus do not leave empty controls in the toolbar.
  useLayoutEffect(() => {
    const update = () => {
      setHasPublishing(Boolean(publishing?.childElementCount));
      setHasActions(Boolean(routine?.childElementCount || destructive?.childElementCount));
    };
    update();
    const observer = new MutationObserver(update);
    for (const target of [publishing, routine, destructive]) {
      if (target) observer.observe(target, { childList: true });
    }
    return () => observer.disconnect();
  }, [publishing, routine, destructive]);

  return <EditorActionTargets.Provider value={label ? { save, preview, workflow, publishing, routine, destructive } : null}>
    {label ? <WorkspaceActions>
      <div className="editor-actions" role="group" aria-label="Editing and publishing">
        <div className="editor-actions-editing" role="group" aria-label="Editing">
          {(view?.kind ? ["preview", "save"] : ["save", "preview"]).map(group =>
            <div key={group} className={`editor-action-slot editor-action-${group}`} ref={group === "save" ? setSave : setPreview} />)}
        </div>
        <div className="editor-action-slot" ref={setWorkflow} />
        <PostTemplateActions closeOnAction label={view?.kind ? "Review & publish" : "Publishing"} variant={view?.kind ? "primary" : "secondary"} icon={view?.kind ? "upload" : undefined} hidden={!hasPublishing}>
          <div className="editor-action-menu-group" ref={setPublishing} />
        </PostTemplateActions>
        {view?.kind ? <WorkspaceSecondaryActions>
          <div className="editor-document-routine-actions" role="group" aria-label={`${label} actions`}>
            <div className="editor-action-menu-group" ref={setRoutine} />
            <div className="editor-action-menu-group editor-action-menu-destructive" ref={setDestructive} />
          </div>
        </WorkspaceSecondaryActions> : <PostTemplateActions closeOnAction label={`${label} actions`} hidden={!hasActions}>
          <div className="editor-action-menu-group" ref={setRoutine} />
          <div className="editor-action-menu-group editor-action-menu-destructive" ref={setDestructive} />
        </PostTemplateActions>}
      </div>
    </WorkspaceActions> : null}
    {children}
  </EditorActionTargets.Provider>;
}

export function useEditorActionsAvailable() {
  return useContext(EditorActionTargets) !== null;
}

export function EditorActionSlot({ group, children }: { group: ActionGroup; children: ReactNode }) {
  const targets = useContext(EditorActionTargets);
  if (!targets) return <WorkspaceActions>{children}</WorkspaceActions>;
  return targets[group] ? createPortal(children, targets[group]) : null;
}
