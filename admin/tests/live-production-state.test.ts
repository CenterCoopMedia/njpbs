import { describe, expect, it } from "vitest";
import { initialLiveWorkspaceState, liveWorkspaceReducer as reduce, type CommandFailure, type LiveWorkspaceState } from "../src/lib/live-production-state";
import { banners, fakeClient, sessionView } from "./live-production-fixtures";
import { bannerEditDirty, commandRequest, orderNumber, parseOrderNumber } from "../src/lib/live-production-workspace";
function selected(): LiveWorkspaceState {
  return reduce(reduce({ ...initialLiveWorkspaceState, sessionId: "rehearsal" }, { type: "banners", rows: banners() }), { type: "select", row: banners()[1] });
}
function failed(action: "take" | "clear", intent: number, refused: boolean): CommandFailure {
  return { action, intent, refused, sequence: 3, text: null, message: refused ? "Refused" : "Unknown" };
}
describe("producer workspace state ownership", () => {
  it("preserves an order-only edit across refresh and adopts its saved baseline", () => {
    const initial = selected();
    const edited = reduce(initial, { type: "edit", edit: { ...initial.edit!, orderInput: "7" } });
    expect(bannerEditDirty(edited.edit)).toBe(true);
    const refreshed = reduce(edited, { type: "banners", rows: banners() });
    expect(refreshed.edit).toEqual(edited.edit);
    const row = { ...banners()[1], order: 6, record: { ...banners()[1].record, draft: { ...banners()[1].record.draft, version: 2 } } };
    const saved = reduce(refreshed, { type: "saved", row });
    expect(bannerEditDirty(saved.edit)).toBe(false);
    expect(saved.edit?.orderInput).toBe("7");
    expect(parseOrderNumber("")).toBeNull(); expect(parseOrderNumber("1.5")).toBeNull();
    expect(parseOrderNumber("1")).toBe(0);
    expect(parseOrderNumber(orderNumber(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseOrderNumber("9007199254740993")).toBeNull();
  });
  it("replaces refreshed active pages while retaining an absent selection's unsaved text", () => {
    const initial = selected();
    const clean = reduce(initial, { type: "banners", rows: [banners()[0]], replace: true });
    expect(clean.rows.map(row => row.record.id)).toEqual(["name-banner"]);
    expect(clean.selectedId).toBe(""); expect(clean.edit).toBeNull();
    const edit = { ...initial.edit!, text: { templateId: "headline" as const, headline: "Keep my unsaved wording" } };
    const dirty = reduce(reduce(initial, { type: "edit", edit }), { type: "banners", rows: [banners()[0]], replace: true });
    expect(dirty.rows.map(row => row.record.id)).toEqual(["name-banner"]);
    expect(dirty.edit).toEqual(edit); expect(dirty.detachedSelection?.record.id).toBe("headline-banner");
    const foundOnLaterPage = reduce(dirty, { type: "banners", rows: [banners()[1]] });
    expect(foundOnLaterPage.detachedSelection).toBeNull(); expect(foundOnLaterPage.edit).toEqual(edit);
    expect(foundOnLaterPage.rows).toHaveLength(2);
  });
  it("keeps the selected banner editor when a different banner save settles", () => {
    const selectedName = reduce(selected(), { type: "select", row: banners()[0] });
    const headline = banners()[1];
    const saved = { ...headline, record: { ...headline.record, draft: { ...headline.record.draft, version: 2,
      text: { templateId: "headline" as const, headline: "Saved headline from the retried request" } } } };
    const result = reduce(selectedName, { type: "saved", row: saved });
    expect(result.selectedId).toBe("name-banner");
    expect(result.edit).toEqual(selectedName.edit);
    expect(result.rows.find(row => row.record.id === "headline-banner")?.record.draft.version).toBe(2);
  });
  it("archive and replacement change rundown rows without clearing requested or observed output", async () => {
    let state = reduce(selected(), { type: "status", view: { ...sessionView(), requestStartedAt: 0 } });
    const command = await fakeClient().command(commandRequest(state.view!, "take", banners()[1]));
    state = reduce(state, { type: "accepted", command, intent: 1 });
    const archived = reduce(state, { type: "archived", row: { ...banners()[1], archived: true } });
    expect(archived.selectedId).toBe(""); expect(archived.edit).toBeNull();
    expect(archived.requested).toEqual(command); expect(archived.view).toEqual(state.view);
    const replaced = reduce(state, { type: "imported", rows: [], replace: true });
    expect(replaced.rows).toEqual([]); expect(replaced.requested).toEqual(command); expect(replaced.view).toEqual(state.view);
  });
  it("does not restore an ended session from an older in-flight status response", () => {
    const active = { ...sessionView(), requestStartedAt: 0 };
    const state = reduce(reduce(selected(), { type: "status", view: active }), {
      type: "session_ended", session: { ...active.session, state: "ended", generation: 2 },
    });
    const late = reduce(state, { type: "status", view: active });
    expect(late.view?.session).toMatchObject({ state: "ended", generation: 2, deviceId: "studio-pc" });
    expect(late.view?.observed).toMatchObject({ state: "unknown", report: null });
  });
  it("retains an uncertain outcome for its session until deliberate reconciliation", () => {
    const uncertain = reduce(selected(), { type: "failed", failure: failed("take", 1, false) });
    const other = reduce(uncertain, { type: "session", id: "another-session" });
    expect(other.uncertainSessions.rehearsal).toEqual(uncertain.failure);
    const returned = reduce(other, { type: "session", id: "rehearsal" });
    expect(returned.failure).toEqual(uncertain.failure);
    expect(returned.uncertainSessions.rehearsal).toBeUndefined();
    const current = reduce(returned, { type: "status", view: { ...sessionView(), requestStartedAt: 0 } });
    expect(reduce(current, { type: "acknowledge", now: 1, connected: true }).failure).toEqual(uncertain.failure);
  });
  it("ignores a stale banner page arriving after a successful save", () => {
    const row = banners()[1];
    const saved = { ...row, record: { ...row.record, draft: { ...row.record.draft, version: 2,
      text: { templateId: "headline" as const, headline: "Just saved" } } } };
    const state = reduce(reduce(selected(), { type: "saved", row: saved }), { type: "banners", rows: [row] });
    expect(state.edit).toMatchObject({ baseVersion: 2, text: saved.record.draft.text });
    expect(state.rows.find(item => item.record.id === row.record.id)).toEqual(saved);
  });
  it("follows saved revisions for untouched selections and preserves real local edits", () => {
    const state = selected();
    const latest = { ...banners()[1], record: { ...banners()[1].record, draft: { ...banners()[1].record.draft,
      version: 2, text: { templateId: "headline" as const, headline: "Another producer's text" } } } };
    expect(reduce(state, { type: "banners", rows: [latest] }).edit).toMatchObject({ baseVersion: 2, text: latest.record.draft.text });
    const edited = reduce(state, { type: "edit", edit: { ...state.edit!, text: { templateId: "headline", headline: "My unsaved text" } } });
    expect(reduce(edited, { type: "banners", rows: [latest] }).edit).toEqual(edited.edit);
  });
  it.each([true, false])("a refused Clear does not erase a lost Take outcome (Clear first=%s)", clearFirst => {
    const actions = [failed("take", 1, false), failed("clear", 2, true)];
    if (clearFirst) actions.reverse();
    const state = actions.reduce((current, failure) => reduce(current, { type: "failed", failure }), selected());
    expect(state.failure).toMatchObject({ action: "take", intent: 1, refused: false });
  });
  it("a later accepted Clear supersedes the uncertain Take in every response order", async () => {
    const view = { ...sessionView(), requestStartedAt: 0 };
    const command = await fakeClient().command(commandRequest(view, "clear"));
    const actions = [{ type: "failed" as const, failure: failed("take", 1, false) },
      { type: "failed" as const, failure: failed("clear", 2, true) }, { type: "accepted" as const, command, intent: 3 }];
    for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
      const state = order.reduce((current, index) => reduce(current, actions[index]), selected());
      expect(state.failure).toBeNull();
      expect(state.requested?.action).toBe("clear");
    }
  });
  it("requires a newer fresh observation before deliberate uncertainty acknowledgment", () => {
    let state = reduce(selected(), { type: "failed", failure: failed("take", 1, false) });
    state = reduce(state, { type: "status", view: { ...sessionView(), requestStartedAt: 0 } });
    expect(reduce(state, { type: "acknowledge", now: 1, connected: true }).failure).not.toBeNull();
    const view = sessionView();
    state = reduce(state, { type: "status", view: { ...view, requestStartedAt: 0,
      observed: { ...view.observed, report: { ...view.observed.report!, sequence: 4 } } } });
    expect(reduce(state, { type: "acknowledge", now: 30_000, connected: true }).failure).not.toBeNull();
    expect(reduce(state, { type: "acknowledge", now: 1, connected: true }).failure).toBeNull();
  });
  it("clears only the recovered polling error and retains command uncertainty", () => {
    let state = reduce(selected(), { type: "failed", failure: failed("take", 1, false) });
    state = reduce(state, { type: "status_error", message: "Read failed" });
    state = reduce(state, { type: "status", view: { ...sessionView(), requestStartedAt: 0 } });
    expect(state.statusError).toBeNull();
    expect(state.failure?.refused).toBe(false);
    state = reduce(state, { type: "invalidate" });
    expect(state.view?.session.id).toBe("rehearsal");
    expect(state.view?.observed.report).toBeNull();
  });
});
