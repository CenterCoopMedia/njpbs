import type { ComponentProps, Ref } from "react";
import type { BlockEditor } from "./BlockEditor";
import { AsyncActionButton, Button, InlineMessage, Toolbar } from "./ui/Primitives";

interface BlockEditorFeedbackProps {
  removalMessage: string | undefined;
  undoNoticeRef: Ref<HTMLButtonElement>;
  onUndoRemoval: () => void;
  onDismissRemoval: () => void;
  editorError: string | null;
  onClearEditorError: () => void;
  conflict: boolean;
  conflictCopy: ComponentProps<typeof BlockEditor>["conflictCopy"];
  hasHomeComposition: boolean;
  allowConflictOverwrite: boolean;
  saving: boolean;
  onReload?: () => void;
  onOverwrite?: () => void;
  overwriteDisabled: boolean;
  saveWarnings: readonly string[];
  structuralError: string | null;
  saveError: string | null;
  hasBlockErrors: boolean;
  invalidBlockCount: number;
}

export function BlockEditorFeedback({
  removalMessage,
  undoNoticeRef,
  onUndoRemoval,
  onDismissRemoval,
  editorError,
  onClearEditorError,
  conflict,
  conflictCopy,
  hasHomeComposition,
  allowConflictOverwrite,
  saving,
  onReload,
  onOverwrite,
  overwriteDisabled,
  saveWarnings,
  structuralError,
  saveError,
  hasBlockErrors,
  invalidBlockCount,
}: BlockEditorFeedbackProps) {
  return (
    <>
      {/*
    The way back from a removal, in the editor's own voice: what went, and one control that
    takes it back. It sits beside the editing commands rather than floating over the page, so
    it cannot cover the block that replaced the removed one, and it stays until it is answered,
    dismissed, or made stale — a notice that fades on a timer is no use to somebody who looked
    away (#1035).
  */}
      {removalMessage !== undefined ? (
        <InlineMessage
          className="block-editor-removal-notice"
          tone="info"
          role="status"
        >
          <span>{removalMessage}</span>
          <Button ref={undoNoticeRef} onClick={onUndoRemoval}>
            Undo removal
          </Button>
          <Button
            variant="ghost"
            aria-label="Dismiss removal notice"
            onClick={onDismissRemoval}
          >
            Dismiss
          </Button>
        </InlineMessage>
      ) : null}

      {editorError ? (
        <InlineMessage className="block-editor-error" tone="error">
          <span className="error-text">{editorError}</span>
          <Button onClick={onClearEditorError}>Dismiss</Button>
        </InlineMessage>
      ) : null}

      {/*
    The conflict gets its own slot rather than a place in the error chain below, because it
    is not the same kind of thing and the two can be true at once. It is a standing question
    about the document, not a fault in this attempt, and it outlives the attempt: answering
    "save anyway" on a page that then fails validation leaves the person with both an error
    to fix and a question still open. Showing only the conflict would hide what to fix;
    showing only the error would hide that the save is still held, and the button that
    releases it. So both render.

    Naming the available outcomes is the whole design. A normal version conflict has two:
    reloading destroys their work and saving anyway destroys someone else's. A create-only
    conflict has just one because this editor never loaded the newly created page, so an
    overwrite cannot be an informed choice.
  */}
      {conflict ? (
        <InlineMessage
          className="block-editor-error"
          tone="warning"
          // Announced, because this arrives asynchronously: the person pressed Save, focus is
          // still on Save, and the answer is that the save did not happen and the button is now
          // disabled. Without a live region a screen reader reports none of that. InlineMessage
          // only derives a role for error and success tones, so warning is silent by default --
          // right for a warning that is on screen from the start, wrong for one that appears in
          // response to an action. The tone stays warning because this is a question, not a
          // fault; the role is about when it is spoken, not how it looks.
          role="alert"
          title={
            conflictCopy?.title ?? (allowConflictOverwrite || hasHomeComposition
              ? "Someone else saved this page while you were editing it"
              : "This page was created while you were editing it")
          }
        >
          <span>
            {conflictCopy?.message ?? (hasHomeComposition
              ? "Your changes are still here and have not been saved. Reload to review the latest version before applying your edits again."
              : allowConflictOverwrite
              ? "Your changes are still here and have not been saved. Saving now would overwrite their work."
              : "Your changes are still here and have not been saved. Reload the page to review the version that was created.")}
          </span>
          <Toolbar>
            {onReload ? (
              // Held while a forced save is in flight, so the two answers cannot both be taken.
              // Reloading mid-save reseeds the editor from the store, and the save that is still
              // out then reports the version *its* write produced -- leaving the host claiming a
              // version that does not describe the blocks now on screen, which is the silent
              // overwrite this whole banner exists to prevent. The host blocks its own rail the
              // same way while saving; this is the one other way out of a hydrated page.
              <Button onClick={onReload} disabled={saving}>
                {conflictCopy?.reloadLabel ?? "Reload the page, discarding your changes"}
              </Button>
            ) : null}
            {/*
          This is the save control while a conflict stands. The page workspace can hide the
          editor's ordinary Save button in favor of its combined Update action, so this
          control must report its own progress. AsyncActionButton keeps focus in place,
          announces the pending state, and refuses a second click while the write is out.

          Held too when save capability is gone: `canSave` follows a live users/{uid}
          snapshot, so a revoke can land while this question is still on screen. handleSave
          refuses it either way, which would make an enabled button a destructive-looking
          promise that quietly does nothing.
        */}
            {onOverwrite ? (
              <AsyncActionButton
                aria-label="Save anyway, overwriting their changes"
                disabled={overwriteDisabled}
                label="Save anyway, overwriting their changes"
                onClick={onOverwrite}
                pending={saving}
                pendingLabel="Saving…"
              />
            ) : null}
          </Toolbar>
        </InlineMessage>
      ) : null}
      {conflict && saving ? (
        // Keep the polite progress update outside the assertive conflict alert. The alert
        // has already explained why the first save stopped; placing this status inside it
        // can make assistive technology repeat the whole warning when the overwrite starts.
        <span
          aria-atomic="true"
          className="block-editor-save-status sr-only"
          role="status"
        >
          Saving…
        </span>
      ) : null}

      {/* One slot for what went wrong with this attempt, so the order here is a priority. */}
      {saveWarnings.length ? <InlineMessage tone="warning" title="Record card warning">
        {saveWarnings.map(warning => <p key={warning}>{warning}</p>)}
      </InlineMessage> : null}
      {structuralError ? (
        <InlineMessage className="block-editor-error" tone="error">
          <span className="error-text">{structuralError}</span>
        </InlineMessage>
      ) : saveError ? (
        <InlineMessage
          className="block-editor-error"
          tone="error"
          title="Save failed"
        >
          <span className="error-text">{saveError}</span>
        </InlineMessage>
      ) : hasBlockErrors ? (
        <InlineMessage className="block-editor-error" tone="error">
          <span className="error-text">
            {conflict
              ? "Fix the highlighted blocks before overwriting."
              : "Fix the highlighted blocks before saving."}
          </span>{" "}
          {/* The first invalid block takes focus; the count names the remaining work. */}
          <span className="block-editor-error-count">
            {invalidBlockCount === 1
              ? "1 block needs attention; it is highlighted in the content."
              : `${invalidBlockCount} blocks need attention; they are highlighted in the content.`}
          </span>
        </InlineMessage>
      ) : null}
    </>
  );
}
