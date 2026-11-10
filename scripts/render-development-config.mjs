#!/usr/bin/env node
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, unlinkSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import inputManifest from "../config/development-inputs.json" with { type: "json" };

export const developmentInputs = Object.freeze(inputManifest.inputs);
export const developmentDerivations = Object.freeze(inputManifest.derivations ?? []);
const refuse = () => { throw new Error("Development configuration refused; configure every named input before rendering"); };
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const gitSource = (root, args, options = {}) => execFileSync("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024,
  env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  ...options,
});

const manifestCache = new Map();
export function readDeploymentManifest(root, ref = "HEAD") {
  const name = "config/development-inputs.json";
  const listing = gitSource(root, ["ls-tree", "-z", ref, "--", name]);
  if (!listing) return null; // Older exact sources predate template inputs.
  const match = listing.match(/^100[0-7]{3} blob ([a-f0-9]{40})\tconfig\/development-inputs\.json\0$/);
  if (!match) refuse();
  if (!manifestCache.has(match[1])) {
    const manifest = JSON.parse(gitSource(root, ["cat-file", "blob", match[1]]));
    if (manifest.schemaVersion !== 1 || !manifest.inputs || Array.isArray(manifest.inputs)) refuse();
    for (const [key, input] of Object.entries(manifest.inputs)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !["origin", "resource"].includes(input.kind) ||
          typeof input.placeholder !== "string" || !Array.isArray(input.files) ||
          input.files.some(path => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes(".."))) refuse();
    }
    for (const item of manifest.derivations ?? []) {
      if (item.type !== "inline-script-csp" || typeof item.source !== "string" || !Array.isArray(item.consumers)) refuse();
    }
    manifestCache.set(match[1], manifest);
  }
  return manifestCache.get(match[1]);
}

function committedTemplates(root, names) {
  if (!names.length) return new Map();
  const listing = gitSource(root, ["ls-tree", "-rz", "HEAD", "--", ...names]);
  const files = new Map();
  for (const line of listing.split("\0").filter(Boolean)) {
    const match = line.match(/^100[0-7]{3} blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) refuse();
    files.set(match[2], match[1]);
  }
  if (names.some(name => !files.has(name))) refuse();
  const ids = [...new Set(files.values())];
  const output = gitSource(root, ["cat-file", "--batch"], {
    input: ids.join("\n") + "\n", encoding: null, stdio: ["pipe", "pipe", "ignore"],
  });
  const blobs = new Map(); let offset = 0;
  for (const id of ids) {
    const end = output.indexOf(10, offset);
    if (end < offset || end - offset > 100) refuse();
    const header = output.subarray(offset, end).toString("ascii").match(/^([a-f0-9]{40}) blob ([0-9]+)$/);
    const size = Number(header?.[2]), start = end + 1, next = start + size;
    if (header?.[1] !== id || !Number.isSafeInteger(size) || size < 0 || next >= output.length || output[next] !== 10) refuse();
    blobs.set(id, output.subarray(start, next).toString("utf8")); offset = next + 1;
  }
  if (offset !== output.length) refuse();
  return new Map(names.map(name => [name, blobs.get(files.get(name))]));
}

export function developmentValues(env = process.env, { manifest = inputManifest, only = Object.keys(manifest.inputs) } = {}) {
  const values = {};
  for (const name of only) {
    const input = manifest.inputs[name];
    if (!input) refuse();
    // config-input: CLOUDFLARE_DEV_PUBLIC_WORKER, CMS_DEV_ADMIN_ORIGIN, CMS_DEV_ADMIN_PAGES
    // config-input: CMS_DEV_API_ORIGIN, CMS_DEV_API_WORKER, CMS_DEV_MEDIA_BUCKET, CMS_DEV_MEDIA_ORIGIN
    // config-input: CMS_DEV_PREVIEW_BUCKET, CMS_DEV_PREVIEW_ORIGIN, CMS_DEV_PREVIEW_RENDERER
    // config-input: CMS_DEV_PREVIEW_STAFF_WORKER, CMS_DEV_PREVIEW_WORKER, CMS_DEV_PUBLIC_ORIGIN
    // config-input: CMS_DEV_SITE_PAGES, CMS_PRODUCTION_API_ORIGIN
    const value = env[name];
    if (typeof value !== "string" || /template|replace|placeholder/i.test(value)) refuse();
    if (input.kind === "resource") {
      if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) refuse();
    } else if (input.kind === "origin") {
      let url;
      try { url = new URL(value); } catch { refuse(); }
      if (url.protocol !== "https:" || url.origin !== value || url.port ||
          !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(url.hostname) ||
          /(^|\.)example\.(org|com|net)$/.test(url.hostname)) refuse();
    } else refuse();
    values[name] = value;
  }
  for (const kind of ["resource", "origin"]) {
    const selected = Object.entries(manifest.inputs).filter(([name, input]) => input.kind === kind && Object.hasOwn(values, name)).map(([name]) => values[name]);
    if (new Set(selected).size !== selected.length) refuse();
  }
  return Object.freeze(values);
}

export function renderDevelopmentText(source, names, values, manifest = inputManifest) {
  const replacements = new Map();
  for (const name of names) {
    const input = manifest.inputs[name];
    if (!input || !values[name]) refuse();
    if (input.kind === "origin") {
      const before = new URL(input.placeholder).hostname, after = new URL(values[name]).hostname;
      replacements.set(before, after);
      replacements.set(before.replaceAll(".", "\\."), after.replaceAll(".", "\\."));
    } else replacements.set(input.placeholder, values[name]);
  }
  // Protect complete unselected origins before matching shorter selected hosts.
  // Fixture suffixes still follow their selected origin without another lookup.
  for (const [name, input] of Object.entries(manifest.inputs)) {
    if (names.includes(name) || input.kind !== "origin") continue;
    const host = new URL(input.placeholder).hostname;
    replacements.set(host, host); replacements.set(host.replaceAll(".", "\\."), host.replaceAll(".", "\\."));
  }
  const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length).map(escape).join("|");
  let rendered = pattern ? source.replace(new RegExp(pattern, "g"), value => replacements.get(value)) : source;
  // The CSP pin describes exact inline bytes and must follow build-time origin
  // substitution. Hashing happens here, never in the emitted browser script.
  const inline = rendered.match(/export const BOARDWALK_EDIT_SCRIPT = `([\s\S]*?)`;/);
  if (inline) {
    const hash = createHash("sha256").update(inline[1]).digest("base64");
    rendered = rendered.replace(/(export const BOARDWALK_EDIT_SCRIPT_HASH = ")[^"]+(";)/, `$1sha256-${hash}$2`);
  }
  if (/^\/\* eslint-disable \*\/\n\/\/ Generated by Wrangler[^\n]+\(hash: [a-f0-9]{32}\)\n/.test(rendered)) {
    // Wrangler hashes its generated type body, excluding these two header lines.
    const body = rendered.split("\n").slice(2).join("\n");
    rendered = rendered.replace(/\(hash: [a-f0-9]{32}\)/,
      "(hash: " + createHash("sha256").update(body).digest("hex").slice(0, 32) + ")");
  }
  return rendered;
}

function filesByInput(only, manifest = inputManifest) {
  only ??= Object.keys(manifest.inputs);
  const files = new Map();
  const add = (filename, name) => {
    if (!files.has(filename)) files.set(filename, []);
    if (!files.get(filename).includes(name)) files.get(filename).push(name);
  };
  for (const [name, input] of Object.entries(manifest.inputs)) {
    if (!only.includes(name)) continue;
    for (const filename of input.files) add(filename, name);
    for (const item of manifest.derivations ?? []) {
      if (input.files.includes(item.source)) for (const filename of item.consumers) add(filename, name);
    }
  }
  return files;
}

function expectedOutputs(root, manifest, only, values) {
  const files = filesByInput(only, manifest), names = [...files.keys()];
  for (const item of manifest.derivations ?? []) {
    if (item.consumers.some(name => files.has(name)) && !names.includes(item.source)) names.push(item.source);
  }
  const templates = committedTemplates(root, names), outputs = new Map();
  for (const [filename, inputs] of files) {
    const source = templates.get(filename);
    for (const name of inputs) {
      if (!manifest.inputs[name].files.includes(filename)) continue; // A derived CSP consumer.
      const marker = manifest.inputs[name].placeholder;
      const token = marker.startsWith("https:") ? new URL(marker).hostname : marker;
      if (!source.includes(token) && !source.includes(token.replaceAll(".", "\\."))) refuse();
    }
    outputs.set(filename, renderDevelopmentText(source, inputs, values, manifest));
  }
  for (const item of manifest.derivations ?? []) {
    if (!item.consumers.some(name => files.has(name))) continue;
    const before = templates.get(item.source).match(/BOARDWALK_EDIT_SCRIPT_HASH = "([^"]+)"/);
    const after = renderDevelopmentText(templates.get(item.source), files.get(item.source) ?? [], values, manifest)
      .match(/BOARDWALK_EDIT_SCRIPT_HASH = "([^"]+)"/);
    if (!before || !after) refuse();
    for (const filename of item.consumers) {
      const source = outputs.get(filename);
      if (!source || !source.includes(before[1])) refuse();
      outputs.set(filename, source.replaceAll(before[1], after[1]));
    }
  }
  return outputs;
}

function configuredInputs(env, manifest = inputManifest) {
  return Object.entries(manifest.inputs).filter(([name, input]) => {
    // config-input: CLOUDFLARE_DEV_PUBLIC_WORKER, CMS_DEV_ADMIN_ORIGIN, CMS_DEV_ADMIN_PAGES
    // config-input: CMS_DEV_API_ORIGIN, CMS_DEV_API_WORKER, CMS_DEV_MEDIA_BUCKET, CMS_DEV_MEDIA_ORIGIN
    // config-input: CMS_DEV_PREVIEW_BUCKET, CMS_DEV_PREVIEW_ORIGIN, CMS_DEV_PREVIEW_RENDERER
    // config-input: CMS_DEV_PREVIEW_STAFF_WORKER, CMS_DEV_PREVIEW_WORKER, CMS_DEV_PUBLIC_ORIGIN
    // config-input: CMS_DEV_SITE_PAGES, CMS_PRODUCTION_API_ORIGIN
    const value = env[name];
    return Object.hasOwn(env, name) && value !== undefined && value !== "" && value !== input.placeholder;
  }).map(([name]) => name);
}

function safeFile(root, filename) {
  const path = resolve(root, filename);
  if (relative(root, path).startsWith("..") || !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(realpathSync(root) + sep)) refuse();
  return path;
}

const receiptName = ".rendered-deployment-inputs.json";
export function hasRenderedDevelopmentInputs(root) {
  try { lstatSync(resolve(root, receiptName)); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function sourceEnvironment(root, env, manifest) {
  const path = resolve(root, receiptName);
  if (!hasRenderedDevelopmentInputs(root)) return { env, recorded: false };
  const receipt = JSON.parse(readFileSync(safeFile(root, receiptName), "utf8"));
  if (receipt.schemaVersion !== 1 || Object.keys(receipt).sort().join() !== "commitSha,inputs,schemaVersion" ||
      receipt.commitSha !== gitSource(root, ["rev-parse", "HEAD"]).trim()) refuse();
  if (!receipt.inputs || !Object.keys(receipt.inputs).length) refuse();
  const values = developmentValues(receipt.inputs, { only: Object.keys(receipt.inputs), manifest });
  for (const [name, value] of Object.entries(values)) {
    // config-input: CLOUDFLARE_DEV_PUBLIC_WORKER, CMS_DEV_ADMIN_ORIGIN, CMS_DEV_ADMIN_PAGES
    // config-input: CMS_DEV_API_ORIGIN, CMS_DEV_API_WORKER, CMS_DEV_MEDIA_BUCKET, CMS_DEV_MEDIA_ORIGIN
    // config-input: CMS_DEV_PREVIEW_BUCKET, CMS_DEV_PREVIEW_ORIGIN, CMS_DEV_PREVIEW_RENDERER
    // config-input: CMS_DEV_PREVIEW_STAFF_WORKER, CMS_DEV_PREVIEW_WORKER, CMS_DEV_PUBLIC_ORIGIN
    // config-input: CMS_DEV_SITE_PAGES, CMS_PRODUCTION_API_ORIGIN
    if (Object.hasOwn(env, name) && env[name] !== value) refuse();
  }
  return { env: values, recorded: true };
}

/** Verify every local change against the committed template and trusted inputs.
 * This retains the clean-source gate after deterministic build preparation.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ allowedChanges?: string[], trustedCopies?: Record<string, string> }} [options]
 */
export function assertDevelopmentSource(root, env = process.env, { allowedChanges = [], trustedCopies = {} } = {}) {
  const status = gitSource(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if (!status && !hasRenderedDevelopmentInputs(root)) return true;
  if (gitSource(root, ["rev-parse", "--show-prefix"]).trim() !== "") refuse();
  const manifest = readDeploymentManifest(root);
  let rows = status.split("\0").filter(Boolean);
  for (const [target, source] of Object.entries(trustedCopies)) {
    if (!rows.includes("?? " + target)) continue;
    const committed = committedTemplates(root, [source]).get(source);
    if (readFileSync(safeFile(root, target), "utf8") !== committed) refuse();
    rows = rows.filter(row => row !== "?? " + target);
  }
  if (!manifest) {
    if (hasRenderedDevelopmentInputs(root)) refuse();
    if (rows.some(row => row.slice(0, 3) !== " M " || !allowedChanges.includes(row.slice(3)))) refuse();
    return true;
  }
  const context = sourceEnvironment(root, env, manifest);
  if (context.recorded) rows = rows.filter(row => row !== "?? " + receiptName);
  const only = configuredInputs(context.env, manifest);
  const values = developmentValues(context.env, { only, manifest }), files = filesByInput(only, manifest);
  for (const row of rows) if (row.slice(0, 3) !== " M " ||
      !allowedChanges.includes(row.slice(3)) && !files.has(row.slice(3))) refuse();
  const outputs = expectedOutputs(root, manifest, only, values);
  const names = context.recorded ? [...outputs.keys()] : rows.map(row => row.slice(3));
  for (const filename of names) {
    if (allowedChanges.includes(filename)) continue;
    if (!outputs.has(filename) || readFileSync(safeFile(root, filename), "utf8") !== outputs.get(filename)) refuse();
  }
  return true;
}

/** Bind deployment receipts and source readback to the same prepared bytes.
 * These helpers run in build/operator tools, never in a request handler.
 */
export function renderCommittedDeploymentSource(filename, source, env = process.env, manifest = inputManifest) {
  if (!manifest) return source;
  const names = configuredInputs(env, manifest).filter(name => manifest.inputs[name].files.includes(filename));
  return renderDevelopmentText(source, names, developmentValues(env, { only: names, manifest }), manifest);
}

export function deploymentInputFingerprint(paths, env = process.env, manifest = inputManifest) {
  if (!manifest) return "";
  const names = configuredInputs(env, manifest).filter(name => manifest.inputs[name].files.some(filename =>
    paths.some(path => filename === path || filename.startsWith(path + "/")))).sort();
  if (!names.length) return "";
  return createHash("sha256").update(JSON.stringify(developmentValues(env, { only: names, manifest }))).digest("hex");
}

/** Render only an explicitly selected disposable checkout, before building or
 * starting tools. No lookup or substitution is added to a request handler.
 */
export function renderDevelopmentConfig(root, env = process.env, options = {}) {
  root = resolve(root);
  assertDevelopmentSource(root, env);
  const manifest = readDeploymentManifest(root);
  if (!manifest) return 0; // Explicit legacy path: preserve verified original pins.
  const only = options.only ?? Object.keys(manifest.inputs);
  if (!only.length) refuse();
  const values = developmentValues(env, { only, manifest });
  const outputs = expectedOutputs(root, manifest, only, values), plan = [];
  for (const [filename, rendered] of outputs) plan.push([safeFile(root, filename), rendered]);
  // Validate the complete plan before any write. Input values never reach stdout.
  for (const [path, rendered] of plan) writeFileSync(path, rendered);
  // Isolated container builds receive only validated non-secret input pins.
  const receipt = resolve(root, receiptName);
  if (existsSync(receipt)) safeFile(root, receiptName);
  writeFileSync(receipt, JSON.stringify({ schemaVersion: 1,
    commitSha: gitSource(root, ["rev-parse", "HEAD"]).trim(), inputs: values }) + "\n", { mode: 0o600 });
  return plan.length;
}

/** Restore only verified render output before selecting a different retained
 * commit. A source checkout never discards an unrelated local edit.
 */
export function restoreDevelopmentTemplates(root, env = process.env) {
  assertDevelopmentSource(root, env);
  const status = gitSource(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  const rows = status.split("\0").filter(row => row && row !== "?? " + receiptName);
  const names = rows.map(row => row.slice(3));
  const templates = names.length ? committedTemplates(root, names) : new Map();
  for (const row of rows) {
    const filename = row.slice(3);
    writeFileSync(safeFile(root, filename), templates.get(filename));
  }
  const receipt = resolve(root, receiptName);
  if (existsSync(receipt)) unlinkSync(safeFile(root, receiptName));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    let root, checking = false;
    while (args.length) {
      const flag = args.shift();
      if (flag === "--check-source" && !checking) checking = true;
      else if (flag === "--production" && !options.only) options.only = ["CMS_PRODUCTION_API_ORIGIN"];
      else if (flag === "--inputs" && !options.only && args[0]) options.only = args.shift().split(",");
      else if (flag === "--root" && !root && args[0]) root = args.shift();
      else refuse();
    }
    if (!root) refuse();
    if (checking) assertDevelopmentSource(root);
    else {
      const count = renderDevelopmentConfig(root, process.env, options);
      process.stdout.write(`Development configuration rendered: ${count} files\n`);
    }
  } catch {
    // OS and parser errors can contain paths or configured values.
    console.error("Development configuration render refused; check inputs and the clean template checkout");
    process.exitCode = 1;
  }
}
