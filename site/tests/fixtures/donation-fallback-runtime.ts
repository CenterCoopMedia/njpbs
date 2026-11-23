import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DonatePortalSignal } from "../../src/lib/donate-degradation";

export async function renderDonationDocument(html: string, signal: DonatePortalSignal | null): Promise<string> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const bundle = await build({ stdin: { resolveDir: root, contents: `
    import { serveDonationDocument, createDonationHealthReader } from './workers/src/public-donation-fallback.ts';
    const readHealth = createDonationHealthReader("fixture");
    export default { async fetch(request) {
      const html = await request.text();
      const target = new Request("https://example.org/");
      const pending = [];
      const ctx = { waitUntil: task => pending.push(task) };
      const serve = async () => new Response(html, { headers: {
        "content-type": "text/html; charset=utf-8",
        "x-njpbs-html-sha256": request.headers.get("x-njpbs-html-sha256"),
      } });
      const first = serveDonationDocument(target, serve, readHealth, ctx);
      const second = serveDonationDocument(target, serve, readHealth, ctx);
      const bodies = await Promise.all([first, second].map(async response => (await response).text()));
      if (pending.length !== 1 || bodies.some(body => body !== html)) {
        throw new Error("Cold page must serve original bytes and queue one health read");
      }
      await pending[0];
      return serveDonationDocument(target, serve, readHealth, ctx);
    } };
  ` }, bundle: true, write: false, format: "esm" });
  const worker = new Miniflare({ workers: [{ config: { name: "donation-fallback", type: "worker",
    compatibilityDate: "2026-07-09", manifest: { mainModule: "index.js", modules: {
      "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
    } } }, dev: { outboundService: { type: "fetcher", handler: request => {
      if (request.url !== "https://us-central1-fixture.cloudfunctions.net/donationHealth" ||
          request.method !== "GET" || request.headers.has("cookie") || request.headers.has("authorization")) {
        throw new Error("Unexpected donation-health request");
      }
      if (!signal) return new WorkerResponse(null, { status: 503 });
      return WorkerResponse.json({ status: signal.kind === "reachable" ? "reachable" : signal.status });
    } } } }] });
  try {
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    const response = await worker.dispatchFetch("https://example.org/", {
      method: "POST",
      body: html,
      headers: { "x-njpbs-html-sha256": digest(html) },
    });
    if (!response.ok) throw new Error(`Donation fixture render failed (${response.status})`);
    const output = await response.text();
    if (response.headers.get("x-njpbs-html-sha256") !== digest(output)) {
      throw new Error("Donation render did not bind the served HTML digest");
    }
    return output;
  } finally {
    await worker.dispose();
  }
}
