/** Private studio records. These are never website content or publish requests. */
export const LIVE_PRODUCTION_SCHEMA_VERSION = 1;
export const LIVE_PRODUCTION_PROTOCOL_VERSION = 1;
export const LIVE_COMMAND_MAX_TTL_MS = 15_000;
export const LIVE_OBSERVATION_STALE_MS = 30_000;
export const LIVE_PRODUCTION_COLLECTION = "liveProductionSessions";

export type BannerText =
  | Readonly<{ templateId: "headline"; headline: string }>
  | Readonly<{ templateId: "name_title"; name: string; title: string }>;

export const LIVE_TEMPLATES = Object.freeze({
  headline: Object.freeze({ overlay: 1,
    fields: Object.freeze({ headline: "TextBlock1.Text" }) }),
  name_title: Object.freeze({ overlay: 1,
    fields: Object.freeze({ name: "TextBlock1.Text", title: "TextBlock2.Text" }) }),
});

export type StudioTitleFiles = Readonly<Record<"headline" | "name_title", string>>;

/** Trusted deployment input, never inferred from native evidence or display names. */
export function parseStudioTitleFiles(value: unknown): StudioTitleFiles {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "headline,name_title") throw new TypeError("Invalid studio title files");
  const files = value as Record<string, unknown>;
  for (const id of ["headline", "name_title"]) {
    const name = files[id];
    if (typeof name !== "string" || name.length > 200 || name.trim() !== name ||
        !/^[^\\/:*?"<>|\x00-\x1f\x7f]+\.gtzip$/i.test(name) || name.startsWith(".") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) || /REPLACE_ME/i.test(name)) throw new TypeError("Invalid studio title files");
  }
  if ((files.headline as string).toLowerCase() === (files.name_title as string).toLowerCase()) throw new TypeError("Studio title files must differ");
  return Object.freeze({ headline: files.headline as string, name_title: files.name_title as string });
}

export type ProductionSession = Readonly<{
  schemaVersion: 1; id: string; title: string; productionProgramId: string;
  publicProgramId: string | null; showPlanId: string | null;
  deviceId: string | null; generation: number; mappingVersion: number;
  state: "draft" | "ready" | "active" | "ended";
  createdAtMs: number; updatedAtMs: number;
}>;

export type LoadedInput = Readonly<{ key: string; number: number; title: string }>;
export type TemplateMapping = Readonly<{
  schemaVersion: 1; sessionId: string; deviceId: string | null; version: number;
  overlay: 1; state: "uncommissioned" | "commissioned";
  inputs: Readonly<{ headline: LoadedInput | null; name_title: LoadedInput | null }>;
  /** Absent in direct-title mappings. When present, names both Overlay 1 targets. */
  overlayInputs?: Readonly<{ headline: LoadedInput; name_title: LoadedInput }>;
  verifiedAtMs: number | null;
}>;

export type BannerSnapshot = Readonly<{
  bannerId: string; sessionId: string; version: number; mappingVersion: number; text: BannerText;
}>;
export type CueSnapshot = Readonly<{
  id: string; capturedAtMs: number; snapshot: BannerSnapshot;
}>;
export type ClearTarget =
  | Readonly<{ kind: "banner"; bannerId: string; version: number; templateId: BannerText["templateId"] }>
  | Readonly<{ kind: "managed_overlay" }>;

type CommandIdentity = Readonly<{
  schemaVersion: 1; protocolVersion: 1; id: string; requestId: string; actorId: string;
  sessionId: string; deviceId: string; sessionGeneration: number; mappingVersion: number;
  sequence: number; clearGeneration: number; overlay: 1;
  createdAtMs: number; expiresAtMs: number; expectedObservationSequence: number;
}>;
export type LiveCommand = CommandIdentity & (
  | Readonly<{ action: "take"; snapshot: BannerSnapshot }>
  | Readonly<{ action: "update_text"; snapshot: BannerSnapshot; expectedLive: AgentObservation }>
  | Readonly<{ action: "clear"; target: ClearTarget }>
);
/** Includes legacy updates for history. Use LiveCommand for new intent. */
export type PersistedLiveCommand = LiveCommand | (CommandIdentity &
  Readonly<{ action: "update_text"; snapshot: BannerSnapshot }>);

/** Server-issued delivery budget; accepted command intent never changes. */
export type LiveCommandDelivery = Readonly<{
  schemaVersion: 1; timingId: string; ttlMs: number; command: LiveCommand;
}>;
export type DeliveryTiming =
  | Readonly<{ kind: "request"; elapsedMs: number }>
  | Readonly<{ kind: "heartbeat"; elapsedSinceReceiptMs: number; roundTripMs: number }>;

export type ConfirmedLiveVersion = Readonly<{
  commandId: string; observationSequence: number; observedAtMs: number; snapshot: BannerSnapshot;
}>;
export type BannerRecord = Readonly<{
  schemaVersion: 1; id: string; sessionId: string;
  draft: Readonly<{ version: number; text: BannerText; updatedAtMs: number; updatedBy: string }>;
  cue: CueSnapshot | null;
  acceptedCommand: PersistedLiveCommand | null;
  confirmedLive: ConfirmedLiveVersion | null;
}>;

export type AgentObservation = Readonly<{
  schemaVersion: 1; protocolVersion: 1; sessionId: string; deviceId: string;
  sessionGeneration: number; mappingVersion: number; sequence: number;
  observedAtMs: number; vmix: "reachable" | "unreachable"; overlay: 1;
  state: "on_air" | "clear" | "unknown"; inputKey: string | null; text: BannerText | null;
  source: "boardwalk" | "manual" | "unknown";
  correlation: Readonly<{ commandId: string; bannerId: string; bannerVersion: number }>
    | Readonly<{ commandId: string }> | null;
}>;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid live production contract: ${message}`);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "object required");
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "plain object required");
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    "unexpected or missing fields");
  return value as Record<string, unknown>;
}

function integer(value: unknown, minimum = 1): asserts value is number {
  check(Number.isSafeInteger(value) && (value as number) >= minimum, "integer out of range");
}

function text(value: unknown, allowEmpty = false): asserts value is string {
  check(typeof value === "string" && (allowEmpty || value.trim().length > 0), "text required");
}

function id(value: unknown): asserts value is string {
  check(typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value), "invalid identity");
}

function nullableId(value: unknown) { if (value !== null) id(value); }
function oneOf(value: unknown, values: readonly unknown[]) { check(values.includes(value), "unsupported value"); }
function schema(value: unknown) { check(value === LIVE_PRODUCTION_SCHEMA_VERSION, "unsupported schema"); }

// Detach accepted records from callers and freeze all nested intent, including text.
function immutable<T>(value: unknown): T {
  function freeze(item: unknown): unknown {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(structuredClone(value)) as T;
}

export function parseBannerText(value: unknown): BannerText {
  const templateId = (value as BannerText | null)?.templateId;
  oneOf(templateId, ["headline", "name_title"]);
  const data = record(value, templateId === "headline" ? ["templateId", "headline"] : ["templateId", "name", "title"]);
  if (templateId === "headline") text(data.headline);
  else { text(data.name); text(data.title, true); }
  return immutable(value);
}

export function parseProductionSession(value: unknown): ProductionSession {
  const data = record(value, ["schemaVersion", "id", "title", "productionProgramId", "publicProgramId",
    "showPlanId", "deviceId", "generation", "mappingVersion", "state", "createdAtMs", "updatedAtMs"]);
  schema(data.schemaVersion);
  [data.id, data.productionProgramId].forEach(id);
  [data.publicProgramId, data.showPlanId, data.deviceId].forEach(nullableId);
  text(data.title);
  integer(data.generation); integer(data.mappingVersion);
  oneOf(data.state, ["draft", "ready", "active", "ended"]);
  integer(data.createdAtMs, 0); integer(data.updatedAtMs, 0);
  check(data.updatedAtMs >= data.createdAtMs, "session timestamp order");
  check(!["ready", "active"].includes(data.state as string) || data.deviceId !== null, "device binding required");
  return immutable(value);
}

function parseLoadedInput(value: unknown): LoadedInput {
  const data = record(value, ["key", "number", "title"]);
  id(data.key); integer(data.number); text(data.title);
  return immutable(value);
}

export function parseTemplateMapping(value: unknown): TemplateMapping {
  const hasOverlays = value !== null && typeof value === "object" && Object.hasOwn(value, "overlayInputs");
  const data = record(value, ["schemaVersion", "sessionId", "deviceId", "version", "overlay", "state", "inputs", "verifiedAtMs",
    ...(hasOverlays ? ["overlayInputs"] : [])]);
  schema(data.schemaVersion); id(data.sessionId); nullableId(data.deviceId); integer(data.version);
  check(data.overlay === 1, "Overlay 1 required");
  oneOf(data.state, ["uncommissioned", "commissioned"]);
  const inputs = record(data.inputs, ["headline", "name_title"]);
  const headline = inputs.headline === null ? null : parseLoadedInput(inputs.headline);
  const nameTitle = inputs.name_title === null ? null : parseLoadedInput(inputs.name_title);
  if (data.verifiedAtMs !== null) integer(data.verifiedAtMs, 0);
  check(!headline || !nameTitle || (headline.key !== nameTitle.key && headline.number !== nameTitle.number), "input collision");
  if (hasOverlays) {
    const overlays = record(data.overlayInputs, ["headline", "name_title"]);
    const pairs = [[headline, parseLoadedInput(overlays.headline)], [nameTitle, parseLoadedInput(overlays.name_title)]] as const;
    for (const [input, overlay] of pairs) {
      check(input, "overlay needs a text input");
      const sameIdentity = input.key === overlay.key || input.number === overlay.number;
      check(!sameIdentity || (input.key === overlay.key && input.number === overlay.number && input.title === overlay.title),
        "inconsistent input identity");
    }
    check(pairs[0].every(left => pairs[1].every(right => left!.key !== right!.key && left!.number !== right!.number)),
      "input collision");
  }
  check(data.state !== "commissioned" || (data.deviceId !== null && headline && nameTitle && data.verifiedAtMs !== null),
    "commissioning evidence required");
  return immutable(value);
}

export function mappedOverlayInput(mapping: TemplateMapping, templateId: BannerText["templateId"]): LoadedInput | null {
  return mapping.overlayInputs?.[templateId] ?? mapping.inputs[templateId];
}

export function parseBannerSnapshot(value: unknown): BannerSnapshot {
  const data = record(value, ["bannerId", "sessionId", "version", "mappingVersion", "text"]);
  id(data.bannerId); id(data.sessionId); integer(data.version); integer(data.mappingVersion);
  parseBannerText(data.text);
  return immutable(value);
}

export function parseCueSnapshot(value: unknown): CueSnapshot {
  const data = record(value, ["id", "capturedAtMs", "snapshot"]);
  id(data.id); integer(data.capturedAtMs, 0); parseBannerSnapshot(data.snapshot);
  return immutable(value);
}

const COMMAND_KEYS = ["schemaVersion", "protocolVersion", "id", "requestId", "actorId", "sessionId", "deviceId",
  "sessionGeneration", "mappingVersion", "sequence", "clearGeneration", "overlay", "createdAtMs", "expiresAtMs",
  "expectedObservationSequence", "action"];

export function parseLiveCommand(value: unknown): LiveCommand {
  const command = parsePersistedLiveCommand(value);
  check(command.action !== "update_text" || "expectedLive" in command, "update needs the prior live observation");
  return command;
}

/** Read stored history only. Admission and delivery must use parseLiveCommand. */
export function parsePersistedLiveCommand(value: unknown): PersistedLiveCommand {
  const action = (value as LiveCommand | null)?.action;
  oneOf(action, ["take", "update_text", "clear"]);
  const hasExpectedLive = action === "update_text" && Object.hasOwn(value as object, "expectedLive");
  const data = record(value, [...COMMAND_KEYS, action === "clear" ? "target" : "snapshot",
    ...(hasExpectedLive ? ["expectedLive"] : [])]);
  schema(data.schemaVersion); check(data.protocolVersion === LIVE_PRODUCTION_PROTOCOL_VERSION, "unsupported protocol");
  [data.id, data.requestId, data.actorId, data.sessionId, data.deviceId].forEach(id);
  [data.sessionGeneration, data.mappingVersion, data.sequence].forEach(value => integer(value));
  // A safety Clear can precede the first native observation.
  integer(data.expectedObservationSequence, action === "clear" ? 0 : 1);
  integer(data.clearGeneration, 0); integer(data.createdAtMs, 0); integer(data.expiresAtMs, 0);
  check(data.expiresAtMs > data.createdAtMs && data.expiresAtMs - data.createdAtMs <= LIVE_COMMAND_MAX_TTL_MS, "command lifetime");
  check(data.overlay === 1, "Overlay 1 required");
  if (action === "clear") {
    const kind = (data.target as ClearTarget | null)?.kind;
    oneOf(kind, ["banner", "managed_overlay"]);
    const target = record(data.target, kind === "banner" ? ["kind", "bannerId", "version", "templateId"] : ["kind"]);
    if (kind === "banner") {
      integer(data.expectedObservationSequence);
      id(target.bannerId); integer(target.version); oneOf(target.templateId, ["headline", "name_title"]);
    }
  } else {
    const snapshot = parseBannerSnapshot(data.snapshot);
    check(snapshot.sessionId === data.sessionId && snapshot.mappingVersion === data.mappingVersion, "snapshot binding");
    if (hasExpectedLive) {
      const prior = parseAgentObservation(data.expectedLive);
      check(prior.source === "boardwalk" && prior.state === "on_air" && prior.text !== null &&
        prior.sessionId === data.sessionId && prior.deviceId === data.deviceId &&
        prior.sessionGeneration === data.sessionGeneration && prior.mappingVersion === data.mappingVersion &&
        prior.sequence === data.expectedObservationSequence && prior.correlation !== null &&
        "bannerId" in prior.correlation && prior.correlation.bannerId === snapshot.bannerId &&
        prior.correlation.bannerVersion < snapshot.version && prior.text.templateId === snapshot.text.templateId &&
        !sameBannerText(prior.text, snapshot.text), "update needs the exact prior live banner and changed saved text");
    }
  }
  return immutable(value);
}

export function parseLiveCommandDelivery(value: unknown): LiveCommandDelivery {
  const data = record(value, ["schemaVersion", "timingId", "ttlMs", "command"]);
  schema(data.schemaVersion); id(data.timingId); integer(data.ttlMs);
  const command = parseLiveCommand(data.command);
  check(data.ttlMs <= command.expiresAtMs - command.createdAtMs, "delivery exceeds command lifetime");
  return immutable(value);
}

/** Only the server computes the remaining budget at response/push creation. */
export function issueLiveCommandDelivery(command: LiveCommand, timingId: string, serverNowMs: number): LiveCommandDelivery {
  const parsed = parseLiveCommand(command);
  integer(serverNowMs, 0);
  check(serverNowMs >= parsed.createdAtMs && serverNowMs < parsed.expiresAtMs, "command expired or from future");
  return parseLiveCommandDelivery({ schemaVersion: 1, timingId, ttlMs: parsed.expiresAtMs - serverNowMs, command: parsed });
}

function elapsedDeliveryMs(value: unknown): number {
  const kind = (value as DeliveryTiming | null)?.kind;
  oneOf(kind, ["request", "heartbeat"]);
  const data = record(value, kind === "request" ? ["kind", "elapsedMs"] : ["kind", "elapsedSinceReceiptMs", "roundTripMs"]);
  const elapsed = kind === "request" ? data.elapsedMs : data.elapsedSinceReceiptMs;
  check(typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0, "monotonic elapsed time required");
  if (kind === "request") return elapsed;
  check(typeof data.roundTripMs === "number" && Number.isFinite(data.roundTripMs) && data.roundTripMs > 0,
    "authenticated heartbeat RTT required");
  // Heartbeat receipt minus its RTT is that heartbeat's request start.
  // Include time since that receipt, never just subtract an old RTT from a new push receipt.
  return elapsed + data.roundTripMs;
}

/** Admission/agent fence check; callers still enforce auth, commissioning and fresh native state. */
export function assertCommandBinding(delivery: LiveCommandDelivery, context: Readonly<{
  sessionId: string; deviceId: string; sessionGeneration: number; mappingVersion: number;
  clearGeneration: number; lastSequence: number; timingId: string; timing: DeliveryTiming;
}>): void {
  const parsedDelivery = parseLiveCommandDelivery(delivery);
  const data = parsedDelivery.command;
  record(context, ["sessionId", "deviceId", "sessionGeneration", "mappingVersion", "clearGeneration", "lastSequence", "timingId", "timing"]);
  id(context.sessionId); id(context.deviceId);
  integer(context.sessionGeneration); integer(context.mappingVersion);
  integer(context.clearGeneration, 0); integer(context.lastSequence, 0); id(context.timingId);
  check(data.sessionId === context.sessionId && data.deviceId === context.deviceId &&
    data.sessionGeneration === context.sessionGeneration && data.mappingVersion === context.mappingVersion &&
    data.clearGeneration === context.clearGeneration, "stale command binding");
  check(data.sequence > context.lastSequence, "replayed or out-of-order command");
  check(parsedDelivery.timingId === context.timingId, "delivery timing binding");
  check(elapsedDeliveryMs(context.timing) < parsedDelivery.ttlMs, "command delivery expired");
}

export function parseConfirmedLiveVersion(value: unknown): ConfirmedLiveVersion {
  const data = record(value, ["commandId", "observationSequence", "observedAtMs", "snapshot"]);
  id(data.commandId); integer(data.observationSequence); integer(data.observedAtMs, 0);
  parseBannerSnapshot(data.snapshot);
  return immutable(value);
}

export function parseBannerRecord(value: unknown): BannerRecord {
  const data = record(value, ["schemaVersion", "id", "sessionId", "draft", "cue", "acceptedCommand", "confirmedLive"]);
  schema(data.schemaVersion); id(data.id); id(data.sessionId);
  const draft = record(data.draft, ["version", "text", "updatedAtMs", "updatedBy"]);
  integer(draft.version); parseBannerText(draft.text); integer(draft.updatedAtMs, 0); id(draft.updatedBy);
  const draftVersion = draft.version;
  const snapshots: BannerSnapshot[] = [];
  if (data.cue !== null) snapshots.push(parseCueSnapshot(data.cue).snapshot);
  const command = data.acceptedCommand === null ? null : parsePersistedLiveCommand(data.acceptedCommand);
  if (command !== null) {
    check(command.sessionId === data.sessionId, "banner command session");
    if (command.action === "clear") {
      check(command.target.kind === "banner" && command.target.bannerId === data.id && command.target.version <= draft.version,
        "banner Clear target");
    } else snapshots.push(command.snapshot);
  }
  const confirmed = data.confirmedLive === null ? null : parseConfirmedLiveVersion(data.confirmedLive);
  if (confirmed !== null) snapshots.push(confirmed.snapshot);
  if (confirmed !== null && command !== null && confirmed.commandId === command.id) {
    check(command.action !== "clear", "Clear cannot confirm a live banner");
    check(confirmed.snapshot.bannerId === command.snapshot.bannerId && confirmed.snapshot.sessionId === command.snapshot.sessionId &&
      confirmed.snapshot.version === command.snapshot.version && confirmed.snapshot.mappingVersion === command.snapshot.mappingVersion &&
      sameBannerText(confirmed.snapshot.text, command.snapshot.text), "confirmed command snapshot");
    check(confirmed.observationSequence > command.expectedObservationSequence,
      "confirmation must follow the command");
  }
  snapshots.forEach(snapshot => check(snapshot.bannerId === data.id && snapshot.sessionId === data.sessionId &&
    snapshot.version <= draftVersion, "banner snapshot identity or future version"));
  const textByVersion = new Map<number, BannerText>([[draftVersion, parseBannerText(draft.text)]]);
  for (const snapshot of snapshots) {
    const prior = textByVersion.get(snapshot.version);
    if (prior) check(sameBannerText(prior, snapshot.text), "one banner version has different text");
    textByVersion.set(snapshot.version, snapshot.text);
  }
  if (command?.action === "clear" && command.target.kind === "banner") {
    const knownText = textByVersion.get(command.target.version);
    check(!knownText || knownText.templateId === command.target.templateId, "banner Clear template");
  }
  return immutable(value);
}

function sameBannerText(left: BannerText, right: BannerText): boolean {
  if (left.templateId === "headline" && right.templateId === "headline") return left.headline === right.headline;
  if (left.templateId === "name_title" && right.templateId === "name_title") return left.name === right.name && left.title === right.title;
  return false;
}

export function parseAgentObservation(value: unknown): AgentObservation {
  const data = record(value, ["schemaVersion", "protocolVersion", "sessionId", "deviceId", "sessionGeneration", "mappingVersion",
    "sequence", "observedAtMs", "vmix", "overlay", "state", "inputKey", "text", "source", "correlation"]);
  schema(data.schemaVersion); check(data.protocolVersion === LIVE_PRODUCTION_PROTOCOL_VERSION, "unsupported protocol");
  id(data.sessionId); id(data.deviceId); integer(data.sessionGeneration); integer(data.mappingVersion); integer(data.sequence);
  integer(data.observedAtMs, 0); check(data.overlay === 1, "Overlay 1 required");
  oneOf(data.vmix, ["reachable", "unreachable"]); oneOf(data.state, ["on_air", "clear", "unknown"]);
  oneOf(data.source, ["boardwalk", "manual", "unknown"]); nullableId(data.inputKey);
  if (data.text !== null) parseBannerText(data.text);
  if (data.correlation !== null) {
    const correlation = record(data.correlation, data.state === "clear" ? ["commandId"] : ["commandId", "bannerId", "bannerVersion"]);
    id(correlation.commandId);
    if (data.state !== "clear") { id(correlation.bannerId); integer(correlation.bannerVersion); }
  }
  check(data.state !== "on_air" || (data.vmix === "reachable" && data.inputKey !== null), "on-air evidence required");
  check(data.state !== "clear" || (data.vmix === "reachable" && data.inputKey === null && data.text === null),
    "Clear observation has visible content");
  check(data.source !== "boardwalk" || ((data.state === "clear" || (data.state === "on_air" && data.text !== null)) &&
    data.correlation !== null), "command correlation required");
  check(data.source === "boardwalk" || data.correlation === null, "manual/unknown attribution");
  check(data.vmix !== "unreachable" || (data.state === "unknown" && data.inputKey === null && data.text === null), "unreachable vMix state");
  return immutable(value);
}

/** Freshness uses server receipt time for a new native sample. Agent wall time is informational. */
export function projectObservedState(report: AgentObservation | null, receivedAtMs: number, nowMs: number): Readonly<{
  state: "on_air" | "clear" | "stale" | "unknown"; report: AgentObservation | null;
}> {
  integer(receivedAtMs, 0); integer(nowMs, 0);
  if (report === null) return Object.freeze({ state: "unknown", report: null });
  const parsed = parseAgentObservation(report);
  if (receivedAtMs > nowMs) return Object.freeze({ state: "unknown", report: parsed });
  const stale = nowMs - receivedAtMs >= LIVE_OBSERVATION_STALE_MS;
  return Object.freeze({ state: stale ? "stale" : parsed.state, report: parsed });
}
