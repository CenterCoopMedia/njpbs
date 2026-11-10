import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenForGuideVideoToken } from "../src/lib/guide-video-worker";

afterEach(() => vi.unstubAllGlobals());

describe("Guide video worker isolation", () => {
  it("asks the requesting tab on every fetch and denies a signed-out tab without reusing bytes", async () => {
    const listeners = new Map<string, (event: any) => void>();
    const tokens = new Map([["alice", "alice.token"], ["bob", "bob.token"]]);
    const fetch = vi.fn(async (_url, init) => new Response(init.headers.get("authorization")));
    class Channel {
      port1 = { onmessage: (_event: any) => {} };
      port2 = { postMessage: (data: unknown) => this.port1.onmessage({ data }) };
    }
    runInNewContext(readFileSync(join(import.meta.dirname, "../public/guide-video-sw.js"), "utf8"), {
      self: {
        location: { origin: "https://admin.njpbs.org" },
        addEventListener: (type: string, callback: (event: any) => void) => listeners.set(type, callback),
        clients: { get: async (id: string) => ({
          postMessage: (_message: unknown, ports: Channel["port2"][]) => ports[0].postMessage({ token: tokens.get(id) }),
        }) },
      },
      URL, Headers, Response, MessageChannel: Channel, setTimeout, clearTimeout, fetch,
    });
    const request = async (clientId: string, extension = "mp4") => {
      let response: Promise<Response> | undefined;
      listeners.get("fetch")!({
        clientId,
        request: new Request(`https://admin.njpbs.org/guide-content/videos/analytics.${extension}`, {
          headers: { range: "bytes=2-5", "if-range": '"etag"' },
        }),
        respondWith: (value: Promise<Response>) => { response = value; },
      });
      return response!;
    };
    expect(await (await request("alice")).text()).toBe("Bearer alice.token");
    expect(await (await request("bob", "jpg")).text()).toBe("Bearer bob.token");
    tokens.delete("alice");
    expect((await request("alice", "vtt")).status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(init.cache).toBe("no-store");
      expect(init.credentials).toBe("omit");
      expect(init.headers.get("range")).toBe("bytes=2-5");
      expect(init.headers.get("if-range")).toBe('"etag"');
    }
  });

  it("does not send a token that finishes refreshing after the guide session ends", async () => {
    let listener: (event: any) => void = () => {};
    const serviceWorker = {
      addEventListener: (_type: string, callback: typeof listener) => { listener = callback; },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", { serviceWorker });
    let resolve!: (token: string) => void;
    const stop = listenForGuideVideoToken(() => new Promise<string>((done) => { resolve = done; }));
    const postMessage = vi.fn();
    listener({ data: { type: "guide-video-token-needed" }, ports: [{ postMessage }] });
    stop();
    resolve("previous.user.token");
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledWith({ token: "" });
  });
});
