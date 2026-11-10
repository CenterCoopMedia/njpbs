// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preparePublicFonts } from "../scripts/prepare-public-fonts.mjs";

const directories: string[] = [];
async function cache() {
  const directory = await mkdtemp(path.join(tmpdir(), "public-fonts-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("pinned public build fonts", () => {
  it.each(["unknown file", "symlink file", "symlink directory"])("refuses a cache containing a %s before any fetch", async invalid => {
    const directory = await cache();
    const other = await cache();
    if (invalid === "unknown file") await writeFile(path.join(directory, "unexpected.txt"), "unreviewed");
    else if (invalid === "symlink file") {
      const target = path.join(other, "font.woff2");
      await writeFile(target, "unreviewed");
      await symlink(target, path.join(directory, "PBSSans-Light.woff2"));
    } else {
      await rm(directory, { recursive: true });
      await symlink(other, directory);
    }
    const fetchImpl = vi.fn(async () => new Response("unexpected"));
    await expect(preparePublicFonts({ directory, offline: false, fetchImpl })).rejects.toThrow("Public font cache");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["publisher/Dockerfile", "node /app/site/scripts/prepare-public-fonts.mjs", "ENV NODE_ENV=production"],
    ["publisher/Dockerfile.pair", "node /app/site/scripts/prepare-public-fonts.mjs", "ARG CMS_DEPLOYMENT_ENVIRONMENT"],
    ["preview-renderer/Dockerfile", "node /app/site/scripts/prepare-public-fonts.mjs", "node --import /app/site/node_modules/tsx/dist/loader.mjs /app/site/scripts/build-compiled-renderer.ts"],
    ["docs/cms/release-without-pause.md", "node site/scripts/prepare-public-fonts.mjs", "All attended first-install blocks"],
    [".github/workflows/ci.yml", "node site/scripts/prepare-public-fonts.mjs", "Compile and verify private renderer"],
    [".github/workflows/cms-dev-publish.yml", "node site/scripts/prepare-public-fonts.mjs", "Prepare pinned search model for offline build"],
    [".github/workflows/cms-publish.yml", "node scripts/prepare-public-fonts.mjs", "Prepare local search model for frozen builds"],
    [".github/workflows/pages.yml", "node scripts/prepare-public-fonts.mjs", "Prepare local search model for frozen builds"],
  ])("seeds verified fonts before the offline boundary in %s", async (file, seed, boundary) => {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    expect(source.indexOf(seed)).toBeGreaterThan(-1);
    expect(source.indexOf(boundary)).toBeGreaterThan(source.indexOf(seed));
  });

  it.each(["CMS_OFFLINE_BUILD", "CMS_DEV_FROZEN_BUILD"])("never fetches missing fonts under %s", async signal => {
    vi.stubEnv(signal, "1");
    const fetchImpl = vi.fn(async () => new Response("unexpected"));
    await expect(preparePublicFonts({ directory: await cache(), fetchImpl })).rejects.toThrow("Public font missing in offline/frozen build");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects corrupt cached bytes without fetching a replacement", async () => {
    const directory = await cache();
    await writeFile(path.join(directory, "PBSSans-Light.woff2"), "corrupt");
    const fetchImpl = vi.fn(async () => new Response("unexpected"));
    await expect(preparePublicFonts({ directory, offline: false, fetchImpl })).rejects.toThrow("Public font checksum mismatch: PBSSans-Light.woff2");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not install a successful response with the wrong digest", async () => {
    const directory = await cache();
    const fetchImpl = vi.fn(async () => new Response("not the pinned font"));
    await expect(preparePublicFonts({ directory, offline: false, fetchImpl })).rejects.toThrow("Public font checksum mismatch");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(directory, "PBSSans-Light.woff2"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes one bounded request and rejects an HTTP failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(preparePublicFonts({ directory: await cache(), offline: false, fetchImpl })).rejects.toThrow("HTTP 503");
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://njpbs.org/brand/fonts/PBSSans-Light.woff2", {
      headers: { "user-agent": "njpbs-build-fonts" }, redirect: "error", signal: expect.any(AbortSignal),
    });
  });
});
