import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRequest, createLiveProductionClient, liveBlockReason, observedState, requestedState, setupLabel } from "../src/lib/live-production-workspace";
import { canUseLiveProduction, liveProductionEnabled } from "../src/lib/live-production-access";
import { routeModuleKeyForPath } from "../src/routes/routeModules";
import { banners, commissioning, observation, session, sessionView, fakeClient } from "./live-production-fixtures";

afterEach(() => vi.unstubAllEnvs());
describe("private studio admission and freshness", () => {
  it("defaults off and retains the server's global staff capability", () => {
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", undefined);
    expect(liveProductionEnabled()).toBe(false);
    vi.stubEnv("VITE_LIVE_PRODUCTION_ENABLED", "true");
    expect(canUseLiveProduction({ id: "producer", grants: [{ role: "editor", sections: ["news"] }] })).toBe(false);
    expect(canUseLiveProduction({ id: "producer", grants: [{ role: "editor",  }] })).toBe(true);
    expect(routeModuleKeyForPath("/live-production/")).toBe("liveProduction");
  });
  it("ages server receipt from monotonic request start, independent of agent and iPad wall clocks", () => {
    const view = { ...sessionView(), serverNowMs: 20_000, requestStartedAt: 50 };
    vi.spyOn(Date, "now").mockReturnValue(9999999999999);
    expect(observedState(view, 11_049)).toBe("clear");
    expect(observedState(view, 11_050)).toBe("stale");
    expect(observedState({ ...view, serverNowMs: 999 }, 51)).toBe("unknown");
    expect(observedState(view, 49)).toBe("unknown");
    vi.restoreAllMocks();
  });
  it("fails closed for offline, inactive, uncommissioned, missing and stale state", () => {
    const view = { ...sessionView(), requestStartedAt: 0 };
    expect(liveBlockReason(view, 1, true)).toBeNull();
    expect(liveBlockReason(view, 1, false)).toMatch(/Reconnect/);
    expect(liveBlockReason(null, 1, true)).toMatch(/Refresh/);
    expect(liveBlockReason({ ...view, session: { ...session, state: "ended" } }, 1, true)).toMatch(/not active/);
    expect(liveBlockReason({ ...view, mapping: { ...view.mapping, state: "uncommissioned" } }, 1, true)).toMatch(/verification/);
    expect(liveBlockReason(view, 30_000, true)).toMatch(/stale/);
  });
  it("bounds fast polling and shows new manual observations or expiry honestly", async () => {
    const view = { ...sessionView(), requestStartedAt: 0 };
    const command = await fakeClient().command(commandRequest(view, "take", banners()[0]));
    expect(requestedState(command, view, 1)).toBe("Awaiting observation");
    expect(requestedState(command, { ...view, observed: { ...view.observed, report: { ...observation, sequence: 4 } } }, 2)).toBe("Different output observed");
    expect(requestedState(command, view, 15_000)).toBe("Unconfirmed");
  });
  it("takes the exact saved version and makes channel Clear explicit", () => {
    const view = { ...sessionView(), requestStartedAt: 0 };
    expect(commandRequest(view, "take", banners()[0])).toMatchObject({ action: "command", commandAction: "take",
      bannerId: "name-banner", baseVersion: 1, expectedClearGeneration: 0, expectedObservationSequence: 3, sessionGeneration: 1, mappingVersion: 1 });
    expect(commandRequest(view, "clear")).toMatchObject({ commandAction: "clear", target: { kind: "managed_overlay" } });
  });
});
describe("cmsLiveProduction adapter", () => {
  it("uses existing preparation actions and keeps program IDs separate from the server session ID", async () => {
    const created = { ...session, id: "server-session", state: "draft", deviceId: null, productionProgramId: "spotlight", publicProgramId: "spotlight" };
    const ended = { ...session, state: "ended", generation: 2 };
    const added = { ...banners()[1], order: 6, record: { ...banners()[1].record, id: "server-banner" } };
    const call = vi.fn(async body => body.action === "create_session" ? { success: true, session: created }
      : body.action === "set_session_state" ? { success: true, session: ended }
      : body.action === "save_banner" ? { success: true, banner: added }
      : body.action === "archive_banner" ? { success: true, banner: { ...banners()[1], archived: true } }
      : { success: true, banners: [added] });
    const client = createLiveProductionClient(call);
    expect(await client.createSession({ action: "create_session", requestId: "create", title: session.title, productionProgramId: "spotlight", publicProgramId: "spotlight" })).toEqual(created);
    expect(await client.save({ action: "save_banner", sessionId: session.id, requestId: "add", baseVersion: 0, order: 6, text: added.record.draft.text })).toEqual(added);
    expect((await client.archive({ action: "archive_banner", sessionId: session.id, requestId: "archive", bannerId: "headline-banner", baseVersion: 1 })).archived).toBe(true);
    const csv = "templateId,headline,name,title\nheadline,news,,";
    expect(await client.importCsv({ action: "import_csv", sessionId: session.id, requestId: "import", csv, archiveExisting: true })).toEqual([added]);
    expect(await client.endSession({ action: "set_session_state", sessionId: session.id, requestId: "end", baseGeneration: 1, state: "ended" })).toEqual(ended);
    expect(call.mock.calls.map(([body]) => body.action)).toEqual(["create_session", "save_banner", "archive_banner", "import_csv", "set_session_state"]);
    expect(call.mock.calls[1][0]).not.toHaveProperty("bannerId");
    expect(call.mock.calls[3][0]).toMatchObject({ csv, archiveExisting: true });
  });
  it("rejects contradictory preparation receipts instead of accepting another session or banner", async () => {
    const call = vi.fn().mockResolvedValue({ success: true, banner: banners()[1] });
    const client = createLiveProductionClient(call);
    await expect(client.archive({ action: "archive_banner", sessionId: session.id, requestId: "archive", bannerId: "headline-banner", baseVersion: 1 })).rejects.toThrow(/reconciliation/);
    call.mockResolvedValue({ success: true, banners: [banners()[0], banners()[0]] });
    await expect(client.importCsv({ action: "import_csv", sessionId: session.id, requestId: "import", csv: "any" })).rejects.toThrow(/reconciliation/);
    call.mockResolvedValue({ success: true, session: { ...session, state: "ended", generation: 1 } });
    await expect(client.endSession({ action: "set_session_state", sessionId: session.id, requestId: "end", baseGeneration: 1, state: "ended" })).rejects.toThrow(/reconciliation/);
  });
  it("pages the authorized program source without inventing a separate catalog", async () => {
    const source = vi.fn().mockResolvedValue({ programs: [{ id: "program-id", title: "Program title" }], nextPage: 3 });
    const client = createLiveProductionClient(async () => ({}), source);
    expect(await client.programs(2)).toEqual({ programs: [{ id: "program-id", title: "Program title" }], nextPage: 3 });
    expect(source).toHaveBeenCalledWith(2, undefined);
    source.mockResolvedValue({ programs: [{ id: "bad/id", title: "Program title" }], nextPage: null });
    await expect(client.programs(1)).rejects.toThrow();
  });
  it("labels operator attestation separately from recorded native title-file paths", async () => {
    const call = vi.fn().mockResolvedValue({ success: true, ...sessionView(), commissioning });
    const client = createLiveProductionClient(call);
    expect(setupLabel(await client.session(session.id))).toBe("Setup verified · title files operator-confirmed");
    call.mockResolvedValue({ success: true, ...sessionView(), commissioning: { ...commissioning,
      titleFiles: { headline: "C:\\Studio\\synthetic-headline.gtzip", name_title: "C:\\Studio\\synthetic-name-title.gtzip" } } });
    expect(setupLabel(await client.session(session.id))).toBe("Setup verified · title file paths recorded");
    call.mockResolvedValue({ success: true, ...sessionView(), commissioning: { ...commissioning,
      titleFiles: { ...commissioning.titleFiles, headline: "C:\\Studio\\synthetic-headline.gtzip" } } });
    expect(setupLabel(await client.session(session.id))).toBe("Setup verified · title files partly operator-confirmed");
  });
  it("rejects commissioning evidence for a different mapping or device", async () => {
    for (const evidence of [{ ...commissioning, mappingVersion: 2 }, { ...commissioning, verifiedByDeviceId: "another-device" }]) {
      const client = createLiveProductionClient(async () => ({ success: true, ...sessionView(), commissioning: evidence }));
      await expect(client.session(session.id)).rejects.toThrow(/evidence needs reconciliation/);
    }
  });
  it("uses documented action envelopes, validates shared records and preserves text", async () => {
    const text = { templateId: "name_title" as const, name: "  Zoë & 李  ", title: "" };
    const call = vi.fn(async body => body.action === "get_session" ? { success: true, ...sessionView() }
      : { success: true, banner: { ...banners()[0], record: { ...banners()[0].record, draft: { version: 2, text, updatedAtMs: 2000, updatedBy: "producer" } } } });
    const client = createLiveProductionClient(call);
    expect(await client.session(session.id)).toEqual(sessionView());
    expect((await client.save({ action: "save_banner", sessionId: session.id, requestId: "save-1", bannerId: "name-banner", baseVersion: 1, text, order: 2 })).record.draft.text).toEqual(text);
    expect(call.mock.calls[1][0]).toMatchObject({ action: "save_banner", baseVersion: 1, text });
  });
  it("accepts the server causal sequence separately from the client audit precondition", async () => {
    const view = { ...sessionView(), requestStartedAt: 0 }, fake = fakeClient();
    const clearRequest = commandRequest(view, "clear");
    const clear = await fake.command(clearRequest);
    const call = vi.fn().mockResolvedValue({ success: true, command: { ...clear, expectedObservationSequence: 0 } });
    const client = createLiveProductionClient(call);
    expect((await client.command(clearRequest)).expectedObservationSequence).toBe(0);
    const takeRequest = commandRequest(view, "take", banners()[0]);
    const take = await fake.command(takeRequest);
    call.mockResolvedValue({ success: true, command: { ...take, expectedObservationSequence: 4 } });
    expect((await client.command(takeRequest)).expectedObservationSequence).toBe(4);
    call.mockResolvedValue({ success: true, command: { ...take, expectedObservationSequence: 2 } });
    await expect(client.command(takeRequest)).rejects.toThrow(/reconciliation/);
  });
  it("keeps ended-session metadata while discarding a prior-generation observation", async () => {
    const view = sessionView();
    const call = vi.fn().mockResolvedValue({ success: true, ...view,
      session: { ...view.session, state: "ended", generation: 2 }, fences: { ...view.fences, active: false, sessionGeneration: 2 } });
    const client = createLiveProductionClient(call);
    const ended = await client.session(session.id);
    expect(ended.session.state).toBe("ended");
    expect(ended.observed).toMatchObject({ state: "unknown", report: null });
    call.mockResolvedValue({ success: true, ...view, session: { ...view.session, generation: 2 },
      fences: { ...view.fences, sessionGeneration: 2 } });
    await expect(client.session(session.id)).rejects.toThrow(/reconciliation/);
  });
  it("rejects cross-session observations and missing timing metadata", async () => {
    const call = vi.fn().mockResolvedValue({ success: true, ...sessionView(), observed: { ...sessionView().observed,
      report: { ...observation, sessionId: "another-session" } } });
    const client = createLiveProductionClient(call);
    await expect(client.session(session.id)).rejects.toThrow(/reconciliation/);
    call.mockResolvedValue({ success: true, ...sessionView(), serverNowMs: undefined });
    await expect(client.session(session.id)).rejects.toThrow(/timing/);
  });
});
