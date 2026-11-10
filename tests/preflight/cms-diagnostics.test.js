import { describe, it, expect, vi } from "vitest";
import { diagnose, parseArguments, parseCredential, firestoreReads, FIELDS, queueSummary } from "../../scripts/cms-diagnostics.mjs";
const revision = "a".repeat(40);
const now = "2026-09-12T01:00:20.000Z";
const refreshAfter = "2026-09-13T01:00:00.000Z";
const start = "2026-09-12T01:00:00.000Z";
const id = "Ab" + "1".repeat(18);
const secret = "PRIVATE-TOKEN-user@example.org-https://example.org/?token=secret";
function fetcher(url) {
  let data = { ok: true, service: "njpbs-cms-api" };
  if (url.endsWith("admin-status.json")) data = { status: "current", refreshAfter, build: { revision, builtAt: start }, milestones: secret };
  if (url.endsWith("_publication.json")) data = { generation: 95, commitSha: revision, secret };
  return Promise.resolve(new Response(JSON.stringify(data)));
}
const options = { fetcher, readGit: async () => revision, checkedAt: now };
describe("CMS diagnostics", () => {
  it("rejects arbitrary URLs, credential paths, duplicate flags and malformed queue IDs", () => {
    for (const args of [["--url", "https://example.org"], ["--firebase", "key.json"], ["--firebase", "--firebase"], ["--queue-id", id], ["--firebase", "--queue-id", "../secret"]]) {
      expect(() => parseArguments(args)).toThrow("invalid_arguments");
    }
    expect(parseArguments(["--firebase", "--queue-id", id])).toEqual({ firebase: true, queueId: id });
  });
  it("accepts only NJ PBS credentials and strips arbitrary endpoints", () => {
    const credential = { type: "service_account", project_id: "njpbs-site", client_email: "diagnostic@njpbs-site.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nfixture", token_uri: "https://evil.invalid" };
    expect(Object.keys(parseCredential(JSON.stringify(credential), {}))).toEqual(["projectId", "clientEmail", "privateKey"]);
    expect(() => parseCredential(JSON.stringify({ ...credential, project_id: "other" }), {})).toThrow("invalid_credential");
    expect(() => parseCredential(JSON.stringify(credential), { FIRESTORE_EMULATOR_HOST: "localhost:8080" })).toThrow("emulator_not_allowed");
    expect(() => parseCredential(secret, {})).toThrow("invalid_credential");
  });
  it("uses fixed public URLs without redirects or credentials and emits only safe fields", async () => {
    const fetch = vi.fn(fetcher);
    const result = await diagnose({ ...options, fetcher: fetch });
    expect(result.ok).toBe(true);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://admin.njpbs.org/admin-status.json", "https://njpbs.org/_publication.json", "https://api.example.org/health"]);
    for (const [, settings] of fetch.mock.calls) expect(settings).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.checks.admin.data).toEqual({ status: "current", revision, builtAt: start, refreshAfter });
  });
  it("derives stale status at the manifest refresh deadline", async () => {
    for (const checkedAt of [refreshAfter, "2026-09-14T00:00:00.000Z"]) {
      const result = await diagnose({ ...options, checkedAt });
      expect(result.checks.admin.data.status).toBe("stale");
    }
    const result = await diagnose({ ...options, fetcher: async url => url.endsWith("admin-status.json")
      ? new Response(JSON.stringify({ status: "unavailable", refreshAfter, build: null })) : fetcher(url) });
    expect(result.checks.admin.data).toEqual({ status: "unavailable", refreshAfter, revision: null, builtAt: null });
  });
  it("requires a ready timestamp only for a ready renderer", async () => {
    for (const phase of ["paused", "starting", "ready"]) {
      const result = await diagnose({ ...options, reads: {
        runtime: async () => ({ phase, rendererSha: revision, serializerId: "cloudflare-preview" }),
        deployment: async () => ({ state: "idle", activeGeneration: 95 }), queue: async () => [],
      } });
      expect(result.checks.previewRuntime.ok).toBe(phase !== "ready");
      if (phase !== "ready") expect(result.checks.previewRuntime.data).toMatchObject({ phase, checkedAt: null });
    }
  });
  it("preserves successful checks when a required check fails and suppresses raw errors", async () => {
    const result = await diagnose({ ...options, readGit: async () => { throw new Error(secret); }, firebaseError: new Error(secret) });
    expect(result.ok).toBe(false);
    expect(result.checks.gitHead).toEqual({ ok: false, error: "unavailable" });
    expect(result.checks.api.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("computes queue timings without reading or printing private content", () => {
    const row = queueSummary(id, { status: "ready", rendererSha: revision, requestedAt: start, serializerClaim: { claimedAt: "2026-09-12T01:00:12.700Z", token: secret }, completedAt: "2026-09-12T01:00:20.500Z", snapshot: secret }, now);
    expect(row).toMatchObject({ acceptanceToClaimMs: 12700, claimToCompletionMs: 7800, totalMs: 20500, pendingAgeMs: null });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(queueSummary(id, { status: "pending", requestedAt: start }, now).pendingAgeMs).toBe(20000);
    expect(() => queueSummary(id, { status: secret, requestedAt: start }, now)).toThrow("invalid_data");
  });
  it("projects sanitized process attribution and leaves missing startup evidence absent", () => {
    const startup = { startupId: "11111111-1111-4111-8111-111111111111", processStartedAtMs: Date.parse(start),
      timingsMs: { "runtime-setup": 20, "runtime-ready": 10, token: secret }, token: secret };
    const base = { status: "failed", requestedAt: start };
    expect(queueSummary(id, { ...base, startup }, now).startup).toEqual({
      startupId: startup.startupId, processStartedAtMs: startup.processStartedAtMs,
      timingsMs: { "runtime-setup": 20, "runtime-ready": 10 },
    });
    for (const value of [undefined, {}, [], { ...startup, startupId: secret }, { ...startup, processStartedAtMs: Infinity }]) {
      expect(queueSummary(id, { ...base, startup: value }, now).startup).toBeNull();
    }
  });
  it("projects all Firestore reads and bounds the latest queue query to 20", async () => {
    const query = { orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), get: vi.fn().mockResolvedValue({ docs: [] }) };
    const db = { doc: vi.fn(path => path), getAll: vi.fn().mockResolvedValue([{ exists: true, id, data: () => ({}) }]), collection: vi.fn(() => query) };
    const reads = firestoreReads(db);
    await reads.runtime(); await reads.deployment(); await reads.queue();
    expect(db.getAll.mock.calls).toEqual([["system/cmsPreviewRuntime", { fieldMask: FIELDS.runtime }], ["system/publicDeployment", { fieldMask: FIELDS.deployment }]]);
    expect(query.orderBy).toHaveBeenCalledWith("requestedAt", "desc");
    expect(query.limit).toHaveBeenCalledWith(20);
    expect(query.select).toHaveBeenCalledWith("status", "rendererSha", "requestedAt", "serializerClaim.claimedAt", "completedAt", "timingsMs", "startup");
    await firestoreReads(db, id).queue();
    expect(db.getAll).toHaveBeenLastCalledWith(`cmsPreviewQueue/${id}`, { fieldMask: FIELDS.queue });
  });
  it("sanitizes projected data again and preserves partial Firestore results", async () => {
    const result = await diagnose({ ...options, reads: {
      runtime: async () => ({ phase: "ready", rendererSha: revision, serializerId: "cloudflare-preview", checkedAt: now, token: secret }),
      deployment: async () => { throw new Error(secret); },
      queue: async () => [{ id, data: { status: "pending", requestedAt: start, rendererSha: secret, snapshot: secret } }],
    } });
    expect(result.ok).toBe(false);
    expect(result.checks.previewRuntime.ok).toBe(true);
    expect(result.checks.previewQueue.data[0]).toMatchObject({ rendererSha: null, pendingAgeMs: 20000 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("reports only allowed bounded stage totals from runtime and queue projections", async () => {
    const dirty = { "node-startup": 31, "source-check": 0, render: 86_400_000, pack: 0.5, upload: -1,
      finish: 86_400_001, claim: Infinity, "queue-read": NaN, "input-read": "15", token: secret };
    const result = await diagnose({ ...options, reads: {
      runtime: async () => ({ phase: "ready", rendererSha: revision, serializerId: "cloudflare-preview", checkedAt: now, startupTimingsMs: dirty }),
      deployment: async () => ({ state: "idle", activeGeneration: 95 }),
      queue: async () => [{ id, data: { status: "ready", requestedAt: start, timingsMs: dirty } }],
    } });
    const clean = { "node-startup": 31, "source-check": 0, render: 86_400_000 };
    expect(result.checks.previewRuntime.data.startupTimingsMs).toEqual(clean);
    expect(result.checks.previewQueue.data[0].timingsMs).toEqual(clean);
    expect(FIELDS.runtime).toEqual(["phase", "rendererSha", "serializerId", "checkedAt", "startupTimingsMs"]);
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const invalid of [null, [], "secret", 42]) {
      expect(queueSummary(id, { status: "ready", requestedAt: start, timingsMs: invalid }, now).timingsMs).toEqual({});
    }
  });
  it("times out unavailable checks and retains the completed API check", async () => {
    vi.useFakeTimers();
    try {
      const pending = diagnose({ ...options, readGit: () => new Promise(() => {}) });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.checks.gitHead.error).toBe("timeout");
      expect(result.checks.api.ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("rejects oversized or malformed responses without leaking bodies", async () => {
    const result = await diagnose({ ...options, fetcher: async () => new Response(secret.repeat(5000)) });
    expect(result.ok).toBe(false);
    expect(result.checks.admin.error).toBe("invalid_data");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
