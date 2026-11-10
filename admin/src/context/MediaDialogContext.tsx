import { createContext, useContext, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface MediaDialogNavigation {
  position: string;
  previous: { ref: RefObject<HTMLButtonElement>; disabledReason?: string; onSelect: (opener?: HTMLElement) => void };
  next: { ref: RefObject<HTMLButtonElement>; disabledReason?: string; onSelect: (opener?: HTMLElement) => void };
}

export const MediaDialogContext = createContext<{
  actionsInHeader: boolean;
  noticeTarget: HTMLDivElement | null;
  contextActionsTarget: HTMLDivElement | null;
  commandsTarget: HTMLDivElement | null;
  navigation?: MediaDialogNavigation;
  compactActions: boolean;
}>({ actionsInHeader: false, noticeTarget: null, contextActionsTarget: null, commandsTarget: null, compactActions: false });

/** Keep an owner's existing prompt outside the scrolling media body. */
export function MediaDialogNotice({ children }: { children: ReactNode }) {
  const { noticeTarget } = useContext(MediaDialogContext);
  return noticeTarget ? createPortal(children, noticeTarget) : children;
}
