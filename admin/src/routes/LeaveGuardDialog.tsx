import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, InlineMessage } from "../components/ui/Primitives";
import { useOverlayRoot } from "../components/ui/floating";
import {
  describeUnsavedElsewhere,
  type ExitSaveOutcome,
} from "../lib/exit-save";

// The confirmation shown when an exit would leave unsaved work behind. It is the one prompt every
// exit path uses: an internal navigation held by the content layout's blocker, a Back that lands
// outside the editor, and sign-out (#1032). A browser unload cannot show it — that path gets the
// platform's own confirmation instead — so the wording here has to be true of every in-app exit
// rather than of navigation alone.
//
// It traps focus while open and returns focus to the control that attempted the exit when it
// closes, per the shared focus contract (#587). The safe choice, keep editing, is the default
// focus, so an accidental Enter does not discard work. Save and leave carries
// primary visual emphasis when saving is available.
//
// `onSave` is optional because not every caller has something to save: the media route's guard
// protects a form the person is closing, while the content editor can commit the work first.
// When it is supplied, the save runs here and the exit waits for its exact result. A refused,
// failed, or conflicted save resolves false, and this dialog stays open with the work intact
// rather than treating "I clicked save and leave" as permission to leave without saving.
function focusableWithin(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled"));
}

export function LeaveGuardDialog({
  onConfirm,
  onCancel,
  onSave,
  title = "Leave with unsaved changes?",
  description,
  confirmLabel = "Discard and leave",
  cancelLabel = "Keep editing",
}: {
  onConfirm: () => void;
  onCancel: () => void;
  onSave?: () => Promise<ExitSaveOutcome>;
  title?: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  const inheritedRoot = useOverlayRoot();
  // A route or sign-out guard can be owned above the active native editor.
  // Keep its confirmation in that modal's top layer, where it remains operable.
  const activeModal = typeof CSS !== "undefined" && CSS.supports?.("selector(:modal)")
    ? document.activeElement?.closest<HTMLElement>("dialog:modal") ?? [...document.querySelectorAll<HTMLElement>("dialog:modal")].at(-1) ?? null : null;
  const overlayRoot = activeModal ?? inheritedRoot;
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveReport, setSaveReport] = useState<ExitSaveOutcome | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // The element focused when the exit was attempted; focus returns here on close.
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const focusables = focusableWithin(dialogRef.current);
    (focusables[0] ?? dialogRef.current)?.focus();
    return () => {
      mounted.current = false;
      triggerRef.current?.focus?.();
    };
  }, []);

  async function saveAndLeave() {
    if (!onSave || saving) return;
    setSaveReport(null);
    setSaving(true);
    let outcome: ExitSaveOutcome = { status: "failed" };
    try {
      outcome = await onSave();
    } finally {
      // The dialog is torn down by the caller on a successful exit, so guard the state writes:
      // this component may already be unmounted by the time the save resolves.
      if (mounted.current) setSaving(false);
    }
    if (!mounted.current) return;
    if (outcome.status === "saved") {
      onConfirm();
      return;
    }
    // Either the save did not land, or it landed here while other work from this session is
    // still only in the browser. Neither is permission to leave: the person chose to keep their
    // work, so the exit waits and the dialog says what is still outstanding.
    setSaveReport(outcome);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      // Escape is the cancel gesture, but never mid-save: the save is already on its way to the
      // server, and closing here would leave the person with no report of how it settled.
      if (!saving) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    // Trap Tab within the dialog so focus cannot reach the backdrop or the page behind it.
    const focusables = focusableWithin(dialogRef.current);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const dialog = (
    <div className="leave-guard-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="leave-guard-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-guard-title"
        aria-describedby="leave-guard-description"
        onKeyDown={handleKeyDown}
      >
        <h2 id="leave-guard-title">{title}</h2>
        <p id="leave-guard-description">
          {saveReport?.status === "unsaved-elsewhere"
            ? // The generic line would contradict what just happened: this surface is saved.
              "What you were working on is saved. Other work from this session is not."
            : onSave
              ? "This work is only in your browser. Save it first, or leave and discard it."
              : (description ??
                "You have unsaved changes in the editor. If you leave now, they will be discarded.")}
        </p>
        {saveReport?.status === "failed" ? (
          <InlineMessage tone="error" title="Save did not finish">
            The save didn&rsquo;t finish, so nothing was left behind. Check the
            editor and try again.
          </InlineMessage>
        ) : null}
        {saveReport?.status === "unsaved-elsewhere" ? (
          <InlineMessage tone="warning" title="Saved here, but not everywhere">
            {describeUnsavedElsewhere(saveReport.items)}
          </InlineMessage>
        ) : null}
        <div className="button-row">
          <Button disabled={saving} onClick={onCancel}>
            {cancelLabel}
          </Button>
          {/* The one choice here that destroys work, styled like every other destructive action
              in the CMS so it cannot be mistaken for the neutral one beside it. */}
          <Button variant="danger-quiet" disabled={saving} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          {onSave ? (
            <Button
              variant="primary"
              disabled={saving}
              onClick={() => void saveAndLeave()}
            >
              {saving ? "Saving…" : "Save and leave"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
  return overlayRoot ? createPortal(dialog, overlayRoot) : dialog;
}
