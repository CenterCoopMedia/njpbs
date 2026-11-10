import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { parseExportRequest, parseImportRequest, buildDedupKey, transferOperationId,
  transition, isTerminal, canRetry, SAFE_ERROR_CODES } = require("../../functions/lib/cuez-transfer-contract");
const video = { kind: "video", sourceId: "video-library", assetId: "asset-1", expectedVersion: 3,
  fileVersion: "file-v1", expectedUpdateTime: "100:200" };
const output = { attemptId: "attempt-1", objectKey: "outputs/one.mp4", objectVersionId: "v1", sizeBytes: 1024 };
const selections = [video,
  { ...video, kind: "clip", clipId: "a".repeat(64), expectedClipOutput: output, expectedJobUpdateTime: "101:0" },
  { ...video, kind: "transcript", transcriptId: "b".repeat(64), expectedEditRevision: 0, expectedJobUpdateTime: "102:0" },
  { kind: "image", assetId: "image-1", expectedVersion: 1, expectedUpdateTime: "103:0" },
  { kind: "post", recordId: "post-1", expectedVersion: 2, expectedUpdateTime: "104:0" },
  { kind: "around-nj", recordId: "c".repeat(64), expectedUpdateTime: "105:0" },
];
const targets = ["story-asset", "story-asset", "dossier", "story-asset", "new-story", "new-story"];
const request = (selection = video, kind = "story-asset") => ({ workspaceId: "workspace/one", selection,
  target: kind === "new-story" ? { kind } : { kind, storyId: "story:one" }, mappingVersion: 1 });
const imported = { workspaceId: "workspace/one", importKind: "story-with-brief-and-dossiers",
  storyId: "story:one", mappingVersion: 1 };
const badOpaque = [undefined, null, "", " ", " leading", "trailing ", "line\nbreak", "nul\0byte",
  "del\u007f", "control\u0085", "x".repeat(1025), "\ud800", "\udfff", "a\ud800b", 1, {}, []];
const badInteger = [undefined, null, 0, -1, 1.5, "1", false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
function expectInvalid(run, code = "invalid_request", status = 400) {
  expect(run).toThrow(expect.objectContaining({ name: "SourceMediaValidationError", code, status,
    message: code === "invalid_request" ? "Transfer request is invalid" : "Transfer transition is invalid" }));
}

describe("first-wave request contracts", () => {
  it.each(selections.map((s, i) => [s, targets[i]]))("accepts and binds every selection field %j", (s, kind) => {
    const base = request(s, kind);
    expect(parseExportRequest(base)).toEqual(base);
    const key = transferOperationId("export", base);
    for (const [field, value] of Object.entries(s)) {
      if (["kind", "sourceId", "expectedClipOutput"].includes(field)) continue;
      const changed = typeof value === "number" ? value + 1 :
        ["clipId", "transcriptId", "recordId"].includes(field) && value.length === 64 ? "d".repeat(64) : `${value}2`;
      expect(transferOperationId("export", request({ ...s, [field]: changed }, kind))).not.toBe(key);
    }
    for (const patch of [{ workspaceId: "other" }, { mappingVersion: 2 },
      ...(kind === "new-story" ? [] : [{ target: { kind, storyId: "other" } }])]) {
      expect(transferOperationId("export", { ...base, ...patch })).not.toBe(key);
    }
    const parsed = parseExportRequest(base);
    parsed.selection.expectedUpdateTime = "changed";
    expect(base.selection.expectedUpdateTime).not.toBe("changed");
  });
  it.each(badOpaque)("rejects malformed opaque values %j, including lone surrogates", value => {
    expectInvalid(() => parseExportRequest({ ...request(), workspaceId: value }));
    expectInvalid(() => parseExportRequest(request({ ...video, fileVersion: value })));
    expectInvalid(() => parseExportRequest(request({ ...video, expectedUpdateTime: value })));
    expectInvalid(() => parseImportRequest({ ...imported, storyId: value }));
    expectInvalid(() => buildDedupKey("import", { ...imported, remoteChangeMarker: value }));
  });
  it.each(badInteger)("rejects invalid positive integers %j", value => {
    expectInvalid(() => parseExportRequest({ ...request(), mappingVersion: value }));
    expectInvalid(() => parseExportRequest(request({ ...video, expectedVersion: value })));
    expectInvalid(() => parseImportRequest({ ...imported, mappingVersion: value }));
  });
  it("accepts exact Unicode and upper bounds", () => {
    const input = request({ ...video, assetId: "x".repeat(128), fileVersion: "x".repeat(1024),
      expectedVersion: Number.MAX_SAFE_INTEGER });
    input.workspaceId = "é𐀀:/?=";
    expect(parseExportRequest(input)).toEqual(input);
    expect(parseExportRequest(request(video, "new-story"))).toEqual(request(video, "new-story"));
    expect(parseImportRequest(imported)).toEqual(imported);
  });
  it.each([undefined, null, [], new Date(), 1, "request"])("rejects non-objects %j", value => {
    expectInvalid(() => parseExportRequest(value));
    expectInvalid(() => parseImportRequest(value));
  });
  it("refuses unknown, inherited, malformed and cross-kind fields without echoing input", () => {
    for (const patch of [{ kind: "unknown" }, { sourceId: "archive" }, { assetId: "bad/id" },
      { assetId: "x".repeat(129) }, { signedUrl: "secret" }, { expectedClipOutput: output }]) {
      expectInvalid(() => parseExportRequest(request({ ...video, ...patch })));
    }
    expectInvalid(() => parseExportRequest({ ...request(), initiatedBy: "secret" }));
    expectInvalid(() => parseExportRequest(Object.create(request())));
    expectInvalid(() => parseExportRequest({ ...request(), target: { kind: "new-story", storyId: "secret" } }));
    expectInvalid(() => parseImportRequest({ ...imported, importKind: "rundown" }));
    expectInvalid(() => parseImportRequest({ ...imported, remoteChangeMarker: "client-supplied" }));
    for (let i = 0; i < selections.length; i++) {
      for (const kind of ["new-story", "story-asset", "dossier"]) {
        // Jules's Oct. 29 decision permits every selected kind in a new story.
        if (kind === targets[i] || kind === "new-story") continue;
        expectInvalid(() => parseExportRequest(request(selections[i], kind)));
      }
    }
    for (const patch of [{ clipId: "A".repeat(64) }, { expectedJobUpdateTime: null },
      { expectedClipOutput: { ...output, url: "secret" } }, { expectedClipOutput: { ...output, sizeBytes: 0 } }]) {
      expectInvalid(() => parseExportRequest(request({ ...selections[1], ...patch })));
    }
    expectInvalid(() => parseExportRequest(request({ ...selections[2], expectedEditRevision: -1 }, "dossier")));
  });
  it("uses the documented literal tuples and ignores object key order", () => {
    expect(buildDedupKey("export", request())).toBe(
      '["boardwalk-transfer-v2","export","workspace/one","story-asset","story:one","video","video-library","asset-1",3,"file-v1","100:200",null,null,null,null,null,1]');
    expect(transferOperationId("export", Object.fromEntries(Object.entries(request()).reverse())))
      .toBe(transferOperationId("export", request()));
    expect(transferOperationId("export", request())).toMatch(/^[a-f0-9]{64}$/);
    // SHA-256 of the literal v2 tuple, computed independently with .NET HashData.
    expect(transferOperationId("export", request())).toBe("b2b46596f374b3859743899cea639d65f06edc36e2710313adb2d4d1eac9ecc8");
    const snapshot = { ...imported, remoteChangeMarker: "remote:v1" };
    expect(buildDedupKey("import", snapshot)).toBe(
      '["boardwalk-transfer-v2","import","workspace/one","story-with-brief-and-dossiers","story:one","remote:v1",1]');
    for (const [field, value] of [["workspaceId", "other"], ["storyId", "other"],
      ["mappingVersion", 2], ["remoteChangeMarker", "remote:v2"]]) {
      expect(transferOperationId("import", { ...snapshot, [field]: value })).not.toBe(transferOperationId("import", snapshot));
    }
    for (const [field, value] of Object.entries(output)) {
      expect(buildDedupKey("export", request({ ...selections[1],
        expectedClipOutput: { ...output, [field]: typeof value === "number" ? value + 1 : `${value}2` } })))
        .not.toBe(buildDedupKey("export", request(selections[1])));
    }
    expectInvalid(() => buildDedupKey("import", imported));
    expectInvalid(() => buildDedupKey("unknown", request()));
  });
  it.each([...SAFE_ERROR_CODES.filter(code => code !== "transient_failure"), undefined, "unknown"])("refuses retry for %s", code => {
    expect(canRetry("failed", code)).toBe(false);
    expectInvalid(() => transition("failed", "retry", code), "invalid_transition", 409);
  });
});

describe("transfer state machine", () => {
  it.each(["output_unavailable", "not_authorized", "not_configured", "invalid_request"])(
    "allows an explicit partial retry after confirmed %s", code => {
      expect(canRetry("failed", code, true)).toBe(true);
      expect(transition("failed", "retry", code, true)).toBe("queued");
      expect(canRetry("failed", code)).toBe(false);
    });
  it.each(["selection_changed", "invalid_transition", "remote_conflict", "outcome_unknown", "unknown"])(
    "keeps unsafe partial retries blocked for %s", code => {
      expect(canRetry("failed", code, true)).toBe(false);
      expectInvalid(() => transition("failed", "retry", code, true), "invalid_transition", 409);
    });
  // The allowed transitions are copied from the document's table, not the implementation.
  const allowed = [
    ["queued", "start", "transferring"],
    ["queued", "confirmed_failure", "failed"],
    ["queued", "confirmed_conflict", "conflict"],
    ["transferring", "confirmed_complete", "complete"],
    ["transferring", "confirmed_failure", "failed"],
    ["transferring", "confirmed_conflict", "conflict"],
    ["transferring", "outcome_unknown", "reconciliation"],
    ["failed", "retry", "queued"],
    ["reconciliation", "confirmed_complete", "complete"],
    ["reconciliation", "confirmed_failure", "failed"],
    ["reconciliation", "confirmed_conflict", "conflict"],
  ];
  const states = ["queued", "transferring", "complete", "conflict", "failed", "reconciliation"];
  const events = ["start", "confirmed_complete", "confirmed_failure", "confirmed_conflict", "outcome_unknown", "retry"];
  it.each(allowed)("allows %s + %s -> %s", (state, event, next) => {
    expect(transition(state, event, "transient_failure")).toBe(next);
  });
  it.each(states.flatMap(state => events.filter(event => !allowed.some(row => row[0] === state && row[1] === event))
    .map(event => [state, event])))("refuses %s + %s", (state, event) => {
    expectInvalid(() => transition(state, event), "invalid_transition", 409);
  });
  it.each([
    ["queued", false, false], ["transferring", false, false], ["complete", true, false],
    ["conflict", true, false], ["failed", false, true], ["reconciliation", false, false],
  ])("reports terminal and retry eligibility for %s", (state, terminal, retry) => {
    expect(isTerminal(state)).toBe(terminal);
    expect(canRetry(state, "transient_failure")).toBe(retry);
  });
  it.each([undefined, null, [], {}, 1, "unknown", "toString", "constructor", "__proto__"])(
    "refuses unknown states and events %j without echoing them", value => {
      expectInvalid(() => transition(value, "start"), "invalid_transition", 409);
      for (const state of states) expectInvalid(() => transition(state, value), "invalid_transition", 409);
      expectInvalid(() => isTerminal(value), "invalid_transition", 409);
      expectInvalid(() => canRetry(value), "invalid_transition", 409);
    },
  );
});
