import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Ubuntu noble-updates InRelease signer F6ECB3762474EDA9D21B7022871920D1991BC93C.
// Its signed main/binary-amd64/Packages.xz authenticates this unmodified package:
// https://packages.ubuntu.com/noble-updates/amd64/bubblewrap/download
const bubblewrapFile = "bubblewrap_0.9.0-1ubuntu0.3_amd64.deb";
const bubblewrapHash = "2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094";
const bubblewrapUrl = "https://github.com/CenterCoopMedia/njpbs/releases/download/ci-bubblewrap-0.9.0-1ubuntu0.3/" + bubblewrapFile;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function execute(run, command, args) {
  const result = run(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Hosted dependency command failed: ${command}`);
}

export async function installBubblewrap(cacheDirectory, run = spawnSync, download = fetch) {
  const present = run("bash", ["-c", "command -v bwrap"], { stdio: "ignore" });
  if (present.error || ![0, 1].includes(present.status)) throw new Error("Cannot inspect bubblewrap installation");
  if (present.status === 0) {
    console.log("bubblewrap is already installed");
    return;
  }
  mkdirSync(cacheDirectory, { recursive: true });
  const path = join(cacheDirectory, bubblewrapFile);
  let bytes;
  if (existsSync(path)) {
    bytes = readFileSync(path);
  } else {
    const response = await download(bubblewrapUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Bubblewrap download failed (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length !== 50436 || digest(bytes) !== bubblewrapHash) throw new Error("Bubblewrap package checksum mismatch");
  if (!existsSync(path)) writeFileSync(path, bytes);
  execute(run, "sudo", ["dpkg", "-i", path]);
}

export function installChromiumDependencies(cacheDirectory, run = spawnSync) {
  mkdirSync(cacheDirectory, { recursive: true });
  const manifestPath = join(cacheDirectory, "sha256.json");
  let hashes;
  if (existsSync(manifestPath)) {
    hashes = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log("Using cached Chromium dependency packages");
  } else {
    console.log("Chromium dependency cache miss: Ubuntu apt access is required");
    const packages = readFileSync(new URL("./playwright-chromium-packages.txt", import.meta.url), "utf8")
      .split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
    if (!packages.length || packages.some((name) => !/^[a-z0-9][a-z0-9+.-]*$/.test(name))) throw new Error("Invalid Chromium package plan");
    const updateArgs = ["apt-get", "-o", "Acquire::Retries=0", "update"];
    const update = run("sudo", updateArgs, { stdio: "inherit" });
    if (update.error || update.status !== 0) execute(run, "sudo", updateArgs);
    execute(run, "sudo", ["apt-get", "-o", "Acquire::Retries=0", "-o", `Dir::Cache::archives=${cacheDirectory}`,
      "--download-only", "--reinstall", "install", "-y", "--no-install-recommends", ...packages]);
    hashes = Object.fromEntries(readdirSync(cacheDirectory).filter((name) => name.endsWith(".deb"))
      .map((name) => [name, digest(readFileSync(join(cacheDirectory, name)))]));
  }
  if (!hashes || Array.isArray(hashes) || typeof hashes !== "object" || !Object.keys(hashes).length) throw new Error("Empty Chromium dependency cache");
  const files = Object.entries(hashes).map(([name, expected]) => {
    if (basename(name) !== name || !name.endsWith(".deb")) throw new Error("Invalid cached package path");
    const path = join(cacheDirectory, name);
    if (digest(readFileSync(path)) !== expected) throw new Error(`Cached package checksum mismatch: ${name}`);
    return path;
  });
  // A cached package must not downgrade a newer runner security update.
  execute(run, "sudo", ["dpkg", "-i", "--refuse-downgrade", ...files]);
  writeFileSync(manifestPath, JSON.stringify(hashes) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [kind, cacheDirectory] = process.argv.slice(2);
    if (process.argv.length !== 4 || !isAbsolute(cacheDirectory ?? "")) throw new Error("Specify dependency kind and absolute cache directory");
    if (kind === "bubblewrap") await installBubblewrap(cacheDirectory);
    else if (kind === "chromium") installChromiumDependencies(cacheDirectory);
    else throw new Error("Unknown hosted dependency kind");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
