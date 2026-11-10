import { afterEach, expect, it, vi } from "vitest";
import { servePreviewPairStandby } from "../site/scripts/cms-preview-pair-standby";
const fixtures: Array<{ stop(): void; closed: Promise<void> }> = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { f.stop(); await f.closed.catch(() => undefined); } });
const identity = { pairId: "preview-next", rendererSha: "a".repeat(40), serializerId: "preview-next", workerVersion: "aaaa1111-1111-1111-1111-111111111111" };
async function setup(startup?: Parameters<typeof servePreviewPairStandby>[0]["startup"]) {
  let mode: "candidate" | "retained" = "candidate", end!: () => void, crash!: (e: Error) => void;
  const listenerClosed = new Promise<void>((r, j) => { end = r; crash = j; });
  const stop = vi.fn(() => end());
  const start = vi.fn(async () => ({ stop, closed: listenerClosed }));
  const context = vi.fn(async () => ({}));
  const authority = vi.fn(async () => ({ mode }));
  const abort = new AbortController();
  const f = await servePreviewPairStandby({ identity, readAuthority: authority, checkContext: context,
    startListener: start, signal: abort.signal, port: 0, startup });
  fixtures.push(f);
  const url = `http://127.0.0.1:${(f.address as { port: number }).port}`;
  return { f, url, start, stop, authority, context, abort, crash, retained: () => { mode = "retained"; } };
}
it("candidate health runs real context probes without opening a listener or journal", async () => {
  const f = await setup();
  const health = await fetch(`${f.url}/health`);
  expect(health.status).toBe(200); expect(await health.json()).toEqual({ status: "ready", mode: "candidate", ...identity });
  expect(f.context).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled();
  expect((await fetch(`${f.url}/wake`, { method: "POST" })).status).toBe(503);
  expect(f.start).not.toHaveBeenCalled();
});
it("joins the private wake request to its process and keeps health distinct", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const startup = { startupId: "11111111-1111-4111-8111-111111111111", processStartedAtMs: 1_790_000_000_000,
      timingsMs: { "node-startup": 30 } };
    const f = await setup(() => startup); f.retained();
    const requestId = "22222222-2222-4222-8222-222222222222";
    const response = await fetch(`${f.url}/wake`, { method: "POST", headers: { "x-njpbs-preview-request-id": requestId } });
    expect(await response.json()).toMatchObject({ status: "ready", startup });
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId, startupId: startup.startupId, stage: "pair-context", phase: "end", outcome: "ok" }),
    ]));
    log.mockClear(); await fetch(`${f.url}/health`);
    const stages = log.mock.calls.map(([line]) => JSON.parse(line).stage);
    expect(stages).toContain("health"); expect(stages).not.toContain("wake");
  } finally { log.mockRestore(); }
});
it("retention can advance without redeploy and concurrent wakes open one listener", async () => {
  const f = await setup(); f.retained();
  const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`${f.url}/wake`, { method: "POST" })));
  expect(responses.every(r => r.status === 200)).toBe(true); expect(f.start).toHaveBeenCalledOnce();
  await fetch(`${f.url}/health`); expect(f.start).toHaveBeenCalledOnce();
});
it("rejects context and authority failures without opening claims or exposing errors", async () => {
  const f = await setup(); f.retained(); f.context.mockRejectedValueOnce(new Error("private-data"));
  const failed = await fetch(`${f.url}/wake`, { method: "POST" });
  expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("private-data");
  expect(f.start).not.toHaveBeenCalled();
  f.authority.mockRejectedValueOnce(new Error("disabled"));
  expect((await fetch(`${f.url}/health`)).status).toBe(503); expect(f.start).not.toHaveBeenCalled();
});
it("checks retention again after CODE and refuses a transition before listener start", async () => {
  const f = await setup(); f.retained();
  f.authority.mockResolvedValueOnce({ mode: "retained" }).mockResolvedValueOnce({ mode: "candidate" });
  expect((await fetch(`${f.url}/wake`, { method: "POST" })).status).toBe(503);
  expect(f.start).not.toHaveBeenCalled();
  await expect(f.f.closed).rejects.toThrow("startup was not confirmed");
});
it("a rejected listener startup ends the process instead of leaving healthy stalled work", async () => {
  const f = await setup(); f.retained(); f.start.mockRejectedValueOnce(new Error("private-startup-data"));
  expect((await fetch(`${f.url}/wake`, { method: "POST" })).status).toBe(503);
  await expect(f.f.closed).rejects.toThrow("startup was not confirmed");
  expect(f.start).toHaveBeenCalledOnce();
  await expect(fetch(`${f.url}/health`)).rejects.toThrow();
});
it("unknown paths and methods never start work; shutdown stops its own listener", async () => {
  const f = await setup();
  expect((await fetch(`${f.url}/wake`)).status).toBe(404);
  expect((await fetch(`${f.url}/health`, { method: "POST" })).status).toBe(404);
  expect(f.authority).not.toHaveBeenCalled(); f.retained();
  await fetch(`${f.url}/wake`, { method: "POST" }); f.abort.abort(); await f.f.closed;
  expect(f.stop).toHaveBeenCalled();
});
it("listener failure terminates this runtime and keeps the boundary error private", async () => {
  const f = await setup(); f.retained(); await fetch(`${f.url}/wake`, { method: "POST" });
  f.crash(new Error("private-data")); await expect(f.f.closed).rejects.toThrow("without a verified result");
});
