import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const workflowsDir = fileURLToPath(
  new URL("../../.github/workflows", import.meta.url),
);
const allowedKeys = new Set(["group", "queue", "cancel-in-progress"]);
const allowedQueueValues = new Set(["single", "max"]);

function isMapping(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unsupportedKeys(
  scope: string,
  concurrency: Record<string, unknown>,
): string[] {
  const findings = Object.keys(concurrency)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => `${scope}: ${key}`);
  const queue = concurrency.queue;
  if (queue !== undefined && !allowedQueueValues.has(String(queue))) {
    findings.push(`${scope}: queue value ${String(queue)}`);
  }
  if (queue === "max" && concurrency["cancel-in-progress"] === true) {
    findings.push(`${scope}: queue max with cancel-in-progress true`);
  }
  return findings;
}

describe("workflow concurrency contract (#1258)", () => {
  it("accepts supported queue values and combinations", () => {
    expect(unsupportedKeys("test", { group: "pages", queue: "max" })).toEqual(
      [],
    );
    expect(
      unsupportedKeys("test", {
        group: "pages",
        queue: "max",
        "cancel-in-progress": false,
      }),
    ).toEqual([]);
    expect(
      unsupportedKeys("test", {
        group: "pages",
        queue: "single",
        "cancel-in-progress": true,
      }),
    ).toEqual([]);
    expect(
      unsupportedKeys("test", {
        group: "pages",
        queue: "max",
        "cancel-in-progress": "${{ false }}",
      }),
    ).toEqual([]);
    expect(
      unsupportedKeys("test", { group: "pages", queue: "unbounded" }),
    ).toEqual(["test: queue value unbounded"]);
    expect(
      unsupportedKeys("test", {
        group: "pages",
        queue: "max",
        "cancel-in-progress": true,
      }),
    ).toEqual(["test: queue max with cancel-in-progress true"]);
  });

  it("uses only GitHub-supported concurrency keys, values and combinations", () => {
    const scanned = readdirSync(workflowsDir)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .sort()
      .flatMap((file) => {
        const workflow = parse(readFileSync(join(workflowsDir, file), "utf8")) as {
          concurrency?: unknown;
          jobs?: Record<string, { concurrency?: unknown }>;
        };
        const candidates = [
          {
            scope: `${file} workflow concurrency`,
            concurrency: workflow.concurrency,
          },
          ...Object.entries(workflow.jobs ?? {}).map(([job, config]) => ({
            scope: `${file} job ${job} concurrency`,
            concurrency: config.concurrency,
          })),
        ];

        return candidates.filter(
          (candidate): candidate is { scope: string; concurrency: Record<string, unknown> } =>
            isMapping(candidate.concurrency),
        );
      });
    expect(scanned.length).toBeGreaterThan(0);

    const findings = scanned.flatMap(({ scope, concurrency }) =>
      unsupportedKeys(scope, concurrency),
    );

    expect(findings).toEqual([]);
  });
});
