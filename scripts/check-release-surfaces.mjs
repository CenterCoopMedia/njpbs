import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Policy already installs the site's locked TypeScript dependency. Parse source;
// never import an application entry point or read deployment configuration.
const require = createRequire(new URL("../site/package.json", import.meta.url));
const ts = require("typescript");
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = "config/release-surfaces.json";

function syntax(source, path) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error(`Cannot parse Functions source: ${path}`);
  return tree;
}

function literal(node, path) {
  if (!node || !ts.isStringLiteral(node)) throw new Error(`Computed Functions registration: ${path}`);
  return node.text;
}

function staticName(node, path) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  throw new Error(`Computed Functions export: ${path}`);
}

function moduleFile(specifier, path, files) {
  if (!specifier.startsWith("./")) throw new Error(`Nonlocal Functions registration: ${path}`);
  const base = posix.normalize(posix.join(posix.dirname(path), specifier));
  const found = [base, `${base}.js`, `${base}/index.js`].find(candidate => files.has(candidate));
  if (!found) throw new Error(`Missing Functions module: ${path} ${specifier}`);
  return found;
}

function exportTarget(node) {
  const text = node?.getText();
  return text === "exports" || text === "module.exports";
}

function esmExports(node, path) {
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) throw new Error(`Unsupported Functions re-export: ${path}`);
    return node.exportClause.elements.map(element => staticName(element.name, path));
  }
  if (ts.isExportAssignment(node)) {
    if (node.isExportEquals) throw new Error(`Unsupported Functions export: ${path}`);
    return ["default"];
  }
  if (!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return [staticName(node.name, path)];
  if (ts.isVariableStatement(node)) return node.declarationList.declarations.map(declaration => staticName(declaration.name, path));
  throw new Error(`Unsupported Functions export: ${path}`);
}

function enclosingFunction(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text;
  }
  return undefined;
}

function devManifestLoop(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (!ts.isForOfStatement(parent)) continue;
    const expression = parent.expression;
    return ts.isCallExpression(expression) && expression.expression.getText() === "Object.entries" &&
      ts.isCallExpression(expression.arguments[0]) && expression.arguments[0].expression.getText() === "devFunctionManifest";
  }
  return false;
}

const devProgram = `
"use strict";
const { CLOUD_WAKE_FUNCTIONS } = require("./lib/cloud-publication-wake-deployment");
const DEV_FUNCTIONS = Object.freeze({});
function devFunctionManifest(deployment) {
  if (deployment?.enabled !== true || deployment.environment !== "development") return DEV_FUNCTIONS;
  const selected = { ...DEV_FUNCTIONS };
  for (const name of CLOUD_WAKE_FUNCTIONS) selected[name] = "./no-build-cloud-wake";
  return Object.freeze(selected);
}
module.exports = { DEV_FUNCTIONS, devFunctionManifest };
`;

function devProgramShape(source, path) {
  const shape = node => {
    // The literal registration object is checked and inventoried separately.
    if (ts.isVariableDeclaration(node) && node.name.getText() === "DEV_FUNCTIONS") return [node.kind, "DEV_FUNCTIONS", "registry-literals"];
    const children = [];
    ts.forEachChild(node, child => { children.push(shape(child)); });
    const text = ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : null;
    const flags = ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : 0;
    return [node.kind, flags, text, children];
  };
  return JSON.stringify(shape(syntax(source, path)));
}

export function entryExports(source, path, files, { devAdapter = false } = {}) {
  const exports = new Map();
  let adapters = 0;
  const add = (name, module) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || exports.has(name)) throw new Error(`Duplicate or invalid Functions export: ${path} ${name}`);
    exports.set(name, module);
  };
  const visit = node => {
    for (const name of esmExports(node, path)) add(name, path);
    if (ts.isVariableDeclaration(node) && exportTarget(node.initializer)) throw new Error(`Unsupported Functions export alias: ${path}`);
    if (ts.isCallExpression(node) && node.expression.getText() === "lazyExport") {
      add(literal(node.arguments[0], path), moduleFile(literal(node.arguments[1], path), path, files));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = node.left;
      const target = exportTarget(left) ||
        ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && exportTarget(left.expression));
      if (target && node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) throw new Error(`Unsupported Functions assignment: ${path}`);
      if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && exportTarget(left.expression)) {
        if (devAdapter && ts.isElementAccessExpression(left) && left.argumentExpression.getText() === "name" && node.right.getText() === "handler") {
          if (!devManifestLoop(node)) throw new Error(`Changed dev Functions adapter: ${path}`);
          adapters++;
        } else {
          const name = ts.isPropertyAccessExpression(left) ? left.name.text : literal(left.argumentExpression, path);
          add(name, path);
        }
      } else if (exportTarget(left)) {
        if (!ts.isObjectLiteralExpression(node.right)) throw new Error(`Computed Functions export object: ${path}`);
        for (const property of node.right.properties) add(staticName(property.name, path), path);
      }
    }
    if (ts.isCallExpression(node) && node.arguments.some(exportTarget)) {
      const getter = node.expression.getText() === "Object.defineProperty" &&
        enclosingFunction(node) === "lazyExport" && node.arguments[1]?.getText() === "exportName";
      if (!getter) throw new Error(`Unsupported Functions registration: ${path}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(source, path));
  if (devAdapter && adapters !== 1) throw new Error(`Changed dev Functions adapter: ${path}`);
  return exports;
}

function frozenDeclaration(source, path, name) {
  let value;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
      if (value || !node.initializer || !ts.isCallExpression(node.initializer) || node.initializer.expression.getText() !== "Object.freeze" || node.initializer.arguments.length !== 1) {
        throw new Error(`Changed Functions manifest: ${path}`);
      }
      value = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax(source, path));
  if (!value) throw new Error(`Missing Functions manifest: ${path}`);
  return value;
}

function devExports(read, files) {
  const path = "functions/dev-manifest.js";
  const source = read(path);
  if (devProgramShape(source, path) !== devProgramShape(devProgram, path)) throw new Error(`Changed Functions manifest producer: ${path}`);
  const object = frozenDeclaration(source, path, "DEV_FUNCTIONS");
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`Changed Functions manifest: ${path}`);
  const result = new Map();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error(`Computed Functions manifest: ${path}`);
    const name = staticName(property.name, path);
    if (result.has(name)) throw new Error(`Duplicate Functions manifest export: ${path} ${name}`);
    result.set(name, moduleFile(literal(property.initializer, path), path, files));
  }
  const wakePath = "functions/lib/cloud-publication-wake-deployment.js";
  const wake = frozenDeclaration(read(wakePath), wakePath, "CLOUD_WAKE_FUNCTIONS");
  if (!ts.isArrayLiteralExpression(wake)) throw new Error(`Changed Functions manifest: ${wakePath}`);
  for (const element of wake.elements) {
    const name = literal(element, wakePath);
    if (result.has(name)) throw new Error(`Duplicate Functions manifest export: ${wakePath} ${name}`);
    result.set(name, moduleFile("./no-build-cloud-wake", path, files));
  }
  return result;
}

export function sourceInventory(root) {
  const files = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20 }).split("\0").filter(Boolean));
  const read = path => {
    if (!files.has(path)) throw new Error(`Missing tracked source: ${path}`);
    return readFileSync(resolve(root, path), "utf8");
  };
  const workflows = [...files].filter(path => /^\.github\/workflows\/[^/]+\.ya?ml(?:\.disabled)?$/.test(path)).sort();
  const wrangler = [...files].filter(isWranglerConfig).sort();
  const entrypoints = new Set();
  for (const path of files) {
    if (posix.basename(path) !== "package.json") continue;
    const pkg = JSON.parse(read(path));
    if (pkg.dependencies?.["firebase-functions"]) entrypoints.add(posix.normalize(posix.join(posix.dirname(path), pkg.main ?? "index.js")));
  }
  entrypoints.add("functions/dev-index.js");
  // Recovered standalone GCP Function, outside the Firebase package manifest.
  const billing = "infrastructure/billing-kill-switch/index.js";
  if (files.has(billing)) entrypoints.add(billing);
  const functions = [...entrypoints].sort().map(path => {
    const devAdapter = path === "functions/dev-index.js";
    const entries = entryExports(read(path), path, files, { devAdapter });
    if (devAdapter) {
      for (const [name, module] of devExports(read, files)) {
        if (entries.has(name)) throw new Error(`Duplicate Functions export: ${path} ${name}`);
        entries.set(name, module);
      }
    }
    if (!entries.size) throw new Error(`No Functions exports discovered: ${path}`);
    return { entrypoint: path, exports: [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, module]) => ({ name, module })) };
  });
  return { workflows, wrangler, functions, files };
}

function isWranglerConfig(path) {
  const name = posix.basename(path);
  const dot = name.lastIndexOf(".");
  if (!["json", "jsonc", "toml"].includes(name.slice(dot + 1))) return false;
  const stem = name.slice(0, dot);
  if (stem === "wrangler") return true;
  if (!stem.startsWith("wrangler.") && !stem.startsWith("wrangler-")) return false;
  return stem.slice("wrangler.".length).split(".").every(part => /^[A-Za-z0-9_-]+$/.test(part));
}

function compare(label, expected, actual) {
  const want = new Set(expected);
  const found = new Set(actual);
  if (want.size !== expected.length) throw new Error(`Duplicate registry ${label}`);
  const missing = [...found].filter(name => !want.has(name)).sort();
  const stale = [...want].filter(name => !found.has(name)).sort();
  if (missing.length || stale.length) throw new Error(`Registry ${label}: missing=[${missing.join(", ")}] stale=[${stale.join(", ")}]`);
}

export function checkRegistry(registry, inventory) {
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.machines) || !registry.machines.length) throw new Error("Invalid release surface registry");
  compare("workflows", registry.workflows, inventory.workflows);
  compare("Wrangler configs", registry.wrangler, inventory.wrangler);
  compare("Functions entrypoints", registry.functions.map(row => row.entrypoint), inventory.functions.map(row => row.entrypoint));
  for (const row of inventory.functions) {
    const expected = registry.functions.find(item => item.entrypoint === row.entrypoint);
    compare(`Functions exports ${row.entrypoint}`, expected.exports.map(item => `${item.name}:${item.module}`), row.exports.map(item => `${item.name}:${item.module}`));
  }
  const ids = new Set();
  for (const machine of registry.machines) {
    if (!/^[a-z][a-z0-9-]+$/.test(machine.id) || ids.has(machine.id) || !["deploy", "release", "ui", "media", "app", "other"].includes(machine.kind) || !machine.sources?.length || !machine.states?.length) throw new Error(`Invalid state machine: ${machine.id}`);
    ids.add(machine.id);
    for (const path of machine.sources) if (!inventory.files.has(path)) throw new Error(`Missing machine source: ${machine.id} ${path}`);
    if (new Set(machine.states).size !== machine.states.length || machine.states.some(state => typeof state !== "string" || !state)) throw new Error(`Invalid machine states: ${machine.id}`);
  }
  return `Release surface registry: ${inventory.workflows.length} workflows, ${inventory.wrangler.length} Wrangler configs, ${inventory.functions.reduce((n, row) => n + row.exports.length, 0)} Functions exports, ${ids.size} machines`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(checkRegistry(JSON.parse(readFileSync(resolve(defaultRoot, registryPath), "utf8")), sourceInventory(defaultRoot)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
