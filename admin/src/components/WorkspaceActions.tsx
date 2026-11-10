import { createContext, type ReactNode, useContext, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface WorkspaceTargets {
  actions: HTMLElement | null;
  secondary: HTMLElement | null;
  status: HTMLElement | null;
  title: HTMLElement | null;
  feedback: HTMLElement | null;
  browseToolbar: HTMLElement | null;
  browseToolbarTrailing: HTMLElement | null;
}

const WorkspaceTargetsContext = createContext<WorkspaceTargets>({
  actions: null,
  secondary: null,
  status: null,
  title: null,
  feedback: null,
  browseToolbar: null,
  browseToolbarTrailing: null,
});

export function WorkspaceActionsProvider({
  children,
  target,
  secondaryTarget = null,
  statusTarget = null,
  titleTarget = null,
  feedbackTarget = null,
  browseToolbarTarget = null,
  browseToolbarTrailingTarget = null,
}: {
  children: ReactNode;
  target: HTMLElement | null;
  secondaryTarget?: HTMLElement | null;
  statusTarget?: HTMLElement | null;
  titleTarget?: HTMLElement | null;
  feedbackTarget?: HTMLElement | null;
  browseToolbarTarget?: HTMLElement | null;
  browseToolbarTrailingTarget?: HTMLElement | null;
}) {
  return (
    <WorkspaceTargetsContext.Provider
      value={{
        actions: target,
        secondary: secondaryTarget,
        status: statusTarget,
        title: titleTarget,
        feedback: feedbackTarget,
        browseToolbar: browseToolbarTarget,
        browseToolbarTrailing: browseToolbarTrailingTarget,
      }}
    >
      {children}
    </WorkspaceTargetsContext.Provider>
  );
}

export function WorkspaceTargetsScope({
  actionsTarget,
  children,
  titleTarget,
}: {
  actionsTarget: HTMLElement | null;
  children: ReactNode;
  titleTarget: HTMLElement | null;
}) {
  const targets = useContext(WorkspaceTargetsContext);
  return (
    <WorkspaceTargetsContext.Provider
      value={{ ...targets, actions: actionsTarget, title: titleTarget }}
    >
      {children}
    </WorkspaceTargetsContext.Provider>
  );
}

export function useWorkspaceActionsAvailable(): boolean {
  return useContext(WorkspaceTargetsContext).actions !== null;
}

export function useWorkspaceSecondaryActionsAvailable(): boolean {
  return useContext(WorkspaceTargetsContext).secondary !== null;
}

export function useWorkspaceFeedbackAvailable(): boolean {
  return useContext(WorkspaceTargetsContext).feedback !== null;
}

export function WorkspaceSecondaryActions({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceTargetsContext).secondary;
  return target ? createPortal(children, target) : children;
}

export function WorkspaceActions({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceTargetsContext).actions;
  return target ? createPortal(children, target) : children;
}

export function WorkspaceStatus({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceTargetsContext).status;
  return target ? createPortal(children, target) : children;
}

export function WorkspaceTitle({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceTargetsContext).title;
  return target ? createPortal(children, target) : children;
}

export function WorkspaceFeedback({ children }: { children: ReactNode }) {
  const target = useContext(WorkspaceTargetsContext).feedback;
  return target ? createPortal(children, target) : children;
}

/** Browsing commands share the shell's second persistent bar without owning route data. */
export function WorkspaceBrowseToolbar({ children, media = false, trailing = false }: { children: ReactNode; media?: boolean; trailing?: boolean }) {
  const targets = useContext(WorkspaceTargetsContext);
  const target = trailing ? targets.browseToolbarTrailing : targets.browseToolbar;
  const origin = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!target || !media) return;
    const host = origin.current?.closest("section");
    if (!host) return;
    const previous = host.style.getPropertyValue("--media-chrome-height");
    // The shell measures both bars. Media focus offsets must not count the second bar twice.
    host.style.setProperty("--media-chrome-height", "0px");
    return () => {
      if (host.style.getPropertyValue("--media-chrome-height") !== "0px") return;
      if (previous) host.style.setProperty("--media-chrome-height", previous);
      else host.style.removeProperty("--media-chrome-height");
    };
  }, [target, media]);
  return target ? <><span hidden ref={origin} />{createPortal(children, target)}</> : children;
}
