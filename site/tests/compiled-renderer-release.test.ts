import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sealCompiledRenderer, verifyCompiledRenderer } from "../scripts/compiled-renderer-release.mjs";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";

const directories: string[] = [];
const sha = "a".repeat(40);
const homeSources = createHomeSourceSnapshot({}, {});
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function release() {
  const directory = await mkdtemp(path.join(tmpdir(), "compiled-renderer-test-"));
  directories.push(directory);
  await mkdir(path.join(directory, "server"));
  await mkdir(path.join(directory, "client"));
  await mkdir(path.join(directory, "runtime"));
  await writeFile(path.join(directory, "runtime/cloud.mjs"), "export const serveCmsPreviewCloud = () => {};");
  await writeFile(path.join(directory, "server/entry.mjs"), "export const rendererSha = 'reviewed';");
  await writeFile(path.join(directory, "client/_preview-assets.json"), "{}");
  await sealCompiledRenderer(directory, sha, homeSources);
  return directory;
}

describe("immutable compiled renderer release", () => {
  it("accepts the same reviewed bytes across repeated jobs", async () => {
    const directory = await release();
    const first = await verifyCompiledRenderer(directory, sha);
    expect(await verifyCompiledRenderer(directory, sha)).toEqual(first);
    expect(first.rendererSha).toBe(sha);
    expect(first.homeSources).toEqual(homeSources);
    expect(JSON.parse(await readFile(path.join(directory, "renderer-release.json"), "utf8")))
      .not.toHaveProperty("homeSources");
  });
  it("rejects another renderer release", async () => {
    await expect(verifyCompiledRenderer(await release(), "b".repeat(40))).rejects.toThrow("requested source");
  });
  it.each(["server/entry.mjs", "client/_preview-assets.json", "server/home-sources.json", "runtime/cloud.mjs"])("rejects changed %s bytes", async file => {
    const directory = await release();
    await writeFile(path.join(directory, file), "changed");
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("manifest");
  });
  it("rejects valid-looking modified Home data", async () => {
    const directory = await release();
    const modified = structuredClone(homeSources);
    modified.pbs.featured[0].title = "Unreviewed feed data";
    await writeFile(path.join(directory, "server/home-sources.json"), JSON.stringify(modified));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("manifest");
  });
  it("rejects a missing runtime even when its manifest entry is also removed", async () => {
    const directory = await release();
    await rm(path.join(directory, "runtime/cloud.mjs"));
    const file = path.join(directory, "renderer-release.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    delete manifest.files["runtime/cloud.mjs"];
    await writeFile(file, JSON.stringify(manifest));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("manifest");
  });
  it("rejects missing Home data before readiness", async () => {
    const directory = await release();
    await rm(path.join(directory, "server/home-sources.json"));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("manifest");
  });
  it.each([null, { schemaVersion: 1 }, homeSources])("rejects Home data substituted into manifest metadata", async homeSources => {
    const directory = await release();
    const file = path.join(directory, "renderer-release.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...manifest, homeSources }));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("sealed files");
  });
  it("rejects missing assets instead of borrowing another release", async () => {
    const directory = await release();
    await rm(path.join(directory, "client/_preview-assets.json"));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("manifest");
  });
  it("rejects unrecorded files", async () => {
    const directory = await release();
    await writeFile(path.join(directory, "client/extra.js"), "unexpected");
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("manifest");
  });
  it("rejects source and manifest symlinks", async () => {
    const directory = await release();
    await symlink("../renderer-release.json", path.join(directory, "client/borrowed.json"));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("non-regular");
    await rm(path.join(directory, "client/borrowed.json"));
    await rm(path.join(directory, "renderer-release.json"));
    await symlink("client/_preview-assets.json", path.join(directory, "renderer-release.json"));
    await expect(verifyCompiledRenderer(directory, sha)).rejects.toThrow("regular file");
  });
});
