import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { join, posix } from "node:path";

export const contractRecipe = "scripts/functions-contract-sources.json";
export const contractInputs = [contractRecipe, "scripts/lib/functions-contracts.mjs", "scripts/compile-functions-contracts.mjs"];
const requireRoot = createRequire(import.meta.url);
const requireSite = createRequire(new URL("../../site/package.json", import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const retainedHome = "home-retained-sources";
const moduleUrl = "__functionsContractModuleUrl";

function compiler(version, requireCompiler) {
  for (const require of [requireCompiler, requireRoot, requireSite].filter(Boolean)) {
    try {
      const esbuild = require("esbuild");
      if (esbuild.version === version) return esbuild.build;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`Functions contracts require the locked esbuild version ${version}`);
}

const retainedLoaders = new Map([
  ["site/scripts/cms-current-code-context.ts", "require"],
  ["site/src/lib/public-artifact-inventory.ts", "requireModule"],
]);

function relocateRetainedRequires(path, source) {
  const alias = retainedLoaders.get(path);
  if (!alias) return source;
  const declaration = `const ${alias} = createRequire(import.meta.url);`;
  if (!source.includes(declaration)) throw new Error(`Unexpected retained Home loader in ${path}`);
  const relocated = source.replace(/^import \{ createRequire \} from "node:module";\r?\n/m, "")
    .replace(declaration, "")
    .replace(new RegExp(`\\b${alias}\\(\\s*"((?:\\.\\./)+functions/lib/[^"]+)"`, "g"),
      (_match, specifier) => {
        const target = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!/^functions\/lib\/[a-z0-9/-]+\.js$/.test(target)) throw new Error("Unexpected retained Home runtime path");
        return `require("functions-runtime:${target.slice("functions/lib/".length)}"`;
      });
  if (/\b(?:createRequire|requireModule)\b/.test(relocated)) throw new Error(`Unexpected retained Home loader in ${path}`);
  return relocated;
}

async function compile({ has, read, requireCompiler }) {
  const { entries } = JSON.parse(await read(contractRecipe));
  const lock = JSON.parse(await read("package-lock.json"));
  const build = compiler(lock.packages["node_modules/esbuild"].version, requireCompiler);
  return new Map(await Promise.all(Object.entries(entries).map(async ([name, source]) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !/^(?:packages\/content-core\/src|site\/src\/lib)\/[a-z][a-z0-9-]*\.ts$/.test(source)) {
      throw new Error("Invalid Functions contract path");
    }
    const output = `functions/lib/${name}.js`;
    const entry = name === "posts-browse-contract"
      ? { stdin: { contents: `export { validatePostsBrowse } from "./${source}";` } }
      : { entryPoints: [source] };
    const isRetainedHome = name === retainedHome;
    const { outputFiles, metafile } = await build({
      ...entry, outfile: output, write: false, bundle: true, platform: "node",
      format: "cjs", target: "node22", legalComments: "none", tsconfigRaw: {}, metafile: true,
      logLevel: "silent",
      logOverride: { "unsupported-require-call": "error", "unsupported-dynamic-import": "error",
        "indirect-require": "error", "direct-eval": "error", "empty-import-meta": "error" },
      define: isRetainedHome ? { "import.meta.url": moduleUrl } : {},
      banner: { js: `// Generated from ${source}.\n"use strict";` },
      plugins: [{ name: "functions-contract-source", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => {
          if (args.kind !== "entry-point" && !args.path.startsWith(".")) {
            // The retained reader imports the schedule writer's module but
            // never emits its PDF renderer into the Functions entry point.
            if (builtins.has(args.path) || args.path === "parse5" || (isRetainedHome && args.path === "pdfkit")) {
              return { path: args.path, external: true };
            }
            if (isRetainedHome && retainedLoaders.has(args.importer)
              && args.path.startsWith("functions-runtime:")) {
              return { path: `./${args.path.slice("functions-runtime:".length)}`, external: true };
            }
            throw new Error("Unexpected Functions contract package import");
          }
          const base = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
          const path = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.js`, `${base}.json`, `${base}/index.ts`]
            .find(file => !file.startsWith("../") && !posix.isAbsolute(file) && has(file));
          if (!path) throw new Error(`Unresolved Functions contract source: ${base}`);
          return { path, namespace: "contract" };
        });
        builder.onLoad({ filter: /.*/, namespace: "contract" }, async ({ path }) => {
          const sourceText = await read(path);
          const extension = posix.extname(path);
          return { contents: isRetainedHome ? relocateRetainedRequires(path, sourceText) : sourceText,
            loader: /^[.][cm]?js$/.test(extension) ? "js" : extension.slice(1) };
        });
      } }],
    });
    if (isRetainedHome && (outputFiles[0].text.includes(moduleUrl)
      || Object.values(metafile.outputs).some(file => file.imports.some(edge => edge.path === "pdfkit")))) {
      throw new Error("The retained Home contract cannot include the Site PDF writer");
    }
    return [output, outputFiles[0].text];
  })));
}

export async function writeFunctionsContracts(directory, requireCompiler) {
  const has = file => lstatSync(join(directory, file), { throwIfNoEntry: false })?.isFile() ?? false;
  const outputs = await compile({ has, read: file => readFile(join(directory, file), "utf8"), requireCompiler });
  // Replace ignored outputs without following existing symlinks or exposing partial files.
  const staging = await mkdtemp(join(directory, "functions/lib/.contracts-"));
  try {
    for (const [file, text] of outputs) await writeFile(join(staging, posix.basename(file)), text);
    for (const file of outputs.keys()) await rename(join(staging, posix.basename(file)), join(directory, file));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return outputs.size;
}

// Earlier deployed revisions carry their own committed bundles. For current
// sources, put the generated modules into the same immutable graph as Git blobs.
export async function addCommittedFunctionsContracts(files, read) {
  if (!files.has(contractRecipe)) return new Map();
  const outputs = await compile({ has: file => files.get(file)?.startsWith("100"),
    read: file => {
      if (!files.get(file)?.startsWith("100")) throw new Error("Functions contract input is not a regular Git blob");
      return read(file);
    } });
  for (const [file, source] of outputs) {
    if (files.has(file)) throw new Error("Generated Functions contract also exists as a Git blob");
    files.set(file, `100644 generated ${createHash("sha256").update(source).digest("hex")}`);
  }
  return outputs;
}
