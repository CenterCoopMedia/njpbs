// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import deployedWorker, { FanoutDeliveryLedger } from "../worker-fanout/index";
import { ZONE, destinationsFor } from "../worker-fanout/fanout";
import { CLAIM_TTL_MS, RETENTION_MS } from "../worker-fanout/delivery-ledger";

const worker: typeof deployedWorker = {
  email(message, env) {
    return deployedWorker.email(message, { FANOUT_DESTINATIONS_JSON: JSON.stringify({
      default: destinationsFor(`social@${ZONE}`), info: destinationsFor(`info@${ZONE}`), engineering: destinationsFor(`engineering@${ZONE}`),
      programming: destinationsFor(`programming@${ZONE}`), desk: destinationsFor(`desk@${ZONE}`),
    }), ...env });
  },
};

function fakeObject() {
  const records = new Map<string, unknown>();
  let alarm: number | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const state = {
    storage: {
      async get<T>(key: string) { return structuredClone(records.get(key)) as T | undefined; },
      async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
      async delete(key: string) { return records.delete(key); },
      async deleteAll() { records.clear(); },
      async getAlarm() { return alarm; },
      async setAlarm(value: number) { alarm = value; },
    },
    blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
      const result = queue.then(run);
      queue = result.catch(() => {});
      return result;
    },
  };
  return { records, state, ledger: new FanoutDeliveryLedger(state), alarm: () => alarm };
}

// Separate invocations share persisted records, never message objects.
function fakeNamespace() {
  const objects = new Map<string, ReturnType<typeof fakeObject>>();
  const namespace = {
    idFromName: (name: string) => name,
    get(id: string) {
      if (!objects.has(id)) objects.set(id, fakeObject());
      return { fetch: (request: Request) => objects.get(id)!.ledger.fetch(request) };
    },
  };
  return { objects, env: { FANOUT_DELIVERIES: namespace } };
}
const recipients = destinationsFor(`social@${ZONE}`);
const infoRecipients = [...recipients, "editor-d@example.org"];
function message(
  forward: (destination: string) => Promise<unknown> = async () => {},
  id: string | null = "<incident-2160@example.test>",
  to = `social@${ZONE}`,
  from = "sender@example.test",
) {
  return { to, from, headers: new Headers(id === null ? {} : { "Message-ID": id }), forward: vi.fn(forward) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("fanout retries", () => {
  it("retries only the Gmail 421 leg, then skips a completed replay", async () => {
    const { env, objects } = fakeNamespace();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = message(async (destination) => {
      if (destination === recipients[1]) {
        // The first success is already committed when the next leg starts.
        expect([...objects.values()][0].records.size).toBeGreaterThan(0);
        throw new Error("upstream temporary error: transient error (421): 4.7.28 private@example.test private subject");
      }
    });
    await expect(worker.email(first, env)).rejects.toThrow("1 destination(s)");
    expect(first.forward.mock.calls.flat()).toEqual(recipients);
    expect(log.mock.calls).toEqual([
      [`njpbs-fanout: alias=social@${ZONE} destination=2/4 category=temporary`],
    ]);
    const object = [...objects.values()][0];
    object.ledger = new FanoutDeliveryLedger(object.state); // cold object, same storage
    const second = message();
    await worker.email(second, env);
    expect(second.forward.mock.calls.flat()).toEqual([recipients[1]]);
    const third = message();
    await worker.email(third, env);
    expect(third.forward).not.toHaveBeenCalled();
  });

  it("does not conflate distinct IDs, aliases, tags, or envelope senders", async () => {
    const { env } = fakeNamespace();
    await worker.email(message(), env);
    for (const { fresh, expected } of [
      { fresh: message(undefined, "<different@example.test>"), expected: recipients },
      { fresh: message(undefined, undefined, `info@${ZONE}`), expected: infoRecipients },
      { fresh: message(undefined, undefined, `social+other@${ZONE}`), expected: recipients },
      { fresh: message(undefined, undefined, undefined, "other@example.test"), expected: recipients },
    ]) {
      await worker.email(fresh, env);
      expect(fresh.forward.mock.calls.flat()).toEqual(expected);
    }
  });

  it("does not guess an identity for messages without Message-ID", async () => {
    const { env, objects } = fakeNamespace();
    for (let attempt = 0; attempt < 2; attempt++) {
      const incoming = message(undefined, null);
      await worker.email(incoming, env);
      expect(incoming.forward.mock.calls.flat()).toEqual(recipients);
    }
    expect(objects.size).toBe(0);
  });

  it("keeps every rejected forward pending, including opaque errors", async () => {
    const { env } = fakeNamespace();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = message(async () => { throw new Error("unverified private@example.test"); });
    await expect(worker.email(first, env)).rejects.toThrow("4 destination(s)");
    const retry = message();
    await worker.email(retry, env);
    expect(retry.forward.mock.calls.flat()).toEqual(recipients);
  });

  it("claims overlapping legs and retries while another invocation is forwarding", async () => {
    const { env } = fakeNamespace();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = message(async (destination) => {
      if (destination === recipients[0]) { started(); await pending; }
    });
    const firstRun = worker.email(first, env);
    await entered;
    const concurrent = message();
    await expect(worker.email(concurrent, env)).rejects.toThrow("1 destination(s)");
    expect(concurrent.forward.mock.calls.flat()).toEqual(recipients.slice(1));
    release();
    await firstRun;
    expect(first.forward.mock.calls.flat()).toEqual([recipients[0]]);
    const retry = message();
    await worker.email(retry, env);
    expect(retry.forward).not.toHaveBeenCalled();
  });

  it("returns normally when overlapping work finishes before this invocation ends", async () => {
    const { env } = fakeNamespace();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const enteredFirst = gate();
    const releaseFirst = gate();
    const enteredSecond = gate();
    const releaseSecond = gate();
    const first = message(async (destination) => {
      if (destination === recipients[0]) { enteredFirst.resolve(); await releaseFirst.promise; }
    });
    const firstRun = worker.email(first, env).catch((error: unknown) => error);
    await enteredFirst.promise;
    const second = message(async (destination) => {
      if (destination === recipients[1]) { enteredSecond.resolve(); await releaseSecond.promise; }
    });
    const secondRun = worker.email(second, env);
    await enteredSecond.promise;
    releaseFirst.resolve();
    expect(await firstRun).toBeInstanceOf(Error); // Second leg is still pending.
    releaseSecond.resolve();
    await expect(secondRun).resolves.toBeUndefined(); // All legs are now accepted.
    expect(second.forward.mock.calls.flat()).toEqual([recipients[1]]);
  });

  it("fails closed before forwarding if the binding or ledger is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = message();
    await expect(worker.email(missing)).rejects.toThrow();
    expect(missing.forward).not.toHaveBeenCalled();
    const { env } = fakeNamespace();
    env.FANOUT_DELIVERIES.get = () => ({ fetch: async () => { throw new Error("private storage detail"); } });
    const unavailable = message();
    await expect(worker.email(unavailable, env)).rejects.toThrow("4 destination(s)");
    expect(unavailable.forward).not.toHaveBeenCalled();
  });

  it("retains an uncertain claim during a sustained write outage and continues other recipients", async () => {
    const { env, objects } = fakeNamespace();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let restoreWrites!: () => void;
    const first = message(async (destination) => {
      if (destination === recipients[0]) {
        const storage = [...objects.values()][0].state.storage;
        const write = storage.put.bind(storage);
        const failedKey = [...objects.values()][0].records.keys().next().value;
        const spy = vi.spyOn(storage, "put").mockImplementation(async (key, value) => {
          if (key === failedKey && (value as { status: string }).status === "accepted") {
            throw new Error("private write failure");
          }
          await write(key, value);
        });
        restoreWrites = () => spy.mockRestore();
      }
    });
    await expect(worker.email(first, env)).rejects.toThrow("1 destination(s)");
    expect(first.forward.mock.calls.flat()).toEqual(recipients);
    expect(log.mock.calls.flat()).toContain(`njpbs-fanout: alias=social@${ZONE} destination=1/4 category=state-write`);
    const retry = message();
    await expect(worker.email(retry, env)).rejects.toThrow("1 destination(s)");
    expect(retry.forward).not.toHaveBeenCalled();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + CLAIM_TTL_MS + 1);
    restoreWrites();
    const recovered = message();
    await worker.email(recovered, env);
    expect(recovered.forward.mock.calls.flat()).toEqual([recipients[0]]);
  });

  it("recovers a transient acceptance-write failure without requesting or forwarding a retry", async () => {
    const { env, objects } = fakeNamespace();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = message(async (destination) => {
      if (destination === recipients[0]) {
        vi.spyOn([...objects.values()][0].state.storage, "put")
          .mockRejectedValueOnce(new Error("temporary receipt outage"));
      }
    });
    await expect(worker.email(first, env)).resolves.toBeUndefined();
    expect(first.forward.mock.calls.flat()).toEqual(recipients);
    expect(log).toHaveBeenCalledTimes(1);
    const retry = message();
    await worker.email(retry, env);
    expect(retry.forward).not.toHaveBeenCalled();
  });

  it("stores only hashes and delivery state, and expires inactive records", async () => {
    const { env, objects } = fakeNamespace();
    const now = Date.now();
    await worker.email(message(), env);
    const object = [...objects.values()][0];
    const stored = JSON.stringify([...objects].map(([name, value]) => [name, [...value.records]]));
    expect(stored).not.toContain("@");
    expect(stored).not.toContain("incident-2160");
    expect(object.alarm()).toBeGreaterThanOrEqual(now + RETENTION_MS);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + RETENTION_MS + 1);
    await object.ledger.alarm();
    expect(object.records.size).toBe(0);
  });
});

describe("durable claim recovery", () => {
  const key = "a".repeat(64);
  const firstToken = "11111111-1111-4111-8111-111111111111";
  const secondToken = "22222222-2222-4222-8222-222222222222";
  function request(operation: string, token: string) {
    return new Request("https://ledger/", {
      method: "POST", body: JSON.stringify({ operation, destination: key, token }),
    });
  }

  it("does not let a stale owner release or complete a replacement claim", async () => {
    const { ledger } = fakeObject();
    expect(await (await ledger.fetch(request("claim", firstToken))).text()).toBe("send");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + CLAIM_TTL_MS + 1);
    expect(await (await ledger.fetch(request("claim", secondToken))).text()).toBe("send");
    expect((await ledger.fetch(request("release", firstToken))).status).toBe(409);
    expect((await ledger.fetch(request("accept", firstToken))).status).toBe(409);
    expect(await (await ledger.fetch(request("claim", firstToken))).text()).toBe("busy");
    expect((await ledger.fetch(request("accept", secondToken))).status).toBe(200);
    expect(await (await ledger.fetch(request("claim", firstToken))).text()).toBe("accepted");
  });

  it("does not erase receipts when an old alarm races renewed retention", async () => {
    const { ledger, records } = fakeObject();
    await ledger.fetch(request("claim", firstToken));
    await ledger.fetch(request("accept", firstToken));
    await ledger.alarm();
    expect(records.size).toBe(1);
  });

  it("redacts sender-selected tags, provider messages, and arbitrary aliases in failure logs", async () => {
    const { env } = fakeNamespace();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fail = async () => { throw new Error("421 secret-subject private-destination@example.test\nextra log"); };
    await expect(worker.email(message(fail, undefined, `social+private-tag@${ZONE}`), env)).rejects.toThrow();
    await expect(worker.email(message(fail, undefined, "private-person@foreign.test"), env)).rejects.toThrow();
    expect(log).toHaveBeenCalledTimes(8);
    const logs = [...log.mock.calls, ...warn.mock.calls].flat().join("\n");
    expect(logs).toContain(`alias=social@${ZONE}`);
    expect(logs).toContain("alias=unknown");
    expect(logs).not.toMatch(/private|secret|extra log|foreign/);
  });
});

describe("identity and retention limits", () => {
  it("distinguishes reused Message-IDs with a different originating Date", async () => {
    const { env } = fakeNamespace();
    const first = message();
    first.headers.set("Date", "Thu, 08 Oct 2026 12:00:00 +0000");
    await worker.email(first, env);
    const replay = message();
    replay.headers.set("Date", first.headers.get("Date")!);
    await worker.email(replay, env);
    expect(replay.forward).not.toHaveBeenCalled();
    const fresh = message();
    fresh.headers.set("Date", "Fri, 09 Oct 2026 12:00:00 +0000");
    await worker.email(fresh, env);
    expect(fresh.forward.mock.calls.flat()).toEqual(recipients);
  });

  it("does not extend retention indefinitely on completed replays", async () => {
    const { env, objects } = fakeNamespace();
    await worker.email(message(), env);
    const object = [...objects.values()][0];
    const expires = object.alarm();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + RETENTION_MS / 2);
    const replay = message();
    await worker.email(replay, env);
    expect(replay.forward).not.toHaveBeenCalled();
    expect(object.alarm()).toBe(expires);
  });

  it("does not request a retry when an acceptance committed but its response was lost", async () => {
    const { env } = fakeNamespace();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const get = env.FANOUT_DELIVERIES.get.bind(env.FANOUT_DELIVERIES);
    let loseOneResponse = true;
    env.FANOUT_DELIVERIES.get = (id: string) => {
      const object = get(id);
      return { async fetch(request: Request) {
        const { operation } = await request.clone().json() as { operation: string };
        const response = await object.fetch(request);
        if (operation === "accept" && loseOneResponse) {
          loseOneResponse = false;
          throw new Error("lost response after commit");
        }
        return response;
      } };
    };
    const incoming = message();
    await expect(worker.email(incoming, env)).resolves.toBeUndefined();
    expect(incoming.forward.mock.calls.flat()).toEqual(recipients);
    const replay = message();
    await worker.email(replay, env);
    expect(replay.forward).not.toHaveBeenCalled();
  });
});
