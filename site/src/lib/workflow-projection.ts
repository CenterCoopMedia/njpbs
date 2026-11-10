// The read boundary between a stored record and the editorial workflow core.
//
// A record and a workflow state both carry a field called `publishAt`, and they mean
// different things. On a record it is a required ISO-8601 string, "the instant this
// becomes public," present whatever the status. On a WorkflowState it is epoch
// ms and set ONLY while the stage is `scheduled`, meaning "the pending go-live time."
// The workflow core models the state as a decoupled envelope, so a record can
// never stand in for a workflow state; that keeps the pure core correct and leaves the
// reconciliation here. This module is that reconciliation, and the only place a record
// becomes a WorkflowState.
//
// Three things it deliberately does not do:
//
// It does not derive the stage from the clock. The record's `status` is the stored
// truth about where a piece sits, and `isDueForPublish` already owns the question of
// whether a scheduled piece's time has arrived. Comparing `publishAt` to `now` here to
// decide "scheduled or published" would put that decision in two places, free to
// disagree, and would make the projection non-deterministic: the same stored row would
// project to different stages depending on when it was read. It would also strand the
// piece. The scheduler queries Firestore for `status == "scheduled"` and is what flips
// a due row to published; a projection that called a past-dated row "published" on its
// own would take it out of the due set while the stored status never moved, so the
// scheduler would never publish it and the build gate, which reads the stored status,
// would never emit it. The UI would say published and the page would never appear.
//
// It does not carry the record's public-instant into any other stage's envelope. For
// every stage but `scheduled` the projected publishAt is null, so the core's "publishAt
// present exactly while scheduled" invariant holds by construction rather than by a
// caller remembering to clear the field.
//
// It does not read the soft-delete marker. The workflow envelope has no notion of
// deletion, so a deleted record still projects to whatever stage it sits in; whether a
// deleted piece may be shown or shipped stays the caller's call, and the build gate is
// where that is settled.

import type { EditorialBase } from "../../../packages/content-core/src/content-model";
import { parsePublishInstant } from "../../../packages/content-core/src/publish-instant";
import { validateWorkflowState, type WorkflowState } from "./editorial-workflow";

/** The subset of a record the projection reads. */
export type Projectable = Pick<EditorialBase, "status" | "publishAt" | "assignee">;

/**
 * Either the envelope the core can act on, or the reason the record could not become
 * one. Shaped like the core's own TransitionResult so a caller handles a refusal the
 * same way in both places: `reason` is editor-facing plain words, `detail` is the
 * machine cause for logs.
 */
export type ProjectionResult =
  | { state: WorkflowState }
  | { error: { reason: string; detail: string } };

/**
 * Project a stored record into the workflow envelope the core speaks.
 *
 * The stage is the record's status. `assignee` normalizes every stored spelling of
 * "nobody" -- absent, null, empty, whitespace -- to the envelope's required null, and
 * trims a real uid. That is the same rule `applyWorkflowAction` applies when it accepts
 * an assign, so a row written before that rule existed, or imported around it, reads
 * back as unassigned rather than as a person whose id is the empty string. Getting this
 * wrong is durable: a move copies the assignee forward untouched, so a blank one would
 * ride along through every later transition. `publishAt` is parsed to epoch ms only for
 * a scheduled record and is null otherwise.
 *
 * A scheduled record whose `publishAt` cannot be read as an absolute instant is an
 * error, not a state with a missing time: it is the one row where the workflow needs
 * the number, and inventing one (the epoch, the current time) would either publish it
 * immediately or bury it. Every other stage ignores the string entirely, so a record
 * sitting in draft with a malformed publishAt still projects -- a stored value the
 * workflow does not read should not block editing the piece.
 *
 * The result is checked through validateWorkflowState on the way out, so this function
 * cannot hand back an envelope the core would reject. That is a postcondition on the
 * mapping above, not a second gate: an unknown stage is the case it catches in practice,
 * since `status` is a compile-time claim about an untrusted stored row.
 */
export function projectWorkflowState(record: Projectable): ProjectionResult {
  // The type says this is a record; at a load boundary the row is whatever the store
  // held. Reject a non-object before dereferencing, matching how the core's own
  // validator treats a malformed row.
  if (typeof record !== "object" || record === null) {
    return {
      error: {
        reason: "this piece could not be loaded. Reload the page, and let the team know if it keeps happening.",
        detail: `record is not an object: ${String(record)}`,
      },
    };
  }

  const stage = record.status;
  // A non-string stored assignee is not a person either, so it reads as unassigned
  // rather than being coerced into the envelope's string slot.
  const stored = typeof record.assignee === "string" ? record.assignee.trim() : "";
  const assignee = stored === "" ? null : stored;

  let publishAt: number | null = null;
  if (stage === "scheduled") {
    publishAt = parsePublishInstant(record.publishAt);
    if (publishAt === null) {
      return {
        error: {
          reason: "this piece is scheduled but its publish time cannot be read. Set the publish time again.",
          detail: `scheduled record has unreadable publishAt: ${String(record.publishAt)}`,
        },
      };
    }
  }

  const state: WorkflowState = { stage, assignee, publishAt };
  const invalid = validateWorkflowState(state);
  if (invalid !== null) return { error: invalid };
  return { state };
}
