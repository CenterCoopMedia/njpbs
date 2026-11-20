import { copyFile, mkdir } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// Both the Site-only and root test installs declare esbuild.
const { build } = createRequire(new URL("../../site/package.json", import.meta.url))("esbuild");

export async function importClosure(source, entries, { replacements = [], boundary } = {}) {
  const allowed = new Set(boundary?.files);
  const relativePath = file => relative(source, file).split(sep).join("/");
  function unexpected(args) {
    return new Error(`${relativePath(args.importer)} imports ${JSON.stringify(args.path)}, which breaks ${boundary.rule}`);
  }
  // Use the same esbuild import graph as the Functions planner. Only the
  // planner needs immutable Git blobs, generated contracts and export hashes.
  const { metafile } = await build({
    absWorkingDir: source,
    entryPoints: entries.map(file => `./${file}`),
    bundle: true, packages: "external", platform: "node", format: "esm",
    write: false, metafile: true, treeShaking: false, outdir: ".fixture-outputs", logLevel: "silent",
    plugins: boundary || replacements.length ? [{ name: "isolated-checkout", setup(builder) {
      builder.onResolve({ filter: /.*/ }, async args => {
        if (args.kind === "entry-point" || args.pluginData) return;
        // These boundaries prove independence at startup. Lazy provider code
        // runs in other tests with its own dependencies.
        if (boundary && args.kind === "dynamic-import") return { path: args.path, external: true };
        if (isBuiltin(args.path)) return;
        const result = await builder.resolve(args.path, { importer: args.importer, namespace: args.namespace,
          resolveDir: args.resolveDir, kind: args.kind, pluginData: true, with: args.with });
        const file = relativePath(result.path);
        if (boundary && (result.errors.length || result.external || !allowed.has(file))) throw unexpected(args);
        if (replacements.includes(file)) return { path: args.path, external: true };
        return result;
      });
    } }] : [],
  });
  return (boundary ? [...allowed] : Object.keys(metafile.inputs)).sort();
}

export async function copyImportClosure(source, destination, entries, { assets = [], ...options } = {}) {
  const files = await importClosure(source, entries, options);
  await Promise.all([...new Set([...files, ...assets])].map(async file => {
    if (isAbsolute(file) || file.startsWith("../")) throw new Error(`Fixture input escapes the source checkout: ${file}`);
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }));
}
