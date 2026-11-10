import { createHash } from "node:crypto";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestName = "renderer-release.json";
const runtimeName = "runtime/cloud.mjs";
const homeSourcesName = "server/home-sources.json";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function releaseFiles(directory, prefix = "") {
  const files = {};
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    const relative = path.posix.join(prefix, name);
    if (relative === manifestName) continue;
    const file = path.join(directory, relative);
    const status = await lstat(file);
    if (status.isDirectory()) Object.assign(files, await releaseFiles(directory, relative));
    else if (status.isFile()) files[relative] = digest(await readFile(file));
    else throw new Error("Compiled renderer release contains a non-regular file");
  }
  return files;
}

/** Seal the build output; request handling can only verify this release. */
export async function sealCompiledRenderer(directory, rendererSha, homeSources) {
  if (!/^[a-f0-9]{40}$/.test(rendererSha)) throw new Error("Invalid compiled renderer source");
  const files = await releaseFiles(directory);
  if (!files["server/entry.mjs"] || !files["client/_preview-assets.json"] || !files[runtimeName]) {
    throw new Error("Compiled renderer output is incomplete");
  }
  // The loader already validates this projection. Bind its bytes to the same
  // release file set as the templates instead of trusting manifest metadata.
  const homeBytes = `${JSON.stringify(homeSources)}\n`;
  await writeFile(path.join(directory, homeSourcesName), homeBytes, { mode: 0o600, flag: "wx" });
  files[homeSourcesName] = digest(homeBytes);
  const manifest = { schemaVersion: 1, rendererSha, files };
  await writeFile(path.join(directory, manifestName), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return manifest;
}

export async function verifyCompiledRenderer(directory, rendererSha) {
  const status = await lstat(path.join(directory, manifestName));
  if (!status.isFile()) throw new Error("Compiled renderer manifest must be a regular file");
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.rendererSha !== rendererSha || !/^[a-f0-9]{40}$/.test(rendererSha)) {
    throw new Error("Compiled renderer release does not match the requested source");
  }
  if (Object.hasOwn(manifest, "homeSources")) {
    throw new Error("Compiled renderer Home data must be in sealed files");
  }
  const actual = await releaseFiles(directory);
  if (!manifest.files || Object.keys(actual).length !== Object.keys(manifest.files).length ||
    !actual["server/entry.mjs"] || !actual["client/_preview-assets.json"] || !actual[homeSourcesName] || !actual[runtimeName] ||
    Object.entries(actual).some(([file, hash]) => manifest.files[file] !== hash)) {
    throw new Error("Compiled renderer release bytes do not match its manifest");
  }
  const homeSources = JSON.parse(await readFile(path.join(directory, homeSourcesName), "utf8"));
  return { ...manifest, homeSources };
}
