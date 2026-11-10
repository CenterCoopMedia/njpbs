import { ControlSizingProvider } from "../../context/ControlSizingContext";
import { useContext, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MediaDialogContext } from "../../context/MediaDialogContext";
import { Menu, type MenuItem } from "../ui/Menu";
import { useToolbarNavigation } from "../ui/useToolbarNavigation";
import { ActionControl } from "../ui/ActionControl";
import { OverflowToolbar, type OverflowToolbarItem } from "../ui/OverflowToolbar";
import { MediaFavoriteButton } from "../MediaFavoriteButton";
import { CopyMediaLinkPanel } from "./CopyMediaLink";
import "./MediaPreviewHeaderActions.css";

export interface MediaPreviewHeaderActionsProps {
  downloads: ReactNode;
  transcript?: { onSelect: () => void; expanded: boolean; controls: string };
  clip?: { onSelect: () => void; expanded: boolean; controls: string };
  favorite?: Pick<ComponentProps<typeof MediaFavoriteButton>, "favorite" | "pending" | "disabled" | "onToggle" | "name">;
  copyLink: string | (() => string);
}

export function MediaPreviewHeaderActions(props: MediaPreviewHeaderActionsProps) {
  return <ControlSizingProvider size="standard"><MediaPreviewHeaderActionsContent {...props} /></ControlSizingProvider>;
}

function MediaPreviewHeaderActionsContent({ downloads, transcript, clip, favorite, copyLink }: MediaPreviewHeaderActionsProps) {
  const root = useRef<HTMLDivElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const frame = useContext(MediaDialogContext);
  const [contextToolbar, setContextToolbar] = useState<HTMLDivElement | null>(null);
  const [commandToolbar, setCommandToolbar] = useState<HTMLDivElement | null>(null);
  useToolbarNavigation(frame.actionsInHeader ? contextToolbar : null);
  useToolbarNavigation(frame.actionsInHeader ? commandToolbar : null);
  const copyAnchor = useRef<HTMLElement | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  function openCopy() {
    copyAnchor.current = copyButton.current?.getClientRects().length ? copyButton.current
      : frame.commandsTarget?.querySelector<HTMLElement>('button[aria-label="More preview actions"]')
      ?? root.current?.querySelector<HTMLElement>('button[aria-label="Copy link"]')
      ?? root.current?.querySelector<HTMLElement>('button[aria-label="More preview actions"]') ?? null;
    setCopyOpen(true);
  }
  useLayoutEffect(() => {
    if (!copyOpen || !frame.actionsInHeader) return;
    copyAnchor.current = frame.compactActions
      ? frame.commandsTarget?.querySelector<HTMLElement>('button[aria-label="More preview actions"]') ?? null
      : copyButton.current;
    window.dispatchEvent(new Event("resize"));
  }, [copyOpen, frame.actionsInHeader, frame.commandsTarget, frame.compactActions]);
  const items: OverflowToolbarItem[] = [];
  for (const [key, action, priority] of [["transcript", transcript, 4], ["clip", clip, 3]] as const) {
    if (action) items.push({
      key, priority,
      node: <ActionControl action={key === "transcript" ? "media-transcript" : "media-clip"} presentation="text"
        aria-controls={action.controls} aria-expanded={action.expanded} onClick={action.onSelect} />,
      menuItem: { key, label: key === "transcript" ? "Transcript" : "Create clip", onSelect: action.onSelect },
    });
  }
  if (favorite) {
    const { name, onToggle, favorite: pressed, pending, disabled } = favorite;
    items.push({
      key: "favorite", priority: 2, zone: "trailing",
      node: <ActionControl action="media-favorite" presentation="icons" contextLabel={name} aria-pressed={pressed === true}
        label={pending ? "Saving favorite" : "Favorite"} aria-busy={pending || undefined}
        aria-disabled={pending || disabled || undefined} disabled={disabled || pressed === undefined}
        onClick={() => { if (!pending) onToggle(); }} />,
      menuItem: { key: "favorite", checked: pressed === true, label: "Favorite", icon: "heart",
        hidden: disabled, disabledReason: pending ? "Saving favorite." : pressed === undefined ? "Checking favorite state." : undefined,
        onSelect: () => { if (!pending && !disabled && pressed !== undefined) onToggle(); } },
    });
  }
  items.push({ key: "copy", priority: 1, zone: "trailing",
    node: <ActionControl action="media-copy-link" ref={copyButton} presentation="icons" aria-expanded={copyOpen} aria-haspopup="dialog" onClick={openCopy} />,
    menuItem: { key: "copy", label: "Copy link", icon: "link", onSelect: openCopy },
  });
  if (frame.actionsInHeader) {
    const navigationItems: MenuItem[] = frame.navigation ? (["previous", "next"] as const).map(direction => ({
      key: `file-${direction}`, label: direction === "previous" ? "Previous file" : "Next file",
      group: `Current results · ${frame.navigation!.position}`, icon: direction === "previous" ? "chevron-left" : "chevron-right",
      disabledReason: frame.navigation![direction].disabledReason,
      onSelect: () => frame.navigation![direction].onSelect(
        frame.commandsTarget?.querySelector<HTMLElement>('button[aria-label="More preview actions"]')
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)),
    })) : [];
    return <div ref={root} className="media-preview-header-actions" data-shared-frame>
      {frame.contextActionsTarget ? createPortal(<div ref={setContextToolbar} className="media-frame-secondary-controls" hidden={frame.compactActions} role="toolbar" aria-label="Asset actions">
        {items.map(item => <span key={item.key}>{item.node}</span>)}
      </div>, frame.contextActionsTarget) : null}
      {frame.commandsTarget ? createPortal(<div ref={setCommandToolbar} className="media-frame-command-controls" role="toolbar" aria-label="Preview actions">
        {downloads}
        {frame.compactActions ? <Menu label="More preview actions" tooltip="More preview actions" variant="ghost" showGroupLabels fitBelow
          items={[...navigationItems, ...items.map(item => ({ ...item.menuItem, group: "Asset" }))]} /> : null}
      </div>, frame.commandsTarget) : null}
      <CopyMediaLinkPanel path={copyLink} open={copyOpen} onOpenChange={setCopyOpen} anchorRef={copyAnchor} />
    </div>;
  }
  return <div ref={root} className="media-preview-header-actions">
    <OverflowToolbar label="Preview actions" items={items} collapseTogether search={downloads} moreLabel="More preview actions" moreVariant="ghost" />
    <CopyMediaLinkPanel path={copyLink} open={copyOpen} onOpenChange={setCopyOpen} anchorRef={copyAnchor} />
  </div>;
}
