import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createRoutingMeasurementWorker } from "../workers/src/public-release-routing-measurement-worker";
import { releasePair, releaseSelector } from "./helpers/private-public-release-pair.js";
import { parseSample, summarize } from "../scripts/measure-public-release-routing.mjs";
import type { SlotReply } from "../workers/src/public-release-router";

const measurementId = "f13d7b1e-9f3a-4e7e-b6b9-c909b7f0d363";
const versionId = "563ced1e-78dd-4717-b9f9-d8fc3e290489";
const secret = "test-only-credential-never-a-real-token";
const slotBody = "fixture-only actual-slot-body";
function fixture() {
  const read = vi.fn(async (_id: string, _budgetMs: number) => ({ environment: "development" as const, selector: releaseSelector(), readStartedAt: Date.now() }));
  const serve = vi.fn(async (request: Request, _selection?: { readStartedAt: number }): Promise<SlotReply> => {
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.headers.has("cookie")).toBe(false);
    return { kind: "response" as const, response: new Response(slotBody, { headers: { "set-cookie": "must-not-return=1" } }) };
  });
  const env = { PUBLIC_RELEASE_ROUTING_EXPERIMENT_ENABLED: "true", FBASE_PROJECT: "njpbs-site-dev", MEASUREMENT_ID: measurementId,
    MEASUREMENT_SECRET: secret, MEASUREMENT_CASES_JSON: JSON.stringify([{ id: "home", path: "/", status: 200,
      bytes: Buffer.byteLength(slotBody), bodyDigest: createHash("sha256").update(slotBody).digest("hex") }]),
    PUBLIC_PAIR_IDENTITIES_JSON: JSON.stringify([releasePair(), releasePair("b", "b".repeat(40))]),
    CF_VERSION_METADATA: { id: versionId }, CMS_API: { getRoutingMeasurementSelector: read },
    PAIR_SLOT_OLD: { serve }, PAIR_SLOT_NEW: { serve } };
  return { env, read, serve, worker: createRoutingMeasurementWorker() };
}
function request(body: unknown = { caseId: "home", routerFirst: false }, url = "https://njpbs-dev-routing-measurement.example.workers.dev/sample") {
  const value = new Request(url, { method: "POST", headers: { authorization: `Bearer ${secret}`, cookie: "private=never-forward", "content-type": "application/json" }, body: JSON.stringify(body) });
  Object.defineProperty(value, "cf", { value: { colo: "EWR" } });
  return value;
}

describe("private development routing measurement", () => {
  it("has no disabled-path binding access or reader IO", async () => {
    const env = { PUBLIC_RELEASE_ROUTING_EXPERIMENT_ENABLED: "false", get CMS_API(): never { throw new Error("must not touch"); } };
    expect((await createRoutingMeasurementWorker().fetch(request(), env)).status).toBe(404);
  });
  it.each(["missing", "same-length-wrong", "short", "oversize"])("refuses %s credentials before binding access", async kind => {
    const { env, read, worker } = fixture(), input = request();
    if (kind === "missing") input.headers.delete("authorization");
    if (kind === "same-length-wrong") input.headers.set("authorization", `Bearer ${"x".repeat(secret.length)}`);
    if (kind === "short") input.headers.set("authorization", "Bearer wrong");
    if (kind === "oversize") input.headers.set("authorization", "x".repeat(2049));
    Object.defineProperty(env, "CMS_API", { get(): never { throw new Error("must not touch"); } });
    expect((await worker.fetch(input, env)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["production-project", "missing-version", "missing-slot", "bad-id", "production-pair", "unsafe-case", "large-case"])("refuses %s before any source read", async kind => {
    const { env, read, worker } = fixture();
    if (kind === "production-project") env.FBASE_PROJECT = "njpbs-site";
    if (kind === "missing-version") env.CF_VERSION_METADATA.id = "";
    if (kind === "missing-slot") env.PAIR_SLOT_NEW = undefined as never;
    if (kind === "bad-id") env.MEASUREMENT_ID = "shared";
    if (kind === "production-pair") env.PUBLIC_PAIR_IDENTITIES_JSON = JSON.stringify([{ ...releasePair(), environment: "production" }, releasePair("b", "b".repeat(40))]);
    if (kind === "unsafe-case") env.MEASUREMENT_CASES_JSON = JSON.stringify(JSON.parse(env.MEASUREMENT_CASES_JSON).map((value: object) => ({ ...value, path: "//njpbs.org/" })));
    if (kind === "large-case") env.MEASUREMENT_CASES_JSON = JSON.stringify(JSON.parse(env.MEASUREMENT_CASES_JSON).map((value: object) => ({ ...value, bytes: 4 * 1024 * 1024 + 1 })));
    expect((await worker.fetch(request(), env)).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["https://njpbs.org/sample", "https://njpbs-dev-routing-measurement.example.workers.dev/sample?token=x"])("refuses target %s", async url => {
    const { env, read, worker } = fixture();
    expect((await worker.fetch(request(undefined, url), env)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
  it("uses the actual router, counts a single isolate and refresh, and returns only paired metrics", async () => {
    const { env, read, serve, worker } = fixture();
    const first = await worker.fetch(request(), env), raw = await first.text();
    expect(first.status).toBe(200);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("fixture-only actual-slot-body");
    expect(raw).not.toContain("set-cookie");
    const parsed = parseSample(JSON.parse(raw), { measurementId, versionId, caseId: "home" });
    expect(parsed.cold).toBe(true);
    const second = parseSample(await (await worker.fetch(request(), env)).json(), { measurementId, versionId, caseId: "home" });
    expect(second.cold).toBe(false);
    expect(second.observations[0].lane).toBe("slot-direct");
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every(args => args[0] === measurementId && args[1] === 3000)).toBe(true);
    expect(serve).toHaveBeenCalledTimes(4);
    const summary = summarize([parsed, second]);
    expect(summary.observedIsolates).toBe(1);
    expect(summary.totals["isolate-start"]).toBe(1);
    expect(summary.totals["cache-hit"]).toBe(1);
    expect(summary.selectorRefreshMs.n).toBe(1);
    expect(summary.cacheHitRate).toBe(.5);
    expect(summary.newInstancesObserved).toBe(1);
    expect(summary.controlReaderCalls).toBe(2);
  });
  it("does not substitute a selector on real backend failure", async () => {
    const { env, read, worker } = fixture(); read.mockRejectedValue(new Error("sensitive backend detail"));
    const reply = await worker.fetch(request(), env);
    // The router's 503 is paired with a refused unprimed control, no success JSON.
    expect(reply.status).toBe(503); expect(await reply.text()).toBe("");
  });
  it("keeps one real module instance and cache across fresh Env object wrappers", async () => {
    const { env, read, worker } = fixture();
    const first = parseSample(await (await worker.fetch(request(), env)).json(), { measurementId, versionId, caseId: "home" });
    const second = parseSample(await (await worker.fetch(request(), { ...env })).json(), { measurementId, versionId, caseId: "home" });
    expect(first.newInstance).toBe(true); expect(second.newInstance).toBe(false);
    expect(second.observations[0].isolateId).toBe(first.observations[0].isolateId);
    expect(read).toHaveBeenCalledTimes(3);
    const window = summarize([second]);
    expect(window.totals.request).toBe(1); expect(window.totals.refresh).toBe(0);
    expect(window.newInstancesObserved).toBe(0); expect(window.cacheHitRate).toBe(1);
    expect(window.selectorRefreshMs).toBe(null);
  });
  it("does not create another isolate when a module receives changed measurement configuration", async () => {
    const { env, read, worker } = fixture();
    expect((await worker.fetch(request(), env)).status).toBe(200);
    expect((await worker.fetch(request(), { ...env, MEASUREMENT_ID: "72c5c482-20c0-46d7-aad4-835a366ebfa6" })).status).toBe(503);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it.each(["status", "bytes"])("refuses matching router/control failures with wrong pinned %s", async kind => {
    const { env, serve, worker } = fixture();
    serve.mockImplementation(async () => ({ kind: "response" as const,
      response: new Response(kind === "bytes" ? "wrong body" : slotBody, { status: kind === "status" ? 404 : 200 }) }));
    const reply = await worker.fetch(request(), env);
    expect(reply.status).toBe(503); expect(await reply.text()).toBe("");
  });
  it("bounds authenticated input before any real selector read", async () => {
    const { env, read, worker } = fixture();
    expect((await worker.fetch(request({ caseId: "home", routerFirst: false, extra: "x".repeat(300) }), env)).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
  it("coalesces concurrent cold requests without manufacturing multiple instance starts", async () => {
    const { env, read, worker } = fixture();
    const replies = await Promise.all([worker.fetch(request(), env), worker.fetch(request(), { ...env })]);
    const samples = await Promise.all(replies.map(async response => parseSample(await response.json(), { measurementId, versionId, caseId: "home" })));
    expect(read).toHaveBeenCalledTimes(3);
    const summary = summarize(samples);
    expect(summary.observedIsolates).toBe(1); expect(summary.newInstancesObserved).toBe(1);
    expect(summary.totals.request).toBe(2); expect(summary.totals.refresh).toBe(1);
  });
  it("refreshes control receipts after native expiry without warming the router cache", async () => {
    let clock = 10000;
    const wall = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const { env, read, serve, worker } = fixture();
      // This is the actual age refusal in functions/lib/public-release-serving.js.
      serve.mockImplementation(async (_request, selection) => Date.now() - selection!.readStartedAt >= 5000
        ? { kind: "reselect" } : { kind: "response", response: new Response(slotBody) });
      const first = parseSample(await (await worker.fetch(request(), env)).json(), { measurementId, versionId, caseId: "home" });
      clock += 6000;
      const reply = await worker.fetch(request(), env);
      expect(reply.status).toBe(200);
      const second = parseSample(await reply.json(), { measurementId, versionId, caseId: "home" });
      expect(second.observations[0].lane).toBe("slot-direct");
      expect(read).toHaveBeenCalledTimes(4); expect(serve).toHaveBeenCalledTimes(4);
      const summary = summarize([first, second]);
      expect(summary.totals.refresh).toBe(2); expect(summary.totals["cache-hit"]).toBe(0);
      expect(summary.controlReaderCalls).toBe(2); expect(summary.controlSelectorReadMs.n).toBe(2);
    } finally { monotonic.mockRestore(); wall.mockRestore(); }
  });
});
