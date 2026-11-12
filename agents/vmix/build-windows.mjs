import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { parseApiOrigin } from "./configuration.mjs";
import { PACKAGE_FILES, writePackageInventory } from "./package-inventory.mjs";

const require = createRequire(import.meta.url);
const { assertSourceSha, parseConnectorManifest } = require("../../functions/lib/studio-connector-package.js");
const directory = dirname(fileURLToPath(import.meta.url));
export const NODE_VERSION = "22.23.5";
export const NODE_ARCHIVE_SHA256 = "4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3";
const archiveName = `node-v${NODE_VERSION}-win-x64.zip`;
const release = `https://nodejs.org/dist/v${NODE_VERSION}/`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

class PackageBuildError extends Error {}
export function describeBuildFailure(error) {
  if (error instanceof PackageBuildError) return error.message;
  if (error?.code === "ENOENT") return "A required package file or build tool was not found.";
  if (error?.code === "EACCES") return "Package files could not be read or written.";
  return "A package build tool failed. Check the Git, Python or esbuild output.";
}

async function download(url, limit) {
  let response;
  try { response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) }); }
  catch { throw new PackageBuildError("Could not reach the official Node archive. Try again."); }
  if (!response.ok) throw new PackageBuildError("Official Node download failed");
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new PackageBuildError("Node download exceeds its size limit");
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof PackageBuildError) throw error;
    throw new PackageBuildError("The official Node download was interrupted. Try again.");
  }
  return Buffer.concat(chunks);
}

export function verifyRuntime(bytes, sums) {
  const official = sums.split(/\r?\n/).find(line => line.endsWith(`  ${archiveName}`))?.split(/\s+/)[0];
  if (official !== NODE_ARCHIVE_SHA256 || digest(bytes) !== NODE_ARCHIVE_SHA256) {
    throw new PackageBuildError("Node runtime checksum does not match the pinned official release");
  }
}

export async function buildWindowsPackage({ output, sourceSha, apiKey, runtimeArchive, apiOrigin = process.env.CMS_STUDIO_API_ORIGIN }) {
  try { assertSourceSha(sourceSha); } catch { throw new PackageBuildError("The package source must be a full commit SHA."); }
  try { apiOrigin = parseApiOrigin(apiOrigin); } catch { throw new PackageBuildError("CMS_STUDIO_API_ORIGIN must be the deployed HTTPS origin."); }
  const root = resolve(directory, "../..");
  const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (checkedOut !== sourceSha) throw new PackageBuildError("Package source must equal the exact checkout commit");
  const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "agents/vmix", "packages/content-core", "functions/lib/studio-connector-package.js"], { cwd: root, encoding: "utf8" });
  if (changed.trim()) throw new PackageBuildError("Commit the package sources before building a release");
  if (typeof apiKey !== "string" || !/^AIza[A-Za-z0-9_-]{35}$/.test(apiKey)) throw new PackageBuildError("The deployed public Firebase web API key is required");
  const sums = (await download(`${release}SHASUMS256.txt`, 1024 * 1024)).toString("utf8");
  const bytes = runtimeArchive ? await readFile(runtimeArchive) : await download(`${release}${archiveName}`, 64 * 1024 * 1024);
  verifyRuntime(bytes, sums);
  const work = await mkdtemp(join(tmpdir(), "studio-connector-"));
  const payload = join(work, "payload");
  await mkdir(payload);
  await mkdir(output, { recursive: true });
  try {
    const runtimeZip = join(work, archiveName);
    await writeFile(runtimeZip, bytes);
    execFileSync("python3", [join(directory, "package-windows.py"), "extract", runtimeZip, join(payload, "runtime")]);
    execFileSync(process.execPath, [join(directory, "build.mjs")], { cwd: directory, stdio: "inherit", env: { ...process.env, CMS_STUDIO_API_ORIGIN: apiOrigin } });
    await copyFile(join(directory, "dist/vmix-agent.cjs"), join(payload, "vmix-agent.cjs"));
    const rootFiles = ["configuration.mjs", "read-studio-configuration.mjs"];
    for (const name of PACKAGE_FILES.filter(name => !["vmix-agent.cjs", "pairing.json", "source.json", ...rootFiles].includes(name))) {
      await copyFile(join(directory, "windows", name), join(payload, name));
    }
    for (const name of rootFiles) {
      await copyFile(join(directory, name), join(payload, name));
    }
    await writeFile(join(payload, "pairing.json"), JSON.stringify({ pairingEndpoint: `${apiOrigin}/cmsPairLiveProductionDevice`, apiKey }, null, 2) + "\n");
    const bundleSha256 = digest(await readFile(join(payload, "vmix-agent.cjs")));
    await writeFile(join(payload, "source.json"), JSON.stringify({ sourceSha, bundleSha256, nodeVersion: NODE_VERSION,
      nodeArchiveSha256: NODE_ARCHIVE_SHA256, nodeChecksumsUrl: `${release}SHASUMS256.txt` }, null, 2) + "\n");
    await writePackageInventory(payload, sourceSha);
    const filename = `NJPBS-Studio-connector-${sourceSha.slice(0, 8)}.zip`;
    const zip = join(output, filename);
    execFileSync("python3", [join(directory, "package-windows.py"), "zip", payload, zip]);
    const packageBytes = await readFile(zip);
    const manifest = parseConnectorManifest({ schemaVersion: 1, sourceSha, sha256: digest(packageBytes), bundleSha256,
      sizeBytes: packageBytes.length, filename, nodeVersion: NODE_VERSION, nodeArchiveSha256: NODE_ARCHIVE_SHA256 }, sourceSha);
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Studio connector package built from ${sourceSha}; SHA-256 ${manifest.sha256}.`);
    return manifest;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { output: { type: "string" }, "source-sha": { type: "string" }, "runtime-archive": { type: "string" } } });
  if (!values.output || !values["source-sha"]) {
    console.error("Use --output directory --source-sha exact-commit with CMS_STUDIO_API_ORIGIN and the deployed public VITE_FIREBASE_API_KEY.");
    process.exit(1);
  }
  buildWindowsPackage({ output: resolve(values.output), sourceSha: values["source-sha"],
    apiKey: process.env.VITE_FIREBASE_API_KEY, runtimeArchive: values["runtime-archive"] }).catch(error => {
    console.error(`Studio connector package build failed: ${describeBuildFailure(error)}`);
    process.exitCode = 1;
  });
}
