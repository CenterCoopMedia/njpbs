import type {
  AgentObservation, BannerRecord, BannerSnapshot, LiveCommand, LiveCommandDelivery, ProductionSession, TemplateMapping,
} from "../../packages/content-core/src/live-production";

// Text and mappings come from #3329, Parker Swift's Oct. 13, 2026, scope.
// Every identity and timestamp below is a synthetic fixture, never a studio input.
export const session: ProductionSession = {
  schemaVersion: 1, id: "fixture-session", title: "Studio rehearsal", productionProgramId: "fixture-production",
  publicProgramId: null, showPlanId: null, deviceId: "fixture-device", generation: 2, mappingVersion: 3,
  state: "active", createdAtMs: 1000, updatedAtMs: 2000,
};
export const mapping: TemplateMapping = {
  schemaVersion: 1, sessionId: "fixture-session", deviceId: null, version: 3, overlay: 1,
  state: "uncommissioned", inputs: { headline: null, name_title: null }, verifiedAtMs: null,
};
export const snapshot: BannerSnapshot = {
  bannerId: "fixture-banner", sessionId: "fixture-session", version: 1, mappingVersion: 3,
  text: { templateId: "headline", headline: "POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY" },
};
export const command: LiveCommand = {
  schemaVersion: 1, protocolVersion: 1, id: "fixture-command", requestId: "fixture-request", actorId: "fixture-staff",
  sessionId: "fixture-session", deviceId: "fixture-device", sessionGeneration: 2, mappingVersion: 3,
  sequence: 4, clearGeneration: 1, overlay: 1, createdAtMs: 2000, expiresAtMs: 17000,
  expectedObservationSequence: 6, action: "take", snapshot,
};
export const delivery: LiveCommandDelivery = {
  schemaVersion: 1, timingId: "fixture-timing", ttlMs: 15000, command,
};
export const banner: BannerRecord = {
  schemaVersion: 1, id: "fixture-banner", sessionId: "fixture-session",
  draft: { version: 2, text: { templateId: "name_title", name: "Example Presenter", title: "Example Studio Host" },
    updatedAtMs: 3000, updatedBy: "fixture-staff" },
  cue: { id: "fixture-cue", capturedAtMs: 1500, snapshot },
  acceptedCommand: command,
  confirmedLive: { commandId: "fixture-command", observationSequence: 7, observedAtMs: 3100, snapshot },
};
export const observation: AgentObservation = {
  schemaVersion: 1, protocolVersion: 1, sessionId: "fixture-session", deviceId: "fixture-device",
  sessionGeneration: 2, mappingVersion: 3, sequence: 7, observedAtMs: 3100, vmix: "reachable", overlay: 1,
  state: "on_air", inputKey: "fixture-headline-input", text: snapshot.text, source: "boardwalk",
  correlation: { commandId: "fixture-command", bannerId: "fixture-banner", bannerVersion: 1 },
};

// Coordinator-approved safety Clear before the first native sample (Oct. 19).
export const clearWithoutObservation: LiveCommand = {
  schemaVersion: 1, protocolVersion: 1, id: "fixture-initial-clear", requestId: "fixture-clear-request", actorId: "fixture-staff",
  sessionId: "fixture-session", deviceId: "fixture-device", sessionGeneration: 2, mappingVersion: 3,
  sequence: 1, clearGeneration: 1, overlay: 1, createdAtMs: 2000, expiresAtMs: 17000,
  expectedObservationSequence: 0, action: "clear", target: { kind: "managed_overlay" },
};
