import type { ReactNode } from "react";
import "./editor-frame-header.css";

export interface EditorFrameHeaderProps {
  scope: "row" | "column" | "block" | "panel";
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
  selected?: boolean;
}

/** One visual hierarchy for spans, columns, planks and their editing panels.
 * Interaction ownership stays with the caller so framing never remounts an editor
 * or changes the meaning of an existing control.
 */
export function EditorFrameHeader({ scope, title, meta, leading, actions, className, selected }: EditorFrameHeaderProps) {
  return <div className={["editor-frame-header", className].filter(Boolean).join(" ")} data-scope={scope} data-selected={selected || undefined}>
    {leading != null ? <div className="editor-frame-leading">{leading}</div> : null}
    <div className="editor-frame-heading">
      <div className="editor-frame-title">{title}</div>
      {meta != null ? <div className="editor-frame-meta">{meta}</div> : null}
    </div>
    {actions != null ? <div className="editor-frame-actions">{actions}</div> : null}
  </div>;
}
