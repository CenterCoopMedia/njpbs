import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { familyFiles, parsePreparedBackground } from "../../site/scripts/no-build-post-background";

it("retains each family's referenced Astro graph with family files, byte digests and MIME types", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-assets-"));
  try {
    const fixtures = {
      "posts/index.html": '<link rel="stylesheet" href="/_astro/site.abc.css"><script src="/_astro/entry.ghi.js"></script>',
      "_astro/site.abc.css": '@font-face{src:url("./font.def.woff2")}',
      "_astro/font.def.woff2": "font bytes",
      "_astro/entry.ghi.js": 'import "./chunk.jkl.js";',
      "_astro/chunk.jkl.js": "export const n = 1;",
      "_astro/unreferenced.wasm": "unrelated search runtime",
      "private/fixture.txt": "excluded",
    };
    for (const [file, bytes] of Object.entries(fixtures)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), bytes);
    }
    // A real ONNX runtime is about 13 MB; unrelated site assets must not consume family capacity.
    await writeFile(path.join(directory, "_astro/unreferenced.wasm"), Buffer.alloc(17 * 1024 * 1024));
    const files = await familyFiles(directory);
    expect(files.map(file => file.path).sort()).toEqual([
      "/_astro/chunk.jkl.js", "/_astro/entry.ghi.js", "/_astro/font.def.woff2", "/_astro/site.abc.css", "/posts/",
    ]);
    for (const file of files) {
      const bytes = fixtures[file.file as keyof typeof fixtures];
      expect(file.size).toBe(Buffer.byteLength(bytes));
      expect(file.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    expect(files.find(file => file.path.endsWith(".woff2"))?.contentType).toBe("font/woff2");
    await symlink(path.join(directory, "private/fixture.txt"), path.join(directory, "_astro/link.js"));
    await expect(familyFiles(directory)).rejects.toThrow("contains a link");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("counts retained assets against each family's 256-file capacity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-assets-bound-"));
  try {
    await mkdir(path.join(directory, "_astro"));
    await mkdir(path.join(directory, "posts"));
    await writeFile(path.join(directory, "posts/index.html"), Array.from({ length: 257 }, (_, i) => `<script src="/_astro/asset.${i}.js"></script>`).join(""));
    for (let index = 0; index < 257; index++) await writeFile(path.join(directory, `_astro/asset.${index}.js`), "public");
    await expect(familyFiles(directory)).rejects.toThrow("Background family exceeds its bound");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("retains the immutable Home root and only its referenced asset graph", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-home-"));
  try {
    await mkdir(path.join(directory, "_astro"));
    await writeFile(path.join(directory, "index.html"), '<!doctype html><link rel="stylesheet" href="/_astro/home.css"><h1>Home</h1>');
    await writeFile(path.join(directory, "_home-sources.json"), '{"publication":{"generation":7}}');
    await writeFile(path.join(directory, "_astro/home.css"), 'body{background-image:url("./home.webp")}');
    await writeFile(path.join(directory, "_astro/home.webp"), "Home image");
    await writeFile(path.join(directory, "_astro/other.css"), "Unrelated stylesheet");
    const files = await familyFiles(directory);
    expect(files.map(file => [file.path, file.outputs]).sort()).toEqual([
      ["/", ["home"]], ["/_astro/home.css", ["home"]], ["/_astro/home.webp", ["home"]], ["/_home-sources.json", ["home"]],
    ]);
    expect(files.find(file => file.path === "/")?.contentType).toBe("text/html; charset=utf-8");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it("retains registered record routes and shared assets without claiming other families", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-records-"));
  const fixtures = {
    "programs/index.html": '<h1>Programs</h1><link href="/_astro/records.css" rel="stylesheet">',
    "programs/example/index.html": '<h1>Example</h1><link href="/_astro/records.css" rel="stylesheet">',
    "programs/old-example/index.html": '<meta http-equiv="refresh" content="0;url=/programs/example/">',
    "shows/index.html": '<meta http-equiv="refresh" content="0;url=/programs/">',
    "shows/example/index.html": '<meta http-equiv="refresh" content="0;url=/programs/example/">',
    "events/index.html": '<h1>Events</h1><link href="/_astro/events.css" rel="stylesheet">',
    "posts/index.html": '<h1>Posts</h1>', "_astro/records.css": 'body{color:navy}',
    "_astro/events.css": 'body{color:blue}',
  };
  try {
    for (const [file, bytes] of Object.entries(fixtures)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), bytes);
    }
    const files = await familyFiles(directory, ["programs"]);
    expect(files.map(file => file.path).sort()).toEqual([
      "/_astro/records.css", "/programs/", "/programs/example/", "/programs/old-example/", "/shows/", "/shows/example/",
    ]);
    for (const file of files) {
      expect(file.outputs).toEqual(["programs"]);
      expect(file.digest).toBe(createHash("sha256").update(fixtures[file.file as keyof typeof fixtures]).digest("hex"));
    }
    const legacy = await familyFiles(directory);
    expect(legacy.map(file => file.path)).toEqual(["/posts/"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it("restores the full retained family receipt above the former 2 MiB cap", () => {
  const files = Array.from({ length: 9984 }, (_, index) => {
    const family = index < 4096 ? "programs" : index < 8192 ? "events" : "authors";
    const slug = `${"retained-".repeat(10)}${index}`;
    return { path: `/${family}/${slug}/`, file: `${family}/${slug}/index.html`, outputs: [family],
      digest: "a".repeat(64), size: 100, contentType: "text/html; charset=utf-8" };
  });
  const contextDigest = "b".repeat(64), bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, contextDigest, routes: [], files }));
  expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
  expect(parsePreparedBackground(bytes, contextDigest).files).toHaveLength(9984);
  expect(() => parsePreparedBackground(bytes, "c".repeat(64))).toThrow("Invalid retained background generation");
});

it("retains the released Program footprint including all responsive derivatives", async () => {
  // Release 086d51e9, verified against the public index/detail on October 23.
  // Six HTML files and 34 assets total 837,094 bytes; 26 assets are images.
  const html = { "programs/index.html": 32792, "programs/njpbs-news/index.html": 37027,
    "programs/state-of-the-arts/index.html": 37531, "shows/index.html": 28162,
    "shows/njpbs-news/index.html": 28248, "shows/state-of-the-arts/index.html": 28236 };
  const sizes = [["webp", 45622], ["avif", 25264], ["webp", 19054], ["webp", 13462], ["webp", 31624],
    ["avif", 33094], ["webp", 74266], ["avif", 12296], ["webp", 110806], ["webp", 31386],
    ["avif", 6279], ["avif", 8343], ["avif", 17331], ["avif", 12566], ["webp", 11386],
    ["avif", 2383], ["webp", 16906], ["webp", 8666], ["avif", 8719], ["avif", 2961],
    ["avif", 4435], ["avif", 11926], ["webp", 4462], ["webp", 5948], ["avif", 5518], ["webp", 22652],
    ["js", 158], ["css", 9505], ["css", 58667], ["js", 5144], ["js", 7702], ["js", 12700], ["js", 3126], ["js", 741]] as const;
  const directory = await mkdtemp(path.join(tmpdir(), "released-program-capacity-"));
  try {
    await mkdir(path.join(directory, "_astro"));
    const references = sizes.map(([extension], index) => `<img src="/_astro/retained-${index}.${extension}">`).join("");
    for (const [file, size] of Object.entries(html)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      const prefix = Buffer.from(file === "programs/index.html" ? references : "<!doctype html><main>Program</main>");
      await writeFile(path.join(directory, file), Buffer.concat([prefix, Buffer.alloc(size - prefix.length, 32)]));
    }
    for (const [index, [extension, size]] of sizes.entries()) {
      await writeFile(path.join(directory, `_astro/retained-${index}.${extension}`), Buffer.alloc(size, 32));
    }
    const files = await familyFiles(directory, ["programs"]);
    expect(files).toHaveLength(40);
    expect(files.reduce((sum, file) => sum + file.size, 0)).toBe(837094);
    expect(files.filter(file => file.contentType.startsWith("image/"))).toHaveLength(26);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("retains a search corpus above 256 files and reports its context capacity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-search-growth-"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await mkdir(path.join(directory, "pagefind"));
    await mkdir(path.join(directory, "search"));
    await writeFile(path.join(directory, "pagefind/pagefind.js"), "public search");
    await writeFile(path.join(directory, "search/meaning-index.json"), "{}");
    for (let i = 0; i < 255; i++) await writeFile(path.join(directory, `pagefind/${i}.pf_fragment`), "fragment");
    const files = await familyFiles(directory, ["search"], "b".repeat(64));
    expect(files).toHaveLength(257);
    expect(info).toHaveBeenCalledWith("Search background output capacity", {
      contextDigest: "b".repeat(64), fileCount: 257, fileLimit: 4096, totalBytes: 2055, byteLimit: 16 * 1024 * 1024,
    });
    expect(warning).not.toHaveBeenCalled();
    // The same expanded search count still cannot exceed the original byte bound.
    await writeFile(path.join(directory, "search/meaning-index.json"), Buffer.alloc(16 * 1024 * 1024));
    await expect(familyFiles(directory, ["search"])).rejects.toThrow("Background family exceeds its bound");
  } finally { info.mockRestore(); warning.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

it("warns at 80% and refuses search above 4096 files before checkpointing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-search-cap-"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await mkdir(path.join(directory, "pagefind"));
    for (let i = 0; i < 3276; i++) await writeFile(path.join(directory, `pagefind/${i}.pf_fragment`), "");
    await familyFiles(directory, ["search"], "c".repeat(64));
    expect(warning).not.toHaveBeenCalled();
    await writeFile(path.join(directory, "pagefind/3276.pf_fragment"), "");
    expect(await familyFiles(directory, ["search"], "c".repeat(64))).toHaveLength(3277);
    expect(warning).toHaveBeenCalledWith("Search background output reached 80% of its file or byte limit",
      expect.objectContaining({ contextDigest: "c".repeat(64), fileCount: 3277, fileLimit: 4096 }));
    for (let i = 3277; i < 4097; i++) await writeFile(path.join(directory, `pagefind/${i}.pf_fragment`), "");
    await expect(familyFiles(directory, ["search"], "c".repeat(64))).rejects.toThrow("Background family exceeds its bound");
    expect(info).toHaveBeenLastCalledWith("Search background output capacity", expect.objectContaining({ fileCount: 4097 }));
  } finally { info.mockRestore(); warning.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

it("warns at the search byte threshold before refusing output with few files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "background-search-byte-cap-"));
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const byteLimit = 16 * 1024 * 1024, threshold = Math.ceil(byteLimit * 0.8);
  try {
    await mkdir(path.join(directory, "pagefind"));
    const file = path.join(directory, "pagefind/index.pf_index");
    await writeFile(file, Buffer.alloc(threshold - 1));
    await familyFiles(directory, ["search"], "d".repeat(64));
    expect(warning).not.toHaveBeenCalled();
    await writeFile(file, Buffer.alloc(threshold));
    expect(await familyFiles(directory, ["search"], "d".repeat(64))).toHaveLength(1);
    expect(warning).toHaveBeenLastCalledWith("Search background output reached 80% of its file or byte limit",
      expect.objectContaining({ fileCount: 1, totalBytes: threshold, byteLimit }));
    await writeFile(file, Buffer.alloc(byteLimit + 1));
    await expect(familyFiles(directory, ["search"], "d".repeat(64))).rejects.toThrow("Background family exceeds its bound");
    expect(warning).toHaveBeenLastCalledWith("Search background output reached 80% of its file or byte limit",
      expect.objectContaining({ fileCount: 1, totalBytes: byteLimit + 1 }));
  } finally { info.mockRestore(); warning.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

it("restores a prepared checkpoint containing full Program, Event and search manifests", () => {
  const files = ["programs", "events", "search"].flatMap(output => Array.from({ length: 4096 }, (_, i) => {
    const folder = output === "search" ? "pagefind" : output;
    return { path: `/${folder}/${i}.json`, file: `${folder}/${i}.json`, outputs: [output],
      digest: "a".repeat(64), size: 10, contentType: "application/json" };
  }));
  const contextDigest = "b".repeat(64);
  expect(parsePreparedBackground(Buffer.from(JSON.stringify({ schemaVersion: 2, contextDigest, routes: [], files })), contextDigest).files)
    .toHaveLength(12_288);
});
