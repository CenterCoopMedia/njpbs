import { build } from "esbuild";
import { Miniflare } from "miniflare";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const postUrl = "https://njpbs.org/posts/cache-test/";
const notFound = "<!doctype html><title>Page not found</title>";
const published = "<!doctype html><title>Published Post</title>";
let directory;
let runtime;
let options;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "njpbs-post-cache-"));
  const assets = join(directory, "assets");
  await mkdir(join(assets, "posts/cache-test"), { recursive: true });
  await mkdir(join(assets, "about"));
  await mkdir(join(assets, "search"));
  await mkdir(join(assets, "feeds"));
  await mkdir(join(assets, "api/v1"), { recursive: true });
  await writeFile(join(assets, "search/index.html"), "Ordinary search HTML");
  await writeFile(join(assets, "feeds/other.xml"), "Unselected feed");
  await writeFile(join(assets, "api/v1/other.json"), "Unselected API");
  await writeFile(join(assets, "404.html"), notFound);
  await writeFile(
    join(assets, "about/index.html"),
    "<!doctype html><title>About</title>",
  );
  await copyFile(join(root, "site/public/_headers"), join(assets, "_headers"));
  const config = JSON.parse(
    (await readFile(join(root, "workers/wrangler.jsonc"), "utf8")).replace(
      /^\s*\/\/.*$/gm,
      "",
    ),
  );
  const bundle = await build({
    entryPoints: [join(root, "workers", config.main)],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    // This Assets contract runs before generated templates exist. The filesystem
    // fixture must never render; the real compiled graph is a named release check.
    plugins: [{ name: "inactive-public-renderer", setup(bundler) {
      bundler.onResolve({ filter: /\.public-post-renderer\/server\/entry\.mjs$/ }, () => ({ path: "public-renderer", namespace: "compiled-fixture" }));
      bundler.onLoad({ filter: /.*/, namespace: "compiled-fixture" }, () => ({ contents:
        `export const rendererSha = "${"a".repeat(40)}";
         function inactive() { throw new Error("Inactive renderer was reached"); }
         export { inactive as renderPublishedPost, inactive as renderPublishedPage, inactive as renderPublicPageContext };`, loader: "js" }));
    } }],
  });
  options = {
    workers: [
      {
        config: {
          name: "public-post-cache",
          type: "worker",
          compatibilityDate: config.compatibility_date,
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
            },
          },
          env: { [config.assets.binding]: { type: "assets" },
            CMS_API: { type: "worker", workerName: "unowned-post-reader" } },
          assets: {
            directory: assets,
            hasUserWorker: true,
            runWorkerFirst: config.assets.run_worker_first,
            htmlHandling: config.assets.html_handling,
            notFoundHandling: config.assets.not_found_handling,
          },
        },
        // Refuse external network access. Authority and assets are local bindings.
        dev: {
          outboundService: {
            type: "fetcher",
            handler: () => new Response(null, { status: 502 }),
          },
        },
      },
      {
        config: {
          name: "unowned-post-reader",
          type: "worker",
          compatibilityDate: config.compatibility_date,
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: `
                import { WorkerEntrypoint } from "cloudflare:workers";
                export default class extends WorkerEntrypoint {
                  getNoBuildPost() { return { kind: "pass" }; }
                }
              ` },
            },
          },
        },
      },
    ],
  };
  runtime = new Miniflare(options);
  await runtime.ready;
});

afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("public Post asset delivery", () => {
  it.each([["/search/", "Ordinary search HTML"], ["/feeds/other.xml", "Unselected feed"],
    ["/api/v1/other.json", "Unselected API"]])("keeps %s outside Post authority during an outage", async (path, body) => {
    const worker = options.workers[0];
    const { CMS_API, ...unbound } = worker.config.env;
    expect(CMS_API).toBeDefined();
    try {
      await runtime.setOptions({ workers: [{ ...worker, config: { ...worker.config, env: unbound } }, ...options.workers.slice(1)] });
      const response = await runtime.dispatchFetch(`https://njpbs.org${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      expect(response.headers.has("x-njpbs-publication-refresh")).toBe(false);
    } finally { await runtime.setOptions(options); }
  });
  it("keeps Assets available when authority is unavailable before any admission", async () => {
    const worker = options.workers[0];
    const { CMS_API, ...withoutReader } = worker.config.env;
    expect(CMS_API).toBeDefined();
    try {
      await runtime.setOptions({ workers: [{ ...worker, config: { ...worker.config, env: withoutReader } }, ...options.workers.slice(1)] });
      for (const path of ["/posts/cache-test/", "/feeds/news.xml", "/authors/cache-test/", "/_publication.json"]) {
        const response = await runtime.dispatchFetch(`https://njpbs.org${path}`);
        // Serve the existing Assets result during authority outages.
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).toBe(notFound);
      }
    } finally { await runtime.setOptions(options); }
  });

  it("uses the reader for retained ownership and passes unowned routes to Assets", async () => {
    const worker = options.workers[0];
    try {
      await runtime.setOptions({ workers: [
        { ...worker, config: { ...worker.config, env: { ...worker.config.env,
          NO_BUILD_POST_ID: { type: "text", value: "retained-post" },
          CMS_API: { type: "worker", workerName: "unowned-post-reader" },
        } } },
        ...options.workers.slice(1),
      ] });
      const response = await runtime.dispatchFetch(postUrl);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(notFound);
    } finally {
      await runtime.setOptions(options);
    }
  });

  it("serves existing full-build Post HTML when the authority binding is missing", async () => {
    const worker = options.workers[0];
    const { CMS_API: _reader, ...unbound } = worker.config.env;
    const file = join(directory, "assets/posts/cache-test/index.html");
    await writeFile(file, published);
    try {
      await runtime.setOptions({ workers: [
        { ...worker, config: { ...worker.config, env: { ...unbound,
          NO_BUILD_POST_ID: { type: "text", value: "retained-post" },
        } } },
        ...options.workers.slice(1),
      ] });
      const response = await runtime.dispatchFetch(postUrl);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-njpbs-content-source")).not.toBe("cms-no-build");
      expect(await response.text()).toBe(published);
    } finally {
      await rm(file);
      await runtime.setOptions(options);
    }
  });

  it.each([
    ["plain GET", {}],
    [
      "desktop navigation",
      {
        headers: { "sec-fetch-mode": "navigate", "user-agent": "Desktop test" },
      },
    ],
    [
      "phone navigation",
      { headers: { "sec-fetch-mode": "navigate", "user-agent": "Phone test" } },
    ],
    ["prefetch", { headers: { purpose: "prefetch" } }],
    ["query string", {}, "?check=1"],
    ["HEAD", { method: "HEAD" }],
    ["Range", { headers: { range: "bytes=0-9" } }],
  ])(
    "does not store a missing Post response for %s",
    async (_name, init, query = "") => {
      const response = await runtime.dispatchFetch(`${postUrl}${query}`, init);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).toBe(
        init.method === "HEAD" ? "" : notFound,
      );
    },
  );

  it("keeps published and withdrawn Post HTML out of caches", async () => {
    const missing = await runtime.dispatchFetch(postUrl);
    expect(missing.status).toBe(404);
    const missingEtag = missing.headers.get("etag");
    expect(missingEtag).toBeTruthy();
    await missing.text();

    const file = join(directory, "assets/posts/cache-test/index.html");
    await writeFile(file, published);
    await runtime.setOptions(options);
    const live = await runtime.dispatchFetch(postUrl, {
      headers: { "if-none-match": missingEtag },
    });
    expect(live.status).toBe(200);
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.get("x-content-type-options")).toBe("nosniff");
    const liveEtag = live.headers.get("etag");
    expect(liveEtag).toBeTruthy();
    expect(await live.text()).toBe(published);

    const redirect = await runtime.dispatchFetch(postUrl.slice(0, -1), {
      redirect: "manual",
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/posts/cache-test/");
    await redirect.text();

    await rm(file);
    await runtime.setOptions(options);
    const withdrawn = await runtime.dispatchFetch(postUrl, {
      headers: { "if-none-match": liveEtag },
    });
    expect(withdrawn.status).toBe(404);
    expect(withdrawn.headers.get("cache-control")).toBe("no-store");
    expect(withdrawn.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await withdrawn.text()).toBe(notFound);
  });

  it("preserves other asset caching", async () => {
    const about = await runtime.dispatchFetch("https://njpbs.org/about/");
    expect(about.status).toBe(200);
    expect(about.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    expect(await about.text()).toContain("<title>About</title>");
  });
});
