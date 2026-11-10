// The editorial workflow (issue #202): how a piece moves from a draft to a published
// page, who may move it, and what each move records. This is the pure state model. It
// holds no Firestore, no Cloud Function, and no live clock: a caller passes the current
// workflow state, the actor, and the reference instant, and gets back either the next
// state plus an audit Transition, or a typed WorkflowError. The storage of the audit log
// (#196/#205), the onSchedule function, notifications, and durable autosave compose on
// top of this at the endpoints; none of them belong here.
//
// It is the workflow ENVELOPE around the content model (issue #200): WorkflowState
// carries no body, fields, or blocks, only a piece's editorial status (its stage, its
// assignee, and, while scheduled, when it goes live). Keeping it a distinct envelope --
// rather than a slice of the persisted record -- is deliberate: a stored EditorialRecord
// carries a required publishAt string with a different meaning (the record's intended
// public instant), so letting a record double as a workflow state conflated two fields.
// The envelope's publishAt is epoch ms and null unless scheduled, which no record shape
// satisfies, so the two can never be confused at the type level.
//
// Boundary contract: the core speaks epoch-ms numbers, never date strings. Turning a
// stored ISO-8601 string into a number -- and validating its timezone and calendar --
// is the persistence boundary's job, done once where the record is read, not in this
// pure core. A NaN or Infinity that reaches here is refused (it would silently pass the
// future-time check, since every comparison with NaN is false), so a bad clock cannot
// smuggle a past publish time through.
//
// The one authorization rule mirrors rbac.ts: a move is authorized by asking whether the
// principal holds the capability the action requires, never by testing a role name.
// Capability gating enforces the workflow. Approval is an explicit resting
// state separate from publication.

import {
  CONTENT_STATUSES,
  isAssignableContentStatus,
  type ContentStatus,
} from "../../../packages/content-core/src/content-model";
import { can, canEditContent, type Principal, type Resource } from "../../../packages/content-core/src/rbac";

/**
 * A piece's workflow state: the editorial envelope, no content. `publishAt` is epoch ms
 * and set ONLY while the stage is scheduled; in every other stage it is null, an
 * invariant validateWorkflowState enforces and every transition maintains. `stage`
 * draws from the same locked vocabulary as a record's status (ContentStatus), but the
 * envelope's distinct shape (a required assignee, a numeric publishAt) is what stops a
 * persisted record from ever standing in for a workflow state.
 */
export interface WorkflowState {
  stage: ContentStatus;
  assignee: string | null;
  publishAt: number | null;
}

/**
 * The moves an editor or the scheduler dispatches, each carrying its own payload so the
 * same reducer runs in the browser, the Cloud Function, and a test. Approval remains a
 * separate reviewed state. A publisher can publish or schedule a saved draft or reviewed
 * version directly. Edit and unschedule return locked work to draft.
 */
export type WorkflowAction =
  | { kind: "edit" }
  | { kind: "submit" }
  | { kind: "sendBack"; comment: string }
  | { kind: "approve" }
  | { kind: "reopen" }
  | { kind: "revise" }
  | { kind: "schedule"; publishAt: number }
  | { kind: "unschedule" }
  | { kind: "publish" }
  | { kind: "unpublish" }
  | { kind: "archive" }
  | { kind: "restore" }
  | { kind: "assign"; assignee: string };

export type ActionKind = WorkflowAction["kind"];

/**
 * Everything a transition needs beyond the state and the action. `now` is the reference
 * instant (epoch ms), passed in so the core stays pure. `resource` carries the ownership
 * and section the capability check reads (a contributor may submit only a draft they
 * own); an omitted resource denies an ownership-scoped grant.
 */
export interface TransitionContext {
  now: number;
  resource?: Resource;
  /** Server-owned publication admission, independent of the working stage. */
  publiclyVisible?: boolean;
}

/**
 * One recorded transition, the exact payload the append-only audit log (#196) stores.
 * `from` and `to` are equal for a stage-preserving action (assign), distinct for a move.
 * `action` is the whole action, not just its kind, so the row keeps WHAT changed -- a
 * schedule's publishAt, an assign's new assignee, a send-back's note. `actor` is the
 * authorizing principal's id, so a move can never be recorded under someone else's name.
 */
export interface Transition {
  from: ContentStatus;
  to: ContentStatus;
  action: WorkflowAction;
  actor: string;
  at: number;
  comment: string | null;
}

/**
 * A refused move. `reason` is editor-facing plain words the person can act on, never a
 * raw stage token or a machine id (matching the editor-admin core, issue #201); `detail`
 * carries the machine cause, for logs and bug reports only.
 */
export interface WorkflowError {
  // Normally the attempted action's kind. On the one path that refuses an unrecognized kind
  // (a malformed runtime action from an untrusted boundary), this echoes the raw attempted
  // string, which is by definition outside ActionKind, so the type admits a plain string for
  // that diagnostic case rather than overstating the guarantee.
  action: ActionKind | string;
  reason: string;
  detail?: string;
}

export type TransitionResult =
  | { state: WorkflowState; transition: Transition }
  | { error: WorkflowError };

/**
 * The legal stage graph, as data: from each stage, which stage-changing action is
 * allowed and where it leads. A piece can only move along an edge here. `assign` is
 * stage-preserving and handled off this graph. Frozen at every level so a consumer
 * that imports it to render buttons cannot add an edge and widen what applyWorkflowAction
 * later trusts; under ES-module strict mode a mutation attempt throws.
 */
export const STAGE_GRAPH: Readonly<
  Record<ContentStatus, Readonly<Partial<Record<ActionKind, ContentStatus>>>>
> = Object.freeze({
  draft: Object.freeze({ submit: "in_review", schedule: "scheduled", publish: "published", archive: "archived" }),
  in_review: Object.freeze({ edit: "draft", sendBack: "draft", approve: "approved", schedule: "scheduled", publish: "published", archive: "archived" }),
  approved: Object.freeze({ edit: "draft", reopen: "draft", schedule: "scheduled", publish: "published", archive: "archived" }),
  scheduled: Object.freeze({ edit: "draft", publish: "published", unschedule: "draft", archive: "archived" }),
  published: Object.freeze({ edit: "draft", revise: "draft", unpublish: "draft", archive: "archived" }),
  archived: Object.freeze({ restore: "draft" }),
} as Record<ContentStatus, Partial<Record<ActionKind, ContentStatus>>>);

/**
 * The capability each action requires, checked through rbac's can()/canEditContent() so
 * a move is gated by what the principal holds, never by a role name. `edit` and `submit`
 * need edit rights on the piece (any or own); publish, schedule and unschedule need
 * content.publish; unpublish needs content.unpublish; archive and restore use the administrator
 * content.delete boundary; assign is an editor power (content.edit.any). There is no
 * assignment-specific capability -- assignment is a review-desk power, not its own
 * permission.
 */
const ACTION_CAPABILITY: Readonly<Record<ActionKind, (p: Principal, r: Resource) => boolean>> = Object.freeze({
  edit: (p, r) => canEditContent(p, r),
  submit: (p, r) => canEditContent(p, r),
  sendBack: (p, r) => can(p, "content.edit.any", r),
  approve: (p, r) => can(p, "content.edit.any", r),
  reopen: (p, r) => can(p, "content.edit.any", r),
  revise: (p, r) => can(p, "content.edit.any", r),
  schedule: (p, r) => can(p, "content.publish", r),
  publish: (p, r) => can(p, "content.publish", r),
  unschedule: (p, r) => can(p, "content.publish", r),
  unpublish: (p, r) => can(p, "content.unpublish", r),
  archive: (p, r) => can(p, "content.delete", r),
  restore: (p, r) => can(p, "content.delete", r),
  assign: (p, r) => can(p, "content.edit.any", r),
});

// The known action kinds, taken as the own keys of ACTION_CAPABILITY so the two can never
// drift. At a runtime boundary (HTTP JSON) the WorkflowAction type is a claim, not a
// guarantee: a malformed action whose `kind` names a prototype member ("__proto__",
// "constructor", "toString") would otherwise resolve an inherited value from the
// prototype-backed graph or this table -- bypassing the illegal-move guard, then throwing
// a TypeError when the inherited value is not callable. Membership is checked against this
// set before any lookup, so an unrecognized kind fails closed as a WorkflowError.
const ACTION_KINDS: ReadonlySet<string> = new Set(Object.keys(ACTION_CAPABILITY));

/**
 * Human names for the stages, for editor-facing copy. The core never shows a raw stage
 * token (matching issue #201's hide-the-machine-names rule).
 */
export const STAGE_LABELS: Readonly<Record<ContentStatus, string>> = Object.freeze({
  draft: "draft",
  in_review: "in review",
  approved: "approved",
  scheduled: "scheduled to publish",
  published: "published",
  archived: "archived",
});

/**
 * A workflow state is well-formed when publishAt is set exactly while the stage is
 * scheduled, and the stage is a known one. This is the invariant every transition
 * maintains and the postcondition applyWorkflowAction checks on the way out, so a corrupt
 * stored state (a stale client, a bad import, an older bug) can never be handed back --
 * and thereby saved -- with a publishAt hanging off a published piece, or a scheduled
 * piece with no time. Rejecting the unknown stage here is also what keeps the STAGE_GRAPH
 * lookup from indexing a stage that has no row. A load boundary can call this directly on
 * a stored piece for the same guarantee.
 */
export function validateWorkflowState(state: WorkflowState): { reason: string; detail: string } | null {
  // The type is a compile-time claim; at a load boundary the row may be null or a non-object.
  // Reject that shape before dereferencing so duePublications can scan a stored set without one
  // bad row throwing and aborting the whole batch -- a malformed row is simply not due.
  if (typeof state !== "object" || state === null) {
    return {
      reason: "this piece has no workflow status. Reload the page, and let the team know if it keeps happening.",
      detail: `workflow state is not an object: ${String(state)}`,
    };
  }
  if (!CONTENT_STATUSES.includes(state.stage)) {
    return {
      reason: "this piece has an unrecognized status. Reload the page, and let the team know if it keeps happening.",
      detail: `unknown stage: ${String(state.stage)}`,
    };
  }
  const scheduled = state.stage === "scheduled";
  const hasWhen = state.publishAt !== null;
  if (scheduled && !hasWhen) {
    return {
      reason: "this piece is scheduled but has no publish time. Set a publish time, or move it back to review.",
      detail: "stage is scheduled but publishAt is null",
    };
  }
  if (!scheduled && hasWhen) {
    return {
      reason: "this piece has a publish time but is not scheduled. Reload the page, and let the team know if it keeps happening.",
      detail: `publishAt is set while stage is ${state.stage}`,
    };
  }
  if (hasWhen && !Number.isFinite(state.publishAt as number)) {
    return {
      reason: "this piece's publish time is not a valid time. Set it again, and let the team know if it keeps happening.",
      detail: `publishAt is not finite: ${String(state.publishAt)}`,
    };
  }
  return null;
}

// The stage an action lands on: the STAGE_GRAPH edge for a stage move, or the same stage
// for the off-graph, stage-preserving assign (refused on a terminal piece). Undefined
// means the move is illegal from here.
function resolveTarget(stage: ContentStatus, action: WorkflowAction): ContentStatus | undefined {
  if (action.kind === "assign") return isAssignableContentStatus(stage) ? stage : undefined;
  // Own-property only. A stage's legal edges are exactly its own keys; an inherited lookup
  // would let a polluted Object.prototype (e.g. a planted "publish" or "schedule") read as a
  // real edge and admit a transition outside the declared workflow.
  const edges = STAGE_GRAPH[stage];
  return Object.hasOwn(edges, action.kind) ? edges[action.kind] : undefined;
}

/**
 * Apply one workflow action. Returns the next state plus the Transition the audit log
 * records, or a WorkflowError the UI surfaces and drops -- the bad state never lands.
 * Pure and non-mutating: a rejected action leaves the piece exactly as it was, and the
 * same inputs always give the same result.
 *
 * The checks run in a deliberate order -- state -> kind -> edge -> authorization ->
 * attribution -> inputs -- so a corrupt state or an unrecognized action kind is surfaced
 * before anything can launder it, and authorization is settled before any input (comment,
 * publish time, assignee) is read, so a refusal never reveals that an unauthorized actor was
 * one field away from success.
 */
export function applyWorkflowAction(
  state: WorkflowState,
  action: WorkflowAction,
  principal: Principal,
  ctx: TransitionContext,
): TransitionResult {
  const fail = (reason: string, detail: string): TransitionResult => ({
    error: { action: action.kind, reason, detail },
  });

  // (1) Surface a corrupt input state, do not heal it. Because a transition rebuilds
  // publishAt from scratch, applying an action to an already-invalid state would silently
  // repair it and erase the evidence of the data bug. This also makes the STAGE_GRAPH
  // lookup total by rejecting an unknown stage first.
  const corrupt = validateWorkflowState(state);
  if (corrupt) return fail(corrupt.reason, corrupt.detail);

  // (1b) Refuse an unrecognized action kind before any lookup. `action` is typed as a
  // WorkflowAction, but a runtime caller (deserialized HTTP JSON) can hand over any string.
  // A kind naming a prototype member would resolve an inherited value from the graph and
  // the capability table, slipping past the illegal-move guard and then throwing; reject it
  // as a clean WorkflowError instead. Checked before resolveTarget, which then only ever
  // does own-key lookups.
  if (!ACTION_KINDS.has(action.kind)) {
    return fail("that action is not recognized.", `unknown action kind: ${String(action.kind)}`);
  }

  // (2) The stage graph is the only way a piece moves. An unresolved target is an illegal
  // move: name the stage in plain words, never the raw token.
  const withdrawingSnapshot = action.kind === "unpublish" && ctx.publiclyVisible === true &&
    ["draft", "in_review", "approved", "scheduled"].includes(state.stage);
  const to = withdrawingSnapshot
    ? (state.stage === "scheduled" ? "draft" : state.stage)
    : resolveTarget(state.stage, action);
  if (to === undefined) {
    return fail(
      `that action is not available while the piece is ${STAGE_LABELS[state.stage]}`,
      `no ${action.kind} edge from ${state.stage}`,
    );
  }

  // (3) Authorization is the workflow enforcement, checked before any input so a refusal
  // never leaks that an unauthorized actor was one field from success.
  if (!ACTION_CAPABILITY[action.kind](principal, ctx.resource ?? {})) {
    return fail("you do not have permission to make this change.", `not authorized for ${action.kind}`);
  }

  // (4) Every transition is attributed to the authorizing principal's id, so a recorded
  // move can never name someone else. An authorized-but-unidentified principal is refused
  // rather than logged anonymously.
  const actor = principal.id?.trim();
  if (!actor) {
    return fail("that change could not be recorded, please try again.", "transition actor (principal id) is empty");
  }

  // (5) The transition stamps ctx.now and the schedule guard compares against it. A
  // non-finite clock would poison the timestamp and silently pass the future check, so
  // refuse it before any transition is built.
  if (!Number.isFinite(ctx.now)) {
    return fail("that change could not be recorded, please try again.", `transition clock is not finite: ${String(ctx.now)}`);
  }

  // (6) Per-action input guards on an otherwise-legal, authorized move. Each guarded branch
  // also builds recordedAction: the detached, normalized action the transition stores. It
  // holds the values that actually took effect (a trimmed note, a trimmed assignee, the
  // validated instant), and it is a fresh object, never the caller's, so a later mutation
  // of the passed-in action cannot rewrite history after this returns.
  let comment: string | null = null;
  let assignee = state.assignee;
  let publishAt: number | null = null;
  let recordedAction: WorkflowAction = { kind: action.kind } as WorkflowAction;

  if (action.kind === "schedule") {
    if (!Number.isFinite(action.publishAt)) {
      return fail("set a valid publish time.", `publishAt is not finite: ${String(action.publishAt)}`);
    }
    if (action.publishAt <= ctx.now) {
      return fail("the publish time must be in the future.", `publishAt ${action.publishAt} is not after now ${ctx.now}`);
    }
    publishAt = action.publishAt;
    recordedAction = { kind: "schedule", publishAt: action.publishAt };
  } else if (action.kind === "sendBack") {
    // The kind is recognized but the payload is still untrusted: a missing or non-string
    // comment must fail closed to a WorkflowError, not throw off .trim() at the HTTP boundary.
    if (typeof action.comment !== "string") {
      return fail("add a note so the writer knows what to change.", `sendBack comment is not a string: ${typeof action.comment}`);
    }
    const note = action.comment.trim();
    if (note === "") return fail("add a note so the writer knows what to change.", "sendBack comment is empty");
    comment = note;
    recordedAction = { kind: "sendBack", comment: note };
  } else if (action.kind === "assign") {
    if (typeof action.assignee !== "string") {
      return fail("pick a person to assign this to.", `assignee is not a string: ${typeof action.assignee}`);
    }
    const who = action.assignee.trim();
    if (who === "") return fail("pick a person to assign this to.", "assignee is empty");
    assignee = who;
    recordedAction = { kind: "assign", assignee: who };
  }

  // (7) Rebuild the state. assign preserves the stage and its publish time and only
  // changes who owns the piece; a stage move recomputes publishAt (set by a schedule,
  // cleared everywhere else), so the result always satisfies the invariant regardless of
  // the input's shape. assignee carries across a move: a move does not reassign the piece.
  const next: WorkflowState =
    action.kind === "assign"
      ? { stage: state.stage, assignee, publishAt: state.publishAt }
      : { stage: to, assignee: state.assignee, publishAt };

  // Postcondition: a belt-and-suspenders check that would catch a future edge added to
  // the graph without its matching publishAt handling.
  const invalid = validateWorkflowState(next);
  if (invalid) return fail(invalid.reason, invalid.detail);

  return {
    state: next,
    transition: { from: state.stage, to, action: recordedAction, actor, at: ctx.now, comment },
  };
}

/**
 * The actions available from a stage, for a UI that renders only the buttons a piece can
 * use (a draft offers submit, publish and schedule). `assign` is added for every
 * non-terminal stage, since it is stage-preserving and off the graph. Returns a fresh
 * array so a caller cannot mutate the source of truth. This reports stage-legality only. To
 * also hide the buttons a given person lacks the capability for, pair it with `canAttempt`,
 * which composes this with the same capability gate the reducer applies.
 */
export function availableActions(stage: ContentStatus): ActionKind[] {
  // A corrupt stage (a runtime string outside the enum, e.g. "__proto__") has no legal
  // actions. Check membership first: without it, STAGE_GRAPH["__proto__"] resolves
  // Object.prototype instead of an absent row, and the function would offer a phantom
  // "assign" button for a piece applyWorkflowAction refuses anyway.
  if (!CONTENT_STATUSES.includes(stage)) return [];
  const edges = Object.keys(STAGE_GRAPH[stage]) as ActionKind[];
  return isAssignableContentStatus(stage) ? [...edges, "assign"] : edges;
}

/**
 * Whether a principal could attempt an action on a piece at a given stage: the action is
 * legal from that stage (availableActions) and the principal holds the capability the action
 * requires, checked through the same rbac gate applyWorkflowAction enforces. The review UI
 * calls this to render only the buttons a given person can actually use, so it never has to
 * duplicate the action-to-capability map (which would drift: `submit`, for one, maps to a
 * content.edit.any-or-own disjunction, not a single capability). It answers a yes/no question
 * and mutates nothing, and the reducer re-checks the same gate, so a stale yes can never
 * authorize a move on its own.
 */
export function canAttempt(
  stage: ContentStatus,
  action: ActionKind,
  principal: Principal,
  resource?: Resource,
): boolean {
  if (!availableActions(stage).includes(action)) return false;
  return ACTION_CAPABILITY[action](principal, resource ?? {});
}

/**
 * The scheduled-publish due check the Cloud Function runs on its timer: a scheduled piece
 * is due once its publishAt has arrived. Pure and total -- it reads the `now` passed in,
 * never a live clock. A non-finite clock means "nothing is due" rather than a silent
 * wrong answer: with a NaN now, `publishAt <= now` is always false, so a due piece would
 * never publish and no error would say why; fail closed and let the caller pass a real
 * clock.
 */
export function isDueForPublish(state: WorkflowState, now: number): boolean {
  // A corrupt stored state is never due. The Cloud Function calls this directly on a
  // persisted row, so it does not pass through applyWorkflowAction's validation: route
  // the same validateWorkflowState check here, so a scheduled row with a non-finite or
  // missing publishAt (a bad import, a -Infinity that would otherwise satisfy `<= now`
  // and auto-publish, a NaN that would silently never fire) fails closed, and the
  // scheduler and the reducer can never disagree about what a well-formed state is.
  if (validateWorkflowState(state) !== null) return false;
  return (
    Number.isFinite(now) &&
    state.stage === "scheduled" &&
    state.publishAt !== null &&
    state.publishAt <= now
  );
}

/**
 * The batch the Cloud Function acts on: given the scheduled pieces keyed by id and the
 * current time, the ids due to go live now, in ascending publishAt order (the order they
 * were meant to publish in), ties broken by id. The id tiebreak makes the batch fully
 * ordered rather than dependent on object key order, so a replay of the same inputs produces
 * the identical sequence. The function flips exactly these to published and triggers one
 * rebuild -- no human in the loop.
 */
export function duePublications(states: Readonly<Record<string, WorkflowState>>, now: number): string[] {
  return Object.entries(states)
    .filter(([, s]) => isDueForPublish(s, now))
    .sort(
      (a, b) =>
        (a[1].publishAt as number) - (b[1].publishAt as number) ||
        (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    )
    .map(([id]) => id);
}
