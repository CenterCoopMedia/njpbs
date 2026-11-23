import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const project = join(root, "functions/tsconfig.checkjs.json");
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx|astro|css)$/;
const excluded = /^(?:archive|docs|proof|evidence|wiki|tasks)\/|(?:^|\/)(?:vendor|node_modules|dist)\/|\.(?:generated|min)\./;
const testFile = /(?:^|\/)(?:fixtures?|tests?|__tests__|e2e|browser-tests)\/|\.(?:test|spec)\./;
const generated = /^\s*(?:\/\/|\/\*|\*)\s*(?:generated (?:from|by)|(?:this file is )?auto[- ]generated|do not edit)/im;
const sizeLimit = 1_000;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function sourceSizes(cwd) {
  const sizes = new Map();
  for (const file of git(cwd, "ls-files", "-z").split("\0")) {
    if (!sourceFile.test(file) || excluded.test(file)) continue;
    const lines = readFileSync(join(cwd, file), "utf8").split(/\r\n|[\r\n\u2028\u2029]/);
    if (lines.at(-1) === "") lines.pop();
    if (!generated.test(lines.slice(0, 5).join("\n"))) sizes.set(file, lines.length);
  }
  return sizes;
}

function checkFunctions(ts, cwd, sizes) {
  const host = {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => cwd,
    getNewLine: () => "\n",
  };
  const config = ts.readConfigFile(project, ts.sys.readFile);
  if (config.error) throw new Error(ts.formatDiagnostics([config.error], host));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(cwd, "functions"));
  if (parsed.errors.length) throw new Error(ts.formatDiagnostics(parsed.errors, host));

  const files = parsed.fileNames.filter((file) => sizes.has(relative(cwd, file)));
  const checked = new Set(files.map((file) => relative(cwd, file)));
  const compilerHost = ts.createCompilerHost(parsed.options);
  compilerHost.getCurrentDirectory = () => join(cwd, "functions");
  const program = ts.createProgram(files, parsed.options, compilerHost);
  const findings = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
    const file = diagnostic.file ? relative(cwd, diagnostic.file.fileName) : null;
    if (file && !checked.has(file)) continue;
    const line = diagnostic.start === undefined ? undefined
      : diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start).line;
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").replaceAll(cwd + "/", "");
    findings.push({ file, line: line === undefined ? null : line + 1, rule: "TS" + diagnostic.code, message });
  }
  return { files: files.length, findings };
}

async function capture(cwd, ESLint, ts) {
  const sizes = sourceSizes(cwd);
  const lintFiles = [...sizes.keys()].filter((file) => !file.endsWith(".css"));
  const eslint = new ESLint({ cwd, overrideConfigFile: join(root, "eslint.config.mjs") });
  const results = await eslint.lintFiles(lintFiles);
  const lint = results.flatMap(({ filePath, messages }) =>
    messages.map(({ ruleId, severity, line, message }) =>
      ({ file: relative(cwd, filePath), line, rule: ruleId ?? "parse", severity, message })));

  return {
    sha: git(cwd, "rev-parse", "HEAD").trim(),
    lintFiles: results.length,
    lint,
    types: checkFunctions(ts, cwd, sizes),
    lines: Object.fromEntries([...sizes].filter(([file]) => !testFile.test(file) && !/\.d\.[cm]?ts$/.test(file))),
  };
}

function renamedPaths(cwd, base) {
  const fields = git(cwd, "diff", "--name-status", "--find-renames", "-z", base, "HEAD").split("\0");
  const renames = new Map();
  for (let i = 0; fields[i];) {
    const status = fields[i++];
    const from = fields[i++];
    if (status.startsWith("R")) renames.set(fields[i++], from);
  }
  return renames;
}

function addedDiagnostics(baseline, current, renames) {
  const key = ({ rule, message }, file) => JSON.stringify([file, rule, message]);
  const counts = new Map();
  for (const finding of baseline) {
    const id = key(finding, finding.file);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return current.filter((finding) => {
    const id = key(finding, renames.get(finding.file) ?? finding.file);
    const count = counts.get(id) ?? 0;
    if (!count) return true;
    counts.set(id, count - 1);
    return false;
  });
}

// Function length and file size are review aids, reported in the totals only:
// a long function or file runs the same as a short one.
export function compare(baseline, current, renames = new Map()) {
  const errors = (lint) => lint.filter(({ severity, rule }) =>
    severity === 2 && rule !== "max-lines-per-function");
  return {
    lint: addedDiagnostics(errors(baseline.lint), errors(current.lint), renames),
    types: addedDiagnostics(baseline.types.findings, current.types.findings, renames),
  };
}

function lintSuppressions(lint) {
  const files = new Map();
  for (const finding of lint) {
    if (finding.severity !== 2 || finding.rule === "parse") continue;
    const rules = files.get(finding.file) ?? new Map();
    const count = (rules.get(finding.rule)?.count ?? 0) + 1;
    rules.set(finding.rule, { count });
    files.set(finding.file, rules);
  }
  return Object.fromEntries([...files].map(([file, rules]) => [file, Object.fromEntries(rules)]));
}

async function main(output, candidate, base) {
  const require = createRequire(join(root, "site/package.json"));
  const { ESLint } = require("eslint");
  const ts = require("typescript");
  mkdirSync(output, { recursive: true });
  const save = (name, data) => writeFileSync(join(output, name + ".json"), JSON.stringify(data) + "\n");
  const summarize = ({ sha, lintFiles, lint, types, lines }) => ({
    sha,
    lintFiles,
    lintErrors: lint.filter(({ severity }) => severity === 2).length,
    lintWarnings: lint.filter(({ severity }) => severity === 1).length,
    longFunctions: lint.filter(({ rule }) => rule === "max-lines-per-function").length,
    complexFunctions: lint.filter(({ rule }) => rule === "complexity").length,
    functionsFiles: types.files,
    typeErrors: types.findings.length,
    oversizedFiles: Object.values(lines).filter((count) => count > sizeLimit).length,
  });
  const current = await capture(resolve(candidate), ESLint, ts);
  save("current", current);
  console.log("Current code health:", summarize(current));

  const baseline = base ? await capture(resolve(base), ESLint, ts) : current;
  save("baseline", baseline);
  save("eslint-suppressions", lintSuppressions(baseline.lint));
  console.log("Baseline code health:", summarize(baseline));

  const findings = compare(baseline, current, base ? renamedPaths(candidate, baseline.sha) : new Map());
  save("new-findings", findings);
  console.log("New problems:", Object.fromEntries(
    Object.entries(findings).map(([check, entries]) => [check, entries.length])));
  if (base && Object.values(findings).some((entries) => entries.length > 0)) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(...process.argv.slice(2));
}
