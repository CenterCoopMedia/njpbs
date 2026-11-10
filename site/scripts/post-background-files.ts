import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { OUTPUTS, backgroundOutputForPath: outputForPath, isBackgroundAssetPath } = require("../../functions/lib/post-background-paths");
const { RECORD_FAMILIES, outputLimits } = require("../../functions/lib/no-build-record-namespace");
export const backgroundFamilies: string[] = [...OUTPUTS, ...RECORD_FAMILIES];
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface FileRecord { path: string; file: string; outputs: string[]; digest: string; size: number; contentType: string }
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".avif": "image/avif", ".wasm": "application/wasm", ".pf_fragment": "application/octet-stream", ".pf_index": "application/octet-stream", ".pf_meta": "application/octet-stream" };
export async function familyFiles(directory: string,
  selectedOutputs: readonly string[] = backgroundFamilies.filter(output => !["programs", "events"].includes(output)),
  contextDigest?: string): Promise<FileRecord[]> {
  if (new Set(selectedOutputs).size !== selectedOutputs.length || selectedOutputs.some(output => !backgroundFamilies.includes(output))) {
    throw new Error("Background output selection is invalid");
  }
  const result: FileRecord[] = [];
  const text = new Map<string, string>();
  async function scan(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Background output contains a link");
      if (entry.isDirectory()) { await scan(absolute); continue; }
      if (!entry.isFile()) throw new Error("Background output is not a file");
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      const publicPath = relative === "index.html" ? "/" : relative.endsWith("/index.html") ? `/${relative.slice(0, -10)}` : `/${relative}`;
      const output = outputForPath(publicPath);
      if (output ? !selectedOutputs.includes(output) : !isBackgroundAssetPath(publicPath)) continue;
      const bytes = await readFile(absolute);
      const extension = path.extname(relative);
      if ([".html", ".css", ".js", ".mjs", ".json", ".xml"].includes(extension)) text.set(publicPath, bytes.toString("utf8"));
      result.push({ path: publicPath, file: relative, outputs: output ? [output] : [],
        digest: sha256(bytes), size: bytes.length, contentType: types[extension] ?? "application/octet-stream" });
    }
  }
  await scan(directory);
  const assets = result.filter(file => isBackgroundAssetPath(file.path));
  for (const family of selectedOutputs) {
    const queue = result.filter(file => file.outputs.includes(family));
    for (const file of queue) {
      const content = text.get(file.path);
      if (!content) continue;
      // Vite emits complete hashed filenames in HTML, CSS, imports, preload
      // lists and new URL() expressions. Match basenames conservatively so
      // absolute, relative and escaped URL prefixes keep their full graph.
      for (const asset of assets) {
        if (!asset.outputs.includes(family) && content.includes(path.posix.basename(asset.path))) {
          asset.outputs.push(family);
          queue.push(asset);
        }
      }
    }
    const limits = outputLimits(family), totalBytes = queue.reduce((sum, file) => sum + file.size, 0);
    if (family === "search" && contextDigest) {
      const measurement = { contextDigest, fileCount: queue.length, fileLimit: limits.files, totalBytes, byteLimit: limits.bytes };
      console.info("Search background output capacity", measurement);
      if (queue.length >= Math.ceil(limits.files * 0.8) || totalBytes >= Math.ceil(limits.bytes * 0.8)) {
        console.warn("Search background output reached 80% of its file or byte limit", measurement);
      }
    }
    if (queue.length > limits.files || totalBytes > limits.bytes) throw new Error("Background family exceeds its bound");
  }
  return result.filter(file => file.outputs.length);
}
