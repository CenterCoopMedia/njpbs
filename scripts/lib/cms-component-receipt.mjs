import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { builtinModules, createRequire } from "node:module";
import runtimeProcess from "node:process";
import { deploymentInputFingerprint, readDeploymentManifest } from "../render-development-config.mjs";
import { fileURLToPath } from "node:url";

const previewPair = () => createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
const pageReader = () => createRequire(import.meta.url)("../../functions/lib/page-reader-compatibility.js");

const execFileAsync = promisify(execFile);

export const RECEIPT_COLLECTION = "cmsDeploymentReceipts";
export const RECEIPT_SCHEMA_VERSION = 1;
export const FUNCTION_GRAPH_VERSION = 2;
export const RECEIPT_COMPONENTS = Object.freeze(["functions", "renderer", "cmsApi"]);
export const RECEIPT_INPUT_PATHS = Object.freeze({
  functions: Object.freeze([
    "config/functions-configuration.json", "config/functions-deployment.json",
    "scripts/configure-cms-functions.mjs", "scripts/lib/functions-configuration.mjs",
    "scripts/lib/functions-secret-versions.mjs",
    "scripts/render-development-config.mjs",
    "config/development-inputs.json",
    "functions",
    ".npmrc",
    "admin/package.json",
    "cms-api/package.json",
    "firebase.json",
    ".firebaserc",
    "scripts/deploy-cms-function-batches.mjs",
    "scripts/lib/functions-deploy-inventory.mjs",
    "scripts/smoke-cms-functions.mjs",
    "scripts/resolve-media-purge.sh",
    "scripts/resolve-cost-ledger-pulls.sh",
    "scripts/prepare-cloud-publication-wake.mjs",
    "packages",
    "package.json",
    "package-lock.json",
  ]),
  renderer: Object.freeze([
    "scripts/render-development-config.mjs",
    "config/development-inputs.json",
    "preview-renderer",
    "site",
    "functions",
    "packages",
    "scripts/prepare-preview-renderer.mjs",
    "package.json",
    "package-lock.json",
  ]),
  cmsApi: Object.freeze([
    "scripts/render-development-config.mjs",
    "config/development-inputs.json",
    "cms-api",
    // External runtime imports of the Worker; types alone do not enter its bundle.
    "functions/lib/public-asset-hosts.json",
    "admin/src/lib/publication-video-set.ts",
    "admin/src/lib/record-equality.ts",
    "admin/src/lib/content-row-editing.ts",
    "admin/src/lib/collection-item-keys.ts",
    "admin/src/lib/block-editor-state.ts",
    "admin/src/lib/home-layouts.ts",
    "admin/src/lib/empty-rich-text.ts",
    "admin/src/lib/field-defaults.ts",
    "admin/src/lib/block-factory.ts",
    "admin/src/lib/public-page-block-ownership.ts",
    "admin/src/lib/content-save-request.ts",
    "functions/lib/page-reader-contract.js",
    "functions/lib/public-page-contract.js",
    "packages/content-core",
    "package.json",
    "package-lock.json",
    ".npmrc",
  ]),
});

const SHA = /^[0-9a-f]{40}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const RUN_ID = /^[0-9]{1,20}$/;

export class ComponentReceiptError extends Error {
  constructor(message) {
    super(message);
    this.name = "ComponentReceiptError";
  }
}

function fail(message) {
  throw new ComponentReceiptError(message);
}

export function requireComponent(value) {
  if (!RECEIPT_COMPONENTS.includes(value)) fail("Receipt component is invalid");
  return value;
}

export function requireSha(value, label = "SHA") {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is invalid`);
  return value;
}

export function requireRunId(value) {
  if (typeof value !== "string" || !RUN_ID.test(value)) fail("Run id is invalid");
  return value;
}

export function requireRunAttempt(value) {
  const attempt = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000) {
    fail("Run attempt is invalid");
  }
  return attempt;
}

export function parseProviderIdentities(value) {
  if (value == null) return null;
  const raw = typeof value === "string" ? JSON.parse(value) : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Provider identities are invalid");
  const keys = Object.keys(raw);
  if (keys.length === 0 || keys.length > 20) fail("Provider identities are invalid");
  const identities = {};
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0 || key.length > 40) fail("Provider identities are invalid");
    const entry = raw[key];
    if (typeof entry === "string") {
      if (entry.length === 0 || entry.length > 300) fail("Provider identities are invalid");
      identities[key] = entry;
      continue;
    }
    if (!Array.isArray(entry) || entry.length === 0 || entry.length > 200) {
      fail("Provider identities are invalid");
    }
    identities[key] = entry.map((item) => {
      if (typeof item !== "string" || item.length === 0 || item.length > 80) {
        fail("Provider identities are invalid");
      }
      return item;
    });
  }
  return identities;
}

// Key order does not change the digest. Only string values are accepted.
export function configurationFingerprint(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) fail("Configuration is invalid");
  const keys = Object.keys(values).sort();
  if (keys.length === 0 || keys.some((key) => typeof values[key] !== "string" || values[key].length === 0)) {
    fail("Configuration is invalid");
  }
  const canonical = JSON.stringify(Object.fromEntries(keys.map((key) => [key, values[key]])));
  return createHash("sha256").update("njpbs-cms-api-configuration-v1\n").update(canonical).digest("hex");
}

// Hash the shared edge secret separately from Worker-only configuration.
export function edgeOriginSecretFingerprint(values) {
  const secret = values?.CMS_EDGE_ORIGIN_SECRET;
  if (typeof secret !== "string" || secret.length < 32) fail("CMS edge origin secret is missing or invalid");
  return configurationFingerprint({ CMS_EDGE_ORIGIN_SECRET: secret });
}

export async function fingerprintPaths(sourceSha, paths, deps = {}) {
  requireSha(sourceSha, "Source SHA");
  if (!Array.isArray(paths) || paths.length === 0) fail("Fingerprint paths are invalid");
  const listTree = deps.listTree ?? (async (sha, treePaths) => {
    const { stdout } = await execFileAsync("git", ["ls-tree", "-r", sha, "--", ...treePaths], {
      cwd: deps.cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  });
  const listing = await listTree(sourceSha, paths);
  const manifest = deps.listTree ? null : readDeploymentManifest(deps.cwd ?? process.cwd(), sourceSha);
  const configured = deploymentInputFingerprint(paths, process.env, manifest);
  return createHash("sha256").update(listing + (configured ? `\nrender-inputs:${configured}` : "")).digest("hex");
}

export async function fingerprintInputs(sourceSha, component, deps = {}) {
  const paths = RECEIPT_INPUT_PATHS[requireComponent(component)];
  if (component !== "cmsApi") return fingerprintPaths(sourceSha, paths, deps);
  return fingerprintPaths(sourceSha, [...paths, ...await cmsApiBundleInputs(sourceSha, deps)], deps);
}

// Discover the Worker's local runtime inputs from committed sources, without
// executing selected application code or reading generated checkout files.
async function cmsApiBundleInputs(sourceSha, deps) {
  requireSha(sourceSha, "Source SHA");
  const { stdout } = await execFileAsync("git", ["ls-tree", "-rz", sourceSha], {
    cwd: deps.cwd, maxBuffer: 16 * 1024 * 1024,
  });
  const files = new Map(stdout.split("\0").filter(Boolean).map(line => {
    const [metadata, path] = line.split("\t");
    if (!path || /[\r\n]/.test(path)) fail("CMS API bundle input path is invalid");
    return [path, metadata];
  }));
  const contents = new Map();
  const read = async path => {
    if (!files.get(path)?.startsWith("100")) fail("CMS API bundle input is not a regular committed file");
    if (!contents.has(path)) contents.set(path, execFileAsync("git", ["show", `${sourceSha}:${path}`], {
      cwd: deps.cwd, maxBuffer: 8 * 1024 * 1024,
    }).then(result => result.stdout));
    return contents.get(path);
  };
  const entryPoints = [];
  for (const configPath of ["cms-api/wrangler.jsonc", "cms-api/wrangler.dev.jsonc"]) {
    const config = JSON.parse(await read(configPath));
    if (typeof config.main !== "string" || posix.isAbsolute(config.main)
      || config.alias || config.build || config.rules || config.tsconfig) fail("CMS API bundle configuration is unsupported");
    const entry = posix.normalize(posix.join("cms-api", config.main));
    if (!entry.startsWith("cms-api/")) fail("CMS API bundle entrypoint is invalid");
    entryPoints.push(entry);
  }
  const tsconfig = JSON.parse(await read("cms-api/tsconfig.json"));
  if (tsconfig.extends || tsconfig.compilerOptions?.paths || tsconfig.compilerOptions?.baseUrl) fail("CMS API bundle aliases are unsupported");
  const lock = JSON.parse(await read("package-lock.json"));
  const external = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`),
    "cloudflare:workers", "cloudflare:sockets", ...Object.entries(lock.packages ?? {})
      .filter(([location, entry]) => location.includes("node_modules/") && !entry.link && !entry.resolved?.startsWith("file:"))
      .map(([location]) => location.split("node_modules/").at(-1))]);
  const { build } = await import("esbuild");
  const result = await build({ entryPoints: [...new Set(entryPoints)], bundle: true, write: false,
    outdir: "/cms-api-inputs-unused", platform: "browser", format: "esm", metafile: true,
    logLevel: "silent", treeShaking: false,
    logOverride: { "unsupported-require-call": "error", "unsupported-dynamic-import": "error", "indirect-require": "error", "direct-eval": "error" },
    plugins: [{ name: "committed-cms-api", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (args.kind === "entry-point") return { path: posix.normalize(args.path), namespace: "git" };
        if (!args.path.startsWith(".")) {
          const name = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0];
          if (!external.has(args.path) && !external.has(name)) fail("CMS API bundle has an unknown package input");
          return { path: args.path, external: true };
        }
        const base = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
        const path = [base, ...[".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"].map(ext => base + ext)]
          .find(candidate => files.has(candidate));
        if (!path || base.startsWith("../")) fail("CMS API bundle has an unresolved local input");
        return { path, namespace: "git" };
      });
      builder.onLoad({ filter: /.*/, namespace: "git" }, async args => ({
        contents: await read(args.path), loader: ({ ".mjs": "js", ".cjs": "js" })[posix.extname(args.path)] ?? posix.extname(args.path).slice(1),
      }));
    } }],
  });
  if (result.warnings.length) fail("CMS API bundle discovery is incomplete");
  const inputs = new Set(Object.keys(result.metafile.inputs).map(path => path.slice("git:".length)));
  // esbuild also reads package/compiler settings above each bundled module.
  for (const file of [...inputs]) {
    let directory = posix.dirname(file);
    while (true) {
      for (const name of ["package.json", "tsconfig.json"]) {
        const config = posix.join(directory, name);
        if (files.has(config)) inputs.add(config);
      }
      if (directory === ".") break;
      directory = posix.dirname(directory);
    }
  }
  return [...inputs].sort();
}

// One Git process for immutable source blobs. Byte-counted frames keep embedded
// newlines/header-like source text from changing the object boundaries.
export async function readCommittedBlobs(blobIds, deps = {}) {
  const ids = [...new Set(blobIds.map(id => requireSha(id, "Blob SHA")))];
  if (!ids.length) return new Map();
  if (ids.length > 10_000) fail("Committed source batch is too large");
  const request = execFileAsync("git", ["cat-file", "--batch"], {
    cwd: deps.cwd, encoding: null, maxBuffer: 64 * 1024 * 1024,
  });
  // The child exit status and strict reply validation also cover broken pipes.
  request.child.stdin.on("error", () => {});
  request.child.stdin.end(`${ids.join("\n")}\n`);
  const { stdout } = await request;
  const result = new Map();
  let offset = 0;
  for (const id of ids) {
    const end = stdout.indexOf(10, offset);
    if (end < offset || end - offset > 100) fail("Committed source frame is invalid");
    const header = stdout.subarray(offset, end).toString("ascii").match(/^([a-f0-9]{40}) blob ([0-9]+)$/);
    const size = Number(header?.[2]);
    const start = end + 1, next = start + size;
    if (header?.[1] !== id || !Number.isSafeInteger(size) || size < 0
      || next >= stdout.length || stdout[next] !== 10) fail("Committed source frame is invalid");
    result.set(id, stdout.subarray(start, next).toString("utf8"));
    offset = next + 1;
  }
  if (offset !== stdout.length) fail("Committed source batch has trailing data");
  return result;
}

// The retained Home reader is a generated CommonJS bundle. Its two static
// createRequire aliases derive URLs from this file's own __filename, so their literal edges
// have exactly the same origin as native require. Admit only the inspected
// bundle versions; an unknown loader chooses a full deploy rather than omitting
// a dependency. Rewriting is for discovery only, never executable output.
export function functionGraphSource(source, file, metadata, parser) {
  if (file === "functions/lib/home-retained-sources.js") {
    if (!["4b62e777dcf9b591597bb5556563e93c593cb929", "9267498eef3de38758ec23fc8459922dd1e4b7d5",
      "45042d7b450d98bb1dd19bec543872d1b4d4cc41",
      "efb5589b8d110ee0c1d078c24ab903c4f4df1ed4",
      "046326ed5c6d2bbeec9a225f2cc8d26c6df1b6c3",
      "b24b366f498ad7270379929c074c60b0650aa5c6",
      "3cf5551ea55dcdd27090ca732120df2a049fe02e",
      "64ba63f43db97408202fb6cf94da1fadb1c6e0ed",
      "ccc2e1484b80e767844bdd30ad09181c4305fc68",
      "89d0875f8d83477be5be5fe71246b07296385664",
      "08e6ccf37936fdf0f394996d87110e8172ba00f9",
      "0c63f0ae9df7e78e8c83503f2697482bcfc9a525",
      "322c8f0534cd3de7721c79d2a14156a94bdb2883",
      "09745dddf633597d571e8838c63aea7b04a19973",
      "398a8d0ea0d6a1518472d7b554ed169dd2dcb5b2",
      "0096c6a05846dcb7b04b55d8670cd75fc1ba9a9c",
      "a67e21c8283f1ba192b3ace10e31a7a6f3172d44",
      "463a670a59c84b5b67957945b80832591abb4a6a",
      "acb8042f1ca98256cd2ccb98d8ed0eac59c1efad",
      "7d71ffb5263b9084a68184ab5727ed4db2841de8",
      "03a54c485188b8ed2a22b7b652a1d36a7a003771",
      "39b977a39305cb271978f3fa909f7614677f1437",
      "8fe9788251e154766254d97c493284b9e9e2ca57",
      "816e8601c9a30ebcb234337b6e77d18d8d650e88",
      "4bddc4d456a5e6cd475b2af6675a9e6f67c6dac1"].includes(metadata?.split(" ").at(-1))) {
      throw new Error("Unknown retained-reader module loader");
    }
    return source.replace(/\b(?:requireModule|require2)(\s*\()/g, "require$1");
  }
  const ts = parser ?? createRequire(new URL("../../site/package.json", import.meta.url))("typescript");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error("Unknown module syntax");
  const loaders = new Set(["createRequire", "getBuiltinModule", "mainModule", "eval", "Function"]);
  const visit = node => {
    const dataKey = node.parent && ts.isPropertyAssignment(node.parent) && node.parent.name === node;
    const identifier = ts.isIdentifier(node) && loaders.has(node.text) && !dataKey;
    const property = ts.isPropertyAccessExpression(node) && node.name.text === "require";
    const computed = ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
      && (loaders.has(node.argumentExpression.text) || node.argumentExpression.text === "require");
    if (identifier || property || computed) throw new Error("Unknown dynamic module loader");
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return source;
}

// Read only committed blobs. Never execute application code to discover its
// graph, and never let the deploy checkout's generated files enter a receipt.
// A module fingerprint covers its complete local closure, including lazy imports.
// Package/config/asset changes remain full releases; only JS module edits can
// select a subset. esbuild refuses unresolved or dynamic require/import edges.
// Native and typed loaders can instantiate this module separately. Share only
// the pure committed graph within this process, never provider or SDK state.
const GRAPH_CACHE = Symbol.for("njpbs.cms-function-graph.v2");
const graphModule = new URL(import.meta.url); graphModule.search = ""; graphModule.hash = "";
export async function fingerprintFunctionGraph(sourceSha, deps = {}) {
  let key, pending, cache;
  try {
    requireSha(sourceSha);
    const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", `${sourceSha}^{tree}`],
      { cwd: deps.cwd, maxBuffer: 16 * 1024 });
    const identity = stdout.trim().split("\n");
    if (identity.length !== 2 || !identity[0] || !SHA.test(identity[1])) return null;
    key = JSON.stringify([graphModule.href, ...identity, sourceSha, deploymentInputFingerprint(RECEIPT_INPUT_PATHS.functions, process.env, readDeploymentManifest(deps.cwd ?? process.cwd(), sourceSha))]);
    cache = runtimeProcess[GRAPH_CACHE] ??= new Map();
    pending = cache.get(key);
    if (!pending) {
      pending = buildFunctionGraph(sourceSha, deps);
      cache.set(key, pending);
      while (cache.size > 8) cache.delete(cache.keys().next().value);
    }
    const graph = await pending;
    if (!graph && cache.get(key) === pending) cache.delete(key);
    return graph ? structuredClone(graph) : null;
  } catch {
    if (cache && cache.get(key) === pending) cache.delete(key);
    return null;
  }
}
async function buildFunctionGraph(sourceSha, deps = {}) {
  try {
    requireSha(sourceSha);
    const git = async (...args) => (await execFileAsync("git", args, {
      cwd: deps.cwd, maxBuffer: 16 * 1024 * 1024,
    })).stdout;
    const listing = await git("ls-tree", "-rz", sourceSha);
    const files = new Map(listing.split("\0").filter(Boolean).map(line => {
      const [metadata, path] = line.split("\t");
      return [path, metadata];
    }));
    // The common Functions/package closure otherwise starts a Git process
    // for every module during esbuild discovery. Batch immutable blobs through
    // the existing byte-framed reader; uncommon outside paths keep the exact
    // original per-file fallback. Neither path executes application code.
    let blobs = new Map();
    try {
      const ids = [...files].filter(([path, metadata]) => metadata.startsWith("100") &&
        /^(functions|packages)\//.test(path) && /\.(js|mjs|json)$/.test(path))
        .map(([, metadata]) => metadata.split(" ").at(-1));
      blobs = await readCommittedBlobs(ids, { cwd: deps.cwd });
    } catch { /* A bounded batch refusal falls back to original source reads. */ }
    const cache = new Map();
    const read = path => {
      if (!cache.has(path)) {
        const id = files.get(path)?.split(" ").at(-1);
        cache.set(path, blobs.has(id) ? Promise.resolve(blobs.get(id)) : git("show", `${sourceSha}:${path}`));
      }
      return cache.get(path);
    };
    const index = await read("functions/index.js");
    if (/^exports\./m.test(index)) return null;
    const entries = [...index.matchAll(/^lazyExport\("([A-Za-z][A-Za-z0-9]*)", "(\.\/[^"\n]+)"[^\n]*\);$/gm)];
    if (!entries.length || entries.length !== [...index.matchAll(/^lazyExport\(/gm)].length) return null;
    const resolveLocal = (specifier, importer = "functions/index.js") => {
      const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
      const path = [base, `${base}.js`, `${base}.json`, `${base}.mjs`, `${base}/index.js`].find(p => files.has(p));
      if (!path || path.startsWith("../") || !files.get(path).startsWith("100")) throw new Error("Unresolved graph edge");
      return path;
    };
    const roots = Object.fromEntries(entries.map(([, name, specifier]) => [name, resolveLocal(specifier)]));
    if (Object.keys(roots).length !== entries.length) return null;
    const pkg = JSON.parse(await read("functions/package.json"));
    const external = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), ...Object.keys(pkg.dependencies)]);
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [...new Set(["functions/index.js", ...Object.values(roots)])], bundle: true, write: false,
      outdir: "/cms-graph-unused", platform: "node", format: "cjs", metafile: true,
      logLevel: "silent", treeShaking: false,
      logOverride: { "unsupported-require-call": "error", "unsupported-dynamic-import": "error", "indirect-require": "error", "direct-eval": "error" },
      plugins: [{ name: "committed-functions", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind === "entry-point") return { path: posix.normalize(args.path), namespace: "git" };
          if (!args.path.startsWith(".")) {
            if (["module", "node:module"].includes(args.path) && args.importer !== "functions/lib/home-retained-sources.js") {
              throw new Error("Unknown dynamic module loader");
            }
            const packageName = args.path.startsWith("@") ? args.path.split("/").slice(0, 2).join("/") : args.path.split("/")[0];
            if (!external.has(args.path) && !external.has(packageName)) throw new Error("Unknown external graph edge");
            return { path: args.path, external: true };
          }
          return { path: resolveLocal(args.path, args.importer), namespace: "git" };
        });
        builder.onLoad({ filter: /.*/, namespace: "git" }, async args => {
          const source = await read(args.path);
          return {
            // The exact lazy shim's variable edge is represented by roots above.
            // Bundle its other edges normally: top-level startup code executes
            // in every function, including closures not reached by its handler.
            contents: args.path.endsWith(".json") ? source : functionGraphSource(args.path === "functions/index.js"
              ? source.replace(/require\(modulePath\)\[moduleExportName\]/g, "({})[moduleExportName]") : source,
            args.path, files.get(args.path)),
            loader: args.path.endsWith(".json") ? "json" : "js",
          };
        });
      } }],
    });
    if (result.warnings.length) return null;
    const inputs = result.metafile.inputs;
    const manifest = readDeploymentManifest(deps.cwd ?? process.cwd(), sourceSha);
    const digest = paths => {
      const configured = deploymentInputFingerprint(paths, process.env, manifest);
      return createHash("sha256").update(paths.sort().map(path => `${files.get(path)}\t${path}`).join("\n") +
        (configured ? `\nrender-inputs:${configured}` : "")).digest("hex");
    };
    const closure = root => {
      const paths = new Set();
      const visit = key => {
        const input = inputs[key];
        if (!input) throw new Error("Incomplete graph");
        if (paths.has(key.slice(4))) return;
        paths.add(key.slice(4));
        for (const edge of input.imports) if (!edge.external) visit(edge.path);
      };
      visit(`git:${root}`);
      return paths;
    };
    const startup = closure("functions/index.js");
    const exports = {};
    for (const [name, root] of Object.entries(roots)) {
      const paths = new Set([...startup, ...closure(root)]);
      const sources = await Promise.all([...paths].map(read));
      exports[name] = {
        fingerprint: digest([...paths]),
        preview: sources.some(source => /CMS_PREVIEW_RENDERER_SHA|cmsPreviewRuntime/.test(source)),
      };
    }
    const globalPaths = [...files.keys()].filter(path => RECEIPT_INPUT_PATHS.functions.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))
      .filter(path => !path.startsWith("functions/") || !/\.(?:js|mjs|cjs)$/.test(path) || path === "functions/index.js");
    return { version: FUNCTION_GRAPH_VERSION, globalFingerprint: digest([...new Set([...globalPaths, ...startup])]), exports };
  } catch {
    // Discovery uncertainty chooses a full deploy, including at receipt write.
    return null;
  }
}

function mutationRecord({
  sourceSha,
  trustedWorkflowSha,
  runId,
  runAttempt,
  startedAt,
  releaseStartedAt = startedAt,
  completedAt,
  inputFingerprint,
  providerIdentities,
}) {
  return {
    sourceSha: requireSha(sourceSha, "Source SHA"),
    trustedWorkflowSha: requireSha(trustedWorkflowSha, "Trusted workflow SHA"),
    runId: requireRunId(runId),
    runAttempt: requireRunAttempt(runAttempt),
    startedAt,
    releaseStartedAt,
    completedAt,
    inputFingerprint: typeof inputFingerprint === "string" && FINGERPRINT.test(inputFingerprint)
      ? inputFingerprint
      : fail("Input fingerprint is invalid"),
    providerIdentities,
  };
}

function sameAttempt(left, right) {
  return left?.sourceSha === right.sourceSha &&
    left?.runId === right.runId &&
    left?.runAttempt === right.runAttempt;
}

export function receiptRef(firestore, component) {
  return firestore.collection(RECEIPT_COLLECTION).doc(requireComponent(component));
}

// A receipt written before releaseStartedAt existed has no reliable lower
// bound: its startedAt can follow the rollout when a retry completed without
// one. It stays unbounded (null) until a release of another commit.
function hasReleaseStart(mutation) {
  return typeof mutation?.releaseStartedAt === "string";
}

// A retry of the same commit keeps its first start. A retry that deploys an
// unchanged container starts no new rollout, and the earlier rollout must
// still count as this commit's release.
function earliestReleaseStart(current, sourceSha, nowIso) {
  const sameCommit = [current?.mutation, current?.lastComplete]
    .filter((mutation) => mutation?.sourceSha === sourceSha);
  if (sameCommit.some((mutation) => !hasReleaseStart(mutation))) return null;
  return sameCommit
    .map((mutation) => mutation.releaseStartedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest, nowIso);
}

export async function startReceipt(firestore, input, deps = {}) {
  const component = requireComponent(input.component);
  const clock = deps.now ?? (() => new Date());
  const nowIso = clock().toISOString();
  const inputFingerprint = input.inputFingerprint ??
    await fingerprintInputs(input.sourceSha, component, deps);
  const functionGraph = component === "functions" ? await fingerprintFunctionGraph(input.sourceSha, deps) : null;
  const ref = receiptRef(firestore, component);
  return firestore.runTransaction(async (transaction) => {
    // Bootstrap reads these receipts in its selector transaction. Reading the
    // selector here makes the two writers conflict instead of crossing epochs.
    const runtime = await transaction.get(firestore.doc("system/cmsPreviewRuntime"));
    assertLegacyPreviewProtocol(runtime.exists ? runtime.data() : null);
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists ? snapshot.data() : null;
    if (current?.schemaVersion !== undefined && current.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
      fail("Legacy receipt writer refuses another schema");
    }
    const nextMutation = mutationRecord({
      sourceSha: input.sourceSha,
      trustedWorkflowSha: input.trustedWorkflowSha,
      runId: input.runId,
      runAttempt: input.runAttempt,
      startedAt: nowIso,
      releaseStartedAt: earliestReleaseStart(current, input.sourceSha, nowIso),
      completedAt: null,
      inputFingerprint,
      providerIdentities: null,
    });
    if (component === "functions") {
      nextMutation.functionGraph = functionGraph;
      nextMutation.previewRendererSha = requireSha(input.previewRendererSha ?? input.sourceSha, "Preview renderer SHA");
      if (current?.state === "in_progress" && current.mutation?.retirementPlan) {
        const sameRun = current.mutation.runId === nextMutation.runId;
        if (sameRun && (current.mutation.sourceSha !== nextMutation.sourceSha
          || current.mutation.trustedWorkflowSha !== nextMutation.trustedWorkflowSha
          || current.mutation.runAttempt > nextMutation.runAttempt)) fail("Functions attempt identity changed");
        // A forward run takes the writer reservation, not the old proof. Prepare
        // retains each pending resource's original identity before any mutation.
        nextMutation.retirementPlan = current.mutation.retirementPlan;
        nextMutation.retirementStarted = current.mutation.retirementStarted === true;
        nextMutation.retirementComplete = sameRun && current.mutation.retirementComplete === true;
      }
    }
    if (
      current?.schemaVersion === RECEIPT_SCHEMA_VERSION &&
      current.state === "in_progress" &&
      sameAttempt(current.mutation, nextMutation)
    ) {
      return { changed: false, receipt: current };
    }
    const lastComplete = current?.state === "complete"
      ? current.mutation
      : (current?.lastComplete ?? null);
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      component,
      state: "in_progress",
      mutation: nextMutation,
      lastComplete,
    };
    transaction.set(ref, receipt);
    return { changed: true, receipt };
  });
}

export async function completeReceipt(firestore, input, { readPageReaderSource = async sourceSha => {
  const source = requireSha(sourceSha, "Source SHA"), descriptor = "cms-api/src/page-reader-contract.json";
  const git = async args => (await execFileAsync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), maxBuffer: 8192,
    env: { PATH: runtimeProcess.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" },
  })).stdout;
  try {
    const file = await git(["ls-tree", "--name-only", source, "--", descriptor]);
    if (!file.trim()) return null;
    if (file.trim() !== descriptor) fail("CMS API Page reader source is invalid");
    return await git(["show", `${source}:${descriptor}`]);
  } catch { fail("CMS API Page reader source could not be verified"); }
} } = {}) {
  const component = requireComponent(input.component);
  const providerIdentities = parseProviderIdentities(input.providerIdentities);
  if (!providerIdentities) fail("Provider identities are required");
  const configurationFingerprint = input.configurationFingerprint ?? null;
  if (configurationFingerprint !== null && !FINGERPRINT.test(configurationFingerprint)) {
    fail("Configuration fingerprint is invalid");
  }
  const variablesFingerprint = input.variablesFingerprint ?? null;
  if (variablesFingerprint !== null && !FINGERPRINT.test(variablesFingerprint)) fail("Variables fingerprint is invalid");
  const nowIso = new Date().toISOString();
  const ref = receiptRef(firestore, component);
  const pageReaderSource = component === "cmsApi" ? await readPageReaderSource(input.sourceSha) : null;
  let pageReaderVersion = 0;
  if (pageReaderSource !== null) {
    const descriptor = JSON.parse(pageReaderSource);
    if (Object.keys(descriptor).sort().join(",") !== "pageReaderVersion,schemaVersion" ||
        descriptor.schemaVersion !== 1 || descriptor.pageReaderVersion !== 1) fail("Unsupported CMS API Page reader contract");
    pageReaderVersion = descriptor.pageReaderVersion;
  }
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) fail("Receipt is not in progress");
    const current = snapshot.data();
    if (
      current.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
      current.state !== "in_progress" ||
      current.mutation?.sourceSha !== requireSha(input.sourceSha, "Source SHA") ||
      current.mutation?.runId !== requireRunId(input.runId) ||
      current.mutation?.runAttempt !== requireRunAttempt(input.runAttempt)
    ) {
      fail("Receipt does not match this mutation");
    }
    const mutation = {
      ...current.mutation,
      completedAt: nowIso,
      providerIdentities,
      configurationFingerprint,
      ...(variablesFingerprint ? { variablesFingerprint } : {}),
    };
    const plan = current.mutation.retirementPlan;
    if (component === "functions" && plan && (current.mutation.retirementComplete !== true
      || plan.sourceSha !== current.mutation.sourceSha || plan.trustedWorkflowSha !== current.mutation.trustedWorkflowSha
      || plan.runId !== current.mutation.runId)) fail("Functions retirement absence has not been proved for this release");
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      component,
      state: "complete",
      mutation,
      lastComplete: mutation,
    };
    if (pageReaderVersion === 1) pageReader().writeApiReaderMarker({ firestore, transaction, receipt });
    transaction.set(ref, receipt);
    return { changed: true, receipt };
  });
}

export async function abandonReceipt(firestore, input) {
  const component = requireComponent(input.component);
  const runId = requireRunId(input.runId);
  const runAttempt = requireRunAttempt(input.runAttempt);
  const clock = input.now ?? (() => new Date());
  const ref = receiptRef(firestore, component);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) fail("Receipt is not in progress");
    const current = snapshot.data();
    if (
      current.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
      current.state !== "in_progress" ||
      current.mutation?.runId !== runId ||
      current.mutation?.runAttempt !== runAttempt
    ) {
      fail("Receipt does not match this run and attempt");
    }
    if (!current.lastComplete) {
      fail("Receipt has no prior completed mutation to restore");
    }
    if (component === "functions" && (runAttempt !== 1 || current.mutation.retirementStarted === true)) {
      fail("A later or started Functions attempt cannot claim no provider mutation");
    }
    const receipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      component,
      state: "complete",
      mutation: current.lastComplete,
      lastComplete: current.lastComplete,
      abandoned: { runId, runAttempt, at: clock().toISOString() },
    };
    transaction.set(ref, receipt);
    return { changed: true, receipt };
  });
}

export async function readReceipt(firestore, component) {
  const snapshot = await receiptRef(firestore, component).get();
  return snapshot.exists ? snapshot.data() : null;
}

export function assertLegacyPreviewProtocol(value) {
  if (value && value.schemaVersion !== 1) {
    fail("Schema-two or unknown preview protocol requires the paired operator; legacy CMS writes are refused");
  }
  return "schema-one";
}

export function candidateReceiptRef(firestore, input) {
  return firestore.collection("cmsDeploymentCandidates").doc(
    `${requireComponent(input.component)}-${requireRunId(input.runId)}-${requireRunAttempt(input.runAttempt)}`,
  );
}

export async function startCandidateReceipt(firestore, input, deps = {}) {
  if (!FINGERPRINT.test(input.configurationFingerprint ?? "")) fail("Candidate configuration fingerprint is invalid");
  const ref = candidateReceiptRef(firestore, input);
  const mutation = mutationRecord({ ...input, startedAt: (deps.now?.() ?? new Date()).toISOString(),
    completedAt: null, providerIdentities: null,
    inputFingerprint: input.inputFingerprint ?? await fingerprintInputs(input.sourceSha, input.component, deps) });
  mutation.configurationFingerprint = input.configurationFingerprint;
  return firestore.runTransaction(async tx => {
    const row = await tx.get(ref);
    if (row.exists) {
      const stored = row.data();
      if (stored.schemaVersion !== 2 || stored.component !== input.component || !["candidate", "verified"].includes(stored.state)
        || !sameAttempt(stored.mutation, mutation) || stored.mutation.inputFingerprint !== mutation.inputFingerprint
        || stored.mutation.configurationFingerprint !== mutation.configurationFingerprint
        || stored.mutation.trustedWorkflowSha !== mutation.trustedWorkflowSha) fail("Candidate receipt conflicts");
      return stored;
    }
    const candidate = { schemaVersion: 2, component: input.component, state: "candidate", mutation };
    tx.create(ref, candidate);
    return candidate;
  });
}

/** @param {{collect?: (component: string, deps?: any) => Promise<Record<string, string>>}} [options] */
export async function verifyCandidateReceipt(firestore, input, options = {}) {
  const { collect = collectLiveIdentities } = options;
  const ref = candidateReceiptRef(firestore, input);
  const attempt = { ...input, sourceSha: requireSha(input.sourceSha), runAttempt: requireRunAttempt(input.runAttempt) };
  const before = (await ref.get()).data();
  if (before?.schemaVersion !== 2 || !["candidate", "verified"].includes(before.state)
    || before.component !== input.component || !sameAttempt(before.mutation, attempt)
    || before.mutation.configurationFingerprint !== input.configurationFingerprint
    || before.mutation.inputFingerprint !== input.inputFingerprint
    || before.mutation.trustedWorkflowSha !== input.trustedWorkflowSha) fail("Candidate receipt conflicts");
  const identities = parseProviderIdentities(await (input.component === "renderer" && collect === collectLiveIdentities
    ? collectPreviewPairIdentities(input.readback?.previewPair, { ...input.readback, rendererRelease: before })
    : collect(input.component, input.readback)));
  if (!identities || !FINGERPRINT.test(input.configurationFingerprint ?? "")) fail("Candidate readback is invalid");
  const verifiedAt = new Date().toISOString();
  return firestore.runTransaction(async tx => {
    const stored = (await tx.get(ref)).data();
    if (previewPair().digest(stored) !== previewPair().digest(before)) fail("Candidate changed during readback");
    if (stored.state === "verified" && (previewPair().digest(stored.mutation.providerIdentities) !== previewPair().digest(identities)
      || stored.mutation.configurationFingerprint !== input.configurationFingerprint)) fail("Candidate readback changed");
    const candidate = { ...stored, state: "verified", mutation: { ...stored.mutation, completedAt: verifiedAt,
      providerIdentities: identities, configurationFingerprint: input.configurationFingerprint } };
    tx.set(ref, candidate);
    return candidate;
  });
}

export async function commitLiveReaderReceipt(firestore, input, { collect = collectLiveIdentities } = {}) {
  if (!["functions", "cmsApi"].includes(input.component)) fail("Only a deployed reader can record reader compatibility");
  const api = previewPair();
  const ref = candidateReceiptRef(firestore, input);
  const liveRef = firestore.collection(api.READER_RECEIPTS).doc(input.component);
  const legacyRef = receiptRef(firestore, input.component);
  const [candidateRow, liveRow, legacyRow] = await firestore.getAll(ref, liveRef, legacyRef);
  const before = candidateRow.data(), previous = liveRow.data(), legacy = legacyRow.data();
  const attempt = { ...input, sourceSha: requireSha(input.sourceSha), runAttempt: requireRunAttempt(input.runAttempt) };
  if (before?.schemaVersion !== 2 || before.state !== "verified" || before.component !== input.component
    || !sameAttempt(before.mutation, attempt)) fail("Reader candidate is not verified");
  if (previous) api.currentReader(previous, input.component);
  if (legacy?.schemaVersion !== 1 || legacy.component !== input.component || legacy.state !== "complete" || legacy.mutation?.sourceSha !== input.sourceSha
    || legacy.mutation.inputFingerprint !== before.mutation.inputFingerprint
    || legacy.mutation.configurationFingerprint !== before.mutation.configurationFingerprint) fail("Legacy reader deployment is not complete at this candidate");
  const live = parseProviderIdentities(await collect(input.component, input.readback));
  if (api.digest(live) !== api.digest(before.mutation.providerIdentities)
    || api.digest(live) !== api.digest(legacy.mutation.providerIdentities)) fail("Live reader changed after verification");
  const reader = api.parseReader({ schemaVersion: 2, component: input.component,
    sourceSha: before.mutation.sourceSha, inputFingerprint: before.mutation.inputFingerprint,
    configurationFingerprint: before.mutation.configurationFingerprint, providerIdentities: live,
    supported: input.supported, verifiedAt: new Date().toISOString() });
  const sameReader = previous && api.digest({ ...previous.lastComplete, verifiedAt: null }) === api.digest({ ...reader, verifiedAt: null });
  if (previous && !sameReader && (!Number.isFinite(Date.parse(before.mutation.startedAt))
    || Date.parse(before.mutation.startedAt) < Date.parse(previous.lastComplete.verifiedAt))) fail("Reader candidate predates the current compatibility receipt");
  return firestore.runTransaction(async tx => {
    const [current, currentLive, currentLegacy] = await tx.getAll(ref, liveRef, legacyRef);
    if (api.digest(current.data()) !== api.digest(before) || api.digest(currentLive.data() ?? null) !== api.digest(previous ?? null)
      || api.digest(currentLegacy.data()) !== api.digest(legacy)) fail("Reader state changed during readback");
    // This call just re-read the deployed provider. Refresh evidence even for
    // unchanged readers so a later pair switch can bind a fresh proof digest.
    const receipt = { schemaVersion: 2, component: input.component, state: "complete", lastComplete: reader };
    tx.set(liveRef, receipt);
    return receipt;
  });
}

export async function collectPreviewPairIdentities(value, deps = {}) {
  const pair = previewPair().parsePair(value);
  const request = deps.fetchFn ?? fetch;
  const token = deps.cloudflareToken ?? process.env.CLOUDFLARE_API_TOKEN;
  const account = deps.cloudflareAccount ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account || deps.rendererRelease?.mutation?.sourceSha !== pair.rendererSha) fail("Pair renderer readback requires the exact candidate");
  const application = await readConsistentRendererApplication(request, account, token, {
    ...deps, applicationName: pair.applicationName, rendererSha: pair.rendererSha,
  });
  const image = application.configuration?.image ?? application.image;
  const imageDigest = application.configuration?.image_digest ?? application.digest ?? image?.split("@")[1];
  if (imageDigest !== pair.imageDigest) fail("Pair renderer image does not match its immutable digest");
  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${pair.workerName}/deployments`, {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
  if (!response?.ok) fail("Pair renderer Worker deployment could not be read");
  const body = await response.json();
  const deployment = (body?.result?.deployments ?? body?.result)?.[0];
  if (!deployment?.id || deployment.versions?.length !== 1
    || deployment.versions[0].version_id !== pair.workerVersion || deployment.versions[0].percentage !== 100) fail("Pair renderer Worker is not pinned to its exact version");
  const { pairId, rendererSha, serializerId, workerName, applicationName, workerVersion } = pair;
  return { pairId, rendererSha, serializerId, workerName, applicationName, workerVersion, imageDigest,
    applicationId: String(application.id), workerDeploymentId: String(deployment.id) };
}

function secretKeys(variables) {
  if (!Array.isArray(variables)) return "";
  return variables
    .map((entry) => `${entry?.key ?? ""}:${entry?.secret ?? ""}:${entry?.version ?? ""}`)
    .sort()
    .join(",");
}

export function functionsInventoryIdentity(functions) {
  if (!Array.isArray(functions)) fail("Function inventory is invalid");
  const rows = functions.map((fn) => {
    const name = String(fn?.name?.split?.("/")?.at?.(-1) ?? "");
    const service = fn?.serviceConfig ?? {};
    const build = fn?.buildConfig ?? {};
    const source = build.source?.storageSource ?? {};
    const envKeys = Object.keys(service.environmentVariables ?? {}).sort().join(",");
    return [
      name,
      fn?.state ?? "",
      fn?.updateTime ?? "",
      service.uri ?? "",
      service.revision ?? "",
      service.service ?? "",
      build.runtime ?? "",
      build.entryPoint ?? "",
      source.bucket ?? "",
      source.object ?? "",
      source.generation ?? "",
      envKeys,
      secretKeys(service.secretEnvironmentVariables),
    ].join("|");
  }).sort();
  return {
    region: "us-central1",
    activeCount: String(functions.filter((fn) => fn?.state === "ACTIVE").length),
    inventoryFingerprint: createHash("sha256").update(rows.join("\n")).digest("hex"),
  };
}

function stableObjectFingerprint(value) {
  const seen = new WeakSet();
  const normalize = (entry) => {
    if (entry == null || typeof entry !== "object") return entry;
    if (seen.has(entry)) return null;
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map(normalize);
    return Object.fromEntries(
      Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]),
    );
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function rolloutToken(value) {
  return typeof value === "string" && /^[a-z0-9_-]{1,32}$/i.test(value) ? value : "unknown";
}

function rolloutVersion(value) {
  return Number.isSafeInteger(value) ? String(value) : "none";
}

function rolloutStepSummary(steps) {
  if (steps == null || (Array.isArray(steps) && steps.length === 0)) return "none";
  if (!Array.isArray(steps)) return "invalid";
  return steps.slice(0, 8)
    .map((step) => `${rolloutVersion(step?.id)}:${rolloutToken(step?.status)}`)
    .join(",");
}

function rendererRolloutLog(rollout, application, afterRelease) {
  const applied = rollout?.progress?.version_distribution?.target_version_percentage;
  return [
    "renderer rollout not converged",
    `status=${rolloutToken(rollout?.status)}`,
    `steps=${rolloutStepSummary(rollout?.steps)}`,
    `target=${rolloutVersion(rollout?.target_version)}`,
    `application=${rolloutVersion(application?.version)}`,
    `applied=${Number.isSafeInteger(applied) ? String(applied) : "none"}`,
    `after_release=${afterRelease ? "yes" : "no"}`,
    `bound=${rolloutBoundToApplication(application, rollout) ? "yes" : "no"}`,
    `instances=${rolloutVersion(rollout?.progress?.version_distribution?.target_version_instances)}/${rolloutVersion(rollout?.progress?.total_instances)}`,
  ].join(" ");
}

function applicationImage(application) {
  const image = application?.configuration?.image ?? application?.image;
  return typeof image === "string" ? image : "";
}

function targetVersionApplied(rollout) {
  const progress = rollout?.progress;
  const distribution = progress?.version_distribution;
  const total = progress?.total_instances;
  const onTarget = distribution?.target_version_instances;
  // A distribution with no instances proves nothing about the target image.
  return distribution?.target_version_percentage === 100
    && distribution?.current_version_instances === 0
    && Number.isSafeInteger(onTarget)
    && Number.isSafeInteger(total)
    && total > 0
    && onTarget === total;
}

function rolloutSide(rollout, side) {
  const version = rollout?.[`${side}_version`];
  const image = rollout?.[`${side}_configuration`]?.image;
  return Number.isSafeInteger(version) && typeof image === "string" && image.length > 0
    ? { version, image }
    : null;
}

// Bind the application record to the rollout's current or target side. The
// record must name this rollout, or have a cleared active_rollout_id after
// completion. A record that names another rollout never binds.
function rolloutBoundToApplication(application, rollout) {
  if (typeof rollout?.id !== "string" || rollout.id.length === 0) return false;
  const activeId = application?.active_rollout_id;
  const cleared = activeId == null && rollout.status === "completed";
  if (activeId !== rollout.id && !cleared) return false;
  const image = applicationImage(application);
  return ["current", "target"].some((side) => {
    const bound = rolloutSide(rollout, side);
    return bound !== null && application?.version === bound.version && image === bound.image;
  });
}

// The rollout must start after a release of this renderer commit began.
// An older rollout, or one from another commit's release, proves nothing.
function releasesOfCommit(receipt, rendererSha) {
  return [receipt?.mutation, receipt?.lastComplete]
    .filter((mutation) => mutation?.sourceSha === rendererSha);
}

// record is a rollout, or an application created without one.
function rolloutAfterRelease(record, releases) {
  const createdAt = Date.parse(record?.created_at);
  return Number.isFinite(createdAt) && releases.some((mutation) => {
    if (!hasReleaseStart(mutation)) return true;
    const startedAt = Date.parse(mutation.releaseStartedAt);
    return Number.isFinite(startedAt) && createdAt >= startedAt;
  });
}

function applicationAtRolloutTarget(application, rollout) {
  const configuration = application?.configuration;
  const target = rollout.target_configuration ?? {};
  const nextConfiguration = {
    ...(configuration && typeof configuration === "object" && !Array.isArray(configuration) ? configuration : {}),
    image: target.image,
  };
  // image_digest and digest on the application record may describe the
  // previous rollout. Hash only the target configuration's digest, so both
  // application shapes give the same identity for the same target.
  if (typeof target.image_digest === "string" && target.image_digest.length > 0) {
    nextConfiguration.image_digest = target.image_digest;
  } else {
    delete nextConfiguration.image_digest;
  }
  const next = {
    ...application,
    version: rollout.target_version,
    configuration: nextConfiguration,
  };
  delete next.digest;
  return next;
}

export async function readConsistentRendererApplication(fetchFn, account, token, deps) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/containers/applications`;
  const read = async (url, error) => {
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response?.ok) fail(error);
    return response.json();
  };
  const releases = async () => deps.rendererRelease
    ? releasesOfCommit(deps.rendererRelease, deps.rendererSha)
    : releasesOfCommit(await readReceipt(deps.firestore, "renderer"), deps.rendererSha);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => {
    process.stderr.write(`${line}\n`);
  });
  const requestedDeadline = deps.rolloutDeadlineMs;
  const deadlineMs = Number.isFinite(requestedDeadline) ? Math.max(0, requestedDeadline) : 5 * 60 * 1000;
  const started = now();
  // Terminal statuses from Containers API ApplicationRollout.status in
  // cloudflare/workers-sdk packages/containers-shared ApplicationRollout.ts:
  // pending, progressing, completed, reverted, replaced.
  // reverted and replaced do not finish.
  const terminalFailure = new Set(["reverted", "replaced"]);
  for (;;) {
    const body = await read(base, "Renderer container identity could not be read");
    const applications = Array.isArray(body?.result) ? body.result : body?.result?.applications;
    const matches = Array.isArray(applications)
      ? applications.filter((entry) => entry?.name === (deps.applicationName ?? "njpbs-cms-preview-renderer"))
      : [];
    const application = matches[0];
    if (matches.length !== 1 || !application?.id) fail("Renderer container identity is invalid");

    const rolloutBody = await read(`${base}/${application.id}/rollouts`, "Renderer container rollout could not be read");
    const rollouts = Array.isArray(rolloutBody?.result)
      ? rolloutBody.result : rolloutBody?.result?.rollouts;
    if (!Array.isArray(rollouts)) fail("Renderer container rollout is invalid");
    if (rollouts.length === 0) {
      const starts = await releases();
      const image = application.configuration?.image ?? application.image;
      if (
        application.version === 1
        && rolloutAfterRelease(application, starts)
        && typeof image === "string"
        && image.length > 0
      ) return application;
      fail("Renderer container rollout is invalid");
    }
    const datedRollouts = rollouts.map((rollout) => ({ rollout, time: Date.parse(rollout?.created_at) }));
    if (datedRollouts.some(({ time }) => !Number.isFinite(time))) fail("Renderer container rollout is invalid");
    const latest = datedRollouts.reduce((left, right) => right.time > left.time ? right : left).rollout;
    const targetImage = latest.target_configuration?.image;
    // Application.version and configuration.image stay on the rollout's
    // current_version and current_configuration after the rollout completes.
    // target_version is the version applied to instances. version_distribution
    // reports that count; 100 with none left on the current version means the
    // target image is live. Record that image, not the application image.
    const stepsComplete = latest.steps == null ||
      (Array.isArray(latest.steps) && latest.steps.every((step) => step?.status === "completed"));
    const applied = latest.status === "completed"
      && stepsComplete
      && Number.isSafeInteger(latest.target_version)
      && latest.target_version > 0
      && typeof targetImage === "string"
      && targetImage.length > 0
      && targetVersionApplied(latest)
      && rolloutBoundToApplication(application, latest);
    const starts = await releases();
    if (starts.length === 0) fail("Renderer receipt does not match the live renderer commit");
    const afterRelease = rolloutAfterRelease(latest, starts);
    if (applied && afterRelease) return applicationAtRolloutTarget(application, latest);
    const status = typeof latest.status === "string" ? latest.status : "";
    log(rendererRolloutLog(latest, application, afterRelease));
    if (terminalFailure.has(status)) fail(`Renderer container rollout ${status}`);
    // created_at and the receipt do not change while this loop waits.
    if (status === "completed" && !afterRelease) fail("Renderer container rollout predates this renderer release");
    const elapsed = now() - started;
    if (elapsed >= deadlineMs) {
      fail("Renderer container rollout and application identity did not converge");
    }
    await sleep(Math.min(5_000, deadlineMs - elapsed));
  }
}

export async function collectLiveIdentities(component, deps = {}) {
  requireComponent(component);
  if (component === "functions") {
    const functions = await (deps.listFunctions ?? (async () => {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const { GoogleAuth } = require("google-auth-library");
      const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }).getClient();
      const { listPages } = await import("../deploy-cms-function-batches.mjs");
      const request = async (url, pageToken) => {
        try {
          return (await client.request({ url, params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) } })).data;
        } catch {
          fail("Live function inventory could not be read");
        }
      };
      return listPages(
        request,
        "https://cloudfunctions.googleapis.com/v2/projects/njpbs-site/locations/us-central1/functions",
        "functions",
      );
    }))();
    deps.inspectFunctions?.(functions);
    return functionsInventoryIdentity(functions);
  }
  if (component === "renderer") {
    const firestore = deps.firestore;
    if (!firestore) fail("Firestore is required for renderer identities");
    const snapshot = await firestore.doc("system/cmsPreviewRuntime").get();
    const data = snapshot.exists ? snapshot.data() : null;
    if (
      !data
      || data.phase !== "ready"
      || !/^[a-f0-9]{40}$/.test(data.rendererSha ?? "")
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(data.serializerId ?? "")
    ) {
      fail("Live renderer identity is not ready");
    }
    const fetchFn = deps.fetchFn ?? fetch;
    const token = deps.cloudflareToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
    const account = deps.cloudflareAccount ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    if (!token || !account) fail("Cloudflare credentials are required for renderer identities");
    const application = await readConsistentRendererApplication(fetchFn, account, token, {
      ...deps,
      rendererSha: data.rendererSha,
    });
    const legacyImage = application.configuration?.image ?? application.image ?? null;
    const legacyImageDigest = application.configuration?.image_digest ?? application.digest ?? null;
    const image = legacyImage ?? "";
    const imageDigest = legacyImageDigest ?? "";
    if (!image && !imageDigest) fail("Renderer container image identity is missing");
    const version = application.version ?? application.current_version ?? application.configuration?.version ?? null;
    const deploymentResponse = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/njpbs-cms-preview-renderer/deployments`,
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!deploymentResponse?.ok) fail("Renderer Worker deployment identity could not be read");
    const deploymentBody = await deploymentResponse.json();
    const workerDeploymentId = deploymentBody?.result?.deployments?.[0]?.id
      ?? deploymentBody?.result?.[0]?.id;
    if (typeof workerDeploymentId !== "string" || workerDeploymentId.length === 0 || workerDeploymentId.length > 80) {
      fail("Renderer Worker deployment identity is invalid");
    }
    const scheduleResponse = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/njpbs-cms-preview-renderer/schedules`,
      {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!scheduleResponse?.ok) fail("Renderer Worker schedule identity could not be read");
    const scheduleBody = await scheduleResponse.json();
    const schedules = Array.isArray(scheduleBody?.result?.schedules)
      ? scheduleBody.result.schedules
      : Array.isArray(scheduleBody?.result) ? scheduleBody.result : null;
    if (!schedules) fail("Renderer Worker schedule identity is invalid");
    const crons = schedules.map((entry) => entry?.cron).filter((cron) => typeof cron === "string").sort();
    if (crons.length !== schedules.length) fail("Renderer Worker schedule identity is invalid");
    return {
      identityVersion: "2",
      phase: String(data.phase),
      rendererSha: data.rendererSha,
      serializerId: data.serializerId,
      applicationId: String(application.id),
      identityFingerprint: stableObjectFingerprint({
        id: String(application.id),
        image: String(image),
        imageDigest: String(imageDigest),
      }),
      legacyIdentityFingerprint: stableObjectFingerprint({
        id: application.id,
        name: application.name ?? "njpbs-cms-preview-renderer",
        image: legacyImage,
        imageDigest: legacyImageDigest,
        version,
      }),
      workerScript: "njpbs-cms-preview-renderer",
      workerDeploymentId,
      workerScheduleFingerprint: stableObjectFingerprint(crons),
    };
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const token = deps.cloudflareToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  const account = deps.cloudflareAccount ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  if (!token || !account) fail("Cloudflare credentials are required for CMS API identities");
  const response = await fetchFn(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/njpbs-cms-api/deployments`,
    {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response?.ok) fail("CMS API deployment identity could not be read");
  const body = await response.json();
  const deployment = body?.result?.deployments?.[0] ?? body?.result?.[0];
  const id = deployment?.id;
  const versions = deployment?.versions;
  if (typeof id !== "string" || id.length === 0 || id.length > 80) {
    fail("CMS API deployment identity is invalid");
  }
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].percentage !== 100 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(versions[0].version_id ?? "")) {
    fail("CMS API version identity is invalid");
  }
  return { script: "njpbs-cms-api", deploymentId: id, versionId: versions[0].version_id };
}
