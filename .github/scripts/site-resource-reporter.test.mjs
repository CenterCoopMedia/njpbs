import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { it } from "node:test";

const vitest = fileURLToPath(new URL("../../site/node_modules/vitest/vitest.mjs", import.meta.url));
const reporter = fileURLToPath(new URL("./site-resource-reporter.mjs", import.meta.url));

it("reports real Vitest results without changing pass or failure status", () => {
  const root = mkdtempSync(join(tmpdir(), "site-resource-reporter-"));
  try {
    writeFileSync(join(root, "vitest.config.mjs"), "export default { test: { globals: true } };\n");
    const fixture = join(root, "resource.test.js");
    const args = [vitest, "run", "--root", root, "--config", join(root, "vitest.config.mjs"),
      "--maxWorkers=1", "--reporter=default", "--reporter=github-actions", `--reporter=${reporter}`];
    const env = { ...process.env, GITHUB_ACTIONS: "true" };
    // Fixture failures must not write summaries or commands into the real CI step.
    for (const key of ["GITHUB_STEP_SUMMARY", "GITHUB_OUTPUT", "GITHUB_ENV"]) delete env[key];
    const options = { encoding: "utf8", env };
    writeFileSync(fixture, "test('passes', () => expect(2 + 2).toBe(4));\n");
    const passing = execFileSync(process.execPath, args, options);
    assert.match(passing, /"reason":"passed"/);

    writeFileSync(fixture, "test('fails', () => expect(2 + 2).toBe(5));\n" +
      "for (let i = 0; i < 11; i++) test('passes ' + i, () => expect(2 + 2).toBe(4));\n");
    const failed = spawnSync(process.execPath, args, options);
    assert.equal(failed.error, undefined);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout + failed.stderr, /::error file=/);
    const records = failed.stdout.split("\n").filter(line => line.startsWith("Site resources: "))
      .map(line => JSON.parse(line.slice("Site resources: ".length)));
    assert.deepEqual(records.map(record => record.phase), ["start", "failure", "end"]);
    assert.equal(records[0].configuredMaxWorkers, 1);
    assert.ok(records[0].availableParallelism > 0);
    assert.equal(records[1].test, "fails");
    assert.equal(records[1].state, "failed");
    assert.ok(records[1].durationMs >= 0);
    assert.equal(records[2].reason, "failed");
    assert.equal(records[2].slowest.length, 10);
    const durations = records[2].slowest.map(test => test.durationMs);
    assert.ok(durations.every((duration, index) => index === 0 || duration <= durations[index - 1]));
    for (const record of records) {
      assert.ok(Object.hasOwn(record.cgroup, "cpu.stat"));
      assert.ok(Object.hasOwn(record.cgroup, "io.pressure"));
      assert.ok(Object.hasOwn(record.cgroup, "memory.events"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
