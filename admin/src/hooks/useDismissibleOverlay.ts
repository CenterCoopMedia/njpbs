import { useEffect, type RefObject } from "react";

/**
 * The two dismissals every temporary panel in the admin honors: Escape closes it and returns
 * focus to the control that opened it, and a pointer pressed anywhere outside closes it without
 * moving focus, because the pointer has already chosen where attention goes. The account menu,
 * the library's create menu, and the block palette all behave this way, so the rule lives once.
 *
 * `root` is the element that contains both the trigger and the panel; anything inside it is
 * "inside" for the outside-pointer test. `trigger` is where Escape sends focus back to.
 */
export function useDismissibleOverlay({
  open,
  root,
  trigger,
  onClose,
}: {
  open: boolean;
  root: RefObject<HTMLElement | null>;
  trigger?: RefObject<HTMLElement | null>;
  onClose: () => void;
}): void {
  useEffect(() => {
    if (!open) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      onClose();
      trigger?.current?.focus();
    }

    function closeWhenOutside(event: PointerEvent) {
      const container = root.current;
      if (!container || !event.composedPath().includes(container)) onClose();
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeWhenOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeWhenOutside);
    };
  }, [open, root, trigger, onClose]);
}
