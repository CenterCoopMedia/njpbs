#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import timingsModule from "../functions/lib/preview-timings.js";
const { previewTimings, previewStartup } = timingsModule;

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const QUEUE_ID = /^[a-zA-Z0-9]{20}$/;
export const FIELDS = Object.freeze({
  runtime: ["phase", "rendererSha", "serializerId", "checkedAt", "startupTimingsMs"],
  deployment: ["state", "activeGeneration", "activeCommitSha", "updatedAt"],
  queue: ["status", "rendererSha", "requestedAt", "serializerClaim.claimedAt", "completedAt", "timingsMs", "startup"],
});
const URLS = {
  admin: "https://admin.njpbs.org/admin-status.json",
  publication: "https://njpbs.org/_publication.json",
  api: "https://api.example.org/health",
};
function fail(code) { throw new Error(code); }
function required(value) { if (value === null || value === undefined) fail("invalid_data"); return value; }
function sha(value) { return typeof value === "string" && SHA.test(value) ? value : null; }
function choice(value, allowed) { return allowed.includes(value) ? value : null; }
function timestamp(value) {
  const millis = typeof value?.toMillis === "function" ? value.toMillis() :
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : null;
}
function elapsed(start, end) {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return ms >= 0 ? ms : null;
}
export function parseArguments(args) {
  const options = { firebase: false, queueId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--firebase" && !options.firebase) options.firebase = true;
    else if (args[i] === "--queue-id" && !options.queueId && QUEUE_ID.test(args[i + 1] ?? "")) options.queueId = args[++i];
    else fail("invalid_arguments");
  }
  if (options.queueId && !options.firebase) fail("invalid_arguments");
  return options;
}
export function parseCredential(input, env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST) fail("emulator_not_allowed");
  if (Buffer.byteLength(input) > MAX_BYTES) fail("invalid_credential");
  let value;
  try { value = JSON.parse(input); } catch { fail("invalid_credential"); }
  if (value?.type !== "service_account" || value.project_id !== "njpbs-site" ||
      !/^[a-zA-Z0-9-]+@njpbs-site\.iam\.gserviceaccount\.com$/.test(value.client_email ?? "") ||
      typeof value.private_key !== "string" || !value.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) fail("invalid_credential");
  // Discard caller-supplied endpoints and all unrelated credential fields.
  return { projectId: "njpbs-site", clientEmail: value.client_email, privateKey: value.private_key };
}
async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}
async function fetchJson(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", credentials: "omit" });
  if (!response.ok) fail("http_error");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) fail("invalid_data");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}
export function queueSummary(id, data, checkedAt) {
  const requestedAt = required(timestamp(data.requestedAt));
  const claimedAt = timestamp(data.serializerClaim?.claimedAt);
  const completedAt = timestamp(data.completedAt);
  const status = required(choice(data.status, ["pending", "building", "ready", "failed", "expired", "cancelled"]));
  return {
    queueId: required(QUEUE_ID.test(id) ? id : null), status,
    timingsMs: previewTimings(data.timingsMs),
    startup: previewStartup(data.startup),
    rendererSha: sha(data.rendererSha), requestedAt, claimedAt, completedAt,
    acceptanceToClaimMs: elapsed(requestedAt, claimedAt),
    claimToCompletionMs: elapsed(claimedAt, completedAt),
    totalMs: elapsed(requestedAt, completedAt),
    pendingAgeMs: status === "pending" ? elapsed(requestedAt, checkedAt) : null,
  };
}
export function firestoreReads(db, queueId) {
  if (queueId !== undefined && queueId !== null && !QUEUE_ID.test(queueId)) fail("invalid_arguments");
  return {
    runtime: async () => {
      const [row] = await db.getAll(db.doc("system/cmsPreviewRuntime"), { fieldMask: FIELDS.runtime });
      if (!row.exists) fail("not_found");
      return row.data();
    },
    deployment: async () => {
      const [row] = await db.getAll(db.doc("system/publicDeployment"), { fieldMask: FIELDS.deployment });
      if (!row.exists) fail("not_found");
      return row.data();
    },
    queue: async () => {
      if (queueId) {
        const [row] = await db.getAll(db.doc(`cmsPreviewQueue/${queueId}`), { fieldMask: FIELDS.queue });
        if (!row.exists) fail("not_found");
        return [{ id: row.id, data: row.data() }];
      }
      const result = await db.collection("cmsPreviewQueue").orderBy("requestedAt", "desc").limit(20).select(...FIELDS.queue).get();
      return result.docs.map(row => ({ id: row.id, data: row.data() }));
    },
  };
}
const SAFE_CODES = new Set(["invalid_arguments", "invalid_credential", "emulator_not_allowed", "invalid_data", "not_found", "http_error", "timeout"]);
function safeCode(error) { return SAFE_CODES.has(error?.message) ? error.message : "unavailable"; }
async function gitRevision(ref) {
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "--verify", ref], { timeout: TIMEOUT_MS, maxBuffer: 1024 });
  return required(sha(stdout.trim()));
}
export async function diagnose({ fetcher = fetch, readGit = gitRevision, reads, firebaseError, checkedAt = new Date().toISOString() } = {}) {
  const report = { checkedAt, ok: true, checks: {} };
  async function check(name, operation) {
    try { report.checks[name] = { ok: true, data: await bounded(operation) }; }
    catch (error) { report.ok = false; report.checks[name] = { ok: false, error: safeCode(error) }; }
  }
  await Promise.all([
    check("gitHead", async () => required(sha(await readGit("HEAD")))),
    check("gitOriginMain", async () => required(sha(await readGit("refs/remotes/origin/main")))),
    check("admin", async () => {
      const data = await fetchJson(URLS.admin, fetcher);
      const status = required(choice(data.status, ["current", "unavailable"]));
      const refreshAfter = required(timestamp(data.refreshAfter));
      const stale = status === "current" && Date.parse(checkedAt) >= Date.parse(refreshAfter);
      return { status: stale ? "stale" : status,
        refreshAfter,
        revision: status === "unavailable" ? null : required(sha(data.build?.revision)),
        builtAt: status === "unavailable" ? null : required(timestamp(data.build?.builtAt)) };
    }),
    check("publication", async () => {
      const data = await fetchJson(URLS.publication, fetcher);
      return { generation: required(Number.isSafeInteger(data.generation) && data.generation >= 1 ? data.generation : null), commitSha: required(sha(data.commitSha)) };
    }),
    check("api", async () => {
      const data = await fetchJson(URLS.api, fetcher);
      if (data.ok !== true || data.service !== "njpbs-cms-api") fail("invalid_data");
      return { ok: true, service: "njpbs-cms-api" };
    }),
  ]);
  if (firebaseError) await check("firebase", () => { throw firebaseError; });
  if (reads) await Promise.all([
    check("previewRuntime", async () => {
      const data = await reads.runtime();
      const phase = required(choice(data.phase, ["ready", "starting", "paused"]));
      const checkedAt = timestamp(data.checkedAt);
      return { phase, rendererSha: required(sha(data.rendererSha)),
        serializerId: required(choice(data.serializerId, ["cloudflare-preview"])),
        checkedAt: phase === "ready" ? required(checkedAt) : checkedAt,
        startupTimingsMs: previewTimings(data.startupTimingsMs) };
    }),
    check("publicDeployment", async () => {
      const data = await reads.deployment();
      return { state: required(choice(data.state, ["idle", "deploying", "reconciling"])),
        activeGeneration: required(Number.isSafeInteger(data.activeGeneration) && data.activeGeneration >= 0 ? data.activeGeneration : null),
        activeCommitSha: sha(data.activeCommitSha), updatedAt: timestamp(data.updatedAt) };
    }),
    check("previewQueue", async () => {
      const rows = await reads.queue();
      if (!Array.isArray(rows) || rows.length > 20) fail("invalid_data");
      return rows.map(row => queueSummary(row.id, row.data, checkedAt));
    }),
  ]);
  return report;
}
async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_BYTES) fail("invalid_credential");
  }
  return input;
}
async function main() {
  let app;
  let reads;
  let firebaseError;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.firebase) {
      try {
        const credential = parseCredential(await bounded(readStdin));
        const { initializeApp, cert } = await import("firebase-admin/app");
        const { getFirestore } = await import("firebase-admin/firestore");
        app = initializeApp({ credential: cert(credential), projectId: "njpbs-site" }, "cms-diagnostics");
        reads = firestoreReads(getFirestore(app), options.queueId);
      } catch (error) { firebaseError = error; }
    }
    const report = await diagnose({ reads, firebaseError });
    await new Promise(resolve => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, resolve));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    await new Promise(resolve => process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), ok: false, checks: { arguments: { ok: false, error: safeCode(error) } } })}\n`, resolve));
    process.exitCode = 1;
  } finally {
    if (app) {
      const { deleteApp } = await import("firebase-admin/app");
      await bounded(() => deleteApp(app)).catch(() => {});
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  // Timed-out read-only SDK calls must not keep this one-shot command running.
  process.exit(process.exitCode ?? 0);
}
