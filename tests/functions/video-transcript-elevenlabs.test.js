import { test } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createHash } = require("node:crypto");
const adapter = require("../../functions/lib/video-transcript-elevenlabs");
const key = Buffer.from("synthetic-key-not-a-provider-key");
const settings = { languageCode: "en-US", maxSpeakers: 3 };
function input(bytes = Buffer.from("synthetic mp4")) {
  return { stream: Readable.from([bytes]), sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    versionId: "v1", expectedVersionId: "v1", durationSeconds: 1800, mimeType: "video/mp4" };
}
const word = (text, start, end, speaker_id = "speaker_0") => ({ text, start, end, speaker_id, type: "word", logprob: -0.25 });
function document() { return { text: "Hello there. Reply", words: [word("Hello", 0, 0.5), { text: " ", type: "spacing" },
  word("there.", 0.5, 1), word("Reply", 2, 3, "speaker_1")], transcription_id: "transcript-123" }; }
function response(value = document()) { return new Response(JSON.stringify(value), { status: 200 }); }
async function consume(body) { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks); }
const errorOutcome = (outcome) => (error) => error.outcome === outcome && error.automaticRetry === false && !error.message.includes("secret");

test("M4A multipart keeps audio bytes and original elapsed word times", async () => {
  const media = { ...input(Buffer.from("synthetic AAC in M4A")), mimeType: "audio/x-m4a" };
  const result = await adapter.transcribe(media, key, settings, { fetchFn: async (_url, request) => {
    const bytes = await consume(request.body);
    assert.equal(bytes.length, Number(request.headers["Content-Length"]));
    assert.ok(bytes.toString().includes('filename="input.m4a"\r\nContent-Type: audio/x-m4a'));
    return response();
  } });
  assert.equal(result.inputSha256, media.sha256);
  assert.equal(result.segments[1].startSeconds, 2);
  assert.equal(result.segments[1].endSeconds, 3);
});

test("fixed synchronous multipart request streams with exact content length and private metadata excluded", async () => {
  const media = input(); let calls = 0;
  const result = await adapter.transcribe(media, key, settings, { fetchFn: async (url, request) => {
    calls++; assert.equal(url, adapter.ENDPOINT); assert.equal(request.method, "POST"); assert.equal(request.redirect, "error");
    assert.equal(request.duplex, "half"); assert.equal(request.headers["xi-api-key"], key.toString());
    assert.ok(request.body instanceof Readable); const body = await consume(request.body);
    assert.equal(body.length, Number(request.headers["Content-Length"]));
    const text = body.toString();
    for (const [name, value] of Object.entries({ model_id: "scribe_v2", diarize: "true", webhook: "false", timestamps_granularity: "word", use_multi_channel: "false", tag_audio_events: "false", no_verbatim: "false", use_speaker_library: "false", detect_speaker_roles: "false", num_speakers: "3", language_code: "en" })) {
      assert.ok(text.includes(`name="${name}"\r\n\r\n${value}\r\n`));
    }
    assert.ok(text.includes('filename="video.mp4"')); assert.ok(!text.includes("source_url")); assert.ok(!text.includes("versionId"));
    return response();
  } });
  assert.equal(result.inputSha256, media.sha256);
  assert.equal(calls, 1); assert.equal(result.model, "scribe_v2"); assert.equal(result.transcriptionId, "transcript-123");
  assert.equal(result.segments[0].text, "Hello there."); assert.equal(result.segments[1].speaker, "spk_1");
  assert.equal(result.segments[0].words[0].confidence, Math.exp(-0.25)); assert.equal(media.stream.destroyed, true);
});

test("preflight rejects wrong version, size, URL, settings, keys and consumed streams without dispatch", async () => {
  let calls = 0; const fetchFn = async () => { calls++; };
  for (const change of [{ versionId: "v2" }, { sizeBytes: adapter.MAX_INPUT_BYTES + 1 }, { durationSeconds: 0 }, { durationSeconds: 7201 },
    { sha256: "wrong" }, { url: "https://evil.invalid" }, { mimeType: "audio/wav" }]) {
    await assert.rejects(adapter.transcribe({ ...input(), ...change }, key, settings, { fetchFn }), errorOutcome("pre_submission"));
  }
  await assert.rejects(adapter.transcribe(input(), Buffer.from("\r\nsecret"), settings, { fetchFn }), errorOutcome("pre_submission"));
  await assert.rejects(adapter.transcribe(input(), key, { ...settings, languageCode: "unknown" }, { fetchFn }), errorOutcome("pre_submission"));
  await assert.rejects(adapter.transcribe(input(), key, settings, { fetchFn, timeoutMs: Infinity }), errorOutcome("pre_submission"));
  const consumed = input(); consumed.stream.read();
  await assert.rejects(adapter.transcribe(consumed, key, settings, { fetchFn }), errorOutcome("pre_submission"));
  assert.equal(calls, 0);
});

test("single pass broadcast-size upload does not assemble the source in memory", async () => {
  const chunk = Buffer.alloc(65536, 7); const count = 864; const hash = createHash("sha256");
  for (let i = 0; i < count; i++) hash.update(chunk);
  let supplied = 0;
  const media = { ...input(), stream: Readable.from((async function* () { for (let i = 0; i < count; i++) { supplied++; yield chunk; } })()),
    sizeBytes: count * chunk.length, sha256: hash.digest("hex") };
  let sent = 0; let largest = 0;
  await adapter.transcribe(media, key, settings, { fetchFn: async (_url, request) => {
    assert.ok(supplied < count);
    for await (const bytes of request.body) { sent += bytes.length; largest = Math.max(largest, bytes.length); }
    assert.equal(sent, Number(request.headers["Content-Length"])); return response();
  } });
  assert.equal(supplied, count); assert.ok(largest <= 131072); assert.ok(media.sizeBytes > 54_000_000);
});

test("post-dispatch checksum, truncation, overflow and stream failure are uncertain and never retried", async () => {
  for (const variant of ["hash", "short", "long", "stream"]) {
    const media = input();
    if (variant === "hash") media.sha256 = "0".repeat(64);
    if (variant === "short") media.sizeBytes++;
    if (variant === "long") media.sizeBytes--;
    if (variant === "stream") media.stream = Readable.from((async function* () { yield Buffer.from("x"); throw new Error("secret source URL"); })());
    let calls = 0;
    await assert.rejects(adapter.transcribe(media, key, settings, { fetchFn: async (_url, request) => { calls++; await consume(request.body); return response(); } }), errorOutcome("needs_reconciliation"));
    assert.equal(calls, 1); assert.ok(media.stream.destroyed);
  }
});

test("every HTTP failure after dispatch stays uncertain, with no redirect or POST retry", async () => {
  for (const status of [301, 400, 401, 413, 422, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(adapter.transcribe(input(), key, settings, { fetchFn: async () => { calls++; return new Response("secret provider detail", { status }); } }), errorOutcome("needs_reconciliation"));
    assert.equal(calls, 1);
  }
});

test("deadline aborts a transport that ignores cancellation and destroys owned source", async () => {
  const media = input(); let request;
  await assert.rejects(adapter.transcribe(media, key, settings, { timeoutMs: 10, fetchFn: async (_url, value) => { request = value; return new Promise(() => {}); } }), errorOutcome("needs_reconciliation"));
  assert.ok(request.signal.aborted); assert.ok(media.stream.destroyed);
});

test("caller cancellation is distinct before dispatch and uncertain after dispatch", async () => {
  const before = new AbortController(); before.abort(); let calls = 0;
  await assert.rejects(adapter.transcribe(input(), key, settings, { signal: before.signal, fetchFn: async () => { calls++; } }), errorOutcome("pre_submission"));
  assert.equal(calls, 0);
  const after = new AbortController();
  await assert.rejects(adapter.transcribe(input(), key, settings, { signal: after.signal, fetchFn: async () => { calls++; after.abort(); return new Promise(() => {}); } }), errorOutcome("needs_reconciliation"));
  assert.equal(calls, 1);
});

test("success before verified upload, malformed response and wrong async shape cannot publish", async () => {
  for (const kind of ["early", "json", "async", "oversize"]) {
    await assert.rejects(adapter.transcribe(input(), key, settings, { fetchFn: async (_url, request) => {
      if (kind !== "early") await consume(request.body);
      if (kind === "json") return new Response("secret malformed json");
      if (kind === "async") return response({ request_id: "request", transcription_id: "transcript" });
      if (kind === "oversize") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(adapter.MAX_RESULT_BYTES + 1)); controller.close(); } }));
      return response();
    } }), errorOutcome("needs_reconciliation"));
  }
});

test("word validation rejects absent, unordered, out-of-source and impossible confidence evidence", () => {
  for (const change of [{ start: undefined }, { end: undefined }, { start: -1 }, { end: 1801 }, { start: 1, end: 0.5 },
    { logprob: 0.1 }, { logprob: NaN }, { text: "\u0000bad" }, { speaker_id: {} }, { type: "invented" }]) {
    assert.throws(() => adapter.normalizeResult({ text: "Hello", words: [{ ...word("Hello", 0, 1), ...change }] }, 1800), errorOutcome("needs_reconciliation"));
  }
  assert.throws(() => adapter.normalizeResult({ text: "x", words: [word("later", 2, 3), word("earlier", 1, 2)] }, 1800), errorOutcome("needs_reconciliation"));
  assert.throws(() => adapter.normalizeResult(document(), 0.5), errorOutcome("needs_reconciliation"));
});

test("zero-length provider words are kept and still pass storage validation", () => {
  const { validateSegments } = require("../../functions/lib/video-transcript-worker");
  // Shape from a real Scribe v2 response for an 18-minute interview (2026-10-28).
  const zero = (speaker) => word("...", 48.62, 48.62, speaker);
  for (const words of [[word("Well", 48.1, 48.62), zero("speaker_1"), word("yes", 48.7, 49)],
    [zero("speaker_1"), word("Well", 48.7, 49)], [word("Well", 48.1, 48.62), zero("speaker_0")]]) {
    const result = adapter.normalizeResult({ text: words.map((x) => x.text).join(" "), words }, 60);
    assert.ok(result.every((segment) => segment.endSeconds > segment.startSeconds));
    assert.equal(result.flatMap((segment) => segment.words).length, words.length);
    assert.doesNotThrow(() => validateSegments(result, { durationSeconds: 60, maxSpeakers: 10 }));
    const mixed = new Set(words.map((x) => x.speaker_id)).size > 1;
    assert.equal(result.some((segment) => segment.speakerUncertain === true), mixed);
  }
  assert.throws(() => adapter.normalizeResult({ text: "...", words: [zero("speaker_0")] }, 60), errorOutcome("needs_reconciliation"));
});

test("unknown speakers and events retain text without fabricated speech alignment", () => {
  const result = adapter.normalizeResult({ text: "Unclear (music)", words: [word("Unclear", 0, 1, null),
    { text: "(music)", start: 1, end: 2, type: "audio_event" }] }, 5);
  assert.equal(result[0].speaker, "unknown"); assert.equal(result[0].speakerUncertain, true);
  assert.equal(result[1].text, "(music)"); assert.equal(result[1].words, undefined);
  assert.equal(adapter.normalizeResult({ text: "", words: [] }, 5).length, 0);
});

test("long speech becomes bounded passages with every real word retained", () => {
  const words = Array.from({ length: 90 }, (_, i) => word("word", i, i + 0.8));
  const result = adapter.normalizeResult({ text: words.map(x => x.text).join(" "), words }, 100);
  assert.equal(result.length, 3); assert.equal(result.flatMap(x => x.words).length, 90);
  assert.ok(result.every(x => x.endSeconds - x.startSeconds <= 30));
  assert.ok(result.every(x => x.text === x.words.map(w => w.text).join(" ")));
});


test("full provider text cannot silently lose unaligned words", () => {
  assert.throws(() => adapter.normalizeResult({ text: "Hello missing", words: [word("Hello", 0, 1)] }, 5), errorOutcome("needs_reconciliation"));
  const tokens = [word("Hello", 0, 0.5), word("!", 0.5, 0.6)];
  assert.equal(adapter.normalizeResult({ text: "Hello!", words: tokens }, 5)[0].text, "Hello !");
});


test("missing expected checksum still returns the digest of the single verified upload", async () => {
  const media = input();
  const expectedDigest = media.sha256;
  delete media.sha256;
  let calls = 0;
  const result = await adapter.transcribe(media, key, settings, { fetchFn: async (_url, request) => {
    calls++;
    await consume(request.body);
    return response();
  } });
  assert.equal(result.inputSha256, expectedDigest);
  assert.equal(calls, 1);
  assert.ok(media.stream.destroyed);
});

test("provided checksum must be a lowercase SHA256 string before dispatch", async () => {
  let calls = 0;
  for (const sha256 of [null, "", 123, {}, "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    await assert.rejects(adapter.transcribe({ ...input(), sha256 }, key, settings,
      { fetchFn: async () => { calls++; } }), errorOutcome("pre_submission"));
  }
  assert.equal(calls, 0);
});
