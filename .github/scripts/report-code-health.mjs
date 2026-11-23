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
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
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
    const { file: source, start, length = 0 } = diagnostic;
    const { line, character } = start === undefined || !source ? {} : source.getLineAndCharacterOfPosition(start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").replaceAll(cwd + "/", "");
    findings.push({
      file, line: line === undefined ? null : line + 1, column: line === undefined ? null : character + 1,
      rule: "TS" + diagnostic.code, message, text: source?.text.slice(start, start + length) ?? null,
    });
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

// Changed files between base and HEAD: head path -> { from: base path, hunks }.
// A new file has from === null; its one hunk covers every line.
function changedFiles(cwd, base) {
  const files = new Map();
  let file;
  let header = false;
  const diff = git(cwd, "-c", "core.quotePath=false", "diff", "-U0", "--find-renames", "--no-prefix",
    "--no-color", "--no-ext-diff", base, "HEAD");
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { from: undefined, to: undefined, hunks: [] };
      header = true;
    } else if (header && /^(?:--- |rename from )/.test(line)) {
      file.from = line.replace(/^(?:--- |rename from )/, "").replace(/\t$/, "");
    } else if (header && /^(?:\+\+\+ |rename to )/.test(line)) {
      file.to = line.replace(/^(?:\+\+\+ |rename to )/, "").replace(/\t$/, "");
      if (file.to !== "/dev/null") files.set(file.to, file);
    } else if (line.startsWith("@@ ")) {
      header = false;
      const [, oldStart, oldCount = "1", newStart, newCount = "1"] =
        line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      file.hunks.push({ oldStart: +oldStart, oldCount: +oldCount, newStart: +newStart, newCount: +newCount });
    }
  }
  for (const file of files.values()) if (file.from === "/dev/null") file.from = null;
  return files;
}

// Where a type error sits: on an unchanged line (as its base line number) or
// inside a changed hunk (by index). Unchanged lines map exactly across the diff.
function basePosition(hunks, line) {
  const index = hunks.findIndex(({ oldStart, oldCount }) => line >= oldStart && line < oldStart + oldCount);
  return index < 0 ? `line ${line}` : `hunk ${index}`;
}

function headPosition(hunks, line) {
  let offset = 0;
  for (const [index, { oldCount, newStart, newCount }] of hunks.entries()) {
    if (line >= newStart && line < newStart + newCount) return `hunk ${index}`;
    if (newCount ? newStart + newCount <= line : newStart < line) offset += newCount - oldCount;
  }
  return `line ${line - offset}`;
}

function addedDiagnostics(baseline, current, key) {
  const counts = new Map();
  for (const finding of baseline) {
    const id = key(finding, false);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return current.filter((finding) => {
    const id = key(finding, true);
    const count = counts.get(id) ?? 0;
    if (!count) return true;
    counts.set(id, count - 1);
    return false;
  });
}

// Function length and file size are review aids, reported in the totals only:
// a long function or file runs the same as a short one.
export function compare(baseline, current, changes = new Map()) {
  const errors = (lint) => lint.filter(({ severity, rule }) =>
    severity === 2 && rule !== "max-lines-per-function");
  const byBase = new Map([...changes.values()].filter(({ from }) => from).map((file) => [file.from, file]));
  const basePath = (file, head) => (head ? changes.get(file)?.from : file) ?? file;
  // A type message quotes the callee's signature, so on an unchanged line a type
  // error matches by base line and column. Inside a changed hunk it matches by
  // flagged text and message.
  const typeKey = ({ file, line, column, rule, message, text }, head) => {
    if (line === null) return JSON.stringify([basePath(file, head), rule, message]);
    const hunks = (head ? changes.get(file) : byBase.get(file))?.hunks ?? [];
    const position = (head ? headPosition : basePosition)(hunks, line);
    const identity = position.startsWith("hunk") ? [text, message] : [column];
    return JSON.stringify([basePath(file, head), rule, position, ...identity]);
  };
  return {
    lint: addedDiagnostics(errors(baseline.lint), errors(current.lint),
      ({ file, rule, message }, head) => JSON.stringify([basePath(file, head), rule, message])),
    types: addedDiagnostics(baseline.types.findings, current.types.findings, typeKey),
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

  const findings = compare(baseline, current, base ? changedFiles(candidate, baseline.sha) : new Map());
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
