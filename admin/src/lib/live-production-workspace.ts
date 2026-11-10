import { sameStudioInputs } from "./live-production-setup";
import {
  LIVE_OBSERVATION_STALE_MS, parseAgentObservation, parseBannerRecord,
  parseLiveCommand, parseProductionSession, parseTemplateMapping, mappedOverlayInput,
  type AgentObservation, type BannerRecord, type BannerText, type LiveCommand, type PersistedLiveCommand,
  type ProductionSession, type TemplateMapping,
} from "../../../packages/content-core/src/live-production";

export type OrderedBanner = Readonly<{
  record: BannerRecord; order: number; source: unknown; archived: boolean;
}>;
export type CommissioningEvidence = Readonly<{
  mappingVersion: number; titleFiles: Readonly<{ headline: string; name_title: string }>;
  operatorId: string; operatorConfirmedAtMs: number; verifiedByDeviceId: string; verifiedAtMs: number;
}>;
export type SessionView = Readonly<{
  session: ProductionSession; mapping: TemplateMapping;
  commissioning: CommissioningEvidence | null;
  fences: Readonly<{ sessionGeneration: number; mappingVersion: number;
    clearGeneration: number; lastSequence: number; active: boolean }>;
  observed: Readonly<{ state: "on_air" | "clear" | "stale" | "unknown";
    report: AgentObservation | null; receivedAtMs: number }>;
  serverNowMs: number;
}>;
export type TimedSessionView = SessionView & { requestStartedAt: number };
export type ProductionProgramPage = { programs: { id: string; title: string }[]; nextPage: number | null };
export type StudioDevice = { id: string; name: string; active: boolean; state: string; sessionId: string | null };
export type StudioInputs = { inputs: { headline: NonNullable<TemplateMapping["inputs"]["headline"]>; name_title: NonNullable<TemplateMapping["inputs"]["name_title"]> };
  overlayInputs: NonNullable<TemplateMapping["overlayInputs"]> };
export type SessionStateRequest = { action: "set_session_state"; sessionId: string; requestId: string; baseGeneration: number; state: "ready" | "active" | "ended" };
export type LiveRequest =
  | { action: "list_sessions"; cursor?: string }
  | { action: "get_session"; sessionId: string }
  | { action: "list_banners"; sessionId: string; cursor?: string }
  | { action: "save_banner"; sessionId: string; requestId: string;
      bannerId?: string; baseVersion: number; text: BannerText; order: number }
  | { action: "archive_banner"; sessionId: string; requestId: string; bannerId: string; baseVersion: number }
  | { action: "import_csv"; sessionId: string; requestId: string; csv: string; archiveExisting?: true }
  | { action: "create_session"; requestId: string; title: string; productionProgramId: string; publicProgramId: string }
  | SessionStateRequest
  | { action: "set_mapping"; sessionId: string; requestId: string; baseMappingVersion: number; deviceId: string; titleFilesConfirmed: true } & StudioInputs
  | { action: "command"; sessionId: string; requestId: string; commandId: string;
      sessionGeneration: number; mappingVersion: number; expectedObservationSequence: number } & (
        { commandAction: "take" | "update_text"; expectedClearGeneration: number; bannerId: string; baseVersion: number }
        | { commandAction: "clear"; target: { kind: "managed_overlay" } });

export interface LiveProductionClient {
  sessions(cursor?: string, signal?: AbortSignal): Promise<{ sessions: ProductionSession[]; nextCursor: string | null }>;
  session(sessionId: string, signal?: AbortSignal): Promise<SessionView>;
  banners(sessionId: string, cursor?: string, signal?: AbortSignal): Promise<{ banners: OrderedBanner[]; nextCursor: string | null }>;
  save(request: Extract<LiveRequest, { action: "save_banner" }>): Promise<OrderedBanner>;
  archive(request: Extract<LiveRequest, { action: "archive_banner" }>): Promise<OrderedBanner>;
  importCsv(request: Extract<LiveRequest, { action: "import_csv" }>): Promise<OrderedBanner[]>;
  createSession(request: Extract<LiveRequest, { action: "create_session" }>): Promise<ProductionSession>;
  endSession(request: SessionStateRequest & { state: "ended" }): Promise<ProductionSession>;
  setSessionState(request: SessionStateRequest): Promise<ProductionSession>;
  setMapping(request: Extract<LiveRequest, { action: "set_mapping" }>): Promise<{ session: ProductionSession; mapping: TemplateMapping }>;
  devices(cursor?: string, signal?: AbortSignal): Promise<{ devices: StudioDevice[]; nextCursor: string | null }>;
  programs(page: number, signal?: AbortSignal): Promise<ProductionProgramPage>;
  command(request: Extract<LiveRequest, { action: "command" }>): Promise<LiveCommand>;
}

type Call = (request: LiveRequest, signal?: AbortSignal) => Promise<unknown>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid live production response.");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid live production timing or order.");
  return value as number;
}
function evidenceText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid studio setup evidence.");
  return value;
}
function cursor(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error("Invalid continuation.");
  return value as string | null;
}
function banner(value: unknown, sessionId: string): OrderedBanner {
  const data = object(value);
  const record = parseBannerRecord(data.record);
  if (record.sessionId !== sessionId || typeof data.archived !== "boolean") throw new Error("Banner session mismatch.");
  return { record, order: integer(data.order), source: data.source, archived: data.archived };
}

// Only this adapter knows the backend action envelope. Tests inject the same interface.
export function createLiveProductionClient(call: Call,
  readPrograms?: (page: number, signal?: AbortSignal) => Promise<unknown>,
  readDevices?: (cursor?: string, signal?: AbortSignal) => Promise<unknown>): LiveProductionClient {
  async function request(body: LiveRequest, signal?: AbortSignal) {
    const result = object(await call(body, signal));
    if (result.success !== true) throw new Error("Live production request was refused.");
    return result;
  }
  async function setSessionState(body: SessionStateRequest) {
    const session = parseProductionSession((await request(body)).session);
    const generation = body.baseGeneration + (body.state === "ended" ? 1 : 0);
    if (session.id !== body.sessionId || session.state !== body.state || session.generation !== generation) throw new Error("Session state needs reconciliation.");
    return session;
  }
  return {
    async sessions(after, signal) {
      const data = await request({ action: "list_sessions", ...(after ? { cursor: after } : {}) }, signal);
      if (!Array.isArray(data.sessions) || data.sessions.length > 100) throw new Error("Invalid session list.");
      return { sessions: data.sessions.map(parseProductionSession), nextCursor: cursor(data.nextCursor) };
    },
    async session(sessionId, signal) {
      const data = await request({ action: "get_session", sessionId }, signal);
      const session = parseProductionSession(data.session);
      const mapping = parseTemplateMapping(data.mapping);
      const observed = object(data.observed);
      let report = observed.report === null ? null : parseAgentObservation(observed.report);
      // Ending advances generation while retaining the last native sample for history.
      if (session.state === "ended" && report?.sessionId === sessionId && report.sessionGeneration < session.generation) report = null;
      const fences = object(data.fences);
      if (session.id !== sessionId || mapping.sessionId !== sessionId ||
          mapping.version !== session.mappingVersion || mapping.deviceId !== session.deviceId ||
          typeof fences.active !== "boolean" ||
          !["on_air", "clear", "stale", "unknown"].includes(observed.state as string) ||
          (report && (report.sessionId !== sessionId || report.deviceId !== session.deviceId ||
            report.sessionGeneration !== session.generation || report.mappingVersion !== session.mappingVersion))) {
        throw new Error("Live production state needs reconciliation.");
      }
      const parsedFences = { sessionGeneration: integer(fences.sessionGeneration),
        mappingVersion: integer(fences.mappingVersion), clearGeneration: integer(fences.clearGeneration),
        lastSequence: integer(fences.lastSequence), active: fences.active };
      if (parsedFences.sessionGeneration !== session.generation || parsedFences.mappingVersion !== mapping.version) {
        throw new Error("Live production fences need reconciliation.");
      }
      let commissioning: CommissioningEvidence | null = null;
      if (data.commissioning != null) {
        const evidence = object(data.commissioning), titleFiles = object(evidence.titleFiles);
        if (mapping.state !== "commissioned" || integer(evidence.mappingVersion) !== mapping.version ||
            evidence.verifiedByDeviceId !== mapping.deviceId || integer(evidence.verifiedAtMs) !== mapping.verifiedAtMs) {
          throw new Error("Studio setup evidence needs reconciliation.");
        }
        commissioning = { mappingVersion: mapping.version,
          titleFiles: { headline: evidenceText(titleFiles.headline), name_title: evidenceText(titleFiles.name_title) },
          operatorId: evidenceText(evidence.operatorId), operatorConfirmedAtMs: integer(evidence.operatorConfirmedAtMs),
          verifiedByDeviceId: evidenceText(evidence.verifiedByDeviceId), verifiedAtMs: integer(evidence.verifiedAtMs) };
      }
      return { session, mapping, commissioning, fences: parsedFences,
        observed: { state: report === null ? "unknown" : observed.state as SessionView["observed"]["state"], report,
          receivedAtMs: integer(observed.receivedAtMs) }, serverNowMs: integer(data.serverNowMs) };
    },
    async banners(sessionId, after, signal) {
      const data = await request({ action: "list_banners", sessionId, ...(after ? { cursor: after } : {}) }, signal);
      if (!Array.isArray(data.banners) || data.banners.length > 100) throw new Error("Invalid banner list.");
      return { banners: data.banners.map(row => banner(row, sessionId)), nextCursor: cursor(data.nextCursor) };
    },
    async save(body) {
      const saved = banner((await request(body)).banner, body.sessionId);
      if (saved.archived || (body.bannerId && saved.record.id !== body.bannerId) ||
          saved.record.draft.version !== body.baseVersion + 1 || saved.order !== body.order || !sameText(saved.record.draft.text, body.text)) {
        throw new Error("Saved banner needs reconciliation.");
      }
      return saved;
    },
    async archive(body) {
      const archived = banner((await request(body)).banner, body.sessionId);
      if (!archived.archived || archived.record.id !== body.bannerId || archived.record.draft.version !== body.baseVersion) {
        throw new Error("Archived banner needs reconciliation.");
      }
      return archived;
    },
    async importCsv(body) {
      const data = await request(body);
      if (!Array.isArray(data.banners) || !data.banners.length || data.banners.length > 100) throw new Error("Invalid imported banners.");
      const rows = data.banners.map(value => banner(value, body.sessionId));
      if (rows.some(row => row.archived) || new Set(rows.map(row => row.record.id)).size !== rows.length) throw new Error("Imported banners need reconciliation.");
      return rows;
    },
    async createSession(body) {
      const session = parseProductionSession((await request(body)).session);
      if (session.productionProgramId !== body.productionProgramId || session.publicProgramId !== body.publicProgramId) throw new Error("Created session needs reconciliation.");
      return session;
    },
    endSession: setSessionState,
    setSessionState,
    async setMapping(body) {
      const data = await request(body), session = parseProductionSession(data.session), mapping = parseTemplateMapping(data.mapping);
      const expected = parseTemplateMapping({ schemaVersion: 1, sessionId: body.sessionId, deviceId: body.deviceId,
        version: body.baseMappingVersion + 1, overlay: 1, state: "uncommissioned", inputs: body.inputs,
        overlayInputs: body.overlayInputs, verifiedAtMs: null });
      if (session.id !== body.sessionId || session.state !== "draft" || session.deviceId !== body.deviceId ||
          session.mappingVersion !== expected.version || mapping.sessionId !== expected.sessionId || mapping.deviceId !== expected.deviceId ||
          mapping.version !== expected.version || mapping.state !== expected.state || mapping.verifiedAtMs !== null || !sameStudioInputs(mapping, expected)) {
        throw new Error("Saved studio connection needs reconciliation.");
      }
      return { session, mapping };
    },
    async devices(after, signal) {
      if (!readDevices) throw new Error("The paired device list is unavailable.");
      const data = object(await readDevices(after, signal));
      if (data.success !== true || !Array.isArray(data.devices) || data.devices.length > 100) throw new Error("Invalid paired device list.");
      const devices = data.devices.map(value => {
        const device = object(value);
        if (cursor(device.id) === null || typeof device.active !== "boolean" || typeof device.state !== "string") throw new Error("Invalid paired device.");
        return { id: device.id as string, name: evidenceText(device.name), active: device.active, state: device.state, sessionId: cursor(device.sessionId) };
      });
      return { devices, nextCursor: cursor(data.nextCursor) };
    },
    async programs(page, signal) {
      if (!readPrograms) throw new Error("The program list is unavailable.");
      const data = object(await readPrograms(page, signal));
      if (!Array.isArray(data.programs) || (data.nextPage !== null && (!Number.isSafeInteger(data.nextPage) || (data.nextPage as number) <= page))) {
        throw new Error("Invalid program list.");
      }
      return { programs: data.programs.map(value => {
        const program = object(value);
        if (cursor(program.id) === null) throw new Error("Invalid program.");
        return { id: program.id as string, title: evidenceText(program.title) };
      }), nextPage: data.nextPage as number | null };
    },
    async command(body) {
      const command = parseLiveCommand((await request(body)).command);
      if (command.id !== body.commandId || command.requestId !== body.requestId || command.sessionId !== body.sessionId ||
          command.action !== body.commandAction || command.sessionGeneration !== body.sessionGeneration ||
          command.mappingVersion !== body.mappingVersion ||
          (body.commandAction !== "clear" && command.expectedObservationSequence < body.expectedObservationSequence) ||
          (body.commandAction === "update_text" && command.expectedObservationSequence !== body.expectedObservationSequence) ||
          (body.commandAction !== "clear" && (command.action === "clear" || command.clearGeneration !== body.expectedClearGeneration ||
            command.snapshot.bannerId !== body.bannerId || command.snapshot.version !== body.baseVersion))) throw new Error("Command receipt needs reconciliation.");
      return command;
    },
  };
}

export function sameText(a: BannerText, b: BannerText): boolean {
  return a.templateId === "headline" && b.templateId === "headline" ? a.headline === b.headline
    : a.templateId === "name_title" && b.templateId === "name_title" && a.name === b.name && a.title === b.title;
}
export function bannerLines(text: BannerText): string[] {
  return text.templateId === "headline" ? [text.headline] : [text.name, text.title];
}
export function templateLabel(text: BannerText): string {
  return text.templateId === "headline" ? "Headline" : "Name and title";
}
export function setupLabel(view: SessionView): string {
  if (view.mapping.state !== "commissioned") return "Setup not verified";
  if (!view.commissioning) return "Setup verified";
  const confirmed = Object.values(view.commissioning.titleFiles).filter(value => value === "operator-confirmed").length;
  return `Setup verified · ${confirmed === 2 ? "title files operator-confirmed" : confirmed === 1
    ? "title files partly operator-confirmed" : "title file paths recorded"}`;
}
export function observedState(view: TimedSessionView | null, now: number): SessionView["observed"]["state"] {
  if (!view || !view.observed.report || view.observed.receivedAtMs > view.serverNowMs ||
      !Number.isFinite(now) || now < view.requestStartedAt) return "unknown";
  // Conservatively count transit from request start. Never use the iPad wall clock.
  if (view.serverNowMs - view.observed.receivedAtMs + now - view.requestStartedAt >= LIVE_OBSERVATION_STALE_MS) return "stale";
  return view.observed.state;
}
export function liveBlockReason(view: TimedSessionView | null, now: number, connected: boolean): string | null {
  if (!connected) return "Reconnect and refresh studio status before using live controls.";
  if (!view) return "Refresh studio status before using live controls.";
  if (view.session.state !== "active" || !view.fences.active) return "This production session is not active.";
  if (view.mapping.state !== "commissioned" || !view.session.deviceId) return "Studio setup needs verification.";
  const state = observedState(view, now);
  if (state === "unknown" || state === "stale") return "Studio status is stale or unknown. Wait for a fresh Studio connector observation.";
  return null;
}
export function updateLiveCandidate(view: TimedSessionView | null, row: OrderedBanner | undefined): boolean {
  const report = view?.observed.report;
  return Boolean(row && !row.archived && report?.state === "on_air" && report.source === "boardwalk" && report.text &&
    report.correlation && "bannerId" in report.correlation && report.correlation.bannerId === row.record.id &&
    row.record.sessionId === view?.session.id && report.text.templateId === row.record.draft.text.templateId &&
    report.inputKey === mappedOverlayInput(view!.mapping, row.record.draft.text.templateId)?.key &&
    report.correlation.bannerVersion < row.record.draft.version && !sameText(report.text, row.record.draft.text));
}
export function liveActionLabel(action: "take" | "update_text" | "clear"): string {
  return { take: "Take", update_text: "Update live", clear: "Clear Overlay 1" }[action];
}
export function commandRequest(view: TimedSessionView, action: "take" | "update_text" | "clear", row?: OrderedBanner): Extract<LiveRequest, { action: "command" }> {
  const base = { action: "command" as const, sessionId: view.session.id,
    requestId: crypto.randomUUID(), commandId: crypto.randomUUID(), sessionGeneration: view.session.generation,
    mappingVersion: view.mapping.version, expectedObservationSequence: view.observed.report?.sequence ?? 0 };
  if (action === "clear") return { ...base, commandAction: "clear", target: { kind: "managed_overlay" } };
  if (!view.observed.report) throw new Error("Take needs a fresh observation.");
  if (!row || row.archived || row.record.sessionId !== view.session.id) throw new Error("Select a saved banner.");
  if (action === "update_text" && !updateLiveCandidate(view, row)) throw new Error("Update live needs changed saved text for the same observed banner and template.");
  return { ...base, commandAction: action, expectedClearGeneration: view.fences.clearGeneration, bannerId: row.record.id, baseVersion: row.record.draft.version };
}

export function requestedState(command: PersistedLiveCommand | null, view: TimedSessionView | null, now: number): string {
  if (!command) return "None";
  if (!view) return "Observation unavailable";
  const report = view.observed.report;
  if (report && !["stale", "unknown"].includes(observedState(view, now)) && report.sequence > command.expectedObservationSequence) {
    return report.correlation?.commandId === command.id ? "Observed" : "Different output observed";
  }
  if (view.serverNowMs + now - view.requestStartedAt >= command.expiresAtMs) return "Unconfirmed";
  return "Awaiting observation";
}

export function orderNumber(order: number): string { return String(BigInt(order) + 1n); }
export function parseOrderNumber(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const order = BigInt(value) - 1n;
  return order <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(order) : null;
}
export type BannerEdit = { text: BannerText; baseText: BannerText; baseVersion: number; orderInput: string; baseOrder: number };
export function savedBannerEdit(row: OrderedBanner): BannerEdit {
  return { text: row.record.draft.text, baseText: row.record.draft.text, baseVersion: row.record.draft.version, orderInput: orderNumber(row.order), baseOrder: row.order };
}
export function bannerEditDirty(edit: BannerEdit | null): boolean {
  return Boolean(edit && (!sameText(edit.text, edit.baseText) || parseOrderNumber(edit.orderInput) !== edit.baseOrder));
}
export function reconcileBannerEdit(edit: BannerEdit | null, row: OrderedBanner | undefined): BannerEdit | null {
  if (!edit || !row) return null;
  if (bannerEditDirty(edit) && (!sameText(edit.text, row.record.draft.text) || parseOrderNumber(edit.orderInput) !== row.order)) return edit;
  return savedBannerEdit(row);
}

export function clearBlockReason(view: TimedSessionView | null, connected: boolean): string | null {
  if (!connected) return "Reconnect before sending Clear Overlay 1.";
  if (!view || view.session.state !== "active" || !view.fences.active || !view.session.deviceId) {
    return "Select an active production session before sending Clear Overlay 1.";
  }
  return null;
}
