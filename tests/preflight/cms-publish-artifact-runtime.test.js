import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const workflow = parse(read(".github/workflows/cms-publish.yml"));
const detection = workflow.jobs.build.steps.find(
  (step) => step.id === "artifact_runtime",
).run;
const settlement = workflow.jobs.build.steps.find(step => step.name === "Writeback success").run;
const preparePath = "scripts/prepare-cms-publish-artifact.cjs";
const runtimeFiles = [
  preparePath,
  "functions/lib/cms-publish-artifact.js",
  "scripts/update-publish-status.cjs",
  "site/scripts/build-with-production-sync.mjs",
  "site/src/lib/cms-loader.ts",
  "site/src/lib/public-artifact-build.ts",
  "site/src/lib/public-artifact-bundle.ts",
  "site/src/lib/public-artifact-inventory.ts",
];

function detectRuntime(version, prepareSource = read(preparePath)) {
  const directory = mkdtempSync(join(tmpdir(), "cms-artifact-runtime-"));
  const output = join(directory, "output");
  try {
    for (const path of runtimeFiles) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(
        join(directory, path),
        path === preparePath ? prepareSource : read(path),
      );
    }
    if (version === "v1") {
      // The v1 build wrapper advertised this input before v2 bundles replaced it.
      writeFileSync(
        join(directory, "site/scripts/build-with-production-sync.mjs"),
        "const { PUBLIC_ARTIFACT_INVENTORY_CANDIDATE_PATH } = process.env;\n",
      );
    }
    if (version !== "legacy") {
      const marker = `scripts/cms-publish-artifact-runtime-${version}.txt`;
      writeFileSync(join(directory, marker), read(marker));
    }
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", detection], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: output },
    });
    const runtimeOutput = readFileSync(output, "utf8");
    if (result.status !== 0) return { ...result, output: runtimeOutput };
    const calls = join(directory, "settlement-args");
    const writeback = spawnSync("bash", ["-c", `set -euo pipefail
node() { printf '%s\\n' "$*" >> "$WRITEBACK_CALLS"; }
${settlement}
`], {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH, SA: "synthetic", QUEUE_ID: "queue-fixture", SOURCE_SHA: "source-fixture",
        ARTIFACT_RECEIPT: "receipt-fixture.json", ARTIFACT_RUNTIME_READY: runtimeOutput.includes("ready=true") ? "true" : "false",
        WRITEBACK_CALLS: calls },
    });
    return { ...result, output: runtimeOutput, writeback,
      writebackArgs: readFileSync(calls, "utf8").trim() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("CMS publish artifact runtime admission", () => {
  it.each(["v1", "v2"])(
    "rejects a %s runtime with the old two-argument prepare script",
    (version) => {
      // The parser before d8340669 treated the new batch id as the commit SHA.
      const oldPrepare = read(preparePath).replace(
        "const [queueId, buildBatchId, commitSha] = process.argv.slice(2);",
        "const [queueId, commitSha] = process.argv.slice(2);",
      );
      const result = detectRuntime(version, oldPrepare);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("marker conflicts with its implementation");
      expect(result.output).toBe("");
    },
  );

  it.each(["v1", "v2"])(
    "accepts a %s runtime with the three-argument prepare script",
    (version) => {
      const result = detectRuntime(version);
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe(`version=${version}\nready=true\n`);
      expect(result.writeback.status, result.writeback.stderr).toBe(0);
      expect(result.writebackArgs).toBe("scripts/update-publish-status.cjs queue-fixture success source-fixture receipt-fixture.json");
    },
  );

  it("preserves build-only settlement for a source without runtime markers", () => {
    const result = detectRuntime("legacy");
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("version=legacy\nready=false\n");
    expect(result.writeback.status, result.writeback.stderr).toBe(0);
    expect(result.writebackArgs).toBe("scripts/update-publish-status.cjs queue-fixture success source-fixture");
    expect(workflow.jobs.build.steps.find(step => step.name === "Writeback success").if)
      .toContain("steps.artifact.outputs.build_required != 'false'");
  });
});
