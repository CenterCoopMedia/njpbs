import { expect, it, vi } from "vitest";
import { pairTerminalRpc, PAIR_TERMINAL_HOST } from "./pair-terminal-rpc";
import { pairStorageRpc } from "./pair-storage-rpc";
import { releasePair, releaseSelector, pairReference } from "../tests/helpers/private-public-release-pair.js";
import protocol from "../functions/lib/public-release-pair.js";
import work from "../functions/lib/public-release-pair-work.js";

function fixture() {
  const original = releasePair("c", "c".repeat(40)), selected = releasePair(), recovery = releasePair("b", "b".repeat(40));
  const selector = { ...releaseSelector(), selectedPair: pairReference(selected), recoveryPair: pairReference(recovery) };
  const rows = new Map<string, any>([["system/publicDeployment", selector], ["system/billing", { disabled: false }],
    ["system/publicReleaseAdmissions/controls/adoption", { schemaVersion: 2, enabled: true }]]);
  for (const pair of [original, selected, recovery]) {
    rows.set(work.publicReleasePairPath(pair.pairId), pair);
    rows.set(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`, { schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  }
  const get = vi.fn(async () => ({ size: 1, customMetadata: { fixture: "only" }, body: new Response("x").body! }));
  const ingress = { prove: vi.fn(async () => new Response("actual binding response")) };
  const authority = { pair: original, read: async (path: string) => rows.get(path) ?? null };
  const call = (path: string, init?: RequestInit) => pairTerminalRpc(new Request(`http://${PAIR_TERMINAL_HOST}${path}`, init), { get } as any, authority, ingress);
  return { rows, original, selected, recovery, get, ingress, authority, call };
}
const digest = "a".repeat(64);
it.each(["original", "selected", "recovery"] as const)("permits immutable H, G and replay reads for the actual %s pair only", async role => {
  const f = fixture(), pair = f[role];
  for (const key of [`release-pair-inputs/v2/${pair.pairId}/objects/${digest}.json`,
    `release-pairs/${pair.pairId}/${digest}/claims/${digest}/objects/${digest}`,
    `release-pair-replay/v2/${protocol.publicReleaseDigest(pair)}/selections/${digest}.json`]) {
    const response = await f.call(`/objects/${key}`);
    expect(response.status).toBe(200); expect(await response.text()).toBe("x");
    expect(response.headers.get("x-pair-metadata")).toBe('{"fixture":"only"}');
    expect(f.get).toHaveBeenLastCalledWith(key);
  }
  expect(f.ingress.prove).not.toHaveBeenCalled();
});
it.each(["/objects/public/latest.json", "/objects/release-pairs/", "/objects/release-pairs/?list=true",
  `/objects/release-pair-inputs/v2/${releasePair("d", "d".repeat(40)).pairId}/objects/${digest}.json`,
  `/objects/release-pair-replay/v2/${"d".repeat(64)}/selections/${digest}.json`,
  `/objects/release-pair-inputs/v2/${releasePair().pairId}/objects/not-a-digest.json`,
  "/prove?path=%2F&digest=bad&status=200", `/prove?path=https://example.test/&digest=${digest}&status=200`,
  `/prove?path=%2F_pair-compiled%2Fprivate&digest=${digest}&status=200`, `/prove?path=%2F&digest=${digest}&status=201`,
  `/prove?path=%2F&digest=${digest}&status=0200`,
  `/prove?path=%2F&digest=${digest}&status=200&extra=yes`, `/prove?path=%2F&path=%2F&digest=${digest}&status=200`])(
  "refuses legacy, listing, other-pair and malformed requests: %s", async path => {
    const f = fixture(); expect((await f.call(path)).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled(); expect(f.ingress.prove).not.toHaveBeenCalled();
  });
it.each(["POST", "PUT", "DELETE", "HEAD"])("refuses %s without reading storage or calling ingress", async method => {
  const f = fixture(); expect((await f.call(`/prove?path=%2F&digest=${digest}&status=200`, { method })).status).toBe(403);
  expect(f.get).not.toHaveBeenCalled(); expect(f.ingress.prove).not.toHaveBeenCalled();
});
it.each(["https://pair-terminal.internal/prove", "http://pair-terminal.internal:80/prove?extra=yes",
  "http://pair-terminal.internal:8080/prove", "http://other.internal/prove"])(
  "refuses malformed private destinations: %s", async url => {
    const f = fixture();
    expect((await pairTerminalRpc(new Request(url), { get: f.get } as any, f.authority, f.ingress)).status).toBe(403);
    expect(f.get).not.toHaveBeenCalled(); expect(f.ingress.prove).not.toHaveBeenCalled();
  });
it("forwards only a canonical GET to the actual private ingress binding", async () => {
  const f = fixture(), response = await f.call(`/prove?path=%2Fnews%2Fstory%2F&digest=${digest}&status=200`);
  expect(await response.text()).toBe("actual binding response");
  const [request, bodyDigest, expected] = f.ingress.prove.mock.calls[0] as unknown as [Request, string, object];
  expect(request.method).toBe("GET"); expect(request.url).toBe("https://dev-public.example.org/news/story/");
  expect(request.headers.get("authorization")).toBe(null); expect(bodyDigest).toBe(digest); expect(expected).toEqual({ status: 200 });
  expect(f.get).not.toHaveBeenCalled();
});
it.each(["billing", "adoption", "original-runtime", "selected-runtime", "pair-reference"])("refuses stale %s authority", async fault => {
  const f = fixture();
  if (fault === "billing") f.rows.set("system/billing", { disabled: true });
  if (fault === "adoption") f.rows.set("system/publicReleaseAdmissions/controls/adoption", { schemaVersion: 2, enabled: false });
  if (fault.endsWith("runtime")) {
    const pair = fault === "original-runtime" ? f.original : f.selected;
    f.rows.set(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`, { schemaVersion: 2, pairId: pair.pairId, status: "retired" });
  }
  if (fault === "pair-reference") f.rows.set(work.publicReleasePairPath(f.selected.pairId), { ...f.selected, commitSha: "d".repeat(40) });
  const response = await f.call(`/prove?path=%2F&digest=${digest}&status=200`);
  expect(response.status).toBe(fault === "billing" ? 503 : 403);
  expect(f.get).not.toHaveBeenCalled(); expect(f.ingress.prove).not.toHaveBeenCalled();
});
it("leaves the original storage endpoint's own-pair restriction unchanged", async () => {
  const f = fixture(), key = `release-pair-inputs/v2/${f.original.pairId}/objects/${digest}.json`;
  expect(await (await pairStorageRpc(new Request(`http://pair-storage.internal/${key}`), { get: f.get } as any, f.authority)).text()).toBe("x");
  const foreign = `release-pair-inputs/v2/${f.selected.pairId}/objects/${digest}.json`;
  expect((await pairStorageRpc(new Request(`http://pair-storage.internal/${foreign}`), { get: f.get } as any, f.authority)).status).toBe(403);
  expect(f.get).toHaveBeenCalledTimes(1);
});
