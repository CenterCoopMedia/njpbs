"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { Readable } = require("node:stream");
const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const MODEL = "scribe_v2";
const MAX_INPUT_BYTES = 2_000_000_000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_DURATION_SECONDS = 7200;
const TIMEOUT_MS = 600_000;
const LANGUAGE = { "en-US": "en", "es-US": "es" };

class AdapterError extends Error {
  constructor(code, outcome) {
    super(code);
    this.code = code;
    this.outcome = outcome;
    this.automaticRetry = false;
  }
}
const invalid = () => new AdapterError("elevenlabs_result_invalid", "needs_reconciliation");
const uncertain = () => new AdapterError("elevenlabs_submission_uncertain", "needs_reconciliation");
function safeText(text) {
  return typeof text === "string" && ![...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
function validateInput(input, key, settings, options) {
  const fields = ["stream", "sizeBytes", "versionId", "expectedVersionId", "sha256", "durationSeconds", "mimeType"];
  if (!input || Object.keys(input).some((name) => !fields.includes(name)) ||
      !(input.stream instanceof Readable) || input.stream.destroyed || input.stream.readableDidRead ||
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_INPUT_BYTES ||
      !["video/mp4", "audio/x-m4a"].includes(input.mimeType) || typeof input.versionId !== "string" || !input.versionId || input.versionId.length > 1024 ||
      input.versionId !== input.expectedVersionId ||
      (input.sha256 !== undefined && (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))) ||
      !Number.isFinite(input.durationSeconds) || input.durationSeconds < 0.1 || input.durationSeconds > MAX_DURATION_SECONDS) {
    throw new AdapterError("elevenlabs_input_invalid", "pre_submission");
  }
  if (!Buffer.isBuffer(key) || key.length < 16 || key.length > 4096 || key.some((byte) => byte < 33 || byte > 126)) {
    throw new AdapterError("elevenlabs_key_invalid", "pre_submission");
  }
  if (!settings || Object.keys(settings).some((name) => !["languageCode", "maxSpeakers"].includes(name)) ||
      !Object.hasOwn(LANGUAGE, settings.languageCode) || !Number.isInteger(settings.maxSpeakers) ||
      settings.maxSpeakers < 2 || settings.maxSpeakers > 10 || typeof options.fetchFn !== "function" ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > TIMEOUT_MS) {
    throw new AdapterError("elevenlabs_settings_invalid", "pre_submission");
  }
}

function normalizeResult(document, durationSeconds, maxSpeakers = 10) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0.1 || durationSeconds > MAX_DURATION_SECONDS ||
      !Number.isInteger(maxSpeakers) || maxSpeakers < 2 || maxSpeakers > 10 || !document ||
      typeof document.text !== "string" || !Array.isArray(document.words) || document.words.length > 200_000 ||
      document.transcripts !== undefined || document.request_id !== undefined) throw invalid();
  const speakers = new Map();
  const segments = [];
  let previous = -1;
  let passage;
  for (const token of document.words) {
    if (!token || !["word", "spacing", "audio_event"].includes(token.type) || typeof token.text !== "string") throw invalid();
    if (token.type === "spacing") {
      if (!/^\s*$/.test(token.text)) throw invalid();
      continue;
    }
    if (!safeText(token.text) || !token.text.trim() || token.text.length > 500 ||
        !Number.isFinite(token.start) || !Number.isFinite(token.end) || token.start < previous ||
        token.start < 0 || token.end < token.start || token.end > durationSeconds || token.end - token.start > 30 ||
        (token.logprob !== undefined && (!Number.isFinite(token.logprob) || token.logprob > 0)) ||
        (token.speaker_id != null && (typeof token.speaker_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(token.speaker_id)))) throw invalid();
    // Scribe returns some real words, such as "...", with end equal to start.
    previous = token.start;
    if (token.speaker_id != null && !speakers.has(token.speaker_id)) {
      if (speakers.size >= maxSpeakers) throw invalid();
      speakers.set(token.speaker_id, `spk_${speakers.size}`);
    }
    const speaker = speakers.get(token.speaker_id) ?? "unknown";
    const text = token.text.trim();
    if (token.type === "audio_event") {
      // Keep provider event text, but never invent spoken-word alignment for it.
      segments.push({ startSeconds: token.start, endSeconds: token.end, text, speaker: "unknown", speakerUncertain: true });
      passage = undefined;
      continue;
    }
    const word = { startSeconds: token.start, endSeconds: token.end, text,
      ...(token.logprob === undefined ? {} : { confidence: Math.exp(token.logprob) }) };
    const newPassage = !passage || passage.speaker !== speaker || token.end - passage.startSeconds > 30 ||
      passage.text.length + text.length + 1 > 500 ||
      (passage.endSeconds - passage.startSeconds >= 15 && /[.!?]["')]*$/.test(passage.text));
    if (newPassage) {
      passage = { startSeconds: token.start, endSeconds: token.end, text, speaker, words: [word],
        ...(speaker === "unknown" ? { speakerUncertain: true } : {}) };
      segments.push(passage);
    } else {
      passage.text += " " + text;
      passage.endSeconds = Math.max(passage.endSeconds, token.end);
      passage.words.push(word);
    }
  }
  // Storage needs each passage to have length. Fold a zero-length passage into a
  // neighbour; its words keep their provider timing.
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const empty = segments[index];
    if (empty.endSeconds > empty.startSeconds) continue;
    const before = segments[index - 1];
    const after = segments[index + 1];
    if (before?.words) {
      before.text += " " + empty.text;
      before.endSeconds = Math.max(before.endSeconds, empty.endSeconds);
      before.words.push(...(empty.words ?? []));
    } else if (after?.words) {
      after.text = empty.text + " " + after.text;
      after.startSeconds = empty.startSeconds;
      after.words.unshift(...(empty.words ?? []));
    } else throw invalid();
    const kept = before?.words ? before : after;
    // The kept passage now holds another speaker's word, so do not claim one speaker.
    if (empty.speaker !== kept.speaker || empty.speakerUncertain) kept.speakerUncertain = true;
    segments.splice(index, 1);
  }
  const normalizedText = (text) => text.replace(/\s+/g, "");
  if (normalizedText(document.words.map((token) => token.text).join("")) !== normalizedText(document.text) ||
      segments.length > 50_000 || Buffer.byteLength(JSON.stringify(segments)) > MAX_RESULT_BYTES) throw invalid();
  if (!segments.length && document.text.trim()) throw invalid();
  return segments;
}

function multipart(input, settings, signal) {
  const boundary = "boardwalk-" + randomBytes(24).toString("hex");
  const fields = { model_id: MODEL, language_code: LANGUAGE[settings.languageCode], num_speakers: String(settings.maxSpeakers),
    diarize: "true", timestamps_granularity: "word", tag_audio_events: "false", webhook: "false", use_multi_channel: "false", file_format: "other",
    no_verbatim: "false", use_speaker_library: "false", detect_speaker_roles: "false" };
  const parts = Object.entries(fields).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const filename = input.mimeType === "audio/x-m4a" ? "input.m4a" : "video.mp4";
  const prefix = Buffer.from(parts.join("") + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const state = { verified: false, inputSha256: null };
  async function* chunks() {
    let count = 0;
    const hash = createHash("sha256");
    yield prefix;
    for await (const chunk of input.stream) {
      if (signal.aborted || !(chunk instanceof Uint8Array)) throw uncertain();
      count += chunk.byteLength;
      if (count > input.sizeBytes) throw uncertain();
      hash.update(chunk);
      // Do not make a second whole-file copy, even for a large upstream chunk.
      for (let offset = 0; offset < chunk.byteLength; offset += 65536) {
        if (signal.aborted) throw uncertain();
        yield chunk.subarray(offset, offset + 65536);
      }
    }
    const inputSha256 = hash.digest("hex");
    if (signal.aborted || count !== input.sizeBytes ||
        (input.sha256 !== undefined && inputSha256 !== input.sha256)) throw uncertain();
    state.inputSha256 = inputSha256;
    state.verified = true;
    yield suffix;
  }
  return { body: Readable.from(chunks(), { objectMode: false, highWaterMark: 65536 }), state,
    contentType: `multipart/form-data; boundary=${boundary}`, contentLength: prefix.length + input.sizeBytes + suffix.length };
}

async function readResult(response) {
  if (!response.body?.getReader) throw invalid();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESULT_BYTES) throw invalid();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    // Cancellation must not extend the submission deadline on a broken transport.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Candidate only: no default transport. Caller persists intent BEFORE this call,
 * rechecks source/credential/billing authority, and owns the version-pinned S3 read
 * with expected-owner and content-length verification. An expected SHA is optional;
 * the computed digest records uploaded bytes and does not independently prove origin.
 * stream is transferred to this function after preflight succeeds; key stays caller-owned.
 * Caller zeroes its key Buffer. Header strings cannot be zeroed. Provider logging
 * follows the account default; this does not promise zero retention.
 */
async function transcribe(input, key, settings, options = {}) {
  const { fetchFn, timeoutMs = TIMEOUT_MS, signal } = options;
  validateInput(input, key, settings, { fetchFn, timeoutMs });
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new AdapterError("elevenlabs_signal_invalid", "pre_submission");
  if (signal?.aborted) throw new AdapterError("elevenlabs_cancelled", "pre_submission");
  const controller = new AbortController();
  const upload = multipart(input, settings, controller.signal);
  let timer;
  let rejectDeadline;
  const stop = () => { controller.abort(); upload.body.destroy(); input.stream.destroy(); rejectDeadline(uncertain()); };
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; timer = setTimeout(stop, timeoutMs); });
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const submit = async () => {
      const response = await fetchFn(ENDPOINT, { method: "POST", redirect: "error", duplex: "half", signal: controller.signal,
        headers: { "xi-api-key": key.toString("ascii"), "Content-Type": upload.contentType, "Content-Length": String(upload.contentLength) }, body: upload.body });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw uncertain();
      }
      const document = await readResult(response);
      if (!upload.state.verified || controller.signal.aborted) throw uncertain();
      return { segments: normalizeResult(document, input.durationSeconds, settings.maxSpeakers), model: MODEL,
        inputSha256: upload.state.inputSha256,
        ...(typeof document.transcription_id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(document.transcription_id)
          ? { transcriptionId: document.transcription_id } : {}) };
    };
    return await Promise.race([submit(), deadline]);
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw uncertain();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    controller.abort();
    upload.body.destroy();
    input.stream.destroy();
  }
}
module.exports = { MODEL, ENDPOINT, MAX_INPUT_BYTES, MAX_RESULT_BYTES, MAX_DURATION_SECONDS, TIMEOUT_MS, normalizeResult, transcribe };
