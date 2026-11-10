import { afterEach, expect, it, vi } from "vitest";
import { publicReleaseTerminalTransport } from "./public-release-terminal-transport";
import { pairTerminalRpc } from "../../publisher/pair-terminal-rpc";
import { releasePair, releaseSelector } from "../../tests/helpers/private-public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
const digest = "a".repeat(64);
afterEach(() => vi.unstubAllGlobals());
it.each(["/files/café.pdf", "/files/新報告.pdf", "/files/<report>.pdf", "/files/\"report\".pdf"])(
  "preserves the public slot's decoded artifact path through both real transport adapters: %s", async path => {
    const pair = releasePair(), other = releasePair("b", "b".repeat(40));
    const rows = new Map<string, any>([["system/billing", { disabled: false }], ["system/publicDeployment", releaseSelector()],
      ["system/publicReleaseAdmissions/controls/adoption", { schemaVersion: 2, enabled: true }]]);
    for (const side of [pair, other]) {
      rows.set(work.publicReleasePairPath(side.pairId), side);
      rows.set(`${work.publicReleasePairPath(side.pairId)}/controls/runtime`, { schemaVersion: 2, pairId: side.pairId, status: "retained" });
    }
    const prove = vi.fn(async (request: Request, actualDigest: string, expected: { status: number }) => {
      expect(decodeURI(new URL(request.url).pathname)).toBe(path);
      expect(request.method).toBe("GET"); expect(actualDigest).toBe(digest); expect(expected).toEqual({ status: 200 });
      return new Response("fixture binding response");
    });
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => pairTerminalRpc(new Request(input, init),
      { get: () => { throw new Error("No object read during canonical forwarding"); } } as any,
      { pair, read: async key => rows.get(key) ?? null }, { prove }));
    const response = await publicReleaseTerminalTransport("development").ingress.prove(new Request(`https://dev-public.example.org${path}`), digest, { status: 200 });
    expect(await response.text()).toBe("fixture binding response"); expect(prove).toHaveBeenCalledTimes(1);
  });
it.each(["/files/%FF.pdf", "/files/one%2Ftwo.pdf", "/files/%252e%252e.pdf", "/files/caf%c3%a9.pdf"])(
  "refuses malformed or noncanonical percent encodings before egress: %s", async path => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(publicReleaseTerminalTransport("development").ingress.prove(new Request(`https://dev-public.example.org${path}`), digest, { status: 200 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
it("uses the platform refusal for credential-bearing request URLs", () => {
  expect(() => new Request("http://user@pair-terminal.internal/prove")).toThrow();
});
