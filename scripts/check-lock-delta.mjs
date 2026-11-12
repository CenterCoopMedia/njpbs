import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCKS = ["package-lock.json", "site/package-lock.json", "functions/package-lock.json",
  "publisher/package-lock.json", "preview-renderer/package-lock.json"];
const HOOKS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];
const ALLOWLIST = new URL("./allowed-install-scripts.json", import.meta.url);
const hash = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const role = entry => entry.dev === true ? "dev" : entry.optional || entry.devOptional ? "optional" : "prod";
const packageName = path => path.split("node_modules/").at(-1);

/** Read only Git objects. No install, registry request, lifecycle hook or checkout code is run. */
export function checkLockDelta(oldRef, newRef, { cwd = process.cwd() } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] });
  const commit = ref => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  const oldCommit = commit(oldRef), newCommit = commit(newRef);
  const read = (sha, path) => git("show", `${sha}:${path}`);
  const root = JSON.parse(read(newCommit, "package.json"));
  const workspaces = root.workspaces;
  if (!Array.isArray(workspaces) || workspaces.some(path => !/^[a-zA-Z0-9_-]+$/.test(path)))
    throw new Error("Unsupported workspace declaration");
  const allowlistBytes = readFileSync(ALLOWLIST, "utf8");
  const allowlist = JSON.parse(allowlistBytes);
  if (!Array.isArray(allowlist) || allowlist.some(name => typeof name !== "string"))
    throw new Error("Invalid install-script allowlist");
  const manifests = new Map();
  for (const path of new Set(["package.json", ...workspaces.map(path => `${path}/package.json`),
    "site/package.json", "functions/package.json", "publisher/package.json", "preview-renderer/package.json"])) {
    const manifest = JSON.parse(read(newCommit, path));
    if (HOOKS.some(hook => Object.hasOwn(manifest.scripts ?? {}, hook)))
      throw new Error(`${path}: install lifecycle hook refused`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const spec of Object.values(manifest[field] ?? {})) {
        if (typeof spec !== "string" || /:|\/|#/.test(spec))
          throw new Error(`${path}: non-registry dependency source refused`);
      }
    }
    manifests.set(path, manifest);
  }
  const lockfiles = LOCKS.map(path => {
    const oldBytes = read(oldCommit, path), newBytes = read(newCommit, path);
    const before = JSON.parse(oldBytes), after = JSON.parse(newBytes);
    for (const lock of [before, after]) {
      if (lock.lockfileVersion !== 3 || !lock.packages || !Object.hasOwn(lock.packages, ""))
        throw new Error(`${path}: version 3 packages lockfile required`);
    }
    for (const [entryPath, entry] of Object.entries(after.packages)) {
      if (entryPath === "") continue;
      if (path === "package-lock.json" && workspaces.includes(entryPath) && !entry.link) continue;
      if (entry.link === true) {
        const target = manifests.get(`${entry.resolved}/package.json`);
        if (path === "package-lock.json" && workspaces.includes(entry.resolved)
          && target && entryPath === `node_modules/${target.name}`) continue;
        throw new Error(`${path}: non-workspace link refused`);
      }
      if (!entryPath.includes("node_modules/") || typeof entry.integrity !== "string"
        || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity))
        throw new Error(`${path}: package integrity missing or invalid`);
      // npm aliases retain their registry package name in the lock entry.
      const name = entry.name ?? packageName(entryPath);
      const prefix = `https://registry.npmjs.org/${name}/-/`;
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)
        || typeof entry.resolved !== "string" || !entry.resolved.startsWith(prefix)
        || !/^[A-Za-z0-9_.-]+\.tgz$/.test(entry.resolved.slice(prefix.length))
        || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(entry.version))
        throw new Error(`${path}: non-registry package source refused`);
      if (entry.dev !== true && entry.hasInstallScript && !allowlist.includes(name))
        throw new Error(`${path}: unreviewed production install script for ${name}`);
    }
    const packages = lock => Object.fromEntries(Object.entries(lock.packages)
      .filter(([path]) => path.includes("node_modules/")));
    const oldPackages = packages(before), newPackages = packages(after);
    const delta = (oldEntries, newEntries) => [...new Set([...Object.keys(oldEntries), ...Object.keys(newEntries)])]
      .sort().filter(key => canonical(oldEntries[key]) !== canonical(newEntries[key]))
      .map(key => ({ path: key, old: oldEntries[key] ? { ...oldEntries[key], role: role(oldEntries[key]) } : null,
        new: newEntries[key] ? { ...newEntries[key], role: role(newEntries[key]) } : null }));
    const production = entries => Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.dev !== true));
    return { path, oldSha256: hash(oldBytes), newSha256: hash(newBytes),
      packages: delta(oldPackages, newPackages),
      production: delta(production(oldPackages), production(newPackages)) };
  });
  return { schemaVersion: 1, oldCommit, newCommit, allowlistSha256: hash(allowlistBytes),
    changed: lockfiles.some(lock => lock.oldSha256 !== lock.newSha256), lockfiles };
}

export function lockDeltaMarkdown(record) {
  const cell = value => String(value).replace(/[&<>|\r\n`]/g, character => `&#${character.charCodeAt(0)};`);
  const lines = ["## Dependency lock delta", "", `OLD: ${record.oldCommit}`, `NEW: ${record.newCommit}`, "",
    "| Lockfile | OLD SHA-256 | NEW SHA-256 |", "| --- | --- | --- |",
    ...record.lockfiles.map(lock => `| ${lock.path} | ${lock.oldSha256} | ${lock.newSha256} |`)];
  for (const [field, title] of [["packages", "All packages"], ["production", "Production closure (dev is not true)"]]) {
    lines.push("", `### ${title}`, "", "| Lockfile | Package path | OLD version (role) | NEW version (role) |",
      "| --- | --- | --- | --- |");
    for (const lock of record.lockfiles) {
      for (const change of lock[field]) {
        const label = entry => entry ? cell(`${entry.version ?? "workspace"} (${entry.role})`) : "—";
        lines.push(`| ${lock.path} | ${cell(change.path)} | ${label(change.old)} | ${label(change.new)} |`);
      }
    }
    if (!record.lockfiles.some(lock => lock[field].length)) lines.push("| — | No package changes | — | — |");
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [oldRef, newRef, ...flags] = process.argv.slice(2);
    if (!oldRef || !newRef || flags.length % 2 || flags.some((value, index) => index % 2 === 0
      && !["--output", "--summary"].includes(value)))
      throw new Error("Usage: node scripts/check-lock-delta.mjs OLD NEW --output record.json [--summary summary.md]");
    const options = Object.fromEntries(Array.from({ length: flags.length / 2 }, (_, index) => flags.slice(index * 2, index * 2 + 2)));
    if (!options["--output"]) throw new Error("--output is required");
    const record = checkLockDelta(oldRef, newRef);
    const bytes = `${canonical(record)}\n`;
    const markdown = `Record SHA-256: ${hash(bytes)}\n\n${lockDeltaMarkdown(record)}`;
    writeFileSync(options["--output"], bytes);
    if (options["--summary"]) appendFileSync(options["--summary"], markdown);
    process.stdout.write(markdown);
  } catch (error) {
    // Git stderr can contain source URLs; report only our own policy errors.
    console.error(error.status !== undefined ? "Lock-delta inputs unavailable in Git" : error.message);
    process.exitCode = 1;
  }
}
