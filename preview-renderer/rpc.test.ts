import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sha = "a".repeat(40);
const outbound = vi.fn(() => new Response("Unexpected outbound request", { status: 500 }));
let runtime: Miniflare;

beforeAll(async () => {
  // Compile with the deployed Wrangler nodejs_compat adapters. Bare esbuild
  // externalizes CommonJS require("node:crypto") without the ESM adapter and
  // cannot represent the actual deployed Worker bundle.
  const directory = await mkdtemp(path.join(tmpdir(), "preview-rpc-worker-"));
  let script: string;
  try {
    const config = path.join(directory, "wrangler.json"), out = path.join(directory, "out");
    await writeFile(config, JSON.stringify({ name: "preview-rpc-fixture", main: fileURLToPath(new URL("./worker.ts", import.meta.url)),
      compatibility_date: "2026-09-08", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false, routes: [] }));
    const wrangler = fileURLToPath(new URL("../bin/wrangler.js", pathToFileURL(createRequire(import.meta.url).resolve("wrangler"))));
    await promisify(execFile)(process.execPath, [wrangler, "deploy", "--dry-run", "--config", config, "--outdir", out],
      { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 25_000, maxBuffer: 1024 * 1024 });
    script = await readFile(path.join(out, "worker.js"), "utf8");
  } finally { await rm(directory, { recursive: true, force: true }); }
  const renderer = (name: string, enabled: string) => ({
    name,
    modules: true,
    script,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { PREVIEW_RENDERER_ENABLED: enabled, PREVIEW_RENDERER_SHA: sha },
    // No container binding or credentials: touching either path must fail.
    outboundService: outbound,
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    workers: [
      {
        name: "caller",
        modules: true,
        compatibilityDate: "2026-09-08",
        serviceBindings: { DISABLED: "disabled", ENABLED: "enabled", OLD: "old" },
        script: `export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            const target = env[url.searchParams.get("target")];
            if (url.pathname === "/http") return target.fetch(request);
            try {
              await target.wake(url.searchParams.get("sha"));
              return Response.json({ wake: "resolved" }, { status: 202 });
            } catch (error) {
              return Response.json({ wake: "rejected", error: error.message }, { status: 202 });
            }
          }
        };`,
      },
      renderer("disabled", "false"),
      renderer("enabled", "true"),
      {
        name: "old",
        modules: true,
        compatibilityDate: "2026-09-08",
        script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
      },
    ],
  }));
  await runtime.ready;
}, 30_000);

afterAll(async () => { await runtime?.dispose(); });

describe("private renderer service binding RPC", () => {
  it("calls the actual default entrypoint while disabled without IO", async () => {
    const response = await runtime.dispatchFetch(`https://caller/wake?target=DISABLED&sha=${sha}`);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ wake: "resolved" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("keeps HTTP requests closed", async () => {
    const response = await runtime.dispatchFetch("https://caller/http?target=ENABLED");
    expect(response.status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects a different release before IO", async () => {
    const response = await runtime.dispatchFetch(`https://caller/wake?target=ENABLED&sha=${"b".repeat(40)}`);
    expect(await response.json()).toEqual({ wake: "rejected", error: "Cloud preview wake release differs" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("lets an optional caller retain acceptance when the old target lacks wake", async () => {
    const response = await runtime.dispatchFetch(`https://caller/wake?target=OLD&sha=${sha}`);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ wake: "rejected", error: expect.stringMatching(/wake|RPC|entrypoint/i) });
    expect(outbound).not.toHaveBeenCalled();
  });
});
