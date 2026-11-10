import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import * as shared from "../../packages/content-core/src/live-production";
import { banner, clearWithoutObservation, command, delivery, mapping, observation, session, snapshot } from "../fixtures/live-production";

const require = createRequire(import.meta.url);
const deployed: typeof shared = require("../../functions/lib/live-production-contract.js");

// Run the same independent fixtures through the TS client and deployable CJS boundary.
describe.each([["shared", shared], ["Functions", deployed]] as const)("%s production contracts", (_name, contract) => {
  const cases = [
    ["parseProductionSession", session], ["parseTemplateMapping", mapping],
    ["parseBannerText", snapshot.text], ["parseBannerSnapshot", snapshot],
    ["parseCueSnapshot", banner.cue], ["parseLiveCommand", command],
    ["parseLiveCommandDelivery", delivery], ["parseLiveCommand", clearWithoutObservation],
    ["parseConfirmedLiveVersion", banner.confirmedLive], ["parseBannerRecord", banner],
    ["parseAgentObservation", observation],
  ] as const;

  it.each(cases)("validates %s and rejects unknown fields and versions", (parser, fixture) => {
    const parse = contract[parser];
    expect(parse(fixture)).toEqual(fixture);
    expect(() => parse({ ...fixture, function: "OverlayInput1In" })).toThrow(TypeError);
    expect(() => parse(null)).toThrow(TypeError);
    if ("schemaVersion" in fixture!) expect(() => parse({ ...fixture, schemaVersion: 2 })).toThrow(TypeError);
  });

  it("keeps GT field contracts independent of deployment filenames", () => {
    expect(contract.LIVE_TEMPLATES).toEqual({
      headline: { overlay: 1, fields: { headline: "TextBlock1.Text" } },
      name_title: { overlay: 1, fields: { name: "TextBlock1.Text", title: "TextBlock2.Text" } },
    });
    expect(() => contract.parseBannerText({ templateId: "one_line", headline: "Legacy third template" })).toThrow();
    const unicode = "  São José 東京 <>& \" ' \n".repeat(2000);
    expect(contract.parseBannerText({ templateId: "headline", headline: unicode })).toEqual({ templateId: "headline", headline: unicode });
    expect(contract.parseBannerText({ templateId: "name_title", name: "Example Presenter", title: "" })).toEqual({
      templateId: "name_title", name: "Example Presenter", title: "",
    });
  });

  it("accepts configured GT basenames and refuses paths, ambiguous names and extra fields", () => {
    const names = { headline: "synthetic-headline.gtzip", name_title: "synthetic-name-title.GTZIP" };
    expect(contract.parseStudioTitleFiles(JSON.parse(JSON.stringify(names)))).toEqual(names);
    expect(Object.isFrozen(contract.parseStudioTitleFiles(names))).toBe(true);
    for (const value of [null, {}, [], { ...names, extra: "unused" },
      ...["", "../title.gtzip", "C:\\title.gtzip", "file:headline.gtzip", "bad\n.gtzip", "bad\u007fname.gtzip",
        " headline.gtzip", "x".repeat(201) + ".gtzip", "CON.gtzip", "REPLACE_ME.gtzip", "same.txt", names.name_title.toLowerCase()]
        .map(headline => ({ ...names, headline }))]) {
      expect(() => contract.parseStudioTitleFiles(value)).toThrow(TypeError);
    }
  });
  it("keeps input identities absent until commissioning and fixes Overlay 1", () => {
    expect(() => contract.parseTemplateMapping({ ...mapping, state: "commissioned" })).toThrow();
    const inputs = {
      headline: { key: "fixture-headline", number: 1, title: "Synthetic headline" },
      name_title: { key: "fixture-name", number: 2, title: "Synthetic name and title" },
    };
    const commissioned = { ...mapping, deviceId: "fixture-device", state: "commissioned", verifiedAtMs: 2000, inputs };
    expect(contract.parseTemplateMapping(commissioned)).toEqual(commissioned);
    expect(() => contract.parseTemplateMapping({ ...commissioned, overlay: 2 })).toThrow();
    expect(() => contract.parseTemplateMapping({ ...commissioned, inputs: { ...inputs, name_title: inputs.headline } })).toThrow();
    expect(() => contract.parseTemplateMapping({ ...mapping, inputs: { ...inputs, extra: null } })).toThrow();
    expect(() => contract.parseProductionSession({ ...session, deviceId: null })).toThrow();
    expect(() => contract.parseProductionSession({ ...session, updatedAtMs: 999 })).toThrow();
  });

  it("accepts explicit overlay identities and preserves legacy direct mappings without a rewrite", () => {
    const inputs = {
      headline: { key: "text-headline", number: 111, title: "synthetic-headline.gtzip" },
      name_title: { key: "text-name", number: 112, title: "synthetic-name-title.gtzip" },
    };
    const direct = { ...mapping, deviceId: "fixture-device", state: "commissioned", verifiedAtMs: 2000, inputs };
    const overlayInputs = {
      headline: { key: "overlay-headline", number: 113, title: "Synthetic headline overlay" },
      name_title: { key: "overlay-name", number: 114, title: "Synthetic name-title overlay" },
    };
    const layered = { ...direct, overlayInputs };
    expect(contract.parseTemplateMapping(direct)).toEqual(direct);
    expect(contract.mappedOverlayInput(contract.parseTemplateMapping(direct), "headline")).toEqual(inputs.headline);
    expect(contract.parseTemplateMapping(layered)).toEqual(layered);
    expect(contract.mappedOverlayInput(contract.parseTemplateMapping(layered), "headline")).toEqual(overlayInputs.headline);
    expect(contract.parseTemplateMapping({ ...direct, overlayInputs: inputs })).toEqual({ ...direct, overlayInputs: inputs });
    for (const invalid of [
      null, {}, { headline: overlayInputs.headline }, { ...overlayInputs, extra: inputs.headline },
      { ...overlayInputs, headline: { ...overlayInputs.headline, number: 112 } },
      { ...overlayInputs, headline: { ...overlayInputs.headline, key: inputs.name_title.key } },
      { ...overlayInputs, name_title: overlayInputs.headline },
      { ...overlayInputs, headline: { ...inputs.headline, title: "Conflicting identity" } },
    ]) expect(() => contract.parseTemplateMapping({ ...direct, overlayInputs: invalid })).toThrow(TypeError);
    expect(() => contract.parseTemplateMapping({ ...layered, inputs: { ...inputs, headline: null } })).toThrow(TypeError);
  });

  it("retains old cue/command/live snapshots while draft text advances", () => {
    const input = structuredClone(banner);
    const parsed = contract.parseBannerRecord(input);
    expect(parsed.draft.version).toBe(2);
    expect(parsed.confirmedLive?.snapshot.version).toBe(1);
    expect(parsed.cue?.snapshot.text).toEqual({ templateId: "headline", headline: "POLL: 3 IN 4 RATE NJ ECONOMY NEGATIVELY" });
    expect(Object.isFrozen(parsed.acceptedCommand)).toBe(true);
    expect(Object.isFrozen(parsed.cue?.snapshot.text)).toBe(true);
    (input.draft.text as { name: string }).name = "New draft";
    expect(parsed.draft.text).toEqual({ templateId: "name_title", name: "Example Presenter", title: "Example Studio Host" });
    expect(() => contract.parseBannerRecord({ ...banner, cue: { ...banner.cue, snapshot: { ...snapshot, bannerId: "other" } } })).toThrow();
    expect(() => contract.parseBannerRecord({ ...banner, cue: { ...banner.cue, snapshot: { ...snapshot, version: 3 } } })).toThrow();
    expect(() => contract.parseBannerRecord({ ...banner, cue: { ...banner.cue, snapshot: { ...snapshot, version: 2 } } })).toThrow();
    const pending = contract.parseBannerRecord({ ...banner, confirmedLive: null });
    expect(pending.confirmedLive).toBeNull(); // Accepted Take is not on-air evidence.
  });

  it("reads and saves a legacy accepted update without admitting or delivering it", () => {
    const legacy = { ...command, action: "update_text" };
    const stored = JSON.parse(JSON.stringify({ ...banner, acceptedCommand: legacy }));
    const parsed = contract.parseBannerRecord(stored);
    expect(parsed).toEqual(stored);
    expect(Object.isFrozen(parsed.acceptedCommand)).toBe(true);
    expect(contract.parseBannerRecord({ ...parsed, draft: { ...parsed.draft, version: 3,
      text: { templateId: "headline", headline: "New saved draft" } } }).acceptedCommand).toEqual(legacy);
    expect(() => contract.parseLiveCommand(legacy)).toThrow(TypeError);
    expect(() => contract.parseLiveCommandDelivery({ ...delivery, command: legacy })).toThrow(TypeError);
    expect(() => contract.parseBannerRecord({ ...stored, acceptedCommand: { ...legacy, expectedLive: null } })).toThrow(TypeError);
    expect(() => contract.parseBannerRecord({ ...stored, acceptedCommand: { ...legacy, function: "Cut" } })).toThrow(TypeError);
  });

  it("accepts only complete semantic Take, text update, and scoped Clear envelopes", () => {
    expect(contract.parseLiveCommand({ ...command, action: "update_text", expectedObservationSequence: observation.sequence,
      expectedLive: observation, snapshot: { ...snapshot, version: 2, text: { templateId: "headline", headline: "Updated headline" } } }).action).toBe("update_text");
    const { snapshot: _snapshot, ...identity } = command;
    for (const target of [{ kind: "managed_overlay" }, { kind: "banner", bannerId: "fixture-banner", version: 1, templateId: "headline" }]) {
      expect(contract.parseLiveCommand({ ...identity, action: "clear", target }).action).toBe("clear");
    }
    for (const patch of [
      { action: "cue" }, { action: "SetText" }, { action: "clear_all" }, { url: "http://localhost:8088/api" },
      { expiresAtMs: 2000 }, { expiresAtMs: 17001 }, { deviceId: null }, { sessionGeneration: 0 },
      { protocolVersion: 2 }, { sequence: 1.5 }, { clearGeneration: -1 }, { createdAtMs: Number.NaN }, { overlay: 2 },
      { snapshot: { ...snapshot, sessionId: "other" } }, { snapshot: { ...snapshot, mappingVersion: 4 } },
    ]) expect(() => contract.parseLiveCommand({ ...command, ...patch })).toThrow(TypeError);
  });

  it("allows zero observation sequence for managed Clear only, while retaining all execution fences", () => {
    expect(contract.parseLiveCommand(clearWithoutObservation)).toEqual(clearWithoutObservation);
    expect(() => contract.parseLiveCommand({ ...clearWithoutObservation, expectedObservationSequence: -1 })).toThrow(TypeError);
    expect(() => contract.parseLiveCommand({ ...clearWithoutObservation, target: { kind: "banner", bannerId: "fixture-banner", version: 1, templateId: "headline" } })).toThrow(TypeError);
    for (const action of ["take", "update_text"]) {
      expect(() => contract.parseLiveCommand({ ...command, action, expectedObservationSequence: 0 })).toThrow(TypeError);
    }
  });

  it("checks a banner Clear template against every retained target revision", () => {
    const { snapshot: _snapshot, ...identity } = command;
    const target = { kind: "banner", bannerId: "fixture-banner", version: 2, templateId: "name_title" };
    const record = { ...banner, acceptedCommand: { ...identity, id: "fixture-clear-command", action: "clear", target } };
    expect(contract.parseBannerRecord(record)).toEqual(record);
    expect(() => contract.parseBannerRecord({ ...record,
      acceptedCommand: { ...identity, id: "fixture-clear-command", action: "clear", target: { ...target, templateId: "headline" } },
    })).toThrow("banner Clear template");
    expect(() => contract.parseBannerRecord({ ...record,
      acceptedCommand: { ...identity, id: "fixture-clear-command", action: "clear", target: { ...target, version: 1 } },
    })).toThrow("banner Clear template");
  });

  it("requires matching command confirmation to retain the exact snapshot and a later observation", () => {
    const confirmed = banner.confirmedLive!;
    for (const patch of [
      { snapshot: { ...snapshot, version: 2, text: banner.draft.text } },
      { snapshot: { ...snapshot, mappingVersion: 4 } },
      { snapshot: { ...snapshot, text: { templateId: "headline", headline: "Uncommanded text" } } },
      { observationSequence: 6 }, { observationSequence: 5 },
    ]) expect(() => contract.parseBannerRecord({ ...banner, confirmedLive: { ...confirmed, ...patch } })).toThrow();
    const { snapshot: _snapshot, ...identity } = command;
    expect(() => contract.parseBannerRecord({ ...banner, acceptedCommand: { ...identity, action: "clear",
      target: { kind: "banner", bannerId: "fixture-banner", version: 1, templateId: "headline" },
    } })).toThrow("Clear cannot confirm a live banner");
    const pendingNewCommand = { ...banner, acceptedCommand: { ...command, id: "fixture-next-command", sequence: 5,
      snapshot: { ...snapshot, version: 2, text: banner.draft.text } } };
    expect(contract.parseBannerRecord(pendingNewCommand).confirmedLive).toEqual(confirmed);
    expect(contract.parseBannerRecord({ ...banner, confirmedLive: { ...confirmed, observedAtMs: 1 } }).confirmedLive?.observedAtMs).toBe(1);
  });

  it("fences expired, replayed, switched-session, changed-mapping, and pre-Clear commands", () => {
    const context = { sessionId: "fixture-session", deviceId: "fixture-device", sessionGeneration: 2,
      mappingVersion: 3, clearGeneration: 1, lastSequence: 3, timingId: "fixture-timing", timing: { kind: "request" as const, elapsedMs: 0 } };
    expect(() => contract.assertCommandBinding(delivery, context)).not.toThrow();
    for (const patch of [
      { sessionId: "other" }, { deviceId: "other" }, { sessionGeneration: 3 }, { mappingVersion: 4 },
      { clearGeneration: 2 }, { lastSequence: 4 }, { lastSequence: 5 }, { timingId: "other" },
      { timing: { kind: "request", elapsedMs: 15000 } }, { timing: { kind: "request", elapsedMs: -1 } },
      { timing: { kind: "request", elapsedMs: NaN } },
    ]) expect(() => contract.assertCommandBinding(delivery, { ...context, ...patch } as typeof context)).toThrow(TypeError);
  });

  it("mints remaining lifetime on the server without changing accepted intent", () => {
    expect(contract.issueLiveCommandDelivery(command, "fixture-timing", 7000)).toEqual({ ...delivery, ttlMs: 10000 });
    expect(command.expiresAtMs).toBe(17000);
    expect(() => contract.issueLiveCommandDelivery(command, "fixture-timing", 17000)).toThrow();
    expect(() => contract.issueLiveCommandDelivery(command, "fixture-timing", 1999)).toThrow();
    for (const ttlMs of [0, -1, 15001, 0.5, NaN]) expect(() => contract.parseLiveCommandDelivery({ ...delivery, ttlMs })).toThrow();
  });

  it("consumes request and heartbeat elapsed time so transit never starts a new TTL", () => {
    const issued = contract.issueLiveCommandDelivery(command, "fixture-timing", 7000); // 10 s remain.
    const context = { sessionId: "fixture-session", deviceId: "fixture-device", sessionGeneration: 2,
      mappingVersion: 3, clearGeneration: 1, lastSequence: 3, timingId: "fixture-timing" };
    expect(() => contract.assertCommandBinding(issued, { ...context, timing: { kind: "request", elapsedMs: 9999.5 } })).not.toThrow();
    expect(() => contract.assertCommandBinding(issued, { ...context, timing: { kind: "request", elapsedMs: 10000 } })).toThrow();
    // Saved heartbeat receipt was 9 s ago; its RTT was 1 s. Its request anchor is 10 s old.
    expect(() => contract.assertCommandBinding(issued, { ...context,
      timing: { kind: "heartbeat", elapsedSinceReceiptMs: 9000, roundTripMs: 1000 },
    })).toThrow("command delivery expired");
    expect(() => contract.assertCommandBinding(issued, { ...context,
      timing: { kind: "heartbeat", elapsedSinceReceiptMs: 8999, roundTripMs: 1000 },
    })).not.toThrow();
    for (const roundTripMs of [null, 0, -1, NaN]) expect(() => contract.assertCommandBinding(issued, { ...context,
      timing: { kind: "heartbeat", elapsedSinceReceiptMs: 0, roundTripMs } as shared.DeliveryTiming,
    })).toThrow("heartbeat RTT required");
  });

  it("reports manual, unknown, and stale state without using ACKs as evidence", () => {
    expect(contract.projectObservedState(observation, 3200, 3300).state).toBe("on_air");
    expect(contract.projectObservedState(observation, 3200, 33200).state).toBe("stale");
    expect(contract.projectObservedState(observation, 3200, 3100).state).toBe("unknown");
    for (const agentWallTime of [1, 3201, 10_000_000]) {
      expect(contract.projectObservedState({ ...observation, observedAtMs: agentWallTime }, 3200, 3300).state).toBe("on_air");
    }
    expect(contract.projectObservedState(null, 3200, 3300).state).toBe("unknown");
    const manual = { ...observation, source: "manual", correlation: null };
    expect(contract.parseAgentObservation(manual)).toEqual(manual);
    const unknown = { ...manual, state: "unknown", source: "unknown", vmix: "unreachable", inputKey: null, text: null };
    expect(contract.projectObservedState(contract.parseAgentObservation(unknown), 3200, 3300).state).toBe("unknown");
    const clear = { ...manual, state: "clear", inputKey: null, text: null };
    expect(contract.projectObservedState(contract.parseAgentObservation(clear), 3200, 3300).state).toBe("clear");
    const boardwalkClear = { ...clear, source: "boardwalk", correlation: { commandId: "fixture-clear-command" } };
    expect(contract.parseAgentObservation(boardwalkClear)).toEqual(boardwalkClear);
    expect(() => contract.parseAgentObservation({ ...boardwalkClear, correlation: observation.correlation })).toThrow();
    for (const patch of [{ source: "manual" }, { state: "clear" }, { vmix: "unreachable" }, { inputKey: null }, { correlation: null }]) {
      expect(() => contract.parseAgentObservation({ ...observation, ...patch })).toThrow(TypeError);
    }
  });
});

it("keeps the standalone Functions bundle generated from the shared source", async () => {
  const output = await build({ entryPoints: ["packages/content-core/src/live-production.ts"], bundle: true,
    platform: "node", format: "cjs", target: "node22", legalComments: "none", write: false,
    banner: { js: "// Generated from packages/content-core/src/live-production.ts.\n// Regenerate with: node scripts/generate-live-production.mjs\n/* eslint-disable */" },
  });
  expect(readFileSync("functions/lib/live-production-contract.js", "utf8")).toBe(output.outputFiles[0].text);
});

it("refuses private records at the existing website publication boundary", () => {
  const { createPublishedSnapshot } = require("../../functions/lib/publish-snapshot.js");
  for (const document of [session, banner, mapping, command, observation]) {
    expect(() => createPublishedSnapshot({ collection: "liveProductionSessions", document })).toThrow("Unknown publish collection");
    expect(() => createPublishedSnapshot({ collection: "cmsPosts", document })).toThrow("no public route");
  }
});
