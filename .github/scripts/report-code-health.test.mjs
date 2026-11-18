import assert from "node:assert/strict";
import test from "node:test";
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
