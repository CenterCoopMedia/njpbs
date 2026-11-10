import { expect, it, vi } from "vitest";
import { readCanonicalBootstrapRoot } from "../../site/scripts/public-release-bootstrap-root-proof";
import { releasePair, releaseSelector } from "../helpers/private-public-release-pair.js";
import p from "../../functions/lib/public-release-pair.js";
import { canonicalReleaseValue } from "../../packages/content-core/src/public-release-routing";
const pair = releasePair(), selector = releaseSelector();
const root = { schemaVersion: 2, environment: pair.environment, epoch: 1, pair: selector.selectedPair,
  codeReceiptDigest: pair.codeAssetManifestDigest, contentHead: selector.contentHead, selectorDigest: p.publicReleaseDigest(selector) };
const headers = { "content-type": "application/json", "cache-control": "no-store", "x-njpbs-publication-origin": "template-dev-public" };
it("uses the exact ordinary public root GET and checks its real canonical bytes and headers", async () => {
  const request: typeof fetch = vi.fn(async (url, options) => {
    expect(url).toBe("https://dev-public.example.org/_publication-v2.json");
    expect(options).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: { accept: "application/json" } });
    return new Response(canonicalReleaseValue(root), { headers });
  });
  const observed = await readCanonicalBootstrapRoot({ pair, selector, request, signal: new AbortController().signal });
  expect(observed.selectorDigest).toBe(root.selectorDigest); expect(observed.rootDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(request).toHaveBeenCalledTimes(1);
});
it.each(["epoch", "pair", "head", "selector", "code", "origin", "cache", "status", "extra", "oversized", "refresh"])(
  "refuses %s before it can certify the public root", async fault => {
    const changed: any = structuredClone(root), changedHeaders: Record<string, string> = { ...headers };
    if (fault === "epoch") changed.epoch = 2;
    if (fault === "pair") changed.pair.commitSha = "c".repeat(40);
    if (fault === "head") changed.contentHead.manifestDigest = "c".repeat(64);
    if (fault === "selector") changed.selectorDigest = "c".repeat(64);
    if (fault === "code") changed.codeReceiptDigest = "c".repeat(64);
    if (fault === "origin") changedHeaders["x-njpbs-publication-origin"] = "some-other-worker";
    if (fault === "cache") changedHeaders["cache-control"] = "public, max-age=60";
    if (fault === "extra") changed.extra = true;
    if (fault === "refresh") changedHeaders["publication-refresh"] = "pending";
    const request: typeof fetch = async () => new Response(fault === "oversized" ? " ".repeat(64 * 1024 + 1) : canonicalReleaseValue(changed), {
      status: fault === "status" ? 503 : 200, headers: changedHeaders });
    await expect(readCanonicalBootstrapRoot({ pair, selector, request, signal: new AbortController().signal })).rejects.toThrow();
  });
it("propagates caller abort and cancels the refused response stream", async () => {
  const controller = new AbortController(), cancel = vi.fn();
  const request: typeof fetch = async () => new Response(new ReadableStream({ start(stream) { controller.abort(); stream.enqueue(new Uint8Array([1])); }, cancel }), { headers });
  await expect(readCanonicalBootstrapRoot({ pair, selector, request, signal: controller.signal })).rejects.toThrow();
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("refuses a valid canonical body with an oversized declared length before reading it", async () => {
  const cancel = vi.fn();
  const request: typeof fetch = async () => new Response(new ReadableStream({ cancel }), { headers: { ...headers, "content-length": String(64 * 1024 + 1) } });
  await expect(readCanonicalBootstrapRoot({ pair, selector, request, signal: new AbortController().signal })).rejects.toThrow("Canonical bootstrap root was refused");
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("enforces the streamed byte limit even without a declared length", async () => {
  const request: typeof fetch = async () => new Response(canonicalReleaseValue(root) + " ".repeat(64 * 1024), { headers });
  await expect(readCanonicalBootstrapRoot({ pair, selector, request, signal: new AbortController().signal })).rejects.toThrow("Private pair reader refused");
});
it("refuses a byte-order mark before otherwise canonical root JSON", async () => {
  const request: typeof fetch = async () => new Response("\ufeff" + canonicalReleaseValue(root), { headers });
  await expect(readCanonicalBootstrapRoot({ pair, selector, request, signal: new AbortController().signal })).rejects.toThrow();
});
