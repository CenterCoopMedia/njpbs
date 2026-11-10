import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { politicsResourceContentPlugin } from "../build/politics-resource-content";
import { ROUTE_PATHS } from "../src/lib/routes";
import { onRequest } from "../functions/_middleware";
import { WHATS_NEW_NOTES } from "../src/data/whats-new";
import { LATEST_WHATS_NEW_ID } from "../src/lib/whats-new-seen";

// Proves the Cloudflare Pages routing files survive a real build: Vite copies the explicit route
// allowlist and top-level 404 boundary from public/ to dist/. The string resolver below checks only
// the committed allowlist. Provider HTTP behavior remains a deployment check because this helper
// does not model Pages' HTML canonicalization, SPA fallback, or header application.

// The admin app root. Vitest runs with the admin directory (its config root) as the working
// directory, so this resolves the project the build should read. import.meta.url is not a usable
// file URL under the vitest module runner on Windows, so the working directory is the reliable
// anchor here.
const adminRoot = process.cwd();
const distDir = path.join(adminRoot, "dist");

interface RedirectRule {
  from: string;
  to: string;
  status: string;
}

function parseHeaderBlocks(source: string): Map<string, Set<string>> {
  const blocks = new Map<string, Set<string>>();
  let pattern: string | null = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!/^\s/.test(rawLine)) {
      pattern = line;
      if (!blocks.has(pattern)) blocks.set(pattern, new Set());
      continue;
    }
    if (!pattern || !line.toLowerCase().startsWith("cache-control:")) continue;
    for (const directive of line.slice(line.indexOf(":") + 1).split(",")) {
      blocks.get(pattern)?.add(directive.trim().toLowerCase());
    }
  }
  return blocks;
}

function parseRedirects(source: string): RedirectRule[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const [from, to, status] = line.split(/\s+/);
      return { from, to, status };
    });
}

// Cloudflare matches rules top to bottom, first match wins; a trailing /* is a splat. Returns the
// destination of the first matching rule, or null when nothing matches (the request falls through
// to a real file).
function resolve(rules: RedirectRule[], requestPath: string): string | null {
  for (const rule of rules) {
    if (rule.from.endsWith("/*")) {
      const prefix = rule.from.slice(0, -2);
      if (requestPath === prefix || requestPath.startsWith(`${prefix}/`)) return rule.to;
    } else if (requestPath === rule.from) {
      return rule.to;
    }
  }
  return null;
}

// One record per emitted chunk in Vite's build manifest. `imports` is the chunk's *static*
// imports, keyed the same way the manifest itself is; `dynamicImports` are the split points a
// route loader reaches. The distinction is the whole point of the graph guard below: a static
// edge from the entry is a file every initial load downloads, a dynamic edge is not.
interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}

// Every chunk the browser must fetch before the entry can run: the entry's static imports,
// their static imports, and so on. Vite writes exactly this set into index.html as modulepreload
// links, so this closure is the built answer to "what does a signed-in editor download first."
function entryStaticClosure(manifest: Record<string, ManifestChunk>): Set<string> {
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  if (!entryKey) throw new Error("the build manifest has no entry chunk");
  const seen = new Set<string>();
  const pending = [...(manifest[entryKey].imports ?? [])];
  while (pending.length > 0) {
    const key = pending.shift() as string;
    // Shared chunks import each other, and some import the entry back; without this the walk
    // would not terminate.
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...(manifest[key]?.imports ?? []));
  }
  return new Set([...seen].map((key) => manifest[key]?.file ?? key));
}

let rules: RedirectRule[] = [];
let javascriptAssets: string[] = [];
let buildManifest: Record<string, ManifestChunk> = {};
let initialChunks: Set<string> = new Set();
let statusManifest: unknown;
let unavailableStatusManifest: unknown;
let notFoundHtml = "";
let builtHeaders = "";
let functionsRoutes: unknown;

const builtStatusManifest = {
  schemaVersion: 2,
  status: "current",
  environment: "Production",
  generatedAt: "2026-08-17T18:00:00.000Z",
  refreshAfter: "2026-08-18T18:00:00.000Z",
  build: {
    revision: "d805028221a24448055bf0adcce344d1921547b7",
    builtAt: "2026-08-17T18:00:00.000Z",
  },
  milestone: {
    number: 16,
    title: "M14: Admin interface + UX",
    state: "open",
    openIssues: 7,
    closedIssues: 30,
    updatedAt: "2026-08-17T17:30:00.000Z",
    url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
  },
  milestones: [
    {
      number: 16,
      title: "M14: Admin interface + UX",
      state: "open",
      openIssues: 7,
      closedIssues: 30,
      updatedAt: "2026-08-17T17:30:00.000Z",
      url: "https://github.com/CenterCoopMedia/njpbs/milestone/16",
    },
  ],
};

beforeAll(async () => {
  const priorManifest = process.env.ADMIN_STATUS_MANIFEST_BASE64;
  const priorNodeEnv = process.env.NODE_ENV;
  try {
    // Vite preserves Vitest's NODE_ENV=test unless production is explicit.
    // Use the shipped React runtime and JSX transform for the budget checks.
    process.env.NODE_ENV = "production";
    delete process.env.ADMIN_STATUS_MANIFEST_BASE64;
    await build({
      root: adminRoot,
      configFile: path.join(adminRoot, "vite.config.ts"),
      logLevel: "silent",
      plugins: [politicsResourceContentPlugin(path.join(adminRoot, "tests/fixtures/resources"))],
      build: { emptyOutDir: true, manifest: true },
    });
    unavailableStatusManifest = JSON.parse(
      readFileSync(path.join(distDir, "admin-status.json"), "utf8"),
    );
    process.env.ADMIN_STATUS_MANIFEST_BASE64 = Buffer.from(
      JSON.stringify(builtStatusManifest),
    ).toString("base64");
    await build({
      root: adminRoot,
      configFile: path.join(adminRoot, "vite.config.ts"),
      logLevel: "silent",
      plugins: [politicsResourceContentPlugin(path.join(adminRoot, "tests/fixtures/resources"))],
      build: { emptyOutDir: true, manifest: true },
    });
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorManifest === undefined) delete process.env.ADMIN_STATUS_MANIFEST_BASE64;
    else process.env.ADMIN_STATUS_MANIFEST_BASE64 = priorManifest;
  }
  rules = parseRedirects(readFileSync(path.join(distDir, "_redirects"), "utf8"));
  builtHeaders = readFileSync(path.join(distDir, "_headers"), "utf8");
  functionsRoutes = JSON.parse(readFileSync(path.join(distDir, "_routes.json"), "utf8"));
  notFoundHtml = readFileSync(path.join(distDir, "404.html"), "utf8");
  statusManifest = JSON.parse(
    readFileSync(path.join(distDir, "admin-status.json"), "utf8"),
  );
  javascriptAssets = readdirSync(path.join(distDir, "assets")).filter((name) =>
    name.endsWith(".js"),
  );
  buildManifest = JSON.parse(
    readFileSync(path.join(distDir, ".vite", "manifest.json"), "utf8"),
  );
  initialChunks = entryStaticClosure(buildManifest);
}, 180000);

describe("built _redirects", () => {
  it("emits an explicit unavailable snapshot when no build manifest is provided", () => {
    expect(unavailableStatusManifest).toMatchObject({
      schemaVersion: 2,
      status: "unavailable",
      environment: "Local",
      build: null,
      milestone: null,
      milestones: null,
    });
  });

  it("emits the reviewed build status as a same-origin asset", () => {
    expect(statusManifest).toEqual({
      ...builtStatusManifest, milestone: null, milestones: null,
    });
    expect(JSON.parse(readFileSync(
      path.join(distDir, "guide-content/admin-status.json"), "utf8"),
    )).toEqual(builtStatusManifest);
  });
  it("places the app entry and a hashed script in dist", () => {
    expect(existsSync(path.join(distDir, "index.html"))).toBe(true);
    const assets = existsSync(path.join(distDir, "assets"))
      ? readdirSync(path.join(distDir, "assets"))
      : [];
    expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
  });

  it("splits Firebase and destination routes below the build warning threshold", () => {
    expect(
      javascriptAssets.some((name) => name.startsWith("Primitives-")),
    ).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("firebase-"))).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("react-router-"))).toBe(true);
    expect(
      javascriptAssets.some(
        (name) => name.startsWith("react-") && !name.startsWith("react-router-"),
      ),
    ).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("tiptap-"))).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("DashboardRoute-"))).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("ContentLayout-"))).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("QueueRoute-"))).toBe(true);
    expect(
      javascriptAssets.some((name) => name.startsWith("AccountSettingsRoute-")),
    ).toBe(true);
    expect(
      javascriptAssets.some((name) => name.startsWith("AdminSettingsRoute-")),
    ).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("CostLedgerRoute-"))).toBe(false);
    expect(javascriptAssets.some((name) => name.startsWith("StaffRoute-"))).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("guide-resource-chunk-"))).toBe(true);
    expect(javascriptAssets.some((name) => name.startsWith("NotFound-"))).toBe(true);

    for (const asset of javascriptAssets) {
      if (asset.startsWith("react-") && !asset.startsWith("react-router-")) {
        expect(
          readFileSync(path.join(distDir, "assets", asset), "utf8").includes(".jsxDEV"),
          `${asset} contains the development JSX runtime`,
        ).toBe(false);
      }
      // The search worker contains the local inference runtime, outside the UI
      // thread. Keep a separate bounded budget; destination chunks stay at 500 kB.
      const budget = /^worker-[A-Za-z0-9_-]{8}\.js$/.test(asset) ? 600_000 : 500_000;
      expect(
        statSync(path.join(distDir, "assets", asset)).size,
        `${asset} exceeds its ${budget / 1000} kB budget`,
      ).toBeLessThan(budget);
    }
  });

  // The committed shelf catalogs (#1046) are editor content: several kilobytes of story
  // and video records that only an editor placing a dynamic shelf ever needs. They belong
  // in the content destination's chunk, never in the entry every signed-in editor
  // downloads before any route mounts. This is easy to lose by accident -- one import of
  // a renderer helper from a module the entry already reaches drags the whole catalog
  // back -- so the built output is the thing asserted, not the import graph.
  it("keeps the shelf catalogs out of the entry chunk", () => {
    const entry = javascriptAssets.filter((name) => name.startsWith("index-"));
    expect(entry.length).toBeGreaterThan(0);
    for (const asset of entry) {
      const source = readFileSync(path.join(distDir, "assets", asset), "utf8");
      expect(source, `${asset} carries the related-story catalog`).not.toContain(
        "Delaney Hall crash",
      );
      expect(source, `${asset} carries a shelf catalog provenance note`).not.toContain(
        "njspotlightnews.org/2026/06/",
      );
    }
  });

  it("loads only the latest What's new id at startup and keeps all notes in one lazy chunk", () => {
    const entry = Object.values(buildManifest).find(chunk => chunk.isEntry)!;
    const initial = [entry.file, ...initialChunks]
      .map(file => readFileSync(path.join(distDir, file), "utf8")).join("\n");
    expect(initial).toContain(LATEST_WHATS_NEW_ID);
    const notesChunk = buildManifest["src/data/whats-new.ts"];
    expect(notesChunk, "notes must retain their lazy entry").toBeDefined();
    expect(initialChunks.has(notesChunk.file)).toBe(false);
    expect(notesChunk.dynamicImports ?? [], "opening notes must not fetch each fragment").toEqual([]);
    const notesSource = readFileSync(path.join(distDir, notesChunk.file), "utf8");
    for (const note of WHATS_NEW_NOTES) {
      expect(initial).not.toContain(note.body);
      expect(notesSource).toContain(note.body);
    }
  });

  // The rich-text editor is the heaviest dependency in the app and only an open editor uses it.
  // It must reach the browser with the content destination, never on the initial load every
  // signed-in editor pays for. Two ways to lose that, so two assertions.
  //
  // The first is the editor's code being merged into the entry chunk, which a text search of
  // the entry catches.
  it("keeps the rich-text editor out of the entry chunk", () => {
    const entry = javascriptAssets.filter((name) => name.startsWith("index-"));
    expect(entry.length).toBeGreaterThan(0);
    for (const asset of entry) {
      const source = readFileSync(path.join(distDir, "assets", asset), "utf8");
      expect(source, `${asset} carries the TipTap editor core`).not.toContain(
        "Duplicate extension names found",
      );
    }
  });

  // The second is the quieter one, and a text search cannot see it: the editor stays in its own
  // file while the entry gains a *static import* of that file, because some shell-reachable
  // module started importing a rich-text helper. The entry chunk's size never moves, the
  // TipTap literals are still only in tiptap-*.js, and every initial load now downloads the
  // editor anyway. So assert the built graph instead of the bytes: walk the entry's transitive
  // static imports in the build manifest -- the same set Vite writes into index.html as
  // modulepreload links -- and require the editor family to be absent from it.
  //
  // Stated in both directions, because "not in the initial load" is only half the intent.
  // React, the router, and Firebase SHOULD be static imports of the entry: they are vendor
  // chunks for cacheability, not deferred work, and the authentication graph needs all three
  // before any route mounts. If one of them ever falls out of this closure it has become a
  // lazy dependency of the shell, which is a load-order change, not a bundling detail.
  it("loads the vendor libraries the shell needs, and not the editor, on first paint", () => {
    const initial = [...initialChunks];
    const named = (prefix: string) =>
      initial.filter((file) => file.startsWith(`assets/${prefix}`));

    // react-router- also starts with react-, so React is counted by exclusion; otherwise the
    // router alone would satisfy the React assertion.
    expect(
      named("react-").filter((file) => !file.startsWith("assets/react-router-")).length,
      "React is not an initial chunk",
    ).toBe(1);
    expect(named("react-router-").length, "the router is not an initial chunk").toBe(1);
    expect(named("firebase-").length, "Firebase is not an initial chunk").toBe(1);

    expect(named("tiptap-"), "the editor is downloaded before any route mounts").toEqual([]);
    expect(named("prosemirror-"), "ProseMirror is downloaded before any route mounts").toEqual(
      [],
    );
    expect(named("ContentTab-"), "the content workspace is in the initial load").toEqual([]);
    expect(named("AdminSettingsRoute-"), "settings and Costs are in the initial load").toEqual([]);
    expect(named("guide-resource-chunk-"), "staff reference surfaces are in the initial load").toEqual([]);
  });

  // A direct browse address gets ContentTab without the rich-text family; opening a page or
  // record still reaches the editor as a dynamic descendant (#1129).
  it("keeps content browsing light and loads the editor only on demand", () => {
    const workspace = buildManifest["src/components/ContentTab.tsx"];
    expect(workspace, "the content workspace is no longer its own chunk").toBeDefined();

    const workspaceImports = (workspace.imports ?? []).map(
      (key) => buildManifest[key]?.file ?? key,
    );
    expect(
      workspaceImports.some(
        (file) =>
          file.startsWith("assets/tiptap-") ||
          file.startsWith("assets/prosemirror-"),
      ),
      "the browse workspace still statically imports the rich-text editor",
    ).toBe(false);
    expect(
      statSync(path.join(distDir, workspace.file)).size,
      `${workspace.file} exceeds the browse-workspace budget`,
    ).toBeLessThan(200_000);

    const editorKey = (workspace.dynamicImports ?? []).find((key) =>
      key.endsWith("src/components/EditorWorkspace.tsx"),
    );
    expect(
      editorKey,
      "ContentTab no longer exposes an on-demand editor boundary",
    ).toBeDefined();

    const seen = new Set<string>();
    const pending = [editorKey as string];
    while (pending.length > 0) {
      const key = pending.shift() as string;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(...(buildManifest[key]?.imports ?? []));
    }
    const editorFiles = [...seen].map(
      (key) => buildManifest[key]?.file ?? key,
    );
    expect(
      editorFiles.some((file) => file.startsWith("assets/tiptap-")),
      "the deferred editor graph no longer reaches TipTap",
    ).toBe(true);
  });

  it("keeps secondary media workspaces out of the Images route graph", () => {
    const media = buildManifest["src/routes/MediaRoute.tsx"];
    expect(media, "the Media route is no longer its own chunk").toBeDefined();

    const secondaryKey = (media.dynamicImports ?? []).find((key) =>
      buildManifest[key]?.file.startsWith("assets/media-secondary-"),
    );
    expect(
      secondaryKey,
      "the secondary media workspaces no longer have a lazy boundary",
    ).toBeDefined();

    const seen = new Set<string>();
    const pending = [...(media.imports ?? [])];
    while (pending.length > 0) {
      const key = pending.shift() as string;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(...(buildManifest[key]?.imports ?? []));
    }
    expect(
      seen.has(secondaryKey as string),
      "the Images route statically imports the secondary media workspaces",
    ).toBe(false);
    expect(
      statSync(path.join(distDir, media.file)).size,
      `${media.file} exceeds the Images route-shell budget`,
    ).toBeLessThan(100_000);
  });

  // A ceiling with no headroom is a tripwire on the next contributor rather than on the
  // change that earned it: before #1122 the entry sat 3.5 kB below the 500 kB per-chunk cap,
  // most of it React and the router. With those grouped as vendor code the entry is what this
  // app actually wrote -- the shell, the auth screens, and the route table -- so hold it to a
  // budget sized for that. This is deliberately far below the 500 kB cap: crossing it means
  // application code the entry loads before any route has roughly doubled, which is worth a
  // deliberate decision (split a surface behind a route, or move the code) rather than a
  // silent slide back toward the cap.
  it("keeps the entry chunk within its application-code budget", () => {
    const entry = javascriptAssets.filter((name) => name.startsWith("index-"));
    expect(entry.length).toBe(1);
    const size = statSync(path.join(distDir, "assets", entry[0])).size;
    expect(size, `${entry[0]} exceeds the entry chunk budget`).toBeLessThan(250_000);
  });

  it("ships the explicit redirects and top-level 404 boundary", () => {
    expect(existsSync(path.join(distDir, "_redirects"))).toBe(true);
    expect(existsSync(path.join(distDir, "404.html"))).toBe(true);
    expect(existsSync(path.join(distDir, "gallery.html"))).toBe(false);
    expect(rules.length).toBeGreaterThan(0);
    expect(notFoundHtml).toContain("Page not found");
    expect(notFoundHtml).toContain('name="robots" content="noindex, nofollow, noarchive"');
    expect(notFoundHtml).not.toMatch(/<script\b/i);
  });

  it("ships guide files only below the Pages Function protected prefix", () => {
    expect(functionsRoutes).toEqual({
      version: 1,
      include: ["/*"],
      exclude: [],
    });
    expect(existsSync(path.join(distDir, "guide-content", "manifest.json"))).toBe(true);
    const research = JSON.parse(readFileSync(path.join(distDir, "guide-content", "resources", "nj-politics.json"), "utf8"));
    const biography = research.people?.find((person: { summary?: unknown }) =>
      typeof person.summary === "string" && person.summary.length > 60 && /^[a-zA-Z0-9 ,.;:-]+$/.test(person.summary),
    )?.summary;
    expect(biography, "the research fixture must supply a distinct full biography").toBeDefined();
    for (const publicFile of ["index.html", ...javascriptAssets.map(name => `assets/${name}`)]) {
      expect(readFileSync(path.join(distDir, publicFile), "utf8"), `${publicFile} contains private research`).not.toContain(biography);
    }
    const search = JSON.parse(
      readFileSync(path.join(distDir, "guide-content", "search.json"), "utf8"),
    ) as { passages?: Array<{ url?: string; text?: string }> };
    expect(search.passages?.length).toBeGreaterThan(10);
    expect(search.passages?.every((passage) => passage.url?.startsWith("/guide/"))).toBe(true);
    expect(JSON.stringify(search)).not.toContain("dev-public.example.org");
    expect(existsSync(path.join(distDir, "guide-content", "pages", "overview.md"))).toBe(true);
    // The public source omits staff screenshots; do not require an excluded image.
    expect(existsSync(path.join(distDir, "guide-content", "images", "home.webp"))).toBe(false);
  });

  it("keeps emitted assets immutable and missing assets uncached within the Pages rule limit", async () => {
    const blocks = parseHeaderBlocks(builtHeaders);
    const emittedAssets = readdirSync(path.join(distDir, "assets"))
      .map(name => `/assets/${name}`).sort();
    const immutablePatterns = [...blocks]
      .filter(([, directives]) => directives.has("immutable"))
      .map(([pattern]) => pattern).sort();
    expect(emittedAssets.length).toBeGreaterThan(0);
    expect(emittedAssets.every(file => /^\/assets\/.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(file))).toBe(true);
    expect(immutablePatterns).toEqual(["/assets/*"]);
    for (const asset of emittedAssets) {
      const directives = blocks.get("/assets/*");
      expect(directives, asset).toContain("public");
      expect(directives, asset).toContain("max-age=31536000");
      expect(directives, asset).toContain("immutable");
      expect(directives, asset).not.toContain("no-store");
    }
    expect(blocks.has("/assets/*")).toBe(true);
    expect(blocks.has("/assets/missing-direct-link-check.js")).toBe(false);
    expect(blocks.size).toBeLessThanOrEqual(80);

    // Pages applies the wildcard before the existing middleware sees the static
    // response. A missing fingerprinted URL must not inherit a year of caching.
    const cacheControl = [...blocks.get("/assets/*")!].join(", ");
    for (const method of ["GET", "HEAD"]) {
      const response = await onRequest({
        request: new Request("https://admin.example.test/assets/missing-Abcd1234.js", { method }),
        env: {
          ASSETS: { fetch: async () => { throw new Error("Unexpected asset fetch"); } },
          STAFF_ACCESS: { validateAccess: async () => { throw new Error("Unexpected staff check"); } },
        },
        next: async () => new Response(method === "HEAD" ? null : notFoundHtml, {
          status: 404,
          headers: { "cache-control": cacheControl, "content-type": "text/html" },
        }),
      });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("cdn-cache-control")).toBe("no-store");
      expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
      expect(await response.text()).toBe(method === "HEAD" ? "" : notFoundHtml);
    }
  });

  it("scopes the rewrites to route prefixes, never a blanket or asset capture", () => {
    expect(rules.some((rule) => rule.from === "/*")).toBe(false);
    expect(rules.some((rule) => rule.from.startsWith("/assets"))).toBe(false);
    // Every rule proxies the app root with a 200. Pages canonicalizes /index.html to /,
    // so /index.html is not a safe proxy destination for a route that must retain its URL.
    for (const rule of rules) {
      expect(rule.to).toBe("/");
      expect(rule.status).toBe("200");
    }
  });

  it("keeps reference routes, research data and the guide worker out of caches", () => {
    const blocks = parseHeaderBlocks(readFileSync(path.join(distDir, "_headers"), "utf8"));
    for (const requestPath of [
      "/resources/nj-politics", "/resources/nj-politics/",
      "/guide-content/resources/nj-politics.json", "/guide-video-sw.js",
    ]) {
      const directives = new Set([...blocks].flatMap(([pattern, values]) => {
        const expression = pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
        return new RegExp(`^${expression}$`).test(requestPath) ? [...values] : [];
      }));
      expect(directives, requestPath).toContain("private");
      expect(directives, requestPath).toContain("no-store");
      expect(directives, requestPath).not.toContain("public");
      expect(directives, requestPath).not.toContain("immutable");
    }
  });

  it("rewrites each known route prefix to the app entry", () => {
    expect(rules.some((rule) => rule.from === "/account")).toBe(true);
    expect(rules.some((rule) => rule.from === "/account/*")).toBe(true);
    expect(resolve(rules, "/account")).toBe("/");
    expect(resolve(rules, "/account/settings")).toBe("/");
    expect(resolve(rules, "/account/profile")).toBe("/");
    expect(resolve(rules, "/admin/settings")).toBe("/");
    expect(resolve(rules, "/dashboard")).toBe("/");
    expect(resolve(rules, "/content")).toBe("/");
    expect(resolve(rules, "/activity")).toBe("/");
    expect(resolve(rules, "/media")).toBe("/");
    expect(resolve(rules, "/media/images")).toBe("/");
    expect(resolve(rules, "/media/videos/archive-originals")).toBe("/");
    expect(resolve(rules, "/media/favorites")).toBe("/");
    expect(resolve(rules, "/media/collections")).toBe("/");
    expect(resolve(rules, `/media/collections/${"a".repeat(64)}`)).toBe("/");
    expect(resolve(rules, "/media/voiceovers")).toBe("/");
    expect(resolve(rules, "/voiceovers")).toBe("/");
    expect(resolve(rules, "/guide")).toBe("/");
    expect(resolve(rules, "/guide/overview")).toBe("/");
    expect(resolve(rules, "/publish-queue")).toBe("/");
    expect(resolve(rules, "/staff-access")).toBe("/");
    expect(resolve(rules, "/staff-profiles")).toBe("/");
  });

  // The named checks above only cover the paths someone remembered to list. This walks
  // the route vocabulary itself, so a route added without a rewrite fails here rather
  // than 404ing on the first reload or bookmark in production.
  it("covers every path in the route vocabulary, with no rule to spare", () => {
    for (const [name, routePath] of Object.entries(ROUTE_PATHS)) {
      if (routePath === "/") continue;
      expect(resolve(rules, routePath), `${name} (${routePath}) has no rewrite`).toBe(
        "/",
      );
      expect(resolve(rules, `${routePath}/`), `${name} (${routePath}/) has no trailing-slash rewrite`).toBe(
        "/",
      );
    }

    // And no rule points somewhere the app does not route at all. A rule may sit on a
    // parent segment (/account carries /account/settings and /account/profile), so a
    // prefix match counts; anything unrelated does not.
    const known = Object.values(ROUTE_PATHS);
    for (const rule of rules) {
      const sourcePath = rule.from.endsWith("/*") ? rule.from.slice(0, -2) : rule.from;
      const routePath = sourcePath.replace(/\/+$/, "") || "/";
      expect(
        known.some(
          (candidate) =>
            candidate === routePath || candidate.startsWith(`${routePath}/`),
        ),
        `${rule.from} is not an app route`,
      ).toBe(true);
    }
  });

  it("rewrites a deep content path so a reload or deep link boots the app", () => {
    expect(resolve(rules, "/content/pages/home/edit")).toBe("/");
    expect(resolve(rules, "/content/article/+")).toBe("/");
  });

  it("adds no proxy rule for assets, static files, or unknown top-level paths", () => {
    expect(resolve(rules, "/assets/index-abc123.js")).toBeNull();
    expect(resolve(rules, "/favicon.svg")).toBeNull();
    expect(resolve(rules, "/index.html")).toBeNull();
    expect(resolve(rules, "/404.html")).toBeNull();
    expect(resolve(rules, "/missing-admin-route")).toBeNull();
  });
});
