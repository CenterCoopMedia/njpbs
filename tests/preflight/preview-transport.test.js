import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
const transportSteps = steps.filter(step => step.env?.CMS_PREVIEW_TRANSPORT);
const readinessSteps = transportSteps.filter(step => step.name.startsWith("Require"));

// Interpret only the variable/default expression used by these deploy steps.
function environment(step, transport, ready = "true") {
  const variables = {
    VITE_CMS_PREVIEW_ENABLED: "true",
    CMS_PREVIEW_ACCESS_VERIFIED: "true",
    CMS_PREVIEW_WRITEBACK_CONFIGURED: "true",
    CMS_PREVIEW_SERIALIZER_READY: ready,
    CMS_PREVIEW_TRANSPORT: transport,
  };
  return Object.fromEntries(Object.entries(step.env).map(([key, expression]) => {
    const match = /^\$\{\{ vars\.(\w+)(?: \|\| '([^']*)')? \}\}$/.exec(expression);
    if (!match) throw new Error(`Unexpected deploy expression for ${key}`);
    return [key, variables[match[1]] || match[2] || ""];
  }));
}

describe("preview deploy transport boundary", () => {

  it.each(transportSteps.map(step => [step.name, step]))("defaults %s to the serializer with an empty variable", (_name, step) => {
    // #2863: Clearing the repo variable must never select paid Actions builds.
    const expression = step.env.CMS_PREVIEW_TRANSPORT;
    expect(environment({ env: { CMS_PREVIEW_TRANSPORT: expression } }, "").CMS_PREVIEW_TRANSPORT).toBe("serializer");
  });

  it.each(readinessSteps.map(step => [step.name, step]))("%s refuses an unready serializer with an empty variable", (_name, step) => {
    const result = spawnSync("bash", ["-c", step.run], { env: environment(step, "", "false"), encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CMS_PREVIEW_SERIALIZER_READY must be true");
  });

  it.each(readinessSteps.map(step => [step.name, step]))("%s admits the ready serializer with an empty variable", (_name, step) => {
    const result = spawnSync("bash", ["-c", step.run], { env: environment(step, ""), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(readinessSteps.map(step => [step.name, step]))("%s rejects the retired GitHub selector", (_name, step) => {
    const result = spawnSync("bash", ["-c", step.run], { env: environment(step, "github"), encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CMS_PREVIEW_TRANSPORT must be serializer");
  });
});
