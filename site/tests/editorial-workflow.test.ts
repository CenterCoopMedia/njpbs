import { describe, expect, it } from "vitest";

import {
  applyWorkflowAction,
  availableActions,
  canAttempt,
  duePublications,
  isDueForPublish,
  validateWorkflowState,
  STAGE_GRAPH,
  type ActionKind,
  type TransitionContext,
  type TransitionResult,
  type WorkflowAction,
  type WorkflowState,
} from "../src/lib/editorial-workflow";
import type { ContentStatus } from "../../packages/content-core/src/content-model";
import { can, type Principal, type Role } from "../../packages/content-core/src/rbac";

// A principal holding a single unscoped grant of the given role, matching the rbac
// spec's helper so the workflow tests read the same way.
function as(role: Role, id?: string): Principal {
  return { id, grants: [{ role }] };
}

// An editor with an id authorizes every stage move; the default context for a move whose
// point is not authorization. now is epoch ms: the core reads no wall clock.
const EDITOR = as("editor", "user-c6fb27c061@example.org");
const ADMIN = as("admin", "user-6ae80bcee6@example.org");
const NOW = 1_000;
const PAST = 500;
const FUTURE = 5_000;
const CTX: TransitionContext = { now: NOW };

const wf = (stage: ContentStatus, over: Partial<WorkflowState> = {}): WorkflowState => ({
  stage,
  assignee: null,
  publishAt: null,
  ...over,
});

const okState = (r: TransitionResult): WorkflowState => {
  if ("error" in r) throw new Error(`expected ok, got error: ${r.error.reason} (${r.error.detail})`);
  return r.state;
};

const errOf = (r: TransitionResult) => {
  if (!("error" in r)) throw new Error("expected an error result");
  return r.error;
};

const move = (
  state: WorkflowState,
  action: WorkflowAction,
  principal: Principal = EDITOR,
  ctx: TransitionContext = CTX,
): TransitionResult => applyWorkflowAction(state, action, principal, ctx);

describe("the stage graph is the only way a piece moves (issue #202)", () => {
  it("walks the full happy path draft -> published through approval and a schedule", () => {
    let s = wf("draft");
    const submit = move(s, { kind: "submit" });
    s = okState(submit);
    expect(s.stage).toBe("in_review");
    if ("transition" in submit) {
      expect(submit.transition).toMatchObject({
        from: "draft",
        to: "in_review",
        action: { kind: "submit" },
        actor: "user-c6fb27c061@example.org",
        at: NOW,
      });
    }

    s = okState(move(s, { kind: "approve" }));
    expect(s.stage).toBe("approved");

    s = okState(move(s, { kind: "schedule", publishAt: FUTURE }));
    expect(s.stage).toBe("scheduled");
    expect(s.publishAt).toBe(FUTURE);

    s = okState(move(s, { kind: "publish" }, as("editor", "cron"), { now: FUTURE }));
    expect(s.stage).toBe("published");
    // publishAt is cleared once the piece is live: it was "when it WILL go live".
    expect(s.publishAt).toBeNull();
  });

  it("publishes any saved working version without a schedule", () => {
    const s = okState(move(wf("approved"), { kind: "publish" }));
    expect(s.stage).toBe("published");
    expect(s.publishAt).toBeNull();
    expect(okState(move(wf("in_review"), { kind: "publish" })).stage)
      .toBe("published");
    expect(okState(move(wf("draft"), { kind: "publish" })).stage)
      .toBe("published");
  });

  it("rejects an illegal transition and leaves the state untouched, even for a super_admin", () => {
    const admin = as("super_admin", "a1");
    const schedule = { kind: "schedule", publishAt: FUTURE } as const;
    const err = errOf(move(wf("published"), schedule, admin));
    expect(err.action).toBe(schedule.kind);
    expect(err.detail).toContain("no schedule edge from published");
    // A published piece cannot be re-submitted; a draft cannot be unpublished.
    expect(errOf(move(wf("published"), { kind: "submit" }, admin)).action).toBe("submit");
    expect(errOf(move(wf("draft"), { kind: "unpublish" }, admin)).action).toBe("unpublish");
  });

  it("phrases an unavailable action in plain words, not the raw stage token", () => {
    const err = errOf(move(wf("in_review"), { kind: "restore" }));
    expect(err.reason).toContain("in review");
    expect(err.reason).not.toContain("in_review");
    expect(err.detail).toContain("no restore edge from in_review");
  });

  it("withdraws an admitted snapshot independently of the working stage and cancels its schedule", () => {
    // #2761: scheduled content may be unreviewed, so withdrawal returns it to draft.
    for (const stage of ["draft", "in_review", "approved", "scheduled"] as const) {
      const state = wf(stage, { publishAt: stage === "scheduled" ? FUTURE : null });
      expect(okState(move(state, { kind: "unpublish" }, EDITOR, { ...CTX, publiclyVisible: true })))
        .toMatchObject({ stage: stage === "scheduled" ? "draft" : stage, publishAt: null });
      expect(errOf(move(state, { kind: "unpublish" }, as("contributor", "reader"), { ...CTX, publiclyVisible: true })).detail)
        .toContain("not authorized");
    }
  });

  it("freezes the graph, so importing it directly cannot add an edge", () => {
    expect(Object.isFrozen(STAGE_GRAPH)).toBe(true);
    expect(Object.isFrozen(STAGE_GRAPH.draft)).toBe(true);
    expect(() => {
      (STAGE_GRAPH.draft as Record<string, ContentStatus>).restore = "archived";
    }).toThrow();
    // The illegal edge still does not exist after the failed mutation.
    expect(errOf(move(wf("draft"), { kind: "restore" }, ADMIN)).action).toBe("restore");
  });
});

describe("review actions carry their evidence (issue #202)", () => {
  it("records approval as a distinct reviewed resting state", () => {
    const r = move(wf("in_review"), { kind: "approve" });
    expect(okState(r).stage).toBe("approved");
    if ("transition" in r) expect(r.transition.comment).toBeNull();
  });

  it("sends an in-review piece back to draft with the reviewer's note", () => {
    const r = move(wf("in_review"), { kind: "sendBack", comment: "  Tighten the lede and add a source.  " });
    expect(okState(r).stage).toBe("draft");
    if ("transition" in r) {
      // The trimmed note is recorded, so the audit row is clean.
      expect(r.transition.comment).toBe("Tighten the lede and add a source.");
    }
  });

  it("refuses a send-back with no note, so the writer is never left guessing", () => {
    const blank = move(wf("in_review"), { kind: "sendBack", comment: "   " });
    expect(errOf(blank).action).toBe("sendBack");
    expect(errOf(blank).detail).toContain("empty");
  });

  it("records a null comment for a move that does not carry one", () => {
    const r = move(wf("approved"), { kind: "publish" });
    if ("transition" in r) expect(r.transition.comment).toBeNull();
  });

  it("requires an explicit reopen before approved content can be edited", () => {
    const r = move(wf("approved"), { kind: "reopen" });
    expect(okState(r).stage).toBe("draft");
  });
});

describe("scheduling requires a real future time (issue #202)", () => {
  it.each(["draft", "in_review", "approved"] as const)("lets a publisher schedule a %s piece for a future time", stage => {
    const s = okState(move(wf(stage), { kind: "schedule", publishAt: FUTURE }));
    expect(s.stage).toBe("scheduled");
    expect(s.publishAt).toBe(FUTURE);
  });

  it("refuses a publish time at or before now", () => {
    expect(errOf(move(wf("approved"), { kind: "schedule", publishAt: NOW })).reason).toContain("future");
    expect(errOf(move(wf("approved"), { kind: "schedule", publishAt: PAST })).action).toBe("schedule");
  });

  it("refuses a non-finite publish time", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(errOf(move(wf("approved"), { kind: "schedule", publishAt: bad })).detail).toContain("not finite");
    }
  });

  it("unschedules back to draft and clears the publish time", () => {
    const s = okState(move(wf("scheduled", { publishAt: 9_000 }), { kind: "unschedule" }));
    // A publisher can edit this draft and schedule it again without another review.
    expect(s.stage).toBe("draft");
    expect(s.publishAt).toBeNull();
  });

  it("publishes a scheduled piece immediately when asked (manual override)", () => {
    const s = okState(move(wf("scheduled", { publishAt: 9_000 }), { kind: "publish" }));
    expect(s.stage).toBe("published");
    expect(s.publishAt).toBeNull();
  });

  it("records the scheduled instant on the transition, so two schedules stay distinguishable", () => {
    const one = move(wf("approved"), { kind: "schedule", publishAt: FUTURE });
    const two = move(wf("approved"), { kind: "schedule", publishAt: 9_000 });
    if ("transition" in one) expect(one.transition.action).toEqual({ kind: "schedule", publishAt: FUTURE });
    if ("transition" in two) expect(two.transition.action).toEqual({ kind: "schedule", publishAt: 9_000 });
  });
});

describe("assignment is stage-preserving and attributed (issue #202)", () => {
  it("sets the assignee without changing the stage, and records the value that took effect", () => {
    const r = move(wf("in_review"), { kind: "assign", assignee: "  user-cf2166419c@example.org  " });
    const s = okState(r);
    expect(s.stage).toBe("in_review");
    expect(s.assignee).toBe("user-cf2166419c@example.org");
    if ("transition" in r) {
      expect(r.transition.from).toBe(r.transition.to);
      // The transition's action holds the trimmed assignee the state took, not the raw
      // input: the audit is the only record of who a piece was assigned to, so it must
      // match the state rather than the caller's untrimmed string.
      expect(r.transition.action).toEqual({ kind: "assign", assignee: "user-cf2166419c@example.org" });
    }
  });

  it("carries the assignee across a stage move", () => {
    const assigned = okState(move(wf("draft"), { kind: "assign", assignee: "user-cf2166419c@example.org" }));
    const submitted = okState(move(assigned, { kind: "submit" }));
    expect(submitted.assignee).toBe("user-cf2166419c@example.org");
  });

  it("preserves a scheduled piece's publish time when only reassigning it", () => {
    const s = okState(move(wf("scheduled", { publishAt: FUTURE }), { kind: "assign", assignee: "user-cf2166419c@example.org" }));
    expect(s.stage).toBe("scheduled");
    expect(s.publishAt).toBe(FUTURE);
    expect(s.assignee).toBe("user-cf2166419c@example.org");
  });

  it("refuses to assign a terminal piece and an empty assignee", () => {
    // A done piece (published or archived) has no active work-assignee.
    expect(errOf(move(wf("published"), { kind: "assign", assignee: "user-cf2166419c@example.org" })).action).toBe("assign");
    expect(errOf(move(wf("archived"), { kind: "assign", assignee: "user-cf2166419c@example.org" })).action).toBe("assign");
    expect(errOf(move(wf("draft"), { kind: "assign", assignee: " " })).detail).toContain("empty");
  });
});

describe("unpublish, archive, and restore (issue #202)", () => {
  it("starts a revision without using the unpublish action", () => {
    const result = move(wf("published"), { kind: "revise" });
    expect(okState(result).stage).toBe("draft");
    if ("transition" in result) expect(result.transition.action).toEqual({ kind: "revise" });
  });

  it("moves published back to draft to be revised, keeping the assignee", () => {
    const s = okState(move(wf("published", { assignee: "user-cf2166419c@example.org" }), { kind: "unpublish" }));
    expect(s.stage).toBe("draft");
    expect(s.publishAt).toBeNull();
    expect(s.assignee).toBe("user-cf2166419c@example.org");
  });

  it("archives every saved active stage and restores it to draft", () => {
    for (const stage of ["draft", "in_review", "approved", "scheduled", "published"] as const) {
      const state = wf(stage, { publishAt: stage === "scheduled" ? FUTURE : null });
      const archived = okState(move(state, { kind: "archive" }, ADMIN));
      expect(archived).toMatchObject({ stage: "archived", publishAt: null });
      expect(okState(move(archived, { kind: "restore" }, ADMIN)))
        .toMatchObject({ stage: "draft", publishAt: null });
    }
  });
});

describe("capability gating is the workflow enforcement (issue #202)", () => {
  it("lets a contributor submit only a draft they own", () => {
    const contributor = as("contributor", "u1");
    const own = move(wf("draft"), { kind: "submit" }, contributor, { now: NOW, resource: { ownerId: "u1" } });
    expect("state" in own).toBe(true);
    const other = move(wf("draft"), { kind: "submit" }, contributor, { now: NOW, resource: { ownerId: "u2" } });
    expect(errOf(other).detail).toContain("not authorized");
  });

  it("refuses a contributor every editor-only move", () => {
    const contributor = as("contributor", "u1");
    const resource = { ownerId: "u1" };
    // Each starts where its edge is legal, so the refusal is the capability check, not a
    // missing edge: publish/sendBack from in_review, unpublish/archive from published,
    // restore from archived.
    const cases: Array<[ContentStatus, WorkflowAction]> = [
      ["draft", { kind: "publish" }],
      ["in_review", { kind: "approve" }],
      ["in_review", { kind: "sendBack", comment: "x" }],
      ["approved", { kind: "schedule", publishAt: FUTURE }],
      ["approved", { kind: "reopen" }],
      ["published", { kind: "revise" }],
      ["published", { kind: "unpublish" }],
      ["published", { kind: "archive" }],
      ["archived", { kind: "restore" }],
      ["in_review", { kind: "assign", assignee: "user-cf2166419c@example.org" }],
    ];
    for (const [stage, action] of cases) {
      const err = errOf(move(wf(stage), action, contributor, { now: NOW, resource }));
      expect(err.detail).toContain("not authorized");
    }
  });

  it("lets an editor approve, publish, reopen, revise, and assign", () => {
    expect("state" in move(wf("in_review"), { kind: "approve" })).toBe(true);
    expect("state" in move(wf("approved"), { kind: "publish" })).toBe(true);
    expect("state" in move(wf("approved"), { kind: "reopen" })).toBe(true);
    expect("state" in move(wf("published"), { kind: "revise" })).toBe(true);
    expect("state" in move(wf("in_review"), { kind: "assign", assignee: "user-cf2166419c@example.org" })).toBe(true);
  });

  it("applies an editor's publish grant to the content section", () => {
    const editor: Principal = {
      id: "news-editor",
      grants: [{ role: "editor", sections: ["news"] }],
    };
    expect(
      "state" in move(wf("draft"), { kind: "publish" }, editor, {
        now: NOW,
        resource: { section: "news" },
      }),
    ).toBe(true);
    expect(
      errOf(move(wf("draft"), { kind: "publish" }, editor, {
        now: NOW,
        resource: { section: "watch" },
      })).detail,
    ).toContain("not authorized");
  });

  it("checks authorization before an input, so a refusal never leaks the input was one field away", () => {
    // A contributor sending back with no note must read as not-authorized, never the
    // missing-note error: the refusal cannot reveal the move was one comment from landing.
    const err = errOf(move(wf("in_review"), { kind: "sendBack", comment: "" }, as("contributor", "u1")));
    expect(err.detail).toContain("not authorized");
    expect(err.detail).not.toContain("comment is empty");
  });
});

describe("the state invariant is enforced on input and output (issue #202)", () => {
  it("passes a clean state and rejects the two corrupt shapes", () => {
    expect(validateWorkflowState(wf("in_review"))).toBeNull();
    expect(validateWorkflowState(wf("scheduled", { publishAt: FUTURE }))).toBeNull();
    expect(validateWorkflowState(wf("scheduled"))?.detail).toContain("publishAt is null");
    expect(validateWorkflowState(wf("published", { publishAt: FUTURE }))?.detail).toContain("publishAt is set");
  });

  it("rejects any action on a corrupt stored state instead of silently healing it", () => {
    // A stored scheduled piece with no time and an in_review piece with a stale time are
    // both corrupt. Every action -- a legal stage move and the off-graph assign -- must
    // reject them, so a transition can never launder the bad shape into a clean save.
    const scheduledNoTime = wf("scheduled");
    const reviewStaleTime = wf("in_review", { publishAt: FUTURE });
    expect(errOf(move(scheduledNoTime, { kind: "publish" })).detail).toContain("publishAt is null");
    expect(errOf(move(scheduledNoTime, { kind: "assign", assignee: "user-cf2166419c@example.org" })).detail).toContain("publishAt is null");
    expect(errOf(move(reviewStaleTime, { kind: "publish" })).detail).toContain("publishAt is set");
  });

  it("checks the state before the edge, so a corrupt state with an illegal action still reports the corrupt state", () => {
    // A scheduled-with-no-time piece given an illegal action (submit) surfaces the
    // corruption, not the illegal edge.
    expect(errOf(move(wf("scheduled"), { kind: "submit" })).detail).toContain("publishAt is null");
  });

  it("keeps publishAt null in every stage except scheduled across the whole path", () => {
    let s = wf("draft");
    s = okState(move(s, { kind: "submit" }));
    expect(validateWorkflowState(s)).toBeNull();
    expect(s.publishAt).toBeNull();
    s = okState(move(s, { kind: "approve" }));
    s = okState(move(s, { kind: "schedule", publishAt: FUTURE }));
    expect(s.publishAt).toBe(FUTURE);
    s = okState(move(s, { kind: "publish" }, as("editor", "cron"), { now: FUTURE }));
    expect(s.publishAt).toBeNull();
  });

  it("never mutates the input state, on success or on rejection", () => {
    const before = wf("in_review", { assignee: "user-cf2166419c@example.org" });
    const snapshot = structuredClone(before);
    move(before, { kind: "schedule", publishAt: FUTURE });
    move(before, { kind: "publish" });
    move(before, { kind: "unpublish" }); // illegal from in_review
    expect(before).toEqual(snapshot);
  });

  it("rejects an unknown stage instead of throwing on the graph lookup", () => {
    // A stored record with a stage no longer in the enum (a bad import, a newer client)
    // passes the null-publishAt shape check but has no STAGE_GRAPH row. It must come back
    // as a WorkflowError, never a thrown TypeError, and the validator must flag it too.
    const bogus = { stage: "on_hold", assignee: null, publishAt: null } as unknown as WorkflowState;
    expect(validateWorkflowState(bogus)?.detail).toContain("unknown stage");
    expect(errOf(move(bogus, { kind: "submit" })).detail).toContain("unknown stage");
  });

  it("refuses an unrecognized action kind instead of throwing on a prototype-keyed lookup", () => {
    // At an HTTP boundary the action is deserialized JSON, so `kind` can be any string. A
    // kind naming a prototype member resolves an inherited value from the frozen graph and
    // capability table, slipping past the illegal-move guard; "__proto__" then throws a
    // TypeError when that inherited value turns out not to be callable. Every unrecognized
    // kind must instead come back as a clean WorkflowError naming the bad kind.
    for (const kind of ["__proto__", "constructor", "toString", "hasOwnProperty", "on_hold"]) {
      const bogus = { kind } as unknown as WorkflowAction;
      const e = errOf(move(wf("in_review"), bogus));
      expect(e.detail).toContain("unknown action kind");
      expect(e.action).toBe(kind);
    }
  });

  it("ignores a polluted Object.prototype edge while keeping direct draft publish and schedule", () => {
    // The worst case at the untrusted boundary. If Object.prototype carries a planted edge
    // key like "publish", an inherited edge lookup would read it as a real STAGE_GRAPH edge
    // and let an authorized editor move a published piece back to scheduled, outside
    // the stage graph. The own-property edge read must ignore the inherited value while
    // still resolving a stage's real, own-key edges.
    const proto = Object.prototype as Record<string, unknown>;
    Object.defineProperty(proto, "publish", { value: "published", configurable: true });
    Object.defineProperty(proto, "schedule", { value: "scheduled", configurable: true });
    try {
      expect("state" in move(wf("draft"), { kind: "publish" })).toBe(true);
      expect("state" in move(wf("draft"), { kind: "schedule", publishAt: FUTURE })).toBe(true);
      expect(errOf(move(wf("published"), { kind: "schedule", publishAt: FUTURE })).detail).toContain("no schedule edge from published");
      // The legitimate own-key edge still resolves: pollution must not break real moves.
      expect("state" in move(wf("approved"), { kind: "publish" })).toBe(true);
    } finally {
      delete proto.publish;
      delete proto.schedule;
    }
  });

  it("rejects a null or non-object stored state instead of throwing on the dereference", () => {
    // A load boundary can hand back a null row or a non-object (a bad import, a partial read).
    // The validator and every action must fail closed to a WorkflowError, never a TypeError
    // off state.stage, so one bad row cannot abort a scheduler scan.
    for (const bad of [null, undefined, 42, "scheduled"]) {
      const state = bad as unknown as WorkflowState;
      expect(validateWorkflowState(state)?.detail).toContain("not an object");
      expect(errOf(move(state, { kind: "submit" })).detail).toContain("not an object");
    }
  });

  it("returns a WorkflowError for a recognized action carrying a malformed payload, never a thrown 500", () => {
    // The kind is recognized but the payload is still untrusted JSON: a missing or non-string
    // comment or assignee must fail closed to a WorkflowError, not throw off .trim() at the
    // HTTP boundary and turn a bad editor request into a 500.
    const sendBack = (comment: unknown) => move(wf("in_review"), { kind: "sendBack", comment } as unknown as WorkflowAction);
    const assign = (assignee: unknown) => move(wf("in_review"), { kind: "assign", assignee } as unknown as WorkflowAction);
    for (const bad of [undefined, null, 42, {}]) {
      expect(errOf(sendBack(bad)).detail).toContain("comment is not a string");
      expect(errOf(assign(bad)).detail).toContain("assignee is not a string");
    }
    // An empty or whitespace string is still refused, but by the existing content guard.
    expect(errOf(sendBack("   ")).detail).toContain("comment is empty");
    expect(errOf(assign("   ")).detail).toContain("assignee is empty");
  });

  it("refuses a transition with an unidentified principal, so nothing is anonymous", () => {
    // An unscoped editor grant authorizes the move, but an absent, empty, or whitespace id
    // leaves the audit row with no actor. Refuse rather than record it.
    for (const id of [undefined, "", "   "]) {
      expect(errOf(move(wf("approved"), { kind: "publish" }, as("editor", id))).detail).toContain("actor");
    }
  });

  it("rejects a non-finite transition clock instead of stamping a bad timestamp", () => {
    // A NaN or Infinity clock would silently pass the future-time check (every comparison
    // with NaN is false) and poison the audit `at`. It must be refused before any
    // transition is built -- including the past-time it would otherwise smuggle through.
    for (const now of [NaN, Infinity, -Infinity]) {
      expect(errOf(move(wf("draft"), { kind: "submit" }, EDITOR, { now })).detail).toContain("clock is not finite");
    }
    expect(errOf(move(wf("approved"), { kind: "schedule", publishAt: 10 }, EDITOR, { now: NaN })).detail)
      .toContain("clock is not finite");
  });

  it("records the action payload in the transition, not just its kind (issue #196)", () => {
    const r = move(wf("approved"), { kind: "schedule", publishAt: 9_000 });
    if ("transition" in r) expect(r.transition.action).toEqual({ kind: "schedule", publishAt: 9_000 });
  });

  it("detaches the recorded action, so mutating the caller's action cannot rewrite history", () => {
    // The transition is the audit's own copy of what happened. A caller that reuses or
    // mutates the action object after dispatch, before the row is persisted, must not be
    // able to change the recorded schedule time out from under the state it was applied to.
    const action: WorkflowAction = { kind: "schedule", publishAt: FUTURE };
    const r = move(wf("approved"), action);
    const s = okState(r);
    (action as { publishAt: number }).publishAt = PAST; // caller mutates its own object afterward
    expect(s.publishAt).toBe(FUTURE);
    if ("transition" in r) {
      expect(r.transition.action).toEqual({ kind: "schedule", publishAt: FUTURE });
      expect(r.transition.action).not.toBe(action);
    }
  });
});

describe("scheduled-publish due check drives the Cloud Function (issue #202)", () => {
  it("is due only when scheduled and the publish time has arrived", () => {
    expect(isDueForPublish(wf("scheduled", { publishAt: 1_000 }), 1_000)).toBe(true);
    expect(isDueForPublish(wf("scheduled", { publishAt: 1_000 }), 999)).toBe(false);
    for (const stage of ["draft", "in_review", "approved", "published", "archived"] as ContentStatus[]) {
      expect(isDueForPublish(wf(stage), 9_999)).toBe(false);
    }
  });

  it("returns the due ids in the order they were meant to publish", () => {
    const states = {
      later: wf("scheduled", { publishAt: 3_000 }),
      soon: wf("scheduled", { publishAt: 1_000 }),
      future: wf("scheduled", { publishAt: 9_000 }),
      reviewOnly: wf("in_review"),
    };
    expect(duePublications(states, 5_000)).toEqual(["soon", "later"]);
    expect(duePublications(states, 500)).toEqual([]);
  });

  it("breaks ties by id, so a replay of the same batch is deterministic", () => {
    // Two pieces due at the same instant must not fall back to object key order. The id
    // tiebreak fixes the sequence regardless of insertion order, so the Cloud Function can
    // replay the batch and get the identical result.
    const sameTime = {
      charlie: wf("scheduled", { publishAt: 1_000 }),
      alice: wf("scheduled", { publishAt: 1_000 }),
      bob: wf("scheduled", { publishAt: 1_000 }),
    };
    expect(duePublications(sameTime, 5_000)).toEqual(["alice", "bob", "charlie"]);
  });

  it("treats a non-finite clock as nothing-due, not a silent wrong answer", () => {
    expect(isDueForPublish(wf("scheduled", { publishAt: 1_000 }), NaN)).toBe(false);
    expect(duePublications({ a: wf("scheduled", { publishAt: 1_000 }) }, NaN)).toEqual([]);
  });

  it("fails closed on a corrupt persisted publishAt, never auto-publishing it", () => {
    // The Cloud Function calls this on stored rows, bypassing applyWorkflowAction. A
    // -Infinity would otherwise satisfy `publishAt <= now` and auto-publish; a NaN would
    // silently never fire; a null scheduled row is malformed. All must read as not-due,
    // via the same validateWorkflowState check the reducer uses.
    for (const bad of [-Infinity, Infinity, NaN] as number[]) {
      expect(isDueForPublish(wf("scheduled", { publishAt: bad }), 9_999)).toBe(false);
    }
    expect(isDueForPublish(wf("scheduled"), 9_999)).toBe(false);
    expect(duePublications({ bad: wf("scheduled", { publishAt: -Infinity }) }, 9_999)).toEqual([]);
  });

  it("skips a null or non-object row in the scheduled set instead of aborting the batch", () => {
    // The Cloud Function scans stored rows; a single null or non-object document must read as
    // not-due and never throw, or one bad row would abort the whole publish sweep. The row is
    // filtered out by isDueForPublish before the sort ever dereferences its publishAt.
    expect(isDueForPublish(null as unknown as WorkflowState, 9_999)).toBe(false);
    const states = {
      good: wf("scheduled", { publishAt: 1_000 }),
      broken: null as unknown as WorkflowState,
      alsoBroken: 7 as unknown as WorkflowState,
    };
    expect(duePublications(states, 9_999)).toEqual(["good"]);
  });
});

describe("availableActions renders only usable buttons (issue #202)", () => {
  it("offers a draft save flow with direct publish", () => {
    const actions = availableActions("draft");
    expect(actions).toContain("submit");
    expect(actions).toContain("assign");
    expect(actions).toContain("publish");
    expect(actions).toContain("schedule");
    expect(actions).toContain("archive");
  });

  it("offers a published piece revise, unpublish, and archive, but not assign", () => {
    const actions = availableActions("published");
    expect(actions).toEqual(expect.arrayContaining(["revise", "unpublish", "archive"]));
    expect(actions).not.toContain("assign");
  });

  it("keeps review tools while allowing direct publication", () => {
    expect(availableActions("in_review")).toEqual(
      expect.arrayContaining(["approve", "sendBack", "assign", "archive"]),
    );
    expect(availableActions("in_review")).toContain("publish");
    expect(availableActions("in_review")).toContain("schedule");
    expect(availableActions("approved")).toEqual(
      expect.arrayContaining(["reopen", "schedule", "publish", "assign", "archive"]),
    );
    expect(availableActions("scheduled")).toContain("archive");
  });

  it("offers an archived piece only restore, not assign", () => {
    expect(availableActions("archived")).toEqual(["restore"]);
  });

  it("returns a fresh array so a caller cannot mutate the graph", () => {
    availableActions("in_review").push("unpublish" as ActionKind);
    expect(availableActions("in_review")).not.toContain("unpublish");
  });

  it("offers no actions for a corrupt stage, never a phantom assign button", () => {
    // A stage outside the enum ("__proto__" would resolve Object.prototype on the graph,
    // "on_hold" a bad import) has no legal actions: the UI must render nothing for it,
    // matching applyWorkflowAction, which refuses the corrupt state outright.
    for (const stage of ["__proto__", "constructor", "on_hold"]) {
      expect(availableActions(stage as ContentStatus)).toEqual([]);
    }
  });
});

describe("canAttempt composes stage-legality with the capability gate (issue #202)", () => {
  const contributor = as("contributor", "u1");

  it("lets a contributor submit their own draft but not approve in review", () => {
    expect(canAttempt("draft", "submit", contributor, { ownerId: "u1" })).toBe(true);
    // Someone else's draft: content.edit.own does not reach it.
    expect(canAttempt("draft", "submit", contributor, { ownerId: "u2" })).toBe(false);
    expect(canAttempt("in_review", "approve", contributor)).toBe(false);
  });

  it("lets an editor approve and then publish", () => {
    expect(canAttempt("in_review", "approve", EDITOR)).toBe(true);
    expect(canAttempt("approved", "publish", EDITOR)).toBe(true);
  });

  it("reserves archive and restore for delete authority", () => {
    for (const stage of ["draft", "in_review", "approved", "scheduled", "published"] as const) {
      expect(canAttempt(stage, "archive", EDITOR)).toBe(false);
      expect(canAttempt(stage, "archive", ADMIN)).toBe(true);
    }
    expect(canAttempt("archived", "restore", EDITOR)).toBe(false);
    expect(canAttempt("archived", "restore", ADMIN)).toBe(true);
  });

  it.each(["draft", "in_review", "approved"] as const)("lets a publisher publish or schedule %s while a Writer cannot", stage => {
    expect(canAttempt(stage, "publish", EDITOR)).toBe(true);
    expect(canAttempt(stage, "schedule", EDITOR)).toBe(true);
    expect(canAttempt(stage, "schedule", contributor, { ownerId: "u1" })).toBe(false);
    expect(errOf(move(wf(stage), { kind: "schedule", publishAt: FUTURE }, contributor, {
      now: NOW, resource: { ownerId: "u1" },
    })).detail).toContain("not authorized");
  });

  it("refuses every action on a corrupt stage", () => {
    expect(canAttempt("__proto__" as ContentStatus, "assign", EDITOR)).toBe(false);
    expect(canAttempt("on_hold" as ContentStatus, "submit", EDITOR)).toBe(false);
  });
});
