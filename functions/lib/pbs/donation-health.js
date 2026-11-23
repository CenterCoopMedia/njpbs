"use strict";

const { corsHeaders, hardeningHeaders } = require("../http-headers");
const { classifyHttpStatus, classifyFetchError } = require("./schedule-proxy");

const DONATION_FORM = "https://www.pbs.org/donation/?station_id=63b643e1-1a13-4dd9-9bab-ff6f7527715f&campaign=passport";
const SUCCESS_MS = 60_000;
const FAILURE_MS = 10_000;

function createDonationHealthHandler({ fetchImpl = fetch, now = Date.now, timeoutMs = 1_500 } = {}) {
  let cached;
  let pending;

  async function probe() {
    try {
      const response = await fetchImpl(DONATION_FORM, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const status = classifyHttpStatus(response.status);
      if (status !== "ok") return status;
      return response.status === 200 &&
        response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/html"
        ? "reachable" : "error";
    } catch (error) {
      return classifyFetchError(error);
    }
  }

  return async (req, res) => {
    const origin = req.get("origin");
    const { headers, allowed } = corsHeaders({ requestOrigin: origin });
    for (const [name, value] of Object.entries({ ...hardeningHeaders(), ...headers })) {
      res.set(name, value);
    }
    res.set("Vary", "Origin, Sec-Fetch-Site");
    res.set("Cache-Control", "no-store");

    if (req.get("sec-fetch-site") === "cross-site" || (origin && !allowed)) {
      return res.status(403).end();
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return res.status(405).end();
    }
    if (!["/", "/donationHealth"].includes(req.originalUrl) || req.get("cookie") || req.get("authorization") ||
        req.get("transfer-encoding") || Number(req.get("content-length") || 0) !== 0) {
      return res.status(400).end();
    }

    // A burst of concurrent page requests shares one probe per instance.
    if (!cached || cached.expiresAt <= now()) {
      pending ??= probe().then(status => {
        cached = { status, expiresAt: now() + (status === "reachable" ? SUCCESS_MS : FAILURE_MS) };
      }).finally(() => { pending = undefined; });
      await pending;
    }
    return res.status(200).json({ status: cached.status });
  };
}

module.exports = { createDonationHealthHandler };
