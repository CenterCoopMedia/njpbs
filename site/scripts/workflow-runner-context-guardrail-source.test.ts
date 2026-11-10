import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflowsDir = fileURLToPath(
  new URL("../../.github/workflows", import.meta.url),
);
const productionWorkflows = ["cms-publish.yml", "pages.yml"] as const;

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jobLevelRunnerTempFindings(file: string): string[] {
  const workflow = parse(readFileSync(join(workflowsDir, file), "utf8")) as {
    jobs?: unknown;
  };
  if (!isMapping(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
    throw new Error(`${file} has no workflow jobs to scan.`);
  }

  return Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
    if (!isMapping(job) || !isMapping(job.env)) return [];
    return Object.entries(job.env)
      .filter(([, value]) =>
        typeof value === "string" && value.includes("runner.temp"),
      )
      .map(([name]) => `${file} job ${jobName} env ${name}`);
  });
}

describe("production workflow runner context contract (#1238)", () => {
  it.each(productionWorkflows)(
    "keeps runner.temp out of job-level env in %s",
    (file) => {
      const findings = jobLevelRunnerTempFindings(file);
      expect(
        findings,
        `Move these paths to step-level env:\n${findings.join("\n")}`,
      ).toEqual([]);
    },
  );
});
