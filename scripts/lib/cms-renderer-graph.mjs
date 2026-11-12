import { deploymentInputFingerprint, readDeploymentManifest } from "../render-development-config.mjs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { builtinModules, createRequire } from "node:module";
import { posix, resolve as absolute } from "node:path";
import { functionGraphSource, readCommittedBlobs } from "./cms-component-receipt.mjs";

const exec = promisify(execFile);
const ROOTS = ["site/scripts/build-compiled-renderer.ts", "site/scripts/run-cms-preview-cloud.ts",
  "site/scripts/render-compiled-preview.ts", "site/scripts/cms-preview-cloud-runtime.ts",
  "site/astro.renderer.config.mjs", "preview-renderer/worker.ts"];
// These programs launch generated modules/sandbox entrypoints rather than
// ordinary imports. Their reviewed contract is part of graph version 1. Any
// changed launcher chooses the original full deploy until its graph is proven.
const LAUNCH_CONTRACTS = {
  "scripts/lib/deployment-settings.mjs": "e2438b3a0bc4087fc62c363f2eb056fd99f024be",
  ".dockerignore": null,
  "preview-renderer/Dockerfile.dockerignore": null,
  "preview-renderer/Dockerfile": "42a38a31586875ca036c505f0c95409ae87cc10f",
  "preview-renderer/worker.ts": "8afb604441bc62f95acdace555b5de75c297afec",
  "preview-renderer/wrangler.jsonc": "de29eeb62adaa32ddd720e48ca3a6f6032beeab5",
  "scripts/prepare-preview-renderer.mjs": "eee8b9e46b78489bf1cbf0dfbc1c8470f7d46c13",
  "site/scripts/deploy-cms-preview-cloud.ts": "9b2ebf2d2a3d464e0f8050dcaa151d18ea863a08",
  "site/astro.renderer.config.mjs": "7357d79b8e0f57d78689d8f8871e9d359cf1471c",
  "site/src/lib/public-content-links.ts": "526e8f43707ce45118ec827c74f67b00f83bf60b",
  "site/scripts/build-compiled-renderer.ts": "aa48e668534cf10f72caafd1d6fd42da264c8927",
  "site/scripts/build-preview-runtime.mjs": "04f41dfe5cd53056d9c48ed744bc766d6627df83",
  "site/scripts/compiled-renderer-adapter.mjs": "cd5e7ca5750dc34a1a000f768953bbfdea66aee2",
  "site/scripts/process-cms-preview.ts": "99833050f6abb21b74abb33e0e584392664bef5d",
  "site/scripts/run-cms-preview-cloud.ts": "aa8a210eeb0de195bb1ca71e5ae6f6c6c405eb3a",
  "site/scripts/render-compiled-preview.ts": "4f8bc132ec4a460149734b0b2c5e6a43f3481ab2",
  "site/scripts/cms-publication-runtime-guard.ts": "4d4022a20284beb50ca042dda859c87b9b061442",
  "site/scripts/cms-preview-operator-checks.ts": "d6c68503575b378001082a83a9556eb95a578c71",
};
const GUARDS = ["site", "preview-renderer", "packages", ".npmrc", "package.json", "package-lock.json",
  "functions/package.json", "admin/package.json", "cms-api/package.json", "scripts/prepare-preview-renderer.mjs",
  "scripts/lib/cms-renderer-graph.mjs", "scripts/lib/cms-component-receipt.mjs"];
const MODULE = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|astro)$/;
class UnknownGraph extends Error {}
const unknown = code => { throw new UnknownGraph(code); };

/** Discover committed module edges without executing a selected checkout.
 * Site/templates/assets remain conservative directory guards: Astro globs,
 * generated server/client modules and sandbox launches may use any of them.
 * Only the Functions directory is narrowed, using real Node require closures.
 */
export async function fingerprintRendererGraph(sourceSha, deps = {}) {
  let activeFile = null;
  let moduleFailure = null, bundling = false;
  try {
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) unknown("source");
    const git = async (...args) => (await exec("git", args, { cwd: deps.cwd, maxBuffer: 24 * 1024 * 1024 })).stdout;
    const files = new Map((await git("ls-tree", "-rz", sourceSha)).split("\0").filter(Boolean).map(line => {
      const [metadata, file, unexpected] = line.split("\t");
      if (!file || unexpected !== undefined || /[\r\n]/.test(file)) unknown("input_path");
      return [file, metadata];
    }));
    if (ROOTS.some(file => !files.has(file))) unknown("entrypoint");
    for (const [file, blob] of Object.entries(LAUNCH_CONTRACTS)) {
      if ((files.get(file)?.split(" ").at(-1) ?? null) !== blob) {
        activeFile = file;
        unknown("build_launch_contract");
      }
    }
    const manifests = new Set(["package.json", "package-lock.json", "functions/package.json",
      "site/package.json", "site/package-lock.json", "preview-renderer/package.json", "preview-renderer/package-lock.json"]);
    const sourceCandidates = [...files].filter(([file, metadata]) => metadata.startsWith("100") && (manifests.has(file)
      || (MODULE.test(file) && /^(?:functions\/|packages\/|preview-renderer\/|scripts\/|site\/(?:src\/|scripts\/|[^/]+$))/.test(file))));
    const prefetched = await readCommittedBlobs(sourceCandidates.map(([, metadata]) => metadata.split(" ").at(-1)), { cwd: deps.cwd });
    const cache = new Map();
    const read = file => {
      if (!files.get(file)?.startsWith("100")) unknown("non_regular_input");
      if (!cache.has(file)) {
        const id = files.get(file).split(" ").at(-1);
        cache.set(file, prefetched.has(id) ? Promise.resolve(prefetched.get(id)) : git("show", `${sourceSha}:${file}`));
      }
      return cache.get(file);
    };
    const resolve = (specifier, importer) => {
      const base = posix.normalize(posix.join(posix.dirname(importer), specifier.split("?")[0]));
      if (base.startsWith("../") || posix.isAbsolute(base)) unknown("outside_repository");
      const file = [base, ...(base.endsWith(".js") ? [base.slice(0, -3) + ".ts"] : []),
        ...[".ts", ".js", ".mjs", ".json", ".astro", "/index.ts", "/index.js"].map(ext => base + ext)].find(path => files.has(path));
      if (!file) unknown("unresolved_module");
      return file;
    };
    const siteRequire = deps.parserRequire ?? createRequire(absolute(deps.cwd ?? process.cwd(), "site/package.json"));
    const ts = siteRequire("typescript");
    const astro = siteRequire("@astrojs/compiler");
    const parserLock = JSON.parse(await read("site/package-lock.json"));
    if (parserLock.packages?.["node_modules/typescript"]?.version !== ts.version
      || parserLock.packages?.["node_modules/@astrojs/compiler"]?.version !== siteRequire("@astrojs/compiler/package.json").version) unknown("parser_version");
    const allowed = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
    const ownedPackages = new Set();
    for (const file of ["package-lock.json", "site/package-lock.json", "preview-renderer/package-lock.json"]) {
      const lock = JSON.parse(await read(file));
      for (const [location, entry] of Object.entries(lock.packages ?? {})) {
        if (!location.includes("node_modules/")) continue;
        const name = location.split("node_modules/").at(-1);
        if (entry.link || entry.resolved?.startsWith("file:")) ownedPackages.add(name);
        else allowed.add(name);
      }
    }
    for (const file of ["package.json", "functions/package.json", "site/package.json", "preview-renderer/package.json"]) {
      const pkg = JSON.parse(await read(file));
      for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) allowed.add(name);
    }
    const external = specifier => {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (specifier.startsWith("astro:")) return;
      if (["cloudflare:workers", "cloudflare:sockets"].includes(specifier)) return;
      if (ownedPackages.has(name)) unknown("owned_package_alias");
      if (!allowed.has(specifier) && !allowed.has(name)) unknown("unknown_package");
    };
    const roots = new Set(), visited = new Set(), extra = new Set();
    if ([...files.keys()].some(file => file.startsWith("site/src/") && /\.(?:mdx|svelte|vue)$/.test(file))) unknown("unsupported_module_language");
    // Every source module behind Astro's broad template/glob guard is included.
    // This also covers a new template importing an existing Site helper.
    const queue = [...ROOTS, ...[...files.keys()].filter(file => file.startsWith("site/src/") && MODULE.test(file) && !file.endsWith(".d.ts"))];
    const enqueue = file => {
      if (/\.(?:mdx|svelte|vue)$/.test(file)) unknown("unsupported_module_language");
      if (file.startsWith("functions/")) roots.add(file);
      else if (MODULE.test(file) && !file.endsWith(".d.ts")) queue.push(file);
      else extra.add(file);
    };
    const edge = (specifier, importer, staticModuleImport = false) => {
      if (["module", "node:module"].includes(specifier) && !staticModuleImport) unknown("module_loader_alias");
      if (specifier.startsWith(".")) enqueue(resolve(specifier, importer));
      else if (specifier.startsWith("/")) {
        // Pagefind emits this browser-only bundle after the guarded Site build.
        if (specifier === "/pagefind/pagefind.js" && allowed.has("pagefind")) return;
        // Browser imports from the guarded public directory are copied assets.
        const file = `site/public${specifier.split("?")[0]}`;
        if (!files.has(file)) unknown("public_asset");
        extra.add(file);
      } else external(specifier);
    };
    while (queue.length) {
      const file = queue.pop();
      activeFile = file;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await read(file);
      let chunks = [source];
      if (file.endsWith(".astro")) {
        const parsed = await astro.parse(source);
        if (parsed.diagnostics.some(message => message.severity === 1)) unknown("template_syntax");
        chunks = [];
        const visit = node => {
          if (node.type === "frontmatter") { chunks.push(node.value); return; }
          if (node.name === "script") {
            if (!node.attributes?.some(attr => attr.name === "type" && attr.value === "application/ld+json")) {
              chunks.push((node.children ?? []).map(child => child.value ?? "").join(""));
            }
            return;
          }
          if (node.type === "expression" && (node.children ?? []).some(child =>
            /\b(?:require|createRequire)\s*\(|\bimport\s*\(/.test(child.value ?? ""))) unknown("template_module_expression");
          for (const child of node.children ?? []) visit(child);
        };
        visit(parsed.ast);
      }
      for (const chunk of chunks) {
        const tree = ts.createSourceFile(`/${file}.ts`, chunk, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        if (tree.parseDiagnostics.length) unknown("module_syntax");
        const requireAliases = new Map();
        let checker;
        // Bind only this committed chunk. No project config, libraries, filesystem
        // modules or application code are loaded to resolve lexical declarations.
        const symbol = node => {
          checker ??= ts.createProgram([tree.fileName], { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest }, {
            getSourceFile: name => name === tree.fileName ? tree : undefined,
            getDefaultLibFileName: () => "/no-library.d.ts", writeFile() {}, getCurrentDirectory: () => "/",
            getDirectories: () => [], fileExists: name => name === tree.fileName,
            readFile: name => name === tree.fileName ? chunk : undefined,
            getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
          }).getTypeChecker();
          return checker.getSymbolAtLocation(node);
        };
        const imported = node => {
          const declarations = symbol(node)?.declarations;
          if (declarations?.length !== 1) return null;
          const declaration = declarations[0];
          let owner = declaration;
          while (owner && !ts.isImportDeclaration(owner)) owner = owner.parent;
          return owner && !owner.importClause?.isTypeOnly ? { declaration, module: owner.moduleSpecifier.text } : null;
        };
        const nodeUrlHelper = (node, name) => {
          const entry = imported(node);
          return entry && ["node:url", "url"].includes(entry.module) && ts.isImportSpecifier(entry.declaration)
            && (entry.declaration.propertyName?.text ?? entry.declaration.name.text) === name;
        };
        const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
        const isMeta = node => node && ts.isPropertyAccessExpression(node) && node.name.text === "url"
          && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;
        const value = (node, seen = new Set()) => {
          const text = literal(node);
          if (text !== null) return text;
          if (ts.isIdentifier(node)) {
            const declarations = symbol(node)?.declarations;
            const declaration = declarations?.length === 1 ? declarations[0] : null;
            if (!declaration || !ts.isVariableDeclaration(declaration) || !localConst(declaration)
              || !declaration.initializer || seen.has(declaration)) return null;
            // An object-valued const can still be mutated or escape its owner.
            if (ts.isNewExpression(declaration.initializer)
              || (ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(tree) === "pathToFileURL")) return null;
            return value(declaration.initializer, new Set([...seen, declaration]));
          }
          if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL"
            && node.arguments?.length === 2 && isMeta(node.arguments[1])) {
            if (symbol(node.expression) && !nodeUrlHelper(node.expression, "URL")) return null;
            const path = value(node.arguments[0], seen);
            if (!path?.startsWith(".") || !/^[A-Za-z0-9_./-]+$/.test(path)) return null;
            const target = posix.normalize(posix.join(posix.dirname(file), path));
            return target.startsWith("../") || posix.isAbsolute(target) ? null : `/${target}`;
          }
          // Other computed URL/path recipes need an inspected launcher contract.
          if (!LAUNCH_CONTRACTS[file]) return null;
          if (ts.isPropertyAccessExpression(node) && node.name.text === "href") return value(node.expression, seen);
          if (ts.isCallExpression(node)) {
            const name = node.expression.getText(tree);
            if (["fileURLToPath", "pathToFileURL"].includes(name) && node.arguments.length === 1
              && nodeUrlHelper(node.expression, name)) return value(node.arguments[0], seen);
            if (["path.join", "path.resolve"].includes(name)) {
              const entry = imported(node.expression.expression);
              if (!entry || !["node:path", "path"].includes(entry.module)
                || !(ts.isImportClause(entry.declaration) || ts.isNamespaceImport(entry.declaration))) return null;
              const paths = node.arguments.map(arg => value(arg, seen));
              if (!paths.every(path => path !== null)) return null;
              return name === "path.resolve" ? paths.some(path => posix.isAbsolute(path)) ? posix.resolve("/", ...paths) : null : posix.join(...paths);
            }
          }
          return null;
        };
        const requireBase = node => {
          if (!ts.isCallExpression(node) || node.expression.getText(tree) !== "createRequire" || node.arguments.length !== 1) return null;
          if (isMeta(node.arguments[0])) return file;
          const base = node.arguments[0];
          if (!LAUNCH_CONTRACTS[file] && !(ts.isNewExpression(base) && ts.isIdentifier(base.expression)
            && base.expression.text === "URL" && literal(base.arguments?.[0]) !== null)) unknown("require_base");
          const path = value(node.arguments[0]);
          if (!path?.startsWith("/") || !files.has(path.slice(1))) unknown("require_base");
          return path.slice(1);
        };
        const localConst = declaration => ts.isIdentifier(declaration.name)
          && ts.isVariableDeclarationList(declaration.parent) && Boolean(declaration.parent.flags & ts.NodeFlags.Const)
          && ts.isVariableStatement(declaration.parent.parent)
          && !declaration.parent.parent.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        const collect = node => {
          if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
            && ts.isNamedImports(node.importClause.namedBindings)
            && node.importClause.namedBindings.elements.some(item => (item.propertyName?.text ?? item.name.text) === "createRequire")
            && !["node:module", "module"].includes(node.moduleSpecifier.text)) unknown("module_loader_alias");
          if (ts.isImportDeclaration(node) && ["node:module", "module"].includes(node.moduleSpecifier.text)) {
            const bindings = node.importClause?.namedBindings;
            if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.some(item =>
              (item.propertyName?.text ?? item.name.text) !== "createRequire" || item.name.text !== "createRequire")) unknown("module_loader_alias");
          }
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const base = requireBase(node.initializer);
            if (node.name.text === "require" && !base) unknown("shadowed_require");
            if (base) {
              if (!localConst(node)) unknown("escaped_require");
              if (requireAliases.has(node.name.text) && requireAliases.get(node.name.text) !== base) unknown("shadowed_require");
              requireAliases.set(node.name.text, base);
            }
          }
          ts.forEachChild(node, collect);
        };
        collect(tree);
        const walk = node => {
          if (["getBuiltinModule", "mainModule"].includes(ts.isIdentifier(node) ? node.text : literal(node))) unknown("module_loader_alias");
          if (ts.isIdentifier(node) && ["eval", "Function"].includes(node.text)
            && !ts.isTypeReferenceNode(node.parent) && !ts.isTypeQueryNode(node.parent)) unknown("dynamic_code");
          if (ts.isIdentifier(node) && node.text === "createRequire") {
            const parent = node.parent;
            if (!ts.isImportSpecifier(parent)) {
              const owner = parent.parent;
              const invokedDirectly = ts.isCallExpression(owner) && owner.expression === parent;
              const initializedLocally = ts.isVariableDeclaration(owner) && owner.initializer === parent && localConst(owner);
              if (!(ts.isCallExpression(parent) && parent.expression === node && (invokedDirectly || initializedLocally))) unknown("escaped_require_factory");
            }
          }
          if (ts.isIdentifier(node) && (node.text === "require" || requireAliases.has(node.text))) {
            const parent = node.parent;
            const comparison = ts.isPropertyAccessExpression(parent) && parent.name.text === "main" ? parent.parent : null;
            const entrypointCheck = comparison && ts.isBinaryExpression(comparison)
              && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(comparison.operatorToken.kind)
              && [comparison.left, comparison.right].some(value => ts.isIdentifier(value) && value.text === "module");
            const localDeclaration = ts.isVariableDeclaration(parent) && parent.name === node && parent.initializer
              && localConst(parent) && requireBase(parent.initializer) === (requireAliases.get(node.text) ?? file);
            const directResolve = ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "resolve"
              && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
            if (!localDeclaration
              && !(ts.isCallExpression(parent) && parent.expression === node)
              && !directResolve
              && !entrypointCheck) unknown("escaped_require");
          }
          if (ts.isNewExpression(node) && node.expression.getText(tree) === "Function") unknown("dynamic_code");
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
            && !node.importClause?.isTypeOnly && !node.isTypeOnly) edge(node.moduleSpecifier.text, file, ts.isImportDeclaration(node));
          if (ts.isCallExpression(node)) {
            const expression = node.expression, name = expression.getText(tree);
            if (["eval", "Function"].includes(name)) unknown("dynamic_code");
            if (["import.meta.glob", "Astro.glob"].includes(name)) {
              if (name === "Astro.glob" && symbol(expression.expression)) unknown("shadowed_glob");
              const argument = node.arguments[0];
              const patterns = ts.isArrayLiteralExpression(argument) ? argument.elements.map(literal) : [literal(argument)];
              // All Site source modules are already queued and every Site asset
              // is guarded. Other roots or computed glob syntax need a new contract.
              if (!patterns.length || patterns.some(pattern => typeof pattern !== "string"
                || posix.isAbsolute(pattern)
                || !/^[./a-zA-Z0-9_*?-]+$/.test(pattern)
                || !posix.normalize(posix.join(posix.dirname(file), pattern)).startsWith("site/src/"))) unknown("unresolved_glob");
              const options = node.arguments[1];
              if (options && (!ts.isObjectLiteralExpression(options) || options.properties.some(property =>
                !ts.isPropertyAssignment(property) || !["eager", "import", "query", "exhaustive", "as"].includes(
                  ts.isIdentifier(property.name) ? property.name.text : literal(property.name))))) unknown("unresolved_glob_options");
            }
            if (expression.kind === ts.SyntaxKind.ImportKeyword) {
              const target = value(node.arguments[0]);
              if (!target) unknown("dynamic_import");
              if (/^\/site\/\.(?:compiled-renderer|public-post-renderer)\//.test(target)) {
                // The actual compiler's source/templates/assets are all guarded.
              } else edge(target, file);
            }
            let base = ts.isIdentifier(expression) ? requireAliases.get(expression.text) : null;
            if (ts.isIdentifier(expression) && expression.text === "require" && !base) base = file;
            if (ts.isPropertyAccessExpression(expression) && expression.name.text === "resolve"
              && ts.isIdentifier(expression.expression)) base = requireAliases.get(expression.expression.text)
                ?? (expression.expression.text === "require" ? file : null);
            if (ts.isCallExpression(expression)) base = requireBase(expression);
            if (base) {
              if (node.arguments.length !== 1 || literal(node.arguments[0]) === null) unknown("dynamic_require");
              edge(node.arguments[0].text, base);
            }
          }
          // Adapter entrypoints and sandbox compiler launches are data paths,
          // not ES imports. Include each literal source-file choice as well.
          const text = literal(node);
          if (text && /^(?:\.\.?\/|site\/|scripts\/|src\/).+\.(?:ts|mjs|js|astro)$/.test(text)) {
            const candidates = [text, posix.join(posix.dirname(file), text), posix.join("site", text)].filter(path => files.has(path));
            for (const candidate of candidates) enqueue(candidate);
          }
          ts.forEachChild(node, walk);
        };
        walk(tree);
      }
    }
    if (!roots.size) unknown("missing_functions_roots");
    const atModule = async (file, operation) => {
      activeFile = file;
      try { return await operation(); }
      catch (error) {
        moduleFailure ??= { file, code: error instanceof UnknownGraph ? error.message : "functions_module_unresolved" };
        throw error;
      }
    };
    const { build } = siteRequire("esbuild");
    bundling = true;
    const result = await build({ entryPoints: [...roots], bundle: true, write: false, outdir: "/cms-renderer-graph-unused",
      platform: "node", format: "cjs", metafile: true, logLevel: "silent", treeShaking: false,
      logOverride: { "unsupported-require-call": "error", "unsupported-dynamic-import": "error", "indirect-require": "error", "direct-eval": "error" },
      plugins: [{ name: "committed-renderer-functions", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => atModule(args.kind === "entry-point" ? posix.normalize(args.path) : args.importer, () => {
          if (args.kind === "entry-point") return { path: posix.normalize(args.path), namespace: "git" };
          if (!args.path.startsWith(".")) {
            if (["module", "node:module"].includes(args.path) && args.importer !== "functions/lib/home-retained-sources.js") unknown("module_loader_alias");
            external(args.path); return { path: args.path, external: true };
          }
          return { path: resolve(args.path, args.importer), namespace: "git" };
        }));
        builder.onLoad({ filter: /.*/, namespace: "git" }, args => atModule(args.path, async () => {
          let contents = await read(args.path);
          if (!args.path.endsWith(".json")) {
            try { contents = functionGraphSource(contents, args.path, files.get(args.path), ts); }
            catch { unknown("functions_loader_contract"); }
          }
          return { contents, loader: args.path.endsWith(".json") ? "json" : args.path.endsWith(".ts") ? "ts" : "js" };
        }));
      } }],
    });
    bundling = false;
    if (result.warnings.length) {
      activeFile = result.warnings[0].location?.file?.replace(/^git:/, "") ?? null;
      unknown("require_graph_warning");
    }
    const dependencyPaths = Object.keys(result.metafile.inputs).map(key => key.slice(4)).sort();
    const guard = file => GUARDS.some(prefix => file === prefix || file.startsWith(`${prefix}/`))
      || (file.startsWith("functions/") && !/\.(?:[cm]?js|ts)$/.test(file));
    const inputs = [...new Set([...files.keys()].filter(guard).concat([...visited], [...extra], dependencyPaths))].sort();
    const nonRegular = inputs.find(file => !files.get(file)?.startsWith("100"));
    if (nonRegular) { activeFile = nonRegular; unknown("non_regular_input"); }
    const manifest = readDeploymentManifest(deps.cwd ?? process.cwd(), sourceSha);
    const configured = deploymentInputFingerprint(inputs, deps.env ?? process.env, manifest);
    const fingerprint = createHash("sha256").update("njpbs-renderer-require-graph-v1\n")
      .update(inputs.map(file => `${files.get(file)}\t${file}`).join("\n"))
      .update(configured ? `\nrender-inputs:${configured}` : "").digest("hex");
    return { version: 1, fingerprint, dependencyPaths };
  } catch (error) {
    if (Array.isArray(error?.errors)) deps.onDiagnostics?.(error.errors.map(item => ({ id: item.id,
      file: item.location?.file, line: item.location?.line, code: /^[a-z_]+$/.test(item.text) ? item.text : "bundler_error" })));
    const diagnosticFile = error?.errors?.[0]?.location?.file?.replace(/^git:/, "");
    deps.onUnknown?.(moduleFailure?.code ?? (error instanceof UnknownGraph ? error.message
      : bundling ? "functions_bundle_unresolved" : "renderer_graph_unresolved"),
    moduleFailure?.file ?? diagnosticFile ?? (bundling ? null : activeFile));
    return null;
  }
}
