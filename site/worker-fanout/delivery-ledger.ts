// One object per hashed envelope + Message-ID. No email content or addresses
// cross this boundary. Accepted forwards are durable; leases cover overlapping
// invocations. SMTP acceptance and this write cannot be one atomic operation.
export const CLAIM_TTL_MS = 10 * 60 * 1_000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

type Delivery = { status: "accepted" } | { status: "pending"; token: string; until: number };
type Operation = "claim" | "accept" | "release" | "status";
export type Claim = "send" | "accepted" | "busy";

// Structural runtime types keep the forwarding boundary testable in Node.
export interface LedgerState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
export interface LedgerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function ledgerClient(namespace: LedgerNamespace, identity: string) {
  // Get a fresh stub per call: a failed Durable Object RPC/fetch may poison a stub.
  async function call(operation: Operation, destination: string, token: string): Promise<string> {
    const stub = namespace.get(namespace.idFromName(identity));
    const response = await stub.fetch(new Request("https://fanout-ledger/", {
      method: "POST",
      body: JSON.stringify({ operation, destination, token }),
    }));
    if (!response.ok) throw new Error("fanout delivery state unavailable");
    const result = await response.text();
    if (operation === "claim" || operation === "status"
      ? !["send", "accepted", "busy"].includes(result) : result !== "ok") {
      throw new Error("invalid fanout delivery state");
    }
    return result;
  }
  return {
    claim: (destination: string, token: string) => call("claim", destination, token) as Promise<Claim>,
    status: (destination: string, token: string) => call("status", destination, token),
    accept: (destination: string, token: string) => call("accept", destination, token),
    release: (destination: string, token: string) => call("release", destination, token),
  };
}

export class FanoutDeliveryLedger {
  constructor(private readonly state: LedgerState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = await request.json() as { operation?: string; destination?: string; token?: string };
    const { operation, destination, token } = input;
    if (!destination || !/^[a-f0-9]{64}$/.test(destination) ||
        !token || !/^[a-f0-9-]{36}$/.test(token) ||
        !["claim", "accept", "release", "status"].includes(operation ?? "")) {
      return new Response(null, { status: 400 });
    }
    // Only storage work is gated. Never hold this gate around an SMTP forward.
    return this.state.blockConcurrencyWhile(async () => {
      try {
        const storage = this.state.storage;
        const delivery = await storage.get<Delivery>(destination);
        if (operation === "status") {
          return new Response(delivery?.status === "accepted" ? "accepted" : "busy");
        }
        if (operation === "claim") {
          if (delivery?.status === "accepted") return new Response("accepted");
          await storage.setAlarm(Date.now() + RETENTION_MS);
          if (delivery?.status === "pending" && delivery.until > Date.now()) return new Response("busy");
          await storage.put(destination, { status: "pending", token, until: Date.now() + CLAIM_TTL_MS });
          return new Response("send");
        }
        // A late completion must not clear or overwrite a newer attempt's claim.
        if (delivery?.status !== "pending" || delivery.token !== token) {
          return new Response(null, { status: 409 });
        }
        if (operation === "accept") await storage.put(destination, { status: "accepted" });
        else await storage.delete(destination);
        return new Response("ok");
      } catch {
        // Neither storage/provider errors nor object keys belong in logs.
        return new Response(null, { status: 503 });
      }
    });
  }

  async alarm(): Promise<void> {
    await this.state.blockConcurrencyWhile(async () => {
      // An old alarm may already be queued when a claim extends retention.
      const next = await this.state.storage.getAlarm();
      if (next !== null && next > Date.now()) return;
      await this.state.storage.deleteAll();
    });
  }
}
