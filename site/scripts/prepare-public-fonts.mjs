import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fonts = JSON.parse(readFileSync(new URL("./public-fonts.json", import.meta.url), "utf8"));
const fontDirectory = fileURLToPath(new URL("../public/brand/fonts/", import.meta.url));

/** Keep licensed font bytes outside Git and verify them before every build. */
export async function preparePublicFonts({
  directory = fontDirectory,
  offline = process.env.CMS_OFFLINE_BUILD === "1" || process.env.CMS_DEV_FROZEN_BUILD === "1",
  fetchImpl = fetch,
} = {}) {
  let cache;
  try { cache = await lstat(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (cache && !cache.isDirectory()) throw new Error("Public font cache must be a real directory");
  if (cache && (await readdir(directory, { withFileTypes: true })).some(file => !file.isFile() || !Object.hasOwn(fonts, file.name))) {
    throw new Error("Public font cache contains unexpected entries");
  }
  for (const [name, digest] of Object.entries(fonts)) {
    const target = path.join(directory, name);
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const cached = bytes !== undefined;
    if (!cached) {
      if (offline) throw new Error(`Public font missing in offline/frozen build: ${name}. Seed verified fonts before the build.`);
      const response = await fetchImpl(`https://njpbs.org/brand/fonts/${name}`, {
        headers: { "user-agent": "njpbs-build-fonts" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Public font download failed: ${name} (HTTP ${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error(`Public font checksum mismatch: ${name}`);
    }
    if (!cached) {
      await mkdir(directory, { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
}

export const publicFonts = {
  name: "njpbs-public-fonts",
  hooks: { "astro:build:start": () => preparePublicFonts() },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await preparePublicFonts();
}
