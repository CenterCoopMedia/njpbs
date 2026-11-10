const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]';

// :focus-visible intentionally still matches some pointer-focused controls, including native
// selects and text inputs. Track only the control reached by pointer-down so CSS can hide that
// duplicate ring; the next keyboard event removes the marker and restores the normal ring.
export function installPointerFocusTracking(root: Document = document): () => void {
  let pointerFocused: HTMLElement | null = null;

  function clearPointerFocus() {
    pointerFocused?.removeAttribute("data-pointer-focus");
    pointerFocused = null;
  }

  function onPointerDown(event: PointerEvent) {
    clearPointerFocus();
    const control = event.composedPath().find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches(FOCUSABLE_SELECTOR),
    );
    if (!control) return;
    pointerFocused = control;
    control.setAttribute("data-pointer-focus", "true");
  }

  function onFocusOut(event: FocusEvent) {
    if (event.composedPath().includes(pointerFocused as EventTarget)) clearPointerFocus();
  }

  root.addEventListener("pointerdown", onPointerDown, true);
  root.addEventListener("keydown", clearPointerFocus, true);
  root.addEventListener("focusout", onFocusOut, true);

  return () => {
    root.removeEventListener("pointerdown", onPointerDown, true);
    root.removeEventListener("keydown", clearPointerFocus, true);
    root.removeEventListener("focusout", onFocusOut, true);
    clearPointerFocus();
  };
}
