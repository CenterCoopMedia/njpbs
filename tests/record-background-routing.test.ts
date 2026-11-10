import { expect, it } from "vitest";
import { createTransitionalPostReadWorker } from "../workers/src/transitional-post-read-worker";
import type { NoBuildPostReply } from "../cms-api/src/index";
import type { RecordRouteAuthority, RecordWithdrawal } from "../workers/src/durable-record-withdrawals";

const sha = "a".repeat(40), contextDigest = "b".repeat(64), origin = "https://njpbs.org";
const marker: RecordWithdrawal = { recordId: "program-one", family: "programs", operationId: "B".repeat(20),
  sourceVersion: 7, revision: 2, ownedPaths: ["/programs/example/", "/programs/former/", "/shows/example/"], verifiedAt: 1234 };
function harness(ready = true) {
  const entries = new Map<string, Response>(), responses = new Set<Response>();
  const pending: Promise<unknown>[] = [];
  let authority: RecordRouteAuthority | null = { owned: true, withdrawal: null }, failed = false, unknown = false, calls = 0;
  let afterDecision: (() => void) | undefined;
  let reply: NoBuildPostReply | undefined;
  const body = '<!doctype html><html><main>Frozen Program output</main></html>';
  const worker = createTransitionalPostReadWorker({ rendererSha: sha, rendererReady: true, recordRendererReady: ready,
    cache: { async match(key) { const value = entries.get(String(key instanceof Request ? key.url : key));
      if (!value) return; const copy = value.clone(); responses.add(copy); return copy; },
    async put(key, value) { entries.set(String(key instanceof Request ? key.url : key), value); responses.add(value); } },
    readRecordAuthority: async path => {
      if (unknown) throw new Error("Durable withdrawal manifest is invalid");
      return authority && ({ ...authority, withdrawal: marker.ownedPaths.includes(path) ? authority.withdrawal : null });
    },
    async getDecision(): Promise<NoBuildPostReply> {
      calls++; if (failed) throw new Error("Authority unavailable"); afterDecision?.();
      if (reply) return reply;
      return { kind: "background", status: 200, bytes: btoa(body), headers: {
        "content-type": "text/html; charset=utf-8", "x-njpbs-public-context-revision": "1",
        "x-njpbs-background-context-sha256": contextDigest, "x-njpbs-background-renderer-sha": sha,
        "x-njpbs-background-purge-tag": "njpbs-post-background", "x-njpbs-record-id": "program-one", "x-njpbs-record-family": "programs",
        "x-njpbs-record-generation": "1", "x-njpbs-source-version": "7", "x-njpbs-record-visible": "true",
      } };
    },
    waitUntil: task => { pending.push(task); }, render: async () => { throw new Error("Record bytes need no Post render"); },
    fetchAsset: async () => new Response("Retained static Assets", { headers: { "content-type": "text/html" } }),
  });
  return { worker, body, get calls() { return calls; }, setAuthority(value: typeof authority) { authority = value; },
    setReply(value: NoBuildPostReply) { reply = value; },
    fail() { failed = true; }, unknown() { unknown = true; }, duringDecision(fn: typeof afterDecision) { afterDecision = fn; },
    request: (path = "/programs/example/", method = "GET") => worker.fetch(new Request(origin + path, { method })),
    async drain() { while (pending.length) await Promise.all(pending.splice(0)); } };
}

it.each(["/programs/", "/shows/", "/programs/example/", "/shows/example/", "/events/example/"])("keeps %s on exact Assets dispatch with zero RPC before activation or ownership", async path => {
  const off = harness(false);
  expect(await off.request(path)).toBeNull(); expect(off.calls).toBe(0);
  const unowned = harness(); unowned.setAuthority({ owned: false, withdrawal: null });
  expect(await unowned.request(path)).toBeNull(); expect(unowned.calls).toBe(0);
});
it("uses the existing authority and body caches for record views", async () => {
  const h = harness();
  const first = await h.request(); expect(first?.status).toBe(200); expect(await first!.text()).toBe(h.body); await h.drain();
  const reads = h.calls;
  const second = await h.request(); expect(await second!.text()).toBe(h.body); expect(h.calls).toBe(reads);
  expect(second!.headers.get("x-njpbs-background-cache")).toBe("HIT");
  expect(second!.headers.get("cache-control")).toBe("no-store");
});
it.each(marker.ownedPaths)("a durable withdrawal wins over cached bytes and static fallback at %s", async path => {
  const h = harness(); await (await h.request(path))!.text(); await h.drain();
  h.setAuthority({ owned: true, withdrawal: marker }); h.fail();
  const response = await h.request(path); expect(response?.status).toBe(410); expect(await response!.text()).toBe("");
  expect(response!.headers.get("x-njpbs-content-source")).toBe("durable-record-withdrawal");
  expect(response!.headers.get("x-njpbs-durable-withdrawal-operation")).toBe(marker.operationId);
  expect(response!.headers.get("x-njpbs-withdrawal-revision")).toBe(String(marker.revision));
});
it("keeps withdrawn records absent with a disabled capability and no private RPC", async () => {
  const h = harness(false); h.setAuthority({ owned: true, withdrawal: marker });
  expect((await h.request())?.status).toBe(410); expect(h.calls).toBe(0);
});
it("observes a first durable withdrawal during an in-flight family read", async () => {
  const h = harness(); h.duringDecision(() => h.setAuthority({ owned: true, withdrawal: marker }));
  expect((await h.request())?.status).toBe(410);
});
it("uses existing backend authority when no withdrawal storage is bound", async () => {
  const h = harness(); h.setAuthority(null);
  const response = await h.request();
  expect(response?.status).toBe(200); expect(await response!.text()).toBe(h.body); expect(h.calls).toBeGreaterThan(0);
});
it.each([true, false])("refuses every Record answer when withdrawal state is unknown (renderer ready: %s)", async ready => {
  const h = harness(ready); h.unknown();
  for (const path of [...marker.ownedPaths.filter(path => !path.startsWith("/shows/")), "/events/example/"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await h.request(path, method);
      expect(response?.status).toBe(503);
      expect(response!.headers.get("cache-control")).toBe("no-store");
      expect(await response!.text()).not.toContain("Retained static Assets");
    }
  }
  expect(h.calls).toBe(0);
});
it("normalizes retained route variants and keeps HEAD empty", async () => {
  const h = harness();
  const response = await h.request("/%2570rograms/example/index.html", "HEAD");
  expect(response?.status).toBe(200); expect(await response!.text()).toBe("");
  h.setAuthority({ owned: true, withdrawal: marker });
  expect((await h.request("/shows/example/index.html"))?.status).toBe(410);
});


it.each([2, 3])("stamps the R2 withdrawal identity on backend generation %s", async generation => {
  const h = harness(); h.setAuthority({ owned: true, withdrawal: marker });
  h.setReply({ kind: "background", status: 410, bytes: "", headers: {
    "cache-control": "no-store", "x-origin-proof": "backend-410",
    "x-njpbs-public-context-revision": "1", "x-njpbs-background-context-sha256": contextDigest,
    "x-njpbs-record-id": "program-one", "x-njpbs-record-family": "programs",
    "x-njpbs-record-generation": String(generation), "x-njpbs-source-version": "7", "x-njpbs-record-visible": "false",
  } });
  const response = await h.request();
  expect(response?.status).toBe(410); expect(await response!.text()).toBe("");
  expect(response!.headers.get("x-origin-proof")).toBe("backend-410");
  expect(response!.headers.get("x-njpbs-durable-withdrawal-operation")).toBe("B".repeat(20));
  expect(response!.headers.get("x-njpbs-withdrawal-revision")).toBe("2");
  await h.drain();
});
