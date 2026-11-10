import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const root = resolve(process.cwd(), "..");
const entry = resolve(root, "workers/src/public-no-build-entry.ts");
const stubs: Record<string, string> = {
  "./durable-record-withdrawals": "export const publicRecordFamily=()=>null,readDurableRecordAuthority=async()=>null;",
  "./no-build-page-worker": "export const isPageScheduleExportPath=()=>false,createNoBuildPageWorker=()=>({fetch:async()=>null});",
  "./durable-page-withdrawals": "export const readDurablePageWithdrawal=async()=>null;",
  "./transitional-post-read-worker": "export const createTransitionalPostReadWorker=()=>({fetch:async()=>null});",
  "../../site/.public-post-renderer/server/entry.mjs": "export const rendererSha='a'.repeat(40),renderPublishedPost=()=>{},renderPublishedPage=()=>{},renderPublicPageContext=()=>{};",
  "./durable-post-withdrawals": "export const readDurablePostWithdrawal=async()=>null;",
  "./no-build-code-post-worker": "export const createNoBuildCodePostWorker=()=>({fetch:async()=>null});",
  "./public-content-last-good": "export const createPublicContentLastGood=()=>undefined;",
  "./public-content-baseline": "export const createContentBaselineAssetReader=({fetchAsset})=>fetchAsset;",
};
let code: string;
beforeAll(async () => {
  // The source entry, observer and servePublicRequest are real. Mock only the
  // unrelated storage/renderer adapters; no generated release artifact is built.
  const result = await build({ stdin: { contents: 'export {default} from "./public-no-build-entry"; export {servePublicRequest} from "./public-worker";',
    resolveDir: resolve(root, "workers/src") }, bundle: true, write: false, format: "cjs", platform: "browser", plugins: [{ name: "entry-adapters",
    setup(plugin) {
      plugin.onResolve({ filter: /^\.{1,2}\// }, args => args.importer === entry && stubs[args.path]
        ? { path: args.path, namespace: "entry-adapter" } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: "entry-adapter" }, args => ({ contents: stubs[args.path], loader: "js" }));
    } }] });
  code = result.outputFiles[0].text;
});
afterEach(() => { vi.unstubAllGlobals(); });
function load() {
  const module = { exports: {} as any };
  new Function("module", "exports", code)(module, module.exports);
  return module.exports;
}
const request = () => new Request("https://njpbs.org/retained.txt");
const asset = () => new Response(new Uint8Array([0, 1, 2, 127, 128, 255]), { headers: { "content-type": "application/octet-stream", "x-retained": "exact" } });
it("runs the actual configured entry and preserves bytes with measurement disabled", async () => {
  expect(readFileSync(`${root}/workers/wrangler.jsonc`, "utf8")).toMatch(/"main":\s*"\.\/src\/public-no-build-entry\.ts"/);
  const module = load(), flag = vi.fn(() => undefined), binding = vi.fn(() => { throw new Error("No disabled binding access"); });
  const allocation = vi.fn(() => { throw new Error("No disabled observer buffer"); });
  const random = vi.fn(() => { throw new Error("No disabled randomness"); });
  vi.stubGlobal("Uint32Array", allocation); vi.stubGlobal("crypto", { getRandomValues: random, randomUUID: random });
  vi.stubGlobal("caches", { default: {} });
  const expected = await module.servePublicRequest(request(), { fetchAsset: asset, getPublishedPage: async () => null,
    noBuildPosts: { fetch: async () => null } });
  const actual = await module.default.fetch(request(), { ASSETS: { fetch: asset }, CMS_API: {},
    get PUBLIC_ISOLATE_START_MEASUREMENT_ENABLED() { return flag(); },
    get ISOLATE_START_ANALYTICS() { return binding(); }, get CF_VERSION_METADATA() { return binding(); } }, { waitUntil: vi.fn() });
  expect(actual.status).toBe(expected.status); expect([...actual.headers]).toEqual([...expected.headers]);
  expect(await actual.arrayBuffer()).toEqual(await expected.arrayBuffer());
  expect(flag).toHaveBeenCalledTimes(1); expect(binding).not.toHaveBeenCalled();
  expect(allocation).not.toHaveBeenCalled(); expect(random).not.toHaveBeenCalled();
});
it("the real entry attempts at most one start without awaiting telemetry or altering serving bytes", async () => {
  const module = load(), then = vi.fn(() => { throw new Error("No telemetry await"); });
  const write = vi.fn(() => ({ get then() { return then(); } }));
  vi.stubGlobal("caches", { default: {} });
  vi.stubGlobal("crypto", { getRandomValues: (values: Uint32Array) => { values[0] = 0; return values; },
    randomUUID: () => "87654321-4321-4321-8321-cba987654321" });
  const env = { ASSETS: { fetch: asset }, CMS_API: {}, PUBLIC_ISOLATE_START_MEASUREMENT_ENABLED: "true",
    ISOLATE_START_ANALYTICS: { writeDataPoint: write }, CF_VERSION_METADATA: { id: "12345678-1234-4234-8234-123456789abc" } };
  for (let requestNumber = 0; requestNumber < 2; requestNumber++) {
    const response = await module.default.fetch(request(), env, { waitUntil: vi.fn() });
    expect(await response.arrayBuffer()).toEqual(await asset().arrayBuffer());
  }
  expect(write).toHaveBeenCalledTimes(1); expect(then).not.toHaveBeenCalled();
});
