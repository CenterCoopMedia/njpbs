import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compare } from "./report-code-health.mjs";

test("reports only added diagnostics and oversized-file growth", () => {
  const lint = { file: "admin/src/old.ts", line: 5, rule: "no-undef", severity: 2, message: "old" };
  const type = { file: "functions/old.js", line: 6, rule: "TS2322", message: "old" };
  const base = {
    lint: [lint],
    types: { findings: [type] },
    lines: { "old.ts": 1_100, "shrinks.ts": 1_200, "grows.ts": 1_100 },
  };
  const moved = { ...lint, file: "admin/src/new.ts", line: 20 };
  const extraLint = { ...moved, line: 30 };
  const extraType = { ...type, line: 9, message: "new" };
  const head = {
    lint: [moved, extraLint, { ...lint, severity: 1, rule: "complexity" }],
    types: { findings: [{ ...type, line: 8 }, extraType] },
    lines: {
      "renamed.ts": 1_100, "shrinks.ts": 1_199, "grows.ts": 1_101,
      "edge.ts": 1_000, "new.css": 1_001,
    },
  };
  const renames = new Map([["admin/src/new.ts", lint.file], ["renamed.ts", "old.ts"]]);

  assert.deepEqual(compare(base, head, renames), {
    lint: [extraLint],
    types: [extraType],
    size: [
      { file: "grows.ts", previous: 1_100, lines: 1_101 },
      { file: "new.css", previous: 0, lines: 1_001 },
    ],
  });
  assert.deepEqual(compare(base, base), { lint: [], types: [], size: [] });
});

test("the report exits nonzero for each kind of new problem and saves the findings", (t) => {
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
  const large = "/* fixture */\n".repeat(1_001);

  mkdirSync(join(candidate, "functions"), { recursive: true });
  git("init", "-q");
  write("existing.cjs", "module.exports = existingUndefinedName;\n");
  write("functions/value.js", "/** @type {number} */\nconst value = 1;\nmodule.exports = value;\n");
  write("existing.css", large);
  commit();
  git("worktree", "add", "--detach", baseline, "HEAD");

  const unchanged = report();
  assert.equal(unchanged.status, 0, unchanged.stderr || unchanged.stdout);

  for (const [category, file, contents] of [
    ["lint", "new.cjs", "module.exports = newUndefinedName;\n"],
    ["types", "functions/value.js", '/** @type {number} */\nconst value = "text";\nmodule.exports = value;\n'],
    ["size", "new.css", large],
    ["size", "existing.css", large + "/* growth */\n"],
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
