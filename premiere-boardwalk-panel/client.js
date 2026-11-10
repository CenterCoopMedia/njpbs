"use strict";

const config = require("./config.js");
const API_ORIGIN = config.apiOrigin;

class BoardwalkClient {
  constructor(storage, fetcher = (...args) => fetch(...args), origin = API_ORIGIN) {
    this.storage = storage;
    this.fetcher = fetcher;
    this.origin = origin;
    this.session = null;
  }

  async restore() {
    try {
      const bytes = await this.storage.getItem("boardwalk-session");
      this.session = JSON.parse(String.fromCharCode(...bytes));
    } catch {
      this.session = null;
    }
    if (this.session && (!/^pds_[A-Za-z0-9_-]{43}$/.test(this.session.sessionToken) ||
        typeof this.session.user?.uid !== "string" || !this.session.user.uid ||
        typeof this.session.user?.displayName !== "string" ||
        !Number.isFinite(Date.parse(this.session.expiresAt)) || Date.parse(this.session.expiresAt) <= Date.now())) {
      await this.forget();
    }
    return this.session;
  }

  async remember(session) {
    // Encode only ASCII JSON: UXP does not supply TextDecoder.
    const text = JSON.stringify(session).replace(/[\u007f-\uffff]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    await this.storage.setItem("boardwalk-session", text);
    this.session = session;
  }

  async forget() {
    this.session = null;
    await this.storage.removeItem("boardwalk-session");
  }

  async post(endpoint, body, { authenticated = false, signal } = {}) {
    if (authenticated && !this.session) throw new Error("Connect your Boardwalk account first.");
    const sessionToken = this.session?.sessionToken;
    const uid = this.session?.user?.uid;
    const start = Date.now();
    const headers = { "Content-Type": "application/json" };
    if (config.local) {
      headers["X-NJPBS-CMS-Edge"] = "local-cms-edge-only";
      // The emulator bypasses the edge that assigns this ID in production.
      headers["X-NJPBS-Request-ID"] = crypto.randomUUID();
    }
    if (authenticated) headers.Authorization = `Bearer ${sessionToken}`;
    let response;
    let failure;
    try {
      response = await this.fetcher(`${this.origin}/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}),
      });
      let result;
      try {
        result = await response.json();
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid response");
      } catch {
        throw Object.assign(new Error(`Boardwalk returned an unreadable response (${response.status}). Try again.`),
          { status: response.status, diagnosticCode: "invalid_response" });
      }
      if (!response.ok) {
        if (response.status === 401 && authenticated && this.session?.sessionToken === sessionToken) await this.forget();
        const error = new Error(result.error || `Boardwalk request failed (${response.status}).`);
        error.status = response.status;
        error.diagnosticCode = "http";
        error.retryAfter = Number(response.headers.get("retry-after")) || 5;
        throw error;
      }
      return result;
    } catch (error) { failure = error; throw error; }
    finally {
      try {
        this.onResult?.({ endpoint, operation: body.operation, uid, error: failure,
          posterRead: body.operation === "cmsCreateSourceMediaRead" && body.payload?.action === "poster",
          outcome: signal?.aborted || failure?.name === "AbortError" ? "canceled" : failure ? "failure" : "success",
          status: response?.status || 0, durationMs: Math.min(86400000, Date.now() - start),
          requestId: response?.headers?.get("x-njpbs-request-id") || headers["X-NJPBS-Request-ID"],
          code: failure?.diagnosticCode || "network" });
      } catch { /* Diagnostics cannot change a media request's result. */ }
    }
  }

  request(operation, payload = {}, signal) {
    return this.post("cmsPremiereRequest", { operation, payload }, { authenticated: true, signal });
  }

  async signOut() {
    // Keep the credential if revocation fails so the editor can retry.
    if (this.session) await this.post("cmsRevokePremiereSession", {}, { authenticated: true });
    await this.forget();
  }
}

module.exports = { BoardwalkClient, API_ORIGIN };
