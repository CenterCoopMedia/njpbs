import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("checks schedule bake freshness and private report safety", () => {
  const pythonTest = "./schedule-job-monitor.test.py";
  const result = spawnSync("python3", ["-B", fileURLToPath(new URL(pythonTest, import.meta.url))], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
