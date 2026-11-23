import { Link } from "react-router";
import type { useEditorLock } from "../hooks/useEditorLock";
import type { EditorLock, EditorLockActor } from "../lib/editor-locks";
import type { RecoveredEditorWork } from "../lib/editor-work-recovery";
import { contentPagesPath, recordListPath } from "../lib/routes";
import type { Surface } from "./EditorWorkspace";
import { Button, InlineMessage } from "./ui/Primitives";

type EditorPresence = ReturnType<typeof useEditorLock>;

function lockStartLabel(lock: EditorLock): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(lock.acquiredAtMs));
}

// The five presence states a person has to be able to tell apart: read-only because somebody
// else holds the record, a takeover this tab has asked for, a takeover that displaced this tab,
// an expired session, and a save conflict (which stays with the version guard, not here).
export function lockedSurfaceMessage(
  lock: EditorLock,
  editorLock: EditorPresence,
  surface: Surface,
  editorLockActor: EditorLockActor | undefined,
  options?: { preserveEditor?: boolean; saving?: boolean },
) {
  const samePerson = lock.ownerId === editorLockActor?.id;
  // "Somebody else has this" and "somebody took this from me" are different things to be told,
  // whether or not there was unsaved work in the tab at the time.
  const displaced = editorLock.displacedBy !== null;
  const keptWork = options?.preserveEditor === true;
  const asked = editorLock.outgoingRequestPending;
  // One ask fits on a lease. Somebody already waiting is not a queue this person can join.
  const waitingElse = editorLock.requestedByOther;
  const title = displaced
    ? `${lock.ownerName} took over this record`
    : samePerson
      ? "You are editing this in another tab or window"
      : asked
        ? `Waiting for ${lock.ownerName} to hand this over`
        : `${lock.ownerName} is editing this right now`;
  const backPath =
    surface.kind === "record"
      ? recordListPath(surface.record)
      : contentPagesPath();
  return (
    <InlineMessage
      tone={displaced ? "warning" : asked ? "info" : "warning"}
      title={title}
      className={
        displaced
          ? "editor-lock-message editor-lock-message-displaced"
          : asked
            ? "editor-lock-message editor-lock-message-requested"
            : "editor-lock-message editor-lock-message-readonly"
      }
    >
      <p>
        {options?.saving
          ? "Another session took over while this tab’s save is finishing. Wait for its result before deciding whether to take over."
          : keptWork
            ? "Your unsaved changes are still here and are kept in this browser, so you can come back to them. Saving is off until you hold the record again."
            : displaced
              ? `${lock.ownerName} now holds the record and this tab is read-only. Nothing you had already saved was affected.`
                : asked
                ? `Your request was sent. ${lock.ownerName} can hand the record over, and this page updates on its own when it becomes free.`
                : `${samePerson ? "That session" : "The editing session"} began ${lockStartLabel(lock)}. This tab is read-only and has not changed the content.`}
      </p>
      <div className="button-row">
        {editorLock.canTakeOver ? (
          <Button
            variant="primary"
            disabled={editorLock.claiming || options?.saving}
            onClick={() => void editorLock.takeOver()}
          >
            {editorLock.claiming
              ? "Taking over…"
              : displaced
                ? "Take the record back"
                : "Take over editing"}
          </Button>
        ) : null}
        {!samePerson && !asked && !waitingElse && !options?.saving ? (
          <Button
            variant={editorLock.canTakeOver ? "secondary" : "primary"}
            onClick={() => void editorLock.requestTakeover()}
          >
            Ask to edit
          </Button>
        ) : null}
        {options?.saving ? null : (
          <Link className="button button-secondary" to={backPath}>
            Back out
          </Link>
        )}
      </div>
      {waitingElse ? (
        <p>
          {`${waitingElse.byName} already asked for this record, so there is nobody to ask ahead of them. This page updates on its own when it becomes free.`}
        </p>
      ) : null}
      {!editorLock.canTakeOver && !waitingElse ? (
        <p>
          Your role cannot take another editor’s active session, so asking is the
          way in.
        </p>
      ) : null}
    </InlineMessage>
  );
}

// Shown to the holder. An ask never moves the record on its own: this is the person who
// decides.
export function takeoverRequestMessage(editorLock: EditorPresence, activeSurfaceDirty: boolean, saving: boolean) {
  const request = editorLock.incomingRequest;
  if (!request) return null;
  return (
    <InlineMessage
      tone="info"
      title={`${request.byName} is asking to edit this`}
      className="editor-lock-message editor-lock-message-incoming"
    >
      <p>
        You still hold the record. Hand it over when you are at a good stopping
        point, or keep going and answer later.
      </p>
      <div className="button-row">
        <Button
          variant="primary"
          disabled={activeSurfaceDirty || saving}
          onClick={() => void editorLock.yieldEditor()}
        >
          Hand over editing
        </Button>
        <Button variant="secondary" onClick={() => void editorLock.dismissRequest()}>
          Keep editing
        </Button>
      </div>
      {activeSurfaceDirty ? (
        <p>Save or discard your changes first, then hand it over.</p>
      ) : null}
    </InlineMessage>
  );
}

export function yieldedMessage(editorLock: EditorPresence) {
  return (
    <InlineMessage
      tone="info"
      title="You handed this record over"
      className="editor-lock-message editor-lock-message-yielded"
    >
      <p>
        This tab is read-only until you ask for the record back. Nothing you saved
        was lost.
      </p>
      <div className="button-row">
        <Button variant="primary" onClick={() => void editorLock.reclaim()}>
          Take the record back
        </Button>
      </div>
    </InlineMessage>
  );
}

export function recoveredWorkMessage(recoveredWork: RecoveredEditorWork | null, discardRecoveredWork: () => void) {
  if (!recoveredWork) return null;
  return (
    <InlineMessage
      tone="info"
      role="status"
      title="Recovered your unsaved changes"
      className="editor-lock-message editor-lock-message-recovered"
    >
      <p>{recoveredWork.displacedBy
        ? `These are the changes you had open when ${recoveredWork.displacedBy} took over. Review them before saving, because the record may have changed since.`
        : "Review the recovered changes, then save them as a draft."}</p>
      <div className="button-row">
        <Button variant="secondary" onClick={discardRecoveredWork}>
          Dismiss this notice
        </Button>
      </div>
    </InlineMessage>
  );
}
