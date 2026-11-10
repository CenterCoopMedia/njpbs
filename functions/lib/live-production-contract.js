// Generated from packages/content-core/src/live-production.ts.
// Regenerate with: node scripts/generate-live-production.mjs
/* eslint-disable */
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/live-production.ts
var live_production_exports = {};
__export(live_production_exports, {
  LIVE_COMMAND_MAX_TTL_MS: () => LIVE_COMMAND_MAX_TTL_MS,
  LIVE_OBSERVATION_STALE_MS: () => LIVE_OBSERVATION_STALE_MS,
  LIVE_PRODUCTION_COLLECTION: () => LIVE_PRODUCTION_COLLECTION,
  LIVE_PRODUCTION_PROTOCOL_VERSION: () => LIVE_PRODUCTION_PROTOCOL_VERSION,
  LIVE_PRODUCTION_SCHEMA_VERSION: () => LIVE_PRODUCTION_SCHEMA_VERSION,
  LIVE_TEMPLATES: () => LIVE_TEMPLATES,
  assertCommandBinding: () => assertCommandBinding,
  issueLiveCommandDelivery: () => issueLiveCommandDelivery,
  mappedOverlayInput: () => mappedOverlayInput,
  parseAgentObservation: () => parseAgentObservation,
  parseBannerRecord: () => parseBannerRecord,
  parseBannerSnapshot: () => parseBannerSnapshot,
  parseBannerText: () => parseBannerText,
  parseConfirmedLiveVersion: () => parseConfirmedLiveVersion,
  parseCueSnapshot: () => parseCueSnapshot,
  parseLiveCommand: () => parseLiveCommand,
  parseLiveCommandDelivery: () => parseLiveCommandDelivery,
  parsePersistedLiveCommand: () => parsePersistedLiveCommand,
  parseProductionSession: () => parseProductionSession,
  parseStudioTitleFiles: () => parseStudioTitleFiles,
  parseTemplateMapping: () => parseTemplateMapping,
  projectObservedState: () => projectObservedState
});
module.exports = __toCommonJS(live_production_exports);
var LIVE_PRODUCTION_SCHEMA_VERSION = 1;
var LIVE_PRODUCTION_PROTOCOL_VERSION = 1;
var LIVE_COMMAND_MAX_TTL_MS = 15e3;
var LIVE_OBSERVATION_STALE_MS = 3e4;
var LIVE_PRODUCTION_COLLECTION = "liveProductionSessions";
var LIVE_TEMPLATES = Object.freeze({
  headline: Object.freeze({
    overlay: 1,
    fields: Object.freeze({ headline: "TextBlock1.Text" })
  }),
  name_title: Object.freeze({
    overlay: 1,
    fields: Object.freeze({ name: "TextBlock1.Text", title: "TextBlock2.Text" })
  })
});
function parseStudioTitleFiles(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "headline,name_title") throw new TypeError("Invalid studio title files");
  const files = value;
  for (const id2 of ["headline", "name_title"]) {
    const name = files[id2];
    if (typeof name !== "string" || name.length > 200 || name.trim() !== name || !/^[^\\/:*?"<>|\x00-\x1f\x7f]+\.gtzip$/i.test(name) || name.startsWith(".") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name) || /REPLACE_ME/i.test(name)) throw new TypeError("Invalid studio title files");
  }
  if (files.headline.toLowerCase() === files.name_title.toLowerCase()) throw new TypeError("Studio title files must differ");
  return Object.freeze({ headline: files.headline, name_title: files.name_title });
}
function check(condition, message) {
  if (!condition) throw new TypeError(`Invalid live production contract: ${message}`);
}
function record(value, keys) {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "object required");
  check(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "plain object required"
  );
  check(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
    "unexpected or missing fields"
  );
  return value;
}
function integer(value, minimum = 1) {
  check(Number.isSafeInteger(value) && value >= minimum, "integer out of range");
}
function text(value, allowEmpty = false) {
  check(typeof value === "string" && (allowEmpty || value.trim().length > 0), "text required");
}
function id(value) {
  check(typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value), "invalid identity");
}
function nullableId(value) {
  if (value !== null) id(value);
}
function oneOf(value, values) {
  check(values.includes(value), "unsupported value");
}
function schema(value) {
  check(value === LIVE_PRODUCTION_SCHEMA_VERSION, "unsupported schema");
}
function immutable(value) {
  function freeze(item) {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  }
  return freeze(structuredClone(value));
}
function parseBannerText(value) {
  const templateId = value?.templateId;
  oneOf(templateId, ["headline", "name_title"]);
  const data = record(value, templateId === "headline" ? ["templateId", "headline"] : ["templateId", "name", "title"]);
  if (templateId === "headline") text(data.headline);
  else {
    text(data.name);
    text(data.title, true);
  }
  return immutable(value);
}
function parseProductionSession(value) {
  const data = record(value, [
    "schemaVersion",
    "id",
    "title",
    "productionProgramId",
    "publicProgramId",
    "showPlanId",
    "deviceId",
    "generation",
    "mappingVersion",
    "state",
    "createdAtMs",
    "updatedAtMs"
  ]);
  schema(data.schemaVersion);
  [data.id, data.productionProgramId].forEach(id);
  [data.publicProgramId, data.showPlanId, data.deviceId].forEach(nullableId);
  text(data.title);
  integer(data.generation);
  integer(data.mappingVersion);
  oneOf(data.state, ["draft", "ready", "active", "ended"]);
  integer(data.createdAtMs, 0);
  integer(data.updatedAtMs, 0);
  check(data.updatedAtMs >= data.createdAtMs, "session timestamp order");
  check(!["ready", "active"].includes(data.state) || data.deviceId !== null, "device binding required");
  return immutable(value);
}
function parseLoadedInput(value) {
  const data = record(value, ["key", "number", "title"]);
  id(data.key);
  integer(data.number);
  text(data.title);
  return immutable(value);
}
function parseTemplateMapping(value) {
  const hasOverlays = value !== null && typeof value === "object" && Object.hasOwn(value, "overlayInputs");
  const data = record(value, [
    "schemaVersion",
    "sessionId",
    "deviceId",
    "version",
    "overlay",
    "state",
    "inputs",
    "verifiedAtMs",
    ...hasOverlays ? ["overlayInputs"] : []
  ]);
  schema(data.schemaVersion);
  id(data.sessionId);
  nullableId(data.deviceId);
  integer(data.version);
  check(data.overlay === 1, "Overlay 1 required");
  oneOf(data.state, ["uncommissioned", "commissioned"]);
  const inputs = record(data.inputs, ["headline", "name_title"]);
  const headline = inputs.headline === null ? null : parseLoadedInput(inputs.headline);
  const nameTitle = inputs.name_title === null ? null : parseLoadedInput(inputs.name_title);
  if (data.verifiedAtMs !== null) integer(data.verifiedAtMs, 0);
  check(!headline || !nameTitle || headline.key !== nameTitle.key && headline.number !== nameTitle.number, "input collision");
  if (hasOverlays) {
    const overlays = record(data.overlayInputs, ["headline", "name_title"]);
    const pairs = [[headline, parseLoadedInput(overlays.headline)], [nameTitle, parseLoadedInput(overlays.name_title)]];
    for (const [input, overlay] of pairs) {
      check(input, "overlay needs a text input");
      const sameIdentity = input.key === overlay.key || input.number === overlay.number;
      check(
        !sameIdentity || input.key === overlay.key && input.number === overlay.number && input.title === overlay.title,
        "inconsistent input identity"
      );
    }
    check(
      pairs[0].every((left) => pairs[1].every((right) => left.key !== right.key && left.number !== right.number)),
      "input collision"
    );
  }
  check(
    data.state !== "commissioned" || data.deviceId !== null && headline && nameTitle && data.verifiedAtMs !== null,
    "commissioning evidence required"
  );
  return immutable(value);
}
function mappedOverlayInput(mapping, templateId) {
  return mapping.overlayInputs?.[templateId] ?? mapping.inputs[templateId];
}
function parseBannerSnapshot(value) {
  const data = record(value, ["bannerId", "sessionId", "version", "mappingVersion", "text"]);
  id(data.bannerId);
  id(data.sessionId);
  integer(data.version);
  integer(data.mappingVersion);
  parseBannerText(data.text);
  return immutable(value);
}
function parseCueSnapshot(value) {
  const data = record(value, ["id", "capturedAtMs", "snapshot"]);
  id(data.id);
  integer(data.capturedAtMs, 0);
  parseBannerSnapshot(data.snapshot);
  return immutable(value);
}
var COMMAND_KEYS = [
  "schemaVersion",
  "protocolVersion",
  "id",
  "requestId",
  "actorId",
  "sessionId",
  "deviceId",
  "sessionGeneration",
  "mappingVersion",
  "sequence",
  "clearGeneration",
  "overlay",
  "createdAtMs",
  "expiresAtMs",
  "expectedObservationSequence",
  "action"
];
function parseLiveCommand(value) {
  const command = parsePersistedLiveCommand(value);
  check(command.action !== "update_text" || "expectedLive" in command, "update needs the prior live observation");
  return command;
}
function parsePersistedLiveCommand(value) {
  const action = value?.action;
  oneOf(action, ["take", "update_text", "clear"]);
  const hasExpectedLive = action === "update_text" && Object.hasOwn(value, "expectedLive");
  const data = record(value, [
    ...COMMAND_KEYS,
    action === "clear" ? "target" : "snapshot",
    ...hasExpectedLive ? ["expectedLive"] : []
  ]);
  schema(data.schemaVersion);
  check(data.protocolVersion === LIVE_PRODUCTION_PROTOCOL_VERSION, "unsupported protocol");
  [data.id, data.requestId, data.actorId, data.sessionId, data.deviceId].forEach(id);
  [data.sessionGeneration, data.mappingVersion, data.sequence].forEach((value2) => integer(value2));
  integer(data.expectedObservationSequence, action === "clear" ? 0 : 1);
  integer(data.clearGeneration, 0);
  integer(data.createdAtMs, 0);
  integer(data.expiresAtMs, 0);
  check(data.expiresAtMs > data.createdAtMs && data.expiresAtMs - data.createdAtMs <= LIVE_COMMAND_MAX_TTL_MS, "command lifetime");
  check(data.overlay === 1, "Overlay 1 required");
  if (action === "clear") {
    const kind = data.target?.kind;
    oneOf(kind, ["banner", "managed_overlay"]);
    const target = record(data.target, kind === "banner" ? ["kind", "bannerId", "version", "templateId"] : ["kind"]);
    if (kind === "banner") {
      integer(data.expectedObservationSequence);
      id(target.bannerId);
      integer(target.version);
      oneOf(target.templateId, ["headline", "name_title"]);
    }
  } else {
    const snapshot = parseBannerSnapshot(data.snapshot);
    check(snapshot.sessionId === data.sessionId && snapshot.mappingVersion === data.mappingVersion, "snapshot binding");
    if (hasExpectedLive) {
      const prior = parseAgentObservation(data.expectedLive);
      check(prior.source === "boardwalk" && prior.state === "on_air" && prior.text !== null && prior.sessionId === data.sessionId && prior.deviceId === data.deviceId && prior.sessionGeneration === data.sessionGeneration && prior.mappingVersion === data.mappingVersion && prior.sequence === data.expectedObservationSequence && prior.correlation !== null && "bannerId" in prior.correlation && prior.correlation.bannerId === snapshot.bannerId && prior.correlation.bannerVersion < snapshot.version && prior.text.templateId === snapshot.text.templateId && !sameBannerText(prior.text, snapshot.text), "update needs the exact prior live banner and changed saved text");
    }
  }
  return immutable(value);
}
function parseLiveCommandDelivery(value) {
  const data = record(value, ["schemaVersion", "timingId", "ttlMs", "command"]);
  schema(data.schemaVersion);
  id(data.timingId);
  integer(data.ttlMs);
  const command = parseLiveCommand(data.command);
  check(data.ttlMs <= command.expiresAtMs - command.createdAtMs, "delivery exceeds command lifetime");
  return immutable(value);
}
function issueLiveCommandDelivery(command, timingId, serverNowMs) {
  const parsed = parseLiveCommand(command);
  integer(serverNowMs, 0);
  check(serverNowMs >= parsed.createdAtMs && serverNowMs < parsed.expiresAtMs, "command expired or from future");
  return parseLiveCommandDelivery({ schemaVersion: 1, timingId, ttlMs: parsed.expiresAtMs - serverNowMs, command: parsed });
}
function elapsedDeliveryMs(value) {
  const kind = value?.kind;
  oneOf(kind, ["request", "heartbeat"]);
  const data = record(value, kind === "request" ? ["kind", "elapsedMs"] : ["kind", "elapsedSinceReceiptMs", "roundTripMs"]);
  const elapsed = kind === "request" ? data.elapsedMs : data.elapsedSinceReceiptMs;
  check(typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0, "monotonic elapsed time required");
  if (kind === "request") return elapsed;
  check(
    typeof data.roundTripMs === "number" && Number.isFinite(data.roundTripMs) && data.roundTripMs > 0,
    "authenticated heartbeat RTT required"
  );
  return elapsed + data.roundTripMs;
}
function assertCommandBinding(delivery, context) {
  const parsedDelivery = parseLiveCommandDelivery(delivery);
  const data = parsedDelivery.command;
  record(context, ["sessionId", "deviceId", "sessionGeneration", "mappingVersion", "clearGeneration", "lastSequence", "timingId", "timing"]);
  id(context.sessionId);
  id(context.deviceId);
  integer(context.sessionGeneration);
  integer(context.mappingVersion);
  integer(context.clearGeneration, 0);
  integer(context.lastSequence, 0);
  id(context.timingId);
  check(data.sessionId === context.sessionId && data.deviceId === context.deviceId && data.sessionGeneration === context.sessionGeneration && data.mappingVersion === context.mappingVersion && data.clearGeneration === context.clearGeneration, "stale command binding");
  check(data.sequence > context.lastSequence, "replayed or out-of-order command");
  check(parsedDelivery.timingId === context.timingId, "delivery timing binding");
  check(elapsedDeliveryMs(context.timing) < parsedDelivery.ttlMs, "command delivery expired");
}
function parseConfirmedLiveVersion(value) {
  const data = record(value, ["commandId", "observationSequence", "observedAtMs", "snapshot"]);
  id(data.commandId);
  integer(data.observationSequence);
  integer(data.observedAtMs, 0);
  parseBannerSnapshot(data.snapshot);
  return immutable(value);
}
function parseBannerRecord(value) {
  const data = record(value, ["schemaVersion", "id", "sessionId", "draft", "cue", "acceptedCommand", "confirmedLive"]);
  schema(data.schemaVersion);
  id(data.id);
  id(data.sessionId);
  const draft = record(data.draft, ["version", "text", "updatedAtMs", "updatedBy"]);
  integer(draft.version);
  parseBannerText(draft.text);
  integer(draft.updatedAtMs, 0);
  id(draft.updatedBy);
  const draftVersion = draft.version;
  const snapshots = [];
  if (data.cue !== null) snapshots.push(parseCueSnapshot(data.cue).snapshot);
  const command = data.acceptedCommand === null ? null : parsePersistedLiveCommand(data.acceptedCommand);
  if (command !== null) {
    check(command.sessionId === data.sessionId, "banner command session");
    if (command.action === "clear") {
      check(
        command.target.kind === "banner" && command.target.bannerId === data.id && command.target.version <= draft.version,
        "banner Clear target"
      );
    } else snapshots.push(command.snapshot);
  }
  const confirmed = data.confirmedLive === null ? null : parseConfirmedLiveVersion(data.confirmedLive);
  if (confirmed !== null) snapshots.push(confirmed.snapshot);
  if (confirmed !== null && command !== null && confirmed.commandId === command.id) {
    check(command.action !== "clear", "Clear cannot confirm a live banner");
    check(confirmed.snapshot.bannerId === command.snapshot.bannerId && confirmed.snapshot.sessionId === command.snapshot.sessionId && confirmed.snapshot.version === command.snapshot.version && confirmed.snapshot.mappingVersion === command.snapshot.mappingVersion && sameBannerText(confirmed.snapshot.text, command.snapshot.text), "confirmed command snapshot");
    check(
      confirmed.observationSequence > command.expectedObservationSequence,
      "confirmation must follow the command"
    );
  }
  snapshots.forEach((snapshot) => check(snapshot.bannerId === data.id && snapshot.sessionId === data.sessionId && snapshot.version <= draftVersion, "banner snapshot identity or future version"));
  const textByVersion = /* @__PURE__ */ new Map([[draftVersion, parseBannerText(draft.text)]]);
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
function sameBannerText(left, right) {
  if (left.templateId === "headline" && right.templateId === "headline") return left.headline === right.headline;
  if (left.templateId === "name_title" && right.templateId === "name_title") return left.name === right.name && left.title === right.title;
  return false;
}
function parseAgentObservation(value) {
  const data = record(value, [
    "schemaVersion",
    "protocolVersion",
    "sessionId",
    "deviceId",
    "sessionGeneration",
    "mappingVersion",
    "sequence",
    "observedAtMs",
    "vmix",
    "overlay",
    "state",
    "inputKey",
    "text",
    "source",
    "correlation"
  ]);
  schema(data.schemaVersion);
  check(data.protocolVersion === LIVE_PRODUCTION_PROTOCOL_VERSION, "unsupported protocol");
  id(data.sessionId);
  id(data.deviceId);
  integer(data.sessionGeneration);
  integer(data.mappingVersion);
  integer(data.sequence);
  integer(data.observedAtMs, 0);
  check(data.overlay === 1, "Overlay 1 required");
  oneOf(data.vmix, ["reachable", "unreachable"]);
  oneOf(data.state, ["on_air", "clear", "unknown"]);
  oneOf(data.source, ["boardwalk", "manual", "unknown"]);
  nullableId(data.inputKey);
  if (data.text !== null) parseBannerText(data.text);
  if (data.correlation !== null) {
    const correlation = record(data.correlation, data.state === "clear" ? ["commandId"] : ["commandId", "bannerId", "bannerVersion"]);
    id(correlation.commandId);
    if (data.state !== "clear") {
      id(correlation.bannerId);
      integer(correlation.bannerVersion);
    }
  }
  check(data.state !== "on_air" || data.vmix === "reachable" && data.inputKey !== null, "on-air evidence required");
  check(
    data.state !== "clear" || data.vmix === "reachable" && data.inputKey === null && data.text === null,
    "Clear observation has visible content"
  );
  check(data.source !== "boardwalk" || (data.state === "clear" || data.state === "on_air" && data.text !== null) && data.correlation !== null, "command correlation required");
  check(data.source === "boardwalk" || data.correlation === null, "manual/unknown attribution");
  check(data.vmix !== "unreachable" || data.state === "unknown" && data.inputKey === null && data.text === null, "unreachable vMix state");
  return immutable(value);
}
function projectObservedState(report, receivedAtMs, nowMs) {
  integer(receivedAtMs, 0);
  integer(nowMs, 0);
  if (report === null) return Object.freeze({ state: "unknown", report: null });
  const parsed = parseAgentObservation(report);
  if (receivedAtMs > nowMs) return Object.freeze({ state: "unknown", report: parsed });
  const stale = nowMs - receivedAtMs >= LIVE_OBSERVATION_STALE_MS;
  return Object.freeze({ state: stale ? "stale" : parsed.state, report: parsed });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LIVE_COMMAND_MAX_TTL_MS,
  LIVE_OBSERVATION_STALE_MS,
  LIVE_PRODUCTION_COLLECTION,
  LIVE_PRODUCTION_PROTOCOL_VERSION,
  LIVE_PRODUCTION_SCHEMA_VERSION,
  LIVE_TEMPLATES,
  assertCommandBinding,
  issueLiveCommandDelivery,
  mappedOverlayInput,
  parseAgentObservation,
  parseBannerRecord,
  parseBannerSnapshot,
  parseBannerText,
  parseConfirmedLiveVersion,
  parseCueSnapshot,
  parseLiveCommand,
  parseLiveCommandDelivery,
  parsePersistedLiveCommand,
  parseProductionSession,
  parseStudioTitleFiles,
  parseTemplateMapping,
  projectObservedState
});
