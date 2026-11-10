import type { MediaDialogNavigation } from "../../context/MediaDialogContext";
import { ActionControl } from "../ui/ActionControl";
import { Icon } from "../ui/Icon";

/** Focus the replacement phone trigger after its keyed asset tools have mounted. */
export function focusMediaDialogNavigation(direction: "previous" | "next", previous: HTMLButtonElement | null, next: HTMLButtonElement | null) {
  const dialog = (previous ?? next)?.closest("dialog, [role=dialog]");
  const more = window.innerWidth <= 780
    ? dialog?.querySelector<HTMLButtonElement>('.media-frame-commands button[aria-label="More preview actions"]')
    : null;
  if (more && !more.disabled) { more.focus(); return; }
  const preferred = direction === "previous" ? previous : next;
  const fallback = direction === "previous" ? next : previous;
  (preferred && !preferred.disabled ? preferred : fallback && !fallback.disabled ? fallback : null)?.focus();
}

/** The guarded owner supplies real result availability/count; every frame uses it. */
export function mediaDialogNavigation({ position, previousRef, nextRef, previousAvailable, nextAvailable, blocked, request }: {
  position: string | null | undefined;
  previousRef: MediaDialogNavigation["previous"]["ref"];
  nextRef: MediaDialogNavigation["next"]["ref"];
  previousAvailable: boolean;
  nextAvailable: boolean;
  blocked: boolean;
  request: (direction: "previous" | "next", opener?: HTMLElement) => void;
}): MediaDialogNavigation | undefined {
  if (!position) return undefined;
  return {
    position,
    previous: { ref: previousRef, disabledReason: blocked ? "Finish the current media action first." : !previousAvailable ? "First file in these results." : undefined,
      onSelect: opener => request("previous", opener) },
    next: { ref: nextRef, disabledReason: blocked ? "Finish the current media action first." : !nextAvailable ? "Last file in these results." : undefined,
      onSelect: opener => request("next", opener) },
  };
}

export function MediaViewerNavigation({ navigation, announcePosition = true }: { navigation: MediaDialogNavigation; announcePosition?: boolean }) {
  return <div className="media-preview-step" role="group" aria-label="Step through this page">
    <ActionControl action="previous-page" presentation="icons" label="Previous file" graphic={<Icon name="chevron-left" />}
      ref={navigation.previous.ref} disabled={Boolean(navigation.previous.disabledReason)} aria-description={navigation.previous.disabledReason}
      onClick={event => navigation.previous.onSelect(event.currentTarget)} />
    <span role={announcePosition ? "status" : undefined} aria-hidden={!announcePosition || undefined}>{navigation.position}</span>
    <ActionControl action="next-page" presentation="icons" label="Next file" graphic={<Icon name="chevron-right" />}
      ref={navigation.next.ref} disabled={Boolean(navigation.next.disabledReason)} aria-description={navigation.next.disabledReason}
      onClick={event => navigation.next.onSelect(event.currentTarget)} />
  </div>;
}
