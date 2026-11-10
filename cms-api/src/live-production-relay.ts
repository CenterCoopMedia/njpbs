import { DurableObject } from "cloudflare:workers";
import { parseTemplateMapping } from "../../packages/content-core/src/live-production";

export const LIVE_STREAM_PATH = "/live-production/agent";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const IDLE_MS = 30_000;
const MAX_REPLY_BYTES = 6_000_000;

export type RelayEnv = {
  FUNCTIONS_ORIGIN: string;
  CMS_EDGE_ORIGIN_SECRET: string;
  LIVE_PRODUCTION_STREAM_ENABLED?: string;
};
type Binding = { sessionId: string; deviceId: string; sessionGeneration: number; mappingVersion: number };
type Connection = Binding & { generation: string; idleAt: number; busy: boolean; tokens: number; updatedAt: number };

export function isLiveCommandRequest(body: ArrayBuffer): boolean {
  try { return JSON.parse(new TextDecoder().decode(body))?.action === "command"; }
  catch { return false; }
}

export function streamBinding(request: Request): Binding | null {
  const url = new URL(request.url);
  const keys = ["sessionId", "deviceId", "sessionGeneration", "mappingVersion"];
  if (url.pathname !== LIVE_STREAM_PATH || url.search.length > 512 ||
      [...url.searchParams.keys()].some(key => !keys.includes(key)) ||
      keys.some(key => url.searchParams.getAll(key).length !== 1)) return null;
  const sessionId = url.searchParams.get("sessionId")!;
  const deviceId = url.searchParams.get("deviceId")!;
  const sessionGeneration = Number(url.searchParams.get("sessionGeneration"));
  const mappingVersion = Number(url.searchParams.get("mappingVersion"));
  if (!ID.test(sessionId) || !ID.test(deviceId) ||
      ![sessionGeneration, mappingVersion].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return { sessionId, deviceId, sessionGeneration, mappingVersion };
}

export async function readLiveReply(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) throw new Error("Device request refused");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY_BYTES) throw new Error("Device response exceeds budget");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const result = JSON.parse(new TextDecoder().decode(bytes));
  if (result?.success !== true) throw new Error("Invalid device response");
  return result;
}

function matches(data: Record<string, unknown>, binding: Binding): boolean {
  const mapping = parseTemplateMapping(data.mapping);
  const fences = data.fences as { sessionGeneration?: number; mappingVersion?: number; active?: boolean } | undefined;
  return mapping.sessionId === binding.sessionId && mapping.deviceId === binding.deviceId &&
    mapping.version === binding.mappingVersion && fences?.sessionGeneration === binding.sessionGeneration &&
    fences.mappingVersion === binding.mappingVersion && fences.active === true;
}

/** No command queue or credential storage. Firestore remains the only journal. */
export class LiveProductionRelay extends DurableObject<RelayEnv> {
  private async device(token: string, binding: Binding, fields: Record<string, unknown>) {
    if (!token || token.length > 16_384 || /\s/.test(token)) throw new Error("Device authentication required");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await readLiveReply(await fetch(`${this.env.FUNCTIONS_ORIGIN}/cmsLiveProductionAgent`, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`,
          "x-njpbs-cms-edge": this.env.CMS_EDGE_ORIGIN_SECRET },
        body: JSON.stringify({ sessionId: binding.sessionId, deviceId: binding.deviceId, ...fields }),
      }));
    } finally { clearTimeout(timer); }
  }

  async fetch(request: Request): Promise<Response> {
    if (this.env.LIVE_PRODUCTION_STREAM_ENABLED !== "true" || !this.env.CMS_EDGE_ORIGIN_SECRET) return new Response(null, { status: 503 });
    const binding = streamBinding(request);
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        request.headers.has("origin") || !binding) return new Response(null, { status: 400 });
    const authorization = request.headers.get("authorization") ?? "";
    if (!/^Bearer [^\s]+$/.test(authorization)) return new Response(null, { status: 401 });
    try {
      // The existing Function checks token revocation, dedicated enrollment and session binding.
      const heartbeat = await this.device(authorization.slice(7), binding, { action: "heartbeat", timingId: crypto.randomUUID() });
      if (!matches(heartbeat, binding)) return new Response(null, { status: 409 });
    } catch {
      console.warn("Live production stream refused", { reason: "device_heartbeat_failed" });
      return new Response(null, { status: 403 });
    }
    const generation = crypto.randomUUID();
    await this.ctx.storage.put("generation", generation);
    for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Connection replaced");
    const pair = new WebSocketPair();
    const connection: Connection = { ...binding, generation, idleAt: Date.now() + IDLE_MS,
      busy: false, tokens: 8, updatedAt: Date.now() };
    pair[1].serializeAttachment(connection);
    this.ctx.acceptWebSocket(pair[1]);
    await this.ctx.storage.setAlarm(connection.idleAt);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state: Connection = socket.deserializeAttachment();
    try {
      if (this.env.LIVE_PRODUCTION_STREAM_ENABLED !== "true" || typeof message !== "string" ||
          new TextEncoder().encode(message).byteLength > 24_000 || state.busy || state.idleAt <= Date.now() ||
          state.generation !== await this.ctx.storage.get("generation")) throw new Error("Inactive stream");
      const frame = JSON.parse(message);
      if (frame?.type !== "pull" || typeof frame.timingId !== "string" || !ID.test(frame.timingId) || typeof frame.token !== "string" ||
          !Number.isSafeInteger(frame.afterSequence) || frame.afterSequence < 0 ||
          Object.keys(frame).some(key => !["type", "timingId", "afterSequence", "token"].includes(key))) throw new Error("Invalid frame");
      const now = Date.now();
      state.tokens = Math.min(8, state.tokens + Math.max(0, now - state.updatedAt) * 4 / 1000);
      if (state.tokens < 1) throw new Error("Message budget exceeded");
      state.tokens--; state.updatedAt = now; state.busy = true; state.idleAt = now + IDLE_MS;
      socket.serializeAttachment(state);
      const data = await this.device(frame.token, state, { action: "pull", timingId: frame.timingId, afterSequence: frame.afterSequence });
      // A replaced or revoked stream cannot deliver a late response from an earlier request.
      if (socket.readyState !== WebSocket.OPEN || state.generation !== await this.ctx.storage.get("generation") || !matches(data, state)) {
        throw new Error("Stream binding changed");
      }
      state.busy = false;
      socket.serializeAttachment(state);
      socket.send(JSON.stringify({ type: "delivery", timingId: frame.timingId, data }));
    } catch {
      console.warn("Live production stream closed", { reason: "pull_failed" });
      socket.close(4002, "Reconcile through device API");
    }
  }

  async notify(binding: Binding): Promise<void> {
    if (this.env.LIVE_PRODUCTION_STREAM_ENABLED !== "true") return;
    const generation = await this.ctx.storage.get("generation");
    for (const socket of this.ctx.getWebSockets()) {
      const state: Connection = socket.deserializeAttachment();
      if (state.generation === generation && state.idleAt > Date.now() &&
          state.sessionId === binding.sessionId && state.deviceId === binding.deviceId &&
          state.sessionGeneration === binding.sessionGeneration && state.mappingVersion === binding.mappingVersion) {
        socket.send('{"type":"wake"}');
      }
    }
  }

  async alarm(): Promise<void> {
    let next = Infinity;
    for (const socket of this.ctx.getWebSockets()) {
      const state: Connection = socket.deserializeAttachment();
      if (state.idleAt <= Date.now()) socket.close(4003, "Idle stream");
      else next = Math.min(next, state.idleAt);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
  webSocketClose(socket: WebSocket): void { socket.close(1000); }
  webSocketError(socket: WebSocket): void { socket.close(1011, "Stream unavailable"); }
}
