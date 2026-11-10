import { test } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { alignmentRequest, validateAlignmentCompletion } = require("../../functions/lib/video-transcript-alignment");

function fixture(text = "Hello María 2026") {
  return {
    source: { sourceId: "video-library", assetId: "asset", bucket: "private-originals",
      objectKey: "staff/source.mov", objectVersionId: "original-v1", sizeBytes: 1000 },
    input: { bucket: "private-renditions", objectKey: "outputs/test/preview.mp4",
      objectVersionId: "web-v1", sizeBytes: 500, durationSeconds: 20 },
    transcript: { id: "a".repeat(64), editRevision: 2, languageCode: "es-US", segmentsVersionId: "segments-v2" },
    engine: { adapterRevision: "alignment-contract-v1", modelRepository: "fixture/alignment",
      modelRevision: "b".repeat(40), cacheSha256: "c".repeat(64) },
    passages: [{ index: 3, text, startSeconds: 1, endSeconds: 8, overlappingSpeech: false }],
  };
}
function completion(snapshot) {
  return { requestId: alignmentRequest(snapshot).id, status: "complete",
    passages: snapshot.passages.map((passage) => ({ index: passage.index,
      words: passage.text.trim() ? passage.text.trim().split(/\s+/u).map((text, i) => ({
        text, startSeconds: passage.startSeconds + i, endSeconds: passage.startSeconds + i + 0.5,
        aligned: true,
      })) : [],
    })),
  };
}
const invalid = (action, code = "alignment_result_invalid") => assert.throws(action,
  (error) => error.code === code && !error.message.includes("private"));

test("request identity is deterministic, canonical and separate from private input", () => {
  const snapshot = fixture();
  const first = alignmentRequest(snapshot);
  const reordered = { ...snapshot, source: Object.fromEntries(Object.entries(snapshot.source).reverse()) };
  assert.deepEqual(alignmentRequest(reordered), first);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first).sort(), ["id", "passages"]);
  assert.equal(JSON.stringify(first).includes("private-originals"), false);
  first.passages[0].text = "different";
  assert.equal(snapshot.passages[0].text, "Hello María 2026");
});

test("every original, viewing copy, revision, language and model change invalidates completion", () => {
  const snapshot = fixture();
  const result = completion(snapshot);
  for (const [section, field, value] of [
    ["source", "sourceId", "other-source"], ["source", "assetId", "other"],
    ["source", "bucket", "other-bucket"], ["source", "objectKey", "other.mov"],
    ["source", "objectVersionId", "v2"], ["source", "sizeBytes", 1001],
    ["input", "bucket", "other-bucket"], ["input", "objectKey", "other.mp4"],
    ["input", "objectVersionId", "v2"], ["input", "sizeBytes", 501],
    ["input", "durationSeconds", 21], ["transcript", "id", "d".repeat(64)],
    ["transcript", "editRevision", 3], ["transcript", "languageCode", "en-US"],
    ["transcript", "segmentsVersionId", "segments-v3"],
    ["engine", "adapterRevision", "v2"], ["engine", "modelRepository", "fixture/other"],
    ["engine", "modelRevision", "e".repeat(40)], ["engine", "cacheSha256", "f".repeat(64)],
  ]) {
    const changed = structuredClone(snapshot);
    changed[section][field] = value;
    invalid(() => validateAlignmentCompletion(changed, result), "alignment_stale");
  }
});

test("exact text, index, bounds and overlap state are bound to the request", () => {
  const snapshot = fixture();
  const result = completion(snapshot);
  for (const [field, value] of [["text", "Hello Maria 2026"], ["index", 4],
    ["startSeconds", 0], ["endSeconds", 9], ["overlappingSpeech", true]]) {
    const changed = structuredClone(snapshot);
    changed.passages[0][field] = value;
    invalid(() => validateAlignmentCompletion(changed, result), "alignment_stale");
  }
});

for (const text of ["Hello María 2026", "José habló español.", "go go go", "one 2 3.5",
  "Hello\nMaría\t2026", "", "   "]) {
  test(`preserves exact staff text and ordered coverage for ${JSON.stringify(text)}`, () => {
    const snapshot = fixture(text);
    const result = completion(snapshot);
    const before = structuredClone({ snapshot, result });
    const candidate = validateAlignmentCompletion(snapshot, result);
    assert.deepEqual(candidate.passages[0].words.map((word) => word.text),
      text.trim() ? text.trim().split(/\s+/u) : []);
    assert.deepEqual({ snapshot, result }, before);
    assert.equal(candidate.timingBasis, "viewing-copy-elapsed");
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.premiereReady, undefined);
    assert.equal(candidate.reviewed, undefined);
    assert.equal(candidate.speaker, undefined);
  });
}

test("no missing, duplicated, changed, inserted or reordered words", () => {
  for (const change of [
    (words) => words.pop(), (words) => words.push({ ...words[0] }),
    (words) => { words[1].text = "Maria"; },
    (words) => { [words[0], words[1]] = [words[1], words[0]]; },
  ]) {
    const snapshot = fixture(); const result = completion(snapshot);
    change(result.passages[0].words);
    invalid(() => validateAlignmentCompletion(snapshot, result));
  }
});

test("missing or uncertain alignment cannot create a timing candidate", () => {
  for (const state of [false, undefined, "true"]) {
    const snapshot = fixture(); const result = completion(snapshot);
    result.passages[0].words[0].aligned = state;
    invalid(() => validateAlignmentCompletion(snapshot, result), "alignment_unavailable");
  }
  for (const status of ["partial", "cancelled", "failed", "running"]) {
    const snapshot = fixture(); const result = { ...completion(snapshot), status };
    invalid(() => validateAlignmentCompletion(snapshot, result), "alignment_unavailable");
  }
});

test("overlapping speech is unavailable rather than silently exportable", () => {
  const snapshot = fixture(); snapshot.passages[0].overlappingSpeech = true;
  invalid(() => validateAlignmentCompletion(snapshot, completion(snapshot)), "alignment_unavailable");
});

test("nonfinite, negative, reversed, overlapping and out-of-passage word times fail", () => {
  for (const [index, field, value] of [[0, "startSeconds", NaN], [0, "endSeconds", Infinity],
    [0, "startSeconds", -1], [0, "endSeconds", 1], [0, "endSeconds", 9],
    [1, "startSeconds", 1.25], [0, "startSeconds", "1"], [0, "endSeconds", true]]) {
    const snapshot = fixture(); const result = completion(snapshot);
    result.passages[0].words[index][field] = value;
    invalid(() => validateAlignmentCompletion(snapshot, result));
  }
});

test("exact end-of-recording is valid but even a small overrun is rejected", () => {
  const snapshot = fixture("end"); snapshot.passages[0].endSeconds = 20;
  const result = completion(snapshot); result.passages[0].words[0].endSeconds = 20;
  validateAlignmentCompletion(snapshot, result);
  result.passages[0].words[0].endSeconds = 20.000001;
  invalid(() => validateAlignmentCompletion(snapshot, result));
});

test("rejects extra fields, missing/duplicate passages and malformed results", () => {
  for (const change of [
    (result) => { result.url = "https://private.invalid"; },
    (result) => { result.passages[0].speaker = "overwrite"; },
    (result) => { result.passages[0].words[0].reviewed = true; },
    (result) => result.passages.pop(),
    (result) => result.passages.push(structuredClone(result.passages[0])),
    (result) => { result.passages[0].index = 8; },
  ]) {
    const snapshot = fixture(); const result = completion(snapshot); change(result);
    invalid(() => validateAlignmentCompletion(snapshot, result));
  }
  for (const result of [null, [], "private", {}, { requestId: null }]) {
    invalid(() => validateAlignmentCompletion(fixture(), result));
  }
});

test("bounds request size, passage count, revisions and model pinning", () => {
  for (const change of [
    (s) => { s.transcript.editRevision = -1; },
    (s) => { s.transcript.editRevision = Number.MAX_SAFE_INTEGER; },
    (s) => { s.transcript.segmentsVersionId = ""; },
    (s) => { s.engine.modelRevision = "main"; },
    (s) => { s.engine.cacheSha256 = "unpinned"; },
    (s) => { s.source.objectVersionId = ""; },
    (s) => { s.source.url = "https://private.invalid"; },
    (s) => { s.input.durationSeconds = 7201; },
    (s) => { s.input.durationSeconds = 0; },
    (s) => { s.passages[0].endSeconds = 21; },
    (s) => { s.passages[0].text = "x".repeat(16001); },
    (s) => { s.passages[0].text = "bad\u0000private"; },
    (s) => { s.passages[0].overlappingSpeech = undefined; },
    (s) => { s.passages = []; },
    (s) => { s.passages = Array.from({ length: 101 }, (_, index) => ({ ...s.passages[0], index })); },
    (s) => { s.passages.push({ ...s.passages[0] }); },
    (s) => { s.passages = Array.from({ length: 100 }, (_, index) => ({ ...s.passages[0], index, text: "🎥".repeat(8000) })); },
  ]) {
    const snapshot = fixture(); change(snapshot);
    invalid(() => alignmentRequest(snapshot), "alignment_request_invalid");
  }
});
