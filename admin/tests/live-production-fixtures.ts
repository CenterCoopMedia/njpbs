import { previewBannerCsv } from "../src/lib/live-production-csv";
import type { AgentObservation, ProductionSession, TemplateMapping } from "../../packages/content-core/src/live-production";
import type { CommissioningEvidence, LiveProductionClient, OrderedBanner, SessionView } from "../src/lib/live-production-workspace";

export const session: ProductionSession = { schemaVersion: 1, id: "rehearsal", title: "Studio rehearsal",
  productionProgramId: "spotlight", publicProgramId: null, showPlanId: null, deviceId: "studio-pc",
  generation: 1, mappingVersion: 1, state: "active", createdAtMs: 0, updatedAtMs: 1000 };
export const mapping: TemplateMapping = { schemaVersion: 1, sessionId: session.id, deviceId: session.deviceId,
  version: 1, overlay: 1, state: "commissioned", inputs: { headline: { key: "headline-input", number: 1, title: "Headline" },
    name_title: { key: "name-input", number: 2, title: "Name and title" } }, verifiedAtMs: 1000 };
export const observation: AgentObservation = { schemaVersion: 1, protocolVersion: 1, sessionId: session.id,
  deviceId: session.deviceId!, sessionGeneration: 1, mappingVersion: 1, sequence: 3, observedAtMs: 999999999,
  vmix: "reachable", overlay: 1, state: "clear", inputKey: null, text: null, source: "manual", correlation: null };
export const commissioning: CommissioningEvidence = { mappingVersion: 1,
  titleFiles: { headline: "operator-confirmed", name_title: "operator-confirmed" }, operatorId: "studio-operator",
  operatorConfirmedAtMs: 900, verifiedByDeviceId: "studio-pc", verifiedAtMs: 1000 };
export function sessionView(): SessionView {
  return { session, mapping, commissioning: null, fences: { sessionGeneration: 1, mappingVersion: 1, clearGeneration: 0, lastSequence: 0, active: true },
    observed: { state: "clear", report: observation, receivedAtMs: 1000 }, serverNowMs: 1000 };
}
export function banners(): OrderedBanner[] {
  return [{ order: 2, source: null, archived: false, record: { schemaVersion: 1, id: "name-banner", sessionId: session.id,
    draft: { version: 1, updatedAtMs: 1000, updatedBy: "producer", text: { templateId: "name_title", name: "JULIE O’CONNOR", title: "NJ PBS SPOTLIGHT SENIOR REPORTER" } },
    cue: null, acceptedCommand: null, confirmedLive: null } },
  { order: 1, source: null, archived: false, record: { schemaVersion: 1, id: "headline-banner", sessionId: session.id,
    draft: { version: 1, updatedAtMs: 1000, updatedBy: "producer", text: { templateId: "headline", headline: "POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY" } },
    cue: null, acceptedCommand: null, confirmedLive: null } }];
}
export function fakeClient({ onAir = false } = {}): LiveProductionClient {
  let rows = banners(), sessions = [session], nextId = 1;
  const liveObservation: AgentObservation = { ...observation, state: "on_air", source: "boardwalk",
    inputKey: mapping.inputs.headline!.key, text: banners()[1].record.draft.text,
    correlation: { commandId: "fixture-take", bannerId: "headline-banner", bannerVersion: 1 } };
  function createdBanner(text: typeof rows[number]["record"]["draft"]["text"], sessionId: string, order: number): OrderedBanner {
    const id = `new-banner-${nextId++}`;
    return { order, source: "manual", archived: false, record: { ...banners()[0].record, id, sessionId,
      draft: { version: 1, text, updatedAtMs: 1000, updatedBy: "producer" } } };
  }
  return {
    devices: async () => ({ devices: [{ id: "studio-pc", name: "Studio PC", active: true, state: "enrolled", sessionId: null }], nextCursor: null }),
    setMapping: async () => { throw new Error("Use the staff API boundary for setup tests."); },
    setSessionState: async () => { throw new Error("Use the staff API boundary for setup tests."); },
    sessions: async () => ({ sessions, nextCursor: null }),
    session: async id => {
      const current = sessions.find(item => item.id === id) ?? { ...session, id };
      const live = current.state === "active";
      return { ...sessionView(), session: current,
        mapping: { ...mapping, sessionId: id, deviceId: current.deviceId, state: current.deviceId ? "commissioned" : "uncommissioned", verifiedAtMs: current.deviceId ? 1000 : null },
        fences: { ...sessionView().fences, sessionGeneration: current.generation, active: live },
        observed: { state: live ? onAir ? "on_air" : "clear" : "unknown", report: live ? { ...(onAir ? liveObservation : observation), sessionId: id, sessionGeneration: current.generation } : null, receivedAtMs: 1000 } };
    },
    banners: async id => ({ banners: rows.filter(row => row.record.sessionId === id && !row.archived), nextCursor: null }),
    programs: async () => ({ programs: [{ id: "spotlight", title: "NJ Spotlight News" }], nextPage: null }),
    createSession: async request => {
      const created = { ...session, id: "new-studio", title: request.title, productionProgramId: request.productionProgramId,
        publicProgramId: request.publicProgramId, deviceId: null, state: "draft" as const, createdAtMs: 2000, updatedAtMs: 2000 };
      sessions = [...sessions, created]; return created;
    },
    endSession: async request => {
      const ended = { ...(sessions.find(item => item.id === request.sessionId) ?? session), id: request.sessionId, state: "ended" as const, generation: request.baseGeneration + 1 };
      sessions = sessions.map(item => item.id === ended.id ? ended : item); return ended;
    },
    archive: async request => {
      const row = { ...rows.find(row => row.record.id === request.bannerId)!, archived: true };
      rows = rows.map(item => item.record.id === row.record.id ? row : item); return row;
    },
    importCsv: async request => {
      const preview = previewBannerCsv(request.csv);
      if (preview.errors.length) throw Object.assign(new Error("Invalid CSV"), { status: 400 });
      const start = Math.max(-1, ...rows.map(row => row.order)) + 1;
      const imported = preview.banners.map((item, index) => ({ ...createdBanner(item.text, request.sessionId, start + index), source: "csv" }));
      rows = [...rows.map(row => request.archiveExisting && row.record.sessionId === request.sessionId ? { ...row, archived: true } : row), ...imported];
      return imported;
    },
    save: async request => {
      const prior = rows.find(item => item.record.id === request.bannerId);
      const saved = prior ? { ...prior, order: request.order,
        record: { ...prior.record, draft: { ...prior.record.draft, version: request.baseVersion + 1, text: request.text } } }
        : createdBanner(request.text, request.sessionId, request.order);
      rows = [...rows.filter(row => row.record.id !== saved.record.id), saved]; return saved;
    },
    command: async request => {
      const identity = { schemaVersion: 1 as const, protocolVersion: 1 as const, id: request.commandId, requestId: request.requestId,
      actorId: "producer", sessionId: request.sessionId, deviceId: "studio-pc", sessionGeneration: request.sessionGeneration,
      mappingVersion: request.mappingVersion, sequence: request.commandAction === "clear" ? 2 : 1, clearGeneration: request.commandAction === "clear" ? 1 : 0,
      overlay: 1 as const, createdAtMs: 1000, expiresAtMs: 16000, expectedObservationSequence: request.expectedObservationSequence };
      if (request.commandAction === "clear") return { ...identity, action: "clear", target: request.target };
      const snapshot = { bannerId: request.bannerId, sessionId: request.sessionId, version: request.baseVersion, mappingVersion: request.mappingVersion,
        text: rows.find(item => item.record.id === request.bannerId)!.record.draft.text };
      return request.commandAction === "update_text" ? { ...identity, action: "update_text", snapshot, expectedLive: liveObservation }
        : { ...identity, action: "take", snapshot };
    },
  };
}
