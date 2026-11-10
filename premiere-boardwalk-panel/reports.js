"use strict";

const OPERATIONS = new Set(["auth.start", "auth.poll", "auth.restore", "auth.revoke", "library.list",
  "media.download", "media.import", "media.export", "markers.read", "markers.apply", "markers.save",
  "upload.start", "upload.part", "upload.complete", "upload.cancel", "cache", "ui", "report.submit"]);
const CODES = new Set(["network", "http", "invalid_response", "storage", "premiere", "unexpected"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 64 * 1024;

function utf8Bytes(text) {
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    count += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return count;
}

function expectedError(message) { return Object.assign(new Error(message), { expected: true }); }
function version(value) {
  const match = String(value || "").match(/^(?:uxp-)?(\d{1,4}(?:\.\d{1,4}){0,3})(?:-local)?$/);
  return match ? match[1] : "unknown";
}
function reportContext(value) {
  return { pluginVersion: version(value.pluginVersion), premiereVersion: version(value.premiereVersion),
    uxpVersion: version(value.uxpVersion), platform: ["win32", "darwin"].includes(value.platform) ? value.platform : "unknown",
    view: ["connection", "library", "detail", "return", "settings"].includes(value.view) ? value.view : "connection",
    ...(/^[0-9a-f]{40}$/.test(value.pluginRevision) ? { pluginRevision: value.pluginRevision } : {}) };
}

// Project only closed labels and bounded numbers. Never copy an Error or request body.
function safeEvent(value, now) {
  if (!value || !OPERATIONS.has(value.operation) || !["success", "failure", "canceled"].includes(value.outcome)) return null;
  const time = Date.parse(value.timestamp);
  if (!Number.isFinite(time) || time < now - DAY || time > now + 60000) return null;
  const event = { timestamp: new Date(time).toISOString(), operation: value.operation, outcome: value.outcome };
  if (Number.isInteger(value.status) && (value.status === 0 || value.status >= 100 && value.status <= 599)) event.status = value.status;
  if (Number.isInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= DAY) event.durationMs = value.durationMs;
  if (UUID.test(value.requestId)) event.requestId = value.requestId;
  if (value.outcome === "failure" && CODES.has(value.code)) event.code = value.code;
  return event;
}
function eligible(event) {
  return event.outcome === "failure" && event.operation !== "report.submit" &&
    !(event.status >= 400 && event.status < 500);
}

class Reports {
  constructor({ store, account, context, send, uuid = () => crypto.randomUUID(), now = Date.now }) {
    Object.assign(this, { store, account, context, send, uuid, now });
    this.uid = null;
    this.events = [];
    this.automatic = [];
    this.manual = null;
    this.generation = 0;
    this.writes = Promise.resolve();
    this.observed = new WeakSet();
    this.storageAvailable = true;
    this.nextAttempt = 0;
  }

  async setAccount(uid) {
    const generation = ++this.generation;
    this.uid = uid || null;
    this.events = []; this.automatic = []; this.manual = null; this.nextAttempt = 0;
    this.storageAvailable = true;
    if (!this.uid) return;
    try {
      await this.writes;
      const text = await this.store.read(uid);
      if (generation !== this.generation || !text || utf8Bytes(text) > MAX_BYTES) return;
      const data = JSON.parse(text);
      if (data.schema !== 1 || !Number.isFinite(data.savedAt) || data.savedAt < this.now() - DAY || data.savedAt > this.now() + 60000) return;
      this.events = (Array.isArray(data.events) ? data.events : []).slice(-100).map(event => safeEvent(event, this.now())).filter(Boolean);
      this.automatic = (Array.isArray(data.automatic) ? data.automatic : []).slice(0, 3).map(item => this.restorePayload(item, "automatic")).filter(Boolean);
      this.manual = this.restorePayload(data.manual, "manual");
      this.storageAvailable = true;
    } catch { if (generation === this.generation) this.storageAvailable = false; }
  }

  restorePayload(value, mode) {
    if (!value || value.mode !== mode || !UUID.test(value.clientRequestId) || !value.context || !Array.isArray(value.events) || value.events.length > 40) return null;
    if (value.events.some(event => !safeEvent(event, this.now()))) return null;
    if (mode === "automatic" && (!value.events.some(eligible) || value.description !== undefined)) return null;
    if (value.description !== undefined && (typeof value.description !== "string" || utf8Bytes(value.description) < 10 || utf8Bytes(value.description) > 2000)) return null;
    return { mode, clientRequestId: value.clientRequestId, context: reportContext(value.context),
      events: value.events.map(event => safeEvent(event, this.now())),
      ...(mode === "manual" && value.description ? { description: value.description } : {}) };
  }

  persist() {
    if (!this.uid) return Promise.resolve();
    const uid = this.uid;
    const generation = this.generation;
    this.events = this.events.filter(event => Date.parse(event.timestamp) >= this.now() - DAY).slice(-100);
    const text = JSON.stringify({ schema: 1, savedAt: this.now(), events: this.events, automatic: this.automatic, manual: this.manual });
    this.writes = this.writes.then(async () => {
      try {
        if (utf8Bytes(text) > MAX_BYTES) throw new Error("Diagnostic limit exceeded");
        await this.store.write(uid, text);
        if (generation === this.generation) this.storageAvailable = true;
      } catch { if (generation === this.generation) this.storageAvailable = false; }
    });
    return this.writes;
  }

  payload(mode, description) {
    return { mode, clientRequestId: this.uuid(), context: reportContext(this.context()),
      events: this.events.slice(-40), ...(description ? { description } : {}) };
  }

  record(value, uid = this.account(), error) {
    try {
      if (!uid || uid !== this.uid) return;
      if (error && typeof error === "object") {
        if (this.observed.has(error) || error.cause && this.observed.has(error.cause)) return;
        this.observed.add(error);
      }
      const event = safeEvent({ timestamp: new Date(this.now()).toISOString(), ...value }, this.now());
      if (!event) return;
      this.events.push(event);
      this.events = this.events.slice(-100);
      if (eligible(event) && this.automatic.length < 3) {
        const signature = item => `${item.operation}/${item.code || ""}/${item.status || 0}`;
        const alreadyQueued = this.automatic.some(item => signature([...item.events].reverse().find(eligible)) === signature(event));
        if (!alreadyQueued) this.automatic.push(this.payload("automatic"));
      }
      void this.persist();
      void this.flush();
    } catch { this.storageAvailable = false; }
  }

  async measure(operation, action) {
    const uid = this.account();
    const start = this.now();
    try {
      const result = await action();
      this.record({ operation, outcome: "success", durationMs: Math.min(DAY, this.now() - start) }, uid);
      return result;
    } catch (failure) {
      const error = failure && typeof failure === "object" ? failure : new Error("The action failed. Try again.");
      this.record({ operation, outcome: error.expected || error.name === "AbortError" ? "canceled" : "failure",
        code: error.diagnosticCode || (operation.startsWith("markers.") || operation === "media.import" ? "premiere" : "unexpected"),
        ...(Number.isInteger(error.status) ? { status: error.status } : {}), durationMs: Math.min(DAY, this.now() - start) }, uid, error);
      throw error;
    }
  }

  async flush() {
    if (this.sending || !this.uid || this.account() !== this.uid || this.now() < this.nextAttempt || !this.automatic.length) return;
    const generation = this.generation;
    const payload = this.automatic[0];
    this.sending = true;
    try {
      const result = await this.send(payload);
      if (!result?.success || result.mode !== "automatic" || result.accepted !== true) throw new Error("Invalid report receipt");
      if (generation === this.generation) this.automatic.shift();
    } catch (error) {
      if (generation === this.generation) {
        if (error.status >= 400 && error.status < 500 && ![401, 408, 429].includes(error.status)) this.automatic.shift();
        this.nextAttempt = this.now() + Math.max(30000, Math.min(15 * 60000, (error.retryAfter || 30) * 1000));
      }
    } finally {
      this.sending = false;
      if (generation === this.generation) await this.persist();
    }
  }

  async submitManual(description) {
    if (!this.uid || this.account() !== this.uid) throw expectedError("Connect Boardwalk before sending a report.");
    const generation = this.generation;
    if (!this.manual) {
      description = description.trim();
      if (description && utf8Bytes(description) < 10) throw expectedError("Add a short sentence about the problem, or leave the description empty.");
      if (utf8Bytes(description) > 2000) throw expectedError("Shorten the description before sending.");
      this.manual = this.payload("manual", description);
      await this.persist();
    }
    const payload = this.manual;
    if (generation !== this.generation || this.account() !== this.uid) throw expectedError("The account changed. Reopen the report for the current account.");
    try {
      const result = await this.send(payload);
      if (!result?.success || result.mode !== "manual" || !/^br_[0-9a-f]{32}$/.test(result.report?.id)) throw new Error("The report receipt was unreadable. Retry to check the same report.");
      if (generation === this.generation) { this.manual = null; await this.persist(); }
      if (generation !== this.generation) throw expectedError("The account changed while the report was being sent.");
      return result.report.id;
    } catch (error) {
      if (generation === this.generation && error.status >= 400 && error.status < 500 && ![401, 408, 409].includes(error.status)) {
        this.manual = null; await this.persist();
      }
      throw error;
    }
  }
}

module.exports = { Reports, safeEvent, reportContext, expectedError, utf8Bytes };
