import { describe, expect, it } from "vitest";
import { projectWorkflowState, type Projectable } from "../src/lib/workflow-projection";
import { isDueForPublish, validateWorkflowState } from "../src/lib/editorial-workflow";
import type { ContentStatus } from "../../packages/content-core/src/content-model";

const PUBLISH_AT = "2026-08-01T09:30:00.000Z";
const INSTANT = Date.UTC(2026, 7, 1, 9, 30);

function record(overrides: Partial<Projectable> = {}): Projectable {
  return { status: "draft", publishAt: PUBLISH_AT, ...overrides };
}

/** Narrow to the success arm, failing the test with the refusal if it is not one. */
function stateOf(result: ReturnType<typeof projectWorkflowState>) {
  if ("error" in result) throw new Error(`expected a state, got: ${result.error.detail}`);
  return result.state;
}

describe("projectWorkflowState", () => {
  it("takes the stage from the record's status", () => {
    expect(stateOf(projectWorkflowState(record({ status: "in_review" }))).stage).toBe("in_review");
  });

  it("carries the publish instant as epoch ms for a scheduled record", () => {
    expect(stateOf(projectWorkflowState(record({ status: "scheduled" }))).publishAt).toBe(INSTANT);
  });

  it.each<ContentStatus>(["draft", "in_review", "published", "archived"])(
    "leaves publishAt null on a %s record, whatever the stored string says",
    (status) => {
      // The record's "instant this becomes public" is not the workflow's "pending
      // go-live time"; letting it through would break the core's invariant on every
      // stage but scheduled.
      expect(stateOf(projectWorkflowState(record({ status }))).publishAt).toBeNull();
    },
  );

  it.each<ContentStatus>(["draft", "in_review", "scheduled", "published", "archived"])(
    "produces a state the core accepts for a %s record",
    (status) => {
      expect(validateWorkflowState(stateOf(projectWorkflowState(record({ status }))))).toBeNull();
    },
  );

  it("does not consult a clock: a past-dated scheduled record still projects as scheduled", () => {
    // Whether a scheduled piece's time has arrived is isDueForPublish's question. If
    // the projection answered it too, the same stored row would project differently
    // depending on when it was read, and the two answers could drift.
    const state = stateOf(projectWorkflowState(record({ status: "scheduled", publishAt: "2020-01-01T00:00:00.000Z" })));
    expect(state.stage).toBe("scheduled");
    expect(isDueForPublish(state, Date.UTC(2026, 7, 3))).toBe(true);
  });

  it("does not mark a future-dated scheduled record due", () => {
    const state = stateOf(projectWorkflowState(record({ status: "scheduled" })));
    expect(isDueForPublish(state, INSTANT - 1)).toBe(false);
    expect(isDueForPublish(state, INSTANT)).toBe(true);
  });

  it("keeps an assigned uid", () => {
    expect(stateOf(projectWorkflowState(record({ assignee: "users/abc" }))).assignee).toBe("users/abc");
  });

  it("trims a stored uid, as the assign action already does", () => {
    expect(stateOf(projectWorkflowState(record({ assignee: "  users/abc  " }))).assignee).toBe("users/abc");
  });

  it.each([
    ["an explicit null", { assignee: null }],
    ["an omitted field", {}],
    ["an empty string", { assignee: "" }],
    ["whitespace", { assignee: "   " }],
    ["a non-string", { assignee: 42 as unknown as string }],
  ])("normalizes %s assignee to null", (_label, overrides) => {
    // The record spells "nobody" several ways; the envelope requires exactly one. A
    // blank that slipped through would ride forward through every later move, since
    // applyWorkflowAction copies the assignee across a stage change untouched.
    expect(stateOf(projectWorkflowState(record(overrides))).assignee).toBeNull();
  });

  it.each([
    "", // empty
    "not-a-date",
    "2026-02-30T00:00:00.000Z", // impossible calendar date
    "2026-08-01T09:30:00", // zone-less
    "2026-08-01T09:30:00.000+05:00", // an offset, not the canonical UTC form
  ])("refuses a scheduled record whose publishAt (%j) is not an absolute instant", (publishAt) => {
    // Scheduled is the one stage that needs the number. Inventing one would either
    // publish the piece immediately or bury it past any due check.
    const result = projectWorkflowState(record({ status: "scheduled", publishAt }));
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.reason).toContain("publish time");
      expect(result.error.detail).toContain("unreadable publishAt");
    }
  });

  it("still projects a draft whose stored publishAt is malformed", () => {
    // The workflow never reads the string outside the scheduled stage, so a bad value
    // there must not block editing the piece.
    const state = stateOf(projectWorkflowState(record({ status: "draft", publishAt: "not-a-date" })));
    expect(state).toEqual({ stage: "draft", assignee: null, publishAt: null });
  });

  it("refuses a record whose status is not a known stage", () => {
    const result = projectWorkflowState(record({ status: "awaiting_approval" as ContentStatus }));
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.detail).toContain("unknown stage");
  });

  it.each([[null], [undefined], ["a string row"]])(
    "refuses the malformed stored row %j instead of throwing",
    (row) => {
      const result = projectWorkflowState(row as unknown as Projectable);
      expect("error" in result).toBe(true);
    },
  );

  it("does not mutate the record it reads", () => {
    const input = record({ status: "scheduled", assignee: "users/abc" });
    const before = { ...input };
    projectWorkflowState(input);
    expect(input).toEqual(before);
  });
});
