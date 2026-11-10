import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCmsApiHandler, type CmsApiEnv } from "../src/index";
import { streamBinding } from "../src/live-production-relay";
import { FirebaseTokenError } from "../src/firebase-auth";
import { simulatorMapping } from "../../agents/vmix/src/simulator";
import { command, snapshot } from "../../tests/fixtures/live-production";

const binding = { sessionId: simulatorMapping.sessionId, deviceId: simulatorMapping.deviceId!, sessionGeneration: 1, mappingVersion: 1 };
const fences = { ...binding, clearGeneration: 0, lastSequence: 0, active: true };
const sockets: WebSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); vi.restoreAllMocks(); });
function request(fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(binding).map(([key, value]) => [key, String(value)])), ...fields });
  return new Request(`https://api.example.org/live-production/agent?${query}`, {
    headers: { upgrade: "websocket", authorization: "Bearer synthetic-token", ...headers },
  });
}
function reply() { return { success: true, mapping: simulatorMapping, fences, deliveries: [], scannedThroughSequence: 0 }; }
function network() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe("https://us-central1-njpbs-site.cloudfunctions.net/cmsLiveProductionAgent");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token");
    expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe("synthetic-edge");
    const body = JSON.parse(String(init?.body));
    expect(body.sessionId).toBe(binding.sessionId); expect(body.deviceId).toBe(binding.deviceId);
    return Response.json(reply());
  });
}
function stub(name: string) { return env.LIVE_PRODUCTION_RELAYS.getByName(name); }
async function connect(name: string) {
  const relay = stub(name);
  const response = await relay.fetch(request());
  expect(response.status).toBe(101);
  const socket = response.webSocket!; socket.accept(); sockets.push(socket);
  return { relay, socket };
}
function message(socket: WebSocket) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    socket.addEventListener("message", event => resolve(JSON.parse(String(event.data))), { once: true });
    socket.addEventListener("close", () => reject(new Error("Socket closed")), { once: true });
  });
}
const pull = (timingId = "timing-1") => JSON.stringify({ type: "pull", token: "synthetic-token", timingId, afterSequence: 0 });

describe("live production relay boundary", () => {
  it("rejects an invalid edge token and an actor over budget before invoking the device Function", async () => {
    const fetcher = network();
    const environment = { ...env, CMS_EDGE_ORIGIN_SECRET: "synthetic-edge" } as unknown as CmsApiEnv;
    const invalid = createCmsApiHandler({ verifyToken: async () => { throw new FirebaseTokenError(); } });
    expect((await invalid.fetch(request(), environment)).status).toBe(401);
    const valid = createCmsApiHandler({ verifyToken: async () => ({ uid: "synthetic-device" }) });
    environment.RATE_LIMITERS = { getByName: (name: string) => ({
      consume: async () => ({ allowed: !name.includes(":actor:"), remaining: 0, retryAfterSeconds: 10 }),
    }) } as unknown as CmsApiEnv["RATE_LIMITERS"];
    expect((await valid.fetch(request(), environment)).status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects untrusted origins, missing authentication and wrong binding before subscription", async () => {
    const origin = await stub("origin").fetch(request({}, { origin: "https://admin.njpbs.org" }));
    expect(origin.status).toBe(400);
    expect((await stub("missing-token").fetch(request({}, { authorization: "" }))).status).toBe(401);
    network().mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await stub("wrong-device").fetch(request())).status).toBe(403);
    expect((await stub("wrong-generation").fetch(request({ sessionGeneration: "2" }))).status).toBe(409);
    expect(streamBinding(new Request(request().url + "&deviceId=other"))).toBeNull();
  });
  it("uses the existing pull envelope, survives hibernation and stores no token", async () => {
    const fetcher = network();
    const { relay, socket } = await connect("hibernation");
    const next = message(socket); socket.send(pull());
    expect(await next).toMatchObject({ type: "delivery", timingId: "timing-1", data: reply() });
    await runInDurableObject(relay, async (_instance, state) => {
      expect(JSON.stringify([...await state.storage.list()])).not.toContain("synthetic-token");
      expect(JSON.stringify(state.getWebSockets()[0].deserializeAttachment())).not.toContain("synthetic-token");
    });
    await evictDurableObject(relay);
    const wake = message(socket); await relay.notify(binding); expect(await wake).toEqual({ type: "wake" });
    const resumed = message(socket); socket.send(pull("timing-2")); expect((await resumed).timingId).toBe("timing-2");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("closes a revoked credential and oversized or non-semantic frames without delivery", async () => {
    const fetcher = network();
    const { socket } = await connect("revoked");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const revoked = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
    socket.send(pull()); await revoked;
    for (const [name, frame] of [["oversized", "x".repeat(24_001)], ["generic", '{"type":"execute","function":"OverlayInput1In"}']]) {
      const connection = await connect(name);
      const closed = new Promise(resolve => connection.socket.addEventListener("close", resolve, { once: true }));
      connection.socket.send(frame); await closed;
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("closes an idle socket and refuses a changed session generation", async () => {
    const fetcher = network();
    const { relay, socket } = await connect("idle");
    const closed = new Promise(resolve => socket.addEventListener("close", resolve, { once: true }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_001);
    await runDurableObjectAlarm(relay); await closed; clock.mockRestore();
    const changed = await connect("changed-session");
    fetcher.mockResolvedValueOnce(Response.json({ ...reply(), fences: { ...fences, sessionGeneration: 2 } }));
    const refused = new Promise(resolve => changed.socket.addEventListener("close", resolve, { once: true }));
    changed.socket.send(pull()); await refused;
  });
  it("supersedes the prior connection without forwarding its delayed pull", async () => {
    const fetcher = network();
    const first = await connect("generation");
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    fetcher.mockImplementationOnce(() => pending);
    first.socket.send(pull());
    // Synchronize at the actual network boundary, without a timing sleep.
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const closed = new Promise(resolve => first.socket.addEventListener("close", resolve, { once: true }));
    const second = await connect("generation");
    await closed; finish(Response.json(reply()));
    const next = message(second.socket); second.socket.send(pull("new-generation"));
    expect((await next).timingId).toBe("new-generation");
  });
  it("keeps disabled streams and browser upgrades outside the generic CMS proxy", async () => {
    const handler = createCmsApiHandler();
    const environment = { ...env, LIVE_PRODUCTION_STREAM_ENABLED: "false" } as unknown as CmsApiEnv;
    expect((await handler.fetch(request(), environment)).status).toBe(503);
    environment.LIVE_PRODUCTION_STREAM_ENABLED = "true";
    expect((await handler.fetch(request({}, { origin: "https://evil.example.test" }), environment)).status).toBe(400);
  });
  it("wakes only the admitted command's device binding after a successful staff response", async () => {
    network();
    const { socket } = await connect(binding.deviceId);
    const accepted = { ...command, ...binding, snapshot: { ...snapshot, sessionId: binding.sessionId, mappingVersion: 1 } };
    const handler = createCmsApiHandler({ verifyToken: async () => ({ uid: "synthetic-staff" }),
      fetchOrigin: async () => Response.json({ success: true, command: accepted }) });
    const environment = { ...env, CMS_EDGE_ORIGIN_SECRET: "synthetic-edge" } as unknown as CmsApiEnv;
    const ctx = createExecutionContext();
    const wake = message(socket);
    const response = await handler.fetch(new Request("https://api.example.org/cmsLiveProduction", {
      method: "POST", headers: { authorization: "Bearer synthetic-staff-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "command" }),
    }), environment, ctx);
    expect(response.status).toBe(200); await waitOnExecutionContext(ctx);
    expect(await wake).toEqual({ type: "wake" });
  });
});
