// Dependency-free source guard for the no-metered-API rule (issues #245, #607,
// #894).
//
// This bootstrap deliberately lives outside the source graph it protects. CI
// invokes it directly with Node before scanned source can execute. Workflows
// that install first keep lifecycle scripts disabled for the whole job, so
// neither first-party nor dependency hooks can execute outside the scan. Keep
// every static import in this file limited to Node built-ins.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const METERED_API_HOST =
  /\b(?:api\.anthropic\.com|api\.openai\.com|openai\.azure\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.cohere\.(?:ai|com)|api\.mistral\.ai|api\.groq\.com|api\.perplexity\.ai|api\.x\.ai|api\.deepseek\.com|openrouter\.ai)\b/gi;

const METERED_SDK_JS =
  /(?:\bfrom|\brequire|\bimport)\s*\(?\s*["'`](@anthropic-ai\/sdk|openai|@google\/generative-ai|@google\/genai|@mistralai\/mistralai|cohere-ai|groq-sdk|@aws-sdk\/client-bedrock-runtime|@ai-sdk\/(?:openai|anthropic|google|mistral|cohere|groq|xai)|@langchain\/(?:openai|anthropic|google-genai|google-vertexai|mistralai|cohere)|langchain\/(?:chat_models|llms|embeddings)\/(?:openai|anthropic|googlevertexai|mistral|cohere))(?:\/[^"'`]*)?["'`]/g;

const METERED_SDK_PY =
  /^[ \t]*import[ \t]+[\w.,\t ]*\b(?:anthropic|openai|google\.generativeai|google\.genai|cohere|mistralai|groq)\b|^[ \t]*from[ \t]+(?:anthropic|openai|google\.generativeai|google\.genai|cohere|mistralai|groq)\b|^[ \t]*from[ \t]+google[ \t]+import[ \t]+(?:generativeai|genai)\b/gm;

// Package scripts can embed Python with `python -c`, so its import is not at
// the start of a source line. Apply this form only when the decoded command
// actually invokes an inline Python program; scanning every shell `--import`
// flag as Python would reject unrelated tools.
const METERED_SDK_PY_COMMAND =
  /(?:\b|-c)import[ \t]+[\w.,\t ]*\b(?:anthropic|openai|google\.generativeai|google\.genai|cohere|mistralai|groq)\b|(?:\b|-c)from[ \t]+(?:anthropic|openai|google\.generativeai|google\.genai|cohere|mistralai|groq)\b|(?:\b|-c)from[ \t]+google[ \t]+import[ \t]+(?:generativeai|genai)\b/g;

const PYTHON_INTERPRETER_COMMAND =
  /(?:^|[\s;&|()])(?:[^\s;&|()]+\/)?(?:python(?:3(?:\.\d+)?)?|py)(?=\s|$)/;

const METERED_SDK_PY_DYNAMIC_COMMAND =
  /\b(?:__import__|importlib\.import_module)\s*\(\s*["'`](?:anthropic|openai|google\.generativeai|google\.genai|cohere|mistralai|groq)["'`]\s*\)|(?:^|\s)-m\s*(?:anthropic|openai|google\.generativeai|google\.genai|cohere|mistralai|groq)\b/g;

const MARKDOWNLINT_MODULE_HOOKS =
  /\b(?:customRules|markdownItPlugins|outputFormatters)\b/g;

const SCANNED_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|astro|py)$/;

const IGNORED_SCAN_DIRECTORIES = new Set([
  ".git",
  ".astro",
  "node_modules",
  "dist",
  "coverage",
  "__pycache__",
]);

// This must match Markdown lint's reachable tree, not the broader source-scan
// exclusions above. coverage/, .astro/, and __pycache__/ can still contain
// linted Markdown, so their directory-level configs must remain visible here.
const IGNORED_MARKDOWNLINT_CONFIG_DIRECTORIES = new Set([
  ".git",
  "node_modules",
]);

// The unit spec embeds the forbidden strings as fixtures. The trusted
// bootstrap contains the ban list itself, so its independent trust-boundary
// assertions replace self-scanning.
const GUARDRAIL_OWN_FILES = new Set([
  ".github/scripts/metered-api-scan.mjs",
  "site/tests/metered-api-guardrail.test.ts",
]);

export const SITE_SCAN_ROOTS = [
  "src",
  "scripts",
  "tests",
  "worker",
  "worker-fanout",
];

export const REPO_SCAN_ROOTS = [
  "functions",
  "scripts",
  "tests",
  "qa",
  "packages",
  "admin",
  "cms-api",
  "crawl-worker",
];

// Root rebuilds can execute lifecycle commands from every workspace, while
// site rebuilds can execute the site's own commands. Keep all first-party
// manifests explicit so a new install surface must make a visible guardrail
// decision instead of entering the execution graph silently.
export const SCANNED_MANIFESTS = [
  "package.json",
  "admin/package.json",
  "cms-api/package.json",
  "crawl-worker/package.json",
  "functions/package.json",
  "site/package.json",
];

// markdownlint-cli2 discovers this supported filename family per directory.
// Scan every candidate anywhere in the repository and reject every config key
// that loads modules: those modules could otherwise execute after the source
// scan has passed.
export const SCANNED_MARKDOWNLINT_CONFIGS = [
  ".markdownlint-cli2.jsonc",
  ".markdownlint-cli2.yaml",
  ".markdownlint-cli2.cjs",
  ".markdownlint-cli2.mjs",
  ".markdownlint.jsonc",
  ".markdownlint.json",
  ".markdownlint.yaml",
  ".markdownlint.yml",
  ".markdownlint.cjs",
  ".markdownlint.mjs",
];

function collect(source, pattern, rule) {
  const out = [];
  for (const match of source.matchAll(pattern)) {
    out.push({ rule, match: match[0].trim() });
  }
  return out;
}

export function findMeteredApiViolations(source) {
  if (!source) return [];
  return [
    ...collect(source, METERED_API_HOST, "metered-api-host"),
    ...collect(source, METERED_SDK_JS, "metered-api-sdk"),
    ...collect(source, METERED_SDK_PY, "metered-api-sdk"),
  ];
}

export function findPackageScriptViolations(source) {
  const manifest = JSON.parse(source);
  const violations = [];
  if (manifest.scripts !== undefined) {
    if (
      manifest.scripts === null ||
      Array.isArray(manifest.scripts) ||
      typeof manifest.scripts !== "object"
    ) {
      throw new Error("package.json scripts must be an object");
    }

    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command !== "string") {
        throw new Error(`package.json scripts.${name} must be a string`);
      }
      const commandViolations = [...findMeteredApiViolations(command)];
      if (PYTHON_INTERPRETER_COMMAND.test(command)) {
        commandViolations.push(
          ...collect(command, METERED_SDK_PY_COMMAND, "metered-api-sdk"),
        );
      }
      commandViolations.push(
        ...collect(command, METERED_SDK_PY_DYNAMIC_COMMAND, "metered-api-sdk"),
      );
      const seen = new Set();
      violations.push(
        ...commandViolations
          .filter((violation) => {
            const key = `${violation.rule}\0${violation.match}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((violation) => ({
            ...violation,
            match: `scripts.${name}: ${violation.match}`,
          })),
      );
    }
  }

  if (manifest["markdownlint-cli2"] !== undefined) {
    violations.push(
      ...findMarkdownlintConfigViolations(
        JSON.stringify(manifest["markdownlint-cli2"]),
      ).map((violation) => ({
        ...violation,
        match: `markdownlint-cli2: ${violation.match}`,
      })),
    );
  }

  return violations;
}

export function findMarkdownlintConfigViolations(source) {
  return [
    ...findMeteredApiViolations(source),
    ...collect(source, MARKDOWNLINT_MODULE_HOOKS, "markdownlint-module-hook"),
  ];
}

export function isMeteredApiScanTarget(relPath) {
  const path = relPath.replace(/\\/g, "/");
  return SCANNED_EXT.test(path) && !GUARDRAIL_OWN_FILES.has(path);
}

export function isMarkdownlintConfigPath(relPath) {
  const path = relPath.replace(/\\/g, "/");
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return SCANNED_MARKDOWNLINT_CONFIGS.includes(basename);
}

function isExcludedPath(relPath, excludedRoots) {
  const path = relPath.replace(/\\/g, "/");
  return excludedRoots.some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function walk(
  absDir,
  relBase,
  ignoredDirectories = IGNORED_SCAN_DIRECTORIES,
  excludedRoots = [],
) {
  const out = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (isExcludedPath(rel, excludedRoots)) continue;
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      out.push(
        ...walk(
          join(absDir, entry.name),
          rel,
          ignoredDirectories,
          excludedRoots,
        ),
      );
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

export function scanRepositorySourceFiles(repoRoot, excludedRoots = []) {
  return walk(
    repoRoot,
    "",
    IGNORED_SCAN_DIRECTORIES,
    excludedRoots,
  ).filter((rel) => isMeteredApiScanTarget(rel));
}

export function scanMarkdownlintConfigFiles(repoRoot, excludedRoots = []) {
  return walk(
    repoRoot,
    "",
    IGNORED_MARKDOWNLINT_CONFIG_DIRECTORIES,
    excludedRoots,
  ).filter((rel) => isMarkdownlintConfigPath(rel));
}

export function scanPackageManifestFiles(repoRoot, excludedRoots = []) {
  return walk(repoRoot, "", IGNORED_SCAN_DIRECTORIES, excludedRoots).filter(
    (rel) => rel === "package.json" || rel.endsWith("/package.json"),
  );
}

export function scanFilesUnder(base, label, listName, root) {
  const abs = join(base, root);
  if (!existsSync(abs)) {
    throw new Error(
      `${label}${root} is in ${listName} but is not on disk. Restore it or drop it from the list: an unscanned root is an unguarded one.`,
    );
  }
  return walk(abs, root).filter((rel) =>
    isMeteredApiScanTarget(`${label}${rel}`),
  );
}

export function scanSiteRootFiles(siteRoot) {
  return readdirSync(siteRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && isMeteredApiScanTarget(`site/${entry.name}`),
    )
    .map((entry) => entry.name);
}

export function meteredOffenders(base, relPaths) {
  return relPaths
    .map((file) => ({
      file,
      violations: findMeteredApiViolations(
        readFileSync(join(base, file), "utf8"),
      ),
    }))
    .filter((offender) => offender.violations.length > 0);
}

export function manifestOffenders(base, relPaths) {
  return relPaths
    .map((file) => ({
      file,
      violations: findPackageScriptViolations(
        readFileSync(join(base, file), "utf8"),
      ),
    }))
    .filter((offender) => offender.violations.length > 0);
}

export function markdownlintConfigOffenders(base, relPaths) {
  return relPaths
    .map((file) => ({
      file,
      violations: findMarkdownlintConfigViolations(
        readFileSync(join(base, file), "utf8"),
      ),
    }))
    .filter((offender) => offender.violations.length > 0);
}

export function runSourceScan(
  repoRoot,
  { strictLayout = true, excludedRoots = [] } = {},
) {
  let scanned = 0;
  let failed = false;

  function report(
    base,
    prefix,
    description,
    files,
    findOffenders = meteredOffenders,
  ) {
    scanned += files.length;
    if (strictLayout && files.length === 0) {
      failed = true;
      console.error(
        `metered-api scan: ${description} matched no scannable files.`,
      );
      return;
    }
    for (const offender of findOffenders(base, files)) {
      failed = true;
      for (const violation of offender.violations) {
        console.error(
          `metered-api scan: ${prefix}${offender.file}: ${violation.rule}: ${violation.match}`,
        );
      }
    }
  }

  function reportRoot(scan) {
    try {
      scan();
    } catch (error) {
      failed = true;
      console.error(
        `metered-api scan: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  reportRoot(() =>
    report(
      repoRoot,
      "",
      "repository-wide first-party source",
      scanRepositorySourceFiles(repoRoot, excludedRoots),
    ),
  );
  reportRoot(() => {
    const manifests = scanPackageManifestFiles(repoRoot, excludedRoots);
    if (strictLayout) {
      for (const manifest of SCANNED_MANIFESTS) {
        if (!manifests.includes(manifest)) {
          throw new Error(
            `${manifest} is a required scan target but is not on disk.`,
          );
        }
      }
    }
    report(
      repoRoot,
      "",
      "first-party package manifests",
      manifests,
      manifestOffenders,
    );
  });
  reportRoot(() =>
    report(
      repoRoot,
      "",
      "tree-wide Markdown lint configuration",
      scanMarkdownlintConfigFiles(repoRoot, excludedRoots),
      markdownlintConfigOffenders,
    ),
  );

  if (scanned === 0) {
    failed = true;
    console.error("metered-api scan: the target tree has no scannable files.");
  }

  if (failed) {
    console.error(
      "metered-api scan: direct metered model calls are not permitted; check flagged source and scan roots.",
    );
    return 1;
  }

  console.log(`metered-api scan: ${scanned} files clean.`);
  return 0;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && thisFile === resolve(process.argv[1])) {
  const scannerRepoRoot = resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.exitCode = runSourceScan(scannerRepoRoot);
  } else if (
    args.length === 2 &&
    args[0] === "--target-root" &&
    args[1].trim() !== ""
  ) {
    const targetRoot = resolve(args[1]);
    const scannerRelativeRoot = relative(targetRoot, scannerRepoRoot).replace(
      /\\/g,
      "/",
    );
    const scannerIsNested =
      scannerRelativeRoot !== "" &&
      scannerRelativeRoot !== ".." &&
      !scannerRelativeRoot.startsWith("../") &&
      !isAbsolute(scannerRelativeRoot);
    process.exitCode = runSourceScan(targetRoot, {
      strictLayout: false,
      excludedRoots: scannerIsNested ? [scannerRelativeRoot] : [],
    });
  } else {
    console.error(
      "metered-api scan: usage: node .github/scripts/metered-api-scan.mjs [--target-root PATH]",
    );
    process.exitCode = 2;
  }
}
