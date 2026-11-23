import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compare } from "./report-code-health.mjs";

test("reports only added lint errors and type errors", () => {
  const lint = { file: "admin/src/old.ts", line: 5, rule: "no-undef", severity: 2, message: "old" };
  const type = { file: "functions/old.js", line: 6, rule: "TS2322", message: "old", source: "return f(old); f(old)" };
  const base = {
    lint: [lint],
    types: { findings: [type] },
  };
  const moved = { ...lint, file: "admin/src/new.ts", line: 20 };
  const extraLint = { ...moved, line: 30 };
  const extraType = { ...type, line: 9, source: "const x = f(old); f(old)" };
  const head = {
    lint: [
      moved, extraLint, { ...lint, message: "replaced name" }, { ...lint, severity: 1, rule: "complexity" },
      { ...lint, rule: "max-lines-per-function", message: "Function 'f' has too many lines (201)." },
    ],
    types: { findings: [{ ...type, line: 8, message: "callee signature changed" }, extraType] },
  };
  const renames = new Map([["admin/src/new.ts", lint.file]]);

  assert.deepEqual(compare(base, head, renames), {
    lint: [extraLint, { ...lint, message: "replaced name" }],
    types: [extraType],
  });
  assert.deepEqual(compare(base, base), { lint: [], types: [] });
});

test("the report exits nonzero for a new lint or type error and saves the findings", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "code-health-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const candidate = join(directory, "candidate");
  const baseline = join(directory, "baseline");
  const output = join(directory, "report");
  const script = fileURLToPath(new URL("./report-code-health.mjs", import.meta.url));
  const git = (...args) => execFileSync("git", args, { cwd: candidate, stdio: "pipe" });
  const write = (name, contents) => writeFileSync(join(candidate, name), contents);
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Test contributor", "-c", "user.email=contributor@example.org", "commit", "-qm", "Fixture");
  };
  const report = () => spawnSync(process.execPath, [script, output, candidate, baseline], { encoding: "utf8" });

  mkdirSync(join(candidate, "functions"), { recursive: true });
  git("init", "-q");
  write("existing.cjs", "module.exports = existingUndefinedName;\n");
  write("functions/value.js", "/** @type {number} */\nconst value = 1;\nmodule.exports = value;\n");
  commit();
  git("worktree", "add", "--detach", baseline, "HEAD");

  const unchanged = report();
  assert.equal(unchanged.status, 0, unchanged.stderr || unchanged.stdout);

  for (const [category, file, contents] of [
    ["lint", "new.cjs", "module.exports = newUndefinedName;\n"],
    ["types", "functions/value.js", '/** @type {number} */\nconst value = "text";\nmodule.exports = value;\n'],
  ]) {
    write(file, contents);
    commit();
    const result = report();
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const findings = JSON.parse(readFileSync(join(output, "new-findings.json"), "utf8"));
    assert.deepEqual(findings[category].map((finding) => finding.file), [file]);
    assert.equal(Object.values(findings).flat().length, 1);
    git("reset", "--hard", "HEAD^1");
  }
});
