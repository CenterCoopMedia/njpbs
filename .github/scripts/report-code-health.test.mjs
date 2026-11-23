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
  const kept = { file: "functions/f.js", line: 6, column: 3, rule: "TS2345", message: "old signature", text: "x" };
  const edited = { file: "functions/f.js", line: 10, column: 5, rule: "TS2322", message: "old", text: "y" };
  const base = { lint: [lint], types: { findings: [kept, edited] } };
  // Two lines inserted after line 2; line 10 edited and now at line 12.
  const changes = new Map([
    ["admin/src/new.ts", { from: lint.file, hunks: [] }],
    ["functions/f.js", { from: "functions/f.js", hunks: [
      { oldStart: 2, oldCount: 0, newStart: 3, newCount: 2 },
      { oldStart: 10, oldCount: 1, newStart: 12, newCount: 1 },
    ] }],
  ]);
  const moved = { ...lint, file: "admin/src/new.ts", line: 20 };
  const extraLint = { ...moved, line: 30, message: "replaced name" };
  const sameName = { ...kept, line: 8, column: 6 };
  const head = {
    lint: [
      moved, extraLint, { ...lint, severity: 1, rule: "complexity" },
      { ...lint, rule: "max-lines-per-function", message: "Function 'f' has too many lines (201)." },
    ],
    types: { findings: [
      sameName, { ...kept, line: 8, message: "changed signature" },
      { ...edited, line: 12, column: 9 }, { ...edited, line: 4, column: 1 },
    ] },
  };

  assert.deepEqual(compare(base, head, changes), {
    lint: [extraLint],
    types: [sameName, { ...edited, line: 4, column: 1 }],
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
  const pair = (call) => `/**\n * @param {number} a\n * @param {number} b\n */\nconst f = (a, b) => a + b;\nconst x = "s";\nmodule.exports = ${call};\n`;
  write("functions/pair.js", pair("[f(1, x), f(1, 1)]"));
  commit();
  git("worktree", "add", "--detach", baseline, "HEAD");

  // The existing error keeps its identity when lines move and its own line changes.
  for (const contents of [pair("[f(1, x), f(1, 1)]").replace("const x", "// moved\nconst x"), pair("[f(2, x), f(1, 1)]")]) {
    write("functions/pair.js", contents);
    commit();
    const result = report();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    git("reset", "--hard", "HEAD^1");
  }

  for (const [category, file, contents] of [
    ["lint", "new.cjs", "module.exports = newUndefinedName;\n"],
    ["types", "functions/pair.js", pair("[f(1, x), f(1, x)]")],
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
