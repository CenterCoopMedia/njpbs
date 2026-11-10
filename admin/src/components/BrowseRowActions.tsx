import { useId, useRef, useState, type ReactNode } from "react";
import { ControlSizingProvider } from "../context/ControlSizingContext";
import { ActionControl } from "./ui/ActionControl";
import { Icon } from "./ui/Icon";
import { Popover } from "./ui/Popover";

/** Native links keep their destination, origin and modified-click behavior in both views. */
export function BrowseRowActions({ primaryAction, children, name, className = "" }: {
  primaryAction: ReactNode; children?: ReactNode; name: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const inline = useRef<HTMLDivElement>(null);
  const [inlineWidth, setInlineWidth] = useState(0);
  const panelId = useId();
  return <ControlSizingProvider size="compact">
    <div className={`browse-row-actions ${className}`}>
      {children ? <div className="browse-row-inline" ref={inline} style={open ? { width: inlineWidth } : undefined}>{open ? null : children}</div> : null}
      <div className="browse-row-primary">{primaryAction}</div>
      <ActionControl action="open-menu" graphic={<Icon name="ellipsis" />}
        label="Actions" accessibleName={`${name} actions`} tooltipLabel={`${name} actions`}
        className="browse-row-overflow" size="compact" variant="ghost" presentation="icons"
        ref={trigger} aria-haspopup="dialog" aria-expanded={open}
        aria-controls={open ? panelId : undefined} onClick={() => {
          if (!open) setInlineWidth(inline.current?.getBoundingClientRect().width ?? 0);
          setOpen(value => !value);
        }} />
      <Popover anchorRef={trigger} label={`${name} actions`} open={open} onOpenChange={setOpen} placement="bottom-end" className="browse-row-action-popover">
        <div id={panelId} className="browse-row-action-list" onClick={event => {
          const target = (event.target as HTMLElement).closest("a[href], button");
          if (!target || target.getAttribute("aria-disabled") === "true" || target.hasAttribute("disabled")) return;
          setOpen(false);
          // Same-page, modified and new-tab links also leave this menu unmounted.
          // A completed route change owns its next focus after this native activation.
          trigger.current?.focus();
        }}>{primaryAction}{children}</div>
      </Popover>
    </div>
  </ControlSizingProvider>;
}
