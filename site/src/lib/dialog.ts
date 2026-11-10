// A reusable modal-dialog controller for the native <dialog> element.
//
// The report form and schedule program-details dialog share this controller.
// Both need the same ARIA APG modal behaviour: move focus in on open, keep Tab
// inside while open, Escape closes, the background is inert, and focus returns
// to the trigger on close. Native <dialog> + showModal() gives the focus trap,
// inert background, top layer, and Escape for free. This controller adds the
// parts the platform does not do reliably, so these overlays keep focus handling
// in one place:
//
//   1. Initial focus goes to a chosen element, not just the first control (which
//      is often a leading radio or a decorative close button).
//   2. Focus returns to the exact trigger on close, even when the browser's own
//      restore would miss -- focus moved programmatically while open, or the
//      trigger lived in a disclosure that has since closed.
//   3. Escape always closes (WCAG 2.1.2): the controller wires it so a modal is
//      never an inescapable keyboard trap even if an overlay forgets a close
//      control.
//
// Framework-free by design: the site ships server-rendered Astro islands with
// vanilla module scripts, so this is a plain function over a <dialog> already in
// the DOM, not a component in a UI framework. Mark any element inside the dialog
// with data-dialog-close to make it a dismiss control; a click on the backdrop
// dismisses too.

export interface ModalDialogOptions {
  /**
   * Element (or a selector resolved within the dialog) to receive focus when the
   * dialog opens. Defaults to the first focusable element, then the dialog
   * itself.
   */
  initialFocus?: HTMLElement | string;
  /** Run after the dialog has opened and initial focus is set. */
  onOpen?: () => void;
  /** Run after the dialog has closed and focus has been restored to the trigger. */
  onClose?: () => void;
  /**
   * Opt into a non-modal fallback when the platform lacks dialog.showModal
   * (effectively only very old WebViews). Off by default: without showModal the
   * background is not inert and Tab is not trapped, so the default is to warn and
   * not open rather than hand the user a broken "modal". Set true only when a
   * warned, non-inert overlay is genuinely better than not opening.
   */
  fallbackToNonModal?: boolean;
}

export interface ModalDialog {
  /**
   * Open the dialog. Pass the trigger so focus returns to it on close; when
   * omitted, the element focused at open time is used.
   */
  open(trigger?: HTMLElement | null): void;
  /** Close the dialog. Idempotent. */
  close(): void;
  /** True while the dialog is open. */
  readonly isOpen: boolean;
  /**
   * True when the platform can open a real modal (dialog.showModal exists). When
   * false, open() warns and does not open by default, so a caller is never handed
   * a non-inert "modal"; read this to handle the unsupported engine yourself, or
   * pass fallbackToNonModal to opt into a warned non-modal overlay.
   */
  readonly supportsModal: boolean;
  /** Remove every listener this controller added. */
  destroy(): void;
}

// Order matters: querySelectorAll returns document order, and the first match
// that is not hidden or explicitly removed from the tab order wins initial focus.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  // type=hidden is never focusable: a leading CSRF/tracking hidden input would
  // otherwise win initial focus and .focus() would silently no-op, leaving focus
  // outside the modal.
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='true']",
].join(",");

// display:none (on the element or any ancestor) makes an element and its whole
// subtree unfocusable -- .focus() is a no-op there. getComputedStyle reports an
// element's own display, not an inherited none, so walk ancestors to catch a
// control nested inside a display:none panel, not only one hidden directly.
function isDisplayNone(el: HTMLElement): boolean {
  if (typeof getComputedStyle !== "function") return false;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return true;
  }
  return false;
}

// A control is "actually disabled" -- and so unfocusable -- when it carries its
// own disabled attribute or sits inside a disabled <fieldset>, which the browser
// disables without giving each descendant its own attribute. .focus() no-ops on
// an actually-disabled control, so a fieldset-disabled field must not win focus.
function isDisabled(el: HTMLElement): boolean {
  if (el.hasAttribute("disabled")) return true;
  return el.closest("fieldset[disabled]") !== null;
}

// Whether .focus() would actually move focus to this element: not hidden, not in
// an aria-hidden subtree (the report form's honeypot), not inside an [inert]
// subtree, not CSS-hidden (display:none on the element or an ancestor), and not
// disabled. tabindex="-1" is allowed here -- it removes an element from the tab
// order, not from programmatic focus, so an explicit initialFocus (an APG
// heading/intro target) may point at one.
function canTakeFocus(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) return false;
  if (el.closest("[aria-hidden='true']")) return false;
  // [inert] (on the element or any ancestor) takes the whole subtree out of focus
  // and the tab order; .focus() no-ops there, so an inactive inert pane before the
  // real controls must not win initial focus. closest() catches an inert ancestor,
  // not only the element's own attribute.
  if (el.closest("[inert]")) return false;
  if (isDisplayNone(el)) return false;
  if (isDisabled(el)) return false;
  return true;
}

// The default scan picks the first *tabbable* control, so beyond being focusable
// it must be in the tab order: tabindex="-1" is skipped here even though it is
// programmatically focusable (resolveInitialFocus still honors it for an explicit
// target).
function isFocusableCandidate(el: HTMLElement): boolean {
  if (el.getAttribute("tabindex") === "-1") return false;
  return canTakeFocus(el);
}

function firstFocusable(root: ParentNode): HTMLElement | null {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
    if (isFocusableCandidate(el)) return el;
  }
  return null;
}

function resolveInitialFocus(
  dialog: HTMLDialogElement,
  initialFocus?: HTMLElement | string,
): HTMLElement {
  const requested =
    initialFocus instanceof HTMLElement
      ? initialFocus
      : typeof initialFocus === "string"
        ? dialog.querySelector<HTMLElement>(initialFocus)
        : null;
  // Only honor an explicit target that can actually take focus. A caller-passed
  // control that a responsive or conditional state has hidden or disabled (a
  // hidden or aria-hidden element, one inside a display:none panel, or a disabled
  // control) would no-op under .focus() and leave focus unplaced, so fall back to
  // the first usable control, then the dialog. canTakeFocus, not
  // isFocusableCandidate, is the right gate: an explicit target is allowed to be
  // tabindex="-1" (programmatically focusable) even though the default scan skips
  // such elements.
  if (requested && canTakeFocus(requested)) return requested;
  return firstFocusable(dialog) ?? dialog;
}

// A dialog's accessible name is a non-empty aria-label, or an aria-labelledby
// whose referenced elements resolve to non-empty text. Checking only that the
// attribute is present would wave through an empty aria-label or an
// aria-labelledby pointing at a missing or empty id -- both leave the modal
// nameless (fails 4.1.2), which is exactly what the dev warning should catch.
function hasAccessibleName(dialog: HTMLDialogElement): boolean {
  const label = dialog.getAttribute("aria-label");
  if (label && label.trim() !== "") return true;
  const labelledby = dialog.getAttribute("aria-labelledby");
  if (labelledby) {
    const doc = dialog.ownerDocument;
    const text = labelledby
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text !== "") return true;
  }
  return false;
}

/**
 * Wire a native <dialog> to the ARIA APG modal pattern. The dialog must carry an
 * accessible name (aria-labelledby or aria-label); a missing name is warned in
 * dev because a nameless modal fails 4.1.2.
 */
export function createModalDialog(
  dialog: HTMLDialogElement,
  options: ModalDialogOptions = {},
): ModalDialog {
  let trigger: HTMLElement | null = null;
  let open = false;
  // Native `close` events we caused ourselves via close(): dialog.close() runs
  // handleClose synchronously here but queues the platform `close` event as a
  // later task. Counting the ones we expect lets onDialogClose swallow exactly
  // those, so a close-then-reopen inside that task gap cannot let a stale event
  // tear down the new session -- the shared `open` flag alone cannot tell two
  // sessions apart, because a reopen flips it back to true.
  let pendingNativeCloses = 0;

  if (!hasAccessibleName(dialog) && typeof console !== "undefined") {
    console.warn(
      "createModalDialog: dialog has no accessible name; add aria-labelledby or aria-label (WCAG 4.1.2).",
      dialog,
    );
  }

  function restoreFocus(): void {
    // Back to the exact trigger. If it detached while the dialog was open there
    // is nowhere sensible to send focus, so leave the browser's own restore in
    // place rather than throw or strand focus on a removed node.
    const target = trigger;
    trigger = null;
    if (!target || !target.isConnected) return;
    target.focus();
    if (document.activeElement === target) return;
    // The trigger is still connected but could not take focus: it was disabled
    // after submit, or its disclosure/menu collapsed (display:none) while the
    // dialog was open -- the case the header comment promises to handle. focus()
    // no-oped, which would strand a keyboard user on <body>, so fall back to the
    // nearest focusable ancestor. Attribute inspection, not a focus() probe,
    // decides focusability so the choice is deterministic without layout. A
    // caller whose trigger predictably vanishes can name a return target in
    // onClose.
    for (
      let node: HTMLElement | null = target.parentElement;
      node;
      node = node.parentElement
    ) {
      if (node.matches(FOCUSABLE_SELECTOR) && isFocusableCandidate(node)) {
        node.focus();
        return;
      }
    }
  }

  // Single close side-effect path. Fires for the public close(), a backdrop or
  // data-dialog-close click, and a native Escape (which closes the dialog and
  // emits `close` without routing through close()), so focus is always restored.
  function handleClose(): void {
    if (!open) return;
    open = false;
    restoreFocus();
    options.onClose?.();
  }

  function onDialogClose(): void {
    // Swallow a `close` event we triggered ourselves via close() -- handleClose
    // already ran for it. A close we did not initiate (a native Escape that
    // bypassed close(), or a form method="dialog" submit) has no pending count
    // and runs normally.
    if (pendingNativeCloses > 0) {
      pendingNativeCloses -= 1;
      return;
    }
    handleClose();
  }

  function onKeydown(event: KeyboardEvent): void {
    // Native <dialog> already closes on Escape in modern browsers; this is the
    // guaranteed escape hatch for engines that do not, and it keeps the promise
    // that a modal is never an inescapable trap. close() is idempotent, so a
    // browser that also closes natively does not double-fire the side effects.
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }

  // A backdrop click has the dialog itself as its target (a click on any child
  // targets that child) AND lands outside the dialog's content box. Checking the
  // box, not just target === dialog, means padding or blank space the dialog
  // renders around its own content does not dismiss -- only a real backdrop click
  // does. With no layout available (happy-dom in tests, or a not-yet-laid-out
  // dialog) getBoundingClientRect is empty, so fall back to the target signal.
  function isBackdropClick(event: MouseEvent): boolean {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return true;
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  }

  function onDialogClick(event: MouseEvent): void {
    const target = event.target;
    // A data-dialog-close element dismisses from anywhere inside. Match on Element,
    // not HTMLElement, so an SVG icon inside the close button still resolves via
    // closest() -- SVGElement is an Element but not an HTMLElement, and the tighter
    // guard would leave an icon-only close button inert.
    if (target instanceof Element && target.closest("[data-dialog-close]")) {
      // A data-dialog-close control's only job is to dismiss. A bare <button>
      // inside a form defaults to type=submit, so without this the close click
      // would also submit the form (or run its validation) as it dismisses.
      // Suppress the default so the affordance is submit-safe in the form-backed
      // overlays this controller covers (newsletter, the report form).
      event.preventDefault();
      close();
      return;
    }
    if (isBackdropClick(event)) close();
  }

  function open_(nextTrigger?: HTMLElement | null): void {
    if (open) return;
    trigger =
      nextTrigger ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else if (options.fallbackToNonModal) {
      // Explicit opt-in only. No showModal means a <dialog> without the modal API
      // (effectively only very old WebViews, since showModal shipped with the
      // element in every engine). Warn -- the background is not inert and Tab is
      // not trapped, so the modal contract cannot be met here -- then open the
      // non-modal overlay the caller asked for.
      if (typeof console !== "undefined") {
        console.warn(
          "createModalDialog: showModal() is unavailable; opening non-modal per fallbackToNonModal. The background is not inert and focus is not trapped (the WCAG modal contract is not met).",
          dialog,
        );
      }
      dialog.setAttribute("open", "");
    } else {
      // Default: refuse to open rather than silently present a broken non-modal
      // "modal". Without showModal the background is not inert and Tab is not
      // trapped, so a keyboard or screen-reader user would be dropped into an
      // overlay that only looks modal. Like the site's report-dialog trigger,
      // leave the caller's real fallback (a plain link, an inline form) in place
      // instead of hijacking it. A caller that genuinely wants the degraded
      // overlay can pass fallbackToNonModal; supportsModal exposes the check.
      if (typeof console !== "undefined") {
        console.warn(
          "createModalDialog: showModal() is unavailable; not opening. Pass fallbackToNonModal to open a non-modal overlay, or handle the unsupported engine via supportsModal.",
          dialog,
        );
      }
      return;
    }
    open = true;
    const focusTarget = resolveInitialFocus(dialog, options.initialFocus);
    focusTarget.focus();
    // resolveInitialFocus already screens out hidden, aria-hidden, and
    // display:none targets; this catches any remaining node that still could not
    // take focus (for example a caller-passed element that is not a focusable
    // type), so focus is never left unplaced on open.
    if (focusTarget !== dialog && document.activeElement !== focusTarget) {
      (firstFocusable(dialog) ?? dialog).focus();
    }
    options.onOpen?.();
  }

  function close(): void {
    if (!open) return;
    if (dialog.open && typeof dialog.close === "function") {
      // dialog.close() drops the open attribute now but queues the native `close`
      // event as a later task. Relying on that event would leave isOpen true and
      // focus unrestored for any same-tick caller that closes and then reopens or
      // reads isOpen. Run the shared side effects now and count the queued event
      // as expected so onDialogClose swallows exactly it -- a plain `open` guard
      // is not enough, because a reopen before the event is delivered flips
      // `open` back to true and would let the stale event tear down the new
      // session.
      pendingNativeCloses += 1;
      dialog.close();
      handleClose();
    } else {
      dialog.removeAttribute("open");
      handleClose();
    }
  }

  dialog.addEventListener("close", onDialogClose);
  dialog.addEventListener("keydown", onKeydown);
  dialog.addEventListener("click", onDialogClick);

  return {
    open: open_,
    close,
    get isOpen() {
      return open;
    },
    get supportsModal() {
      return typeof dialog.showModal === "function";
    },
    destroy() {
      dialog.removeEventListener("close", onDialogClose);
      dialog.removeEventListener("keydown", onKeydown);
      dialog.removeEventListener("click", onDialogClick);
    },
  };
}
