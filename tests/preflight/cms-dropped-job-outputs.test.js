import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8"));
const CHECK = "Stop on a job output GitHub dropped";
const needsOf = job => [workflow.jobs[job].needs ?? []].flat();
const checks = job => workflow.jobs[job].steps[0].name === CHECK;

// A job is covered for a producer when it runs the check itself or needs a job that ran it after that producer.
function covered(job, producer) {
  if (checks(job)) return true;
  return needsOf(job).some(need => need !== producer && needsOf(need).includes(producer) && covered(need, producer));
}

function runCheck(gh) {
  const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
  writeFileSync(join(bin, "gh"), `#!/bin/bash\n${gh}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return spawnSync("bash", ["-e", "-c", workflow.jobs.firebase.steps[0].run], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" } });
}

describe("job outputs GitHub drops for a masked value", () => {
  it("checks before every job that reads an earlier job's outputs", () => {
    for (const [job, definition] of Object.entries(workflow.jobs)) {
      const producers = new Set([...JSON.stringify(definition).matchAll(/needs\.([a-z-]+)\.outputs\./g)].map(match => match[1]));
      for (const producer of producers) expect(covered(job, producer), `${job} reads ${producer} outputs`).toBe(true);
    }
    const steps = Object.keys(workflow.jobs).filter(checks).map(job => workflow.jobs[job].steps[0]);
    expect(steps.length).toBeGreaterThan(1);
    for (const step of steps) expect(step).toEqual(steps[0]);
    for (const job of Object.keys(workflow.jobs).filter(checks)) {
      expect(workflow.jobs[job].permissions).toMatchObject({ contents: "read", actions: "read", checks: "read" });
    }
  });

  it("stops with the job and output name, and refuses when the annotations cannot be read", () => {
    const dropped = runCheck(`case "$*" in *"/jobs"*) printf '7\\tfirebase-preflight\\n';;
      *) printf "Skip output 'reader_binding' since it may contain secret.\\nNode 20 is deprecated\\n";; esac`);
    expect(dropped.status).toBe(1);
    expect(dropped.stdout).toContain("GitHub dropped job output firebase-preflight.reader_binding");
    expect(runCheck(`case "$*" in *"/jobs"*) printf '7\\tverify\\n';; *) printf 'Node 20 is deprecated\\n';; esac`).status).toBe(0);
    expect(runCheck(`case "$*" in *"/jobs"*) printf '7\\tverify\\n';; *) exit 1;; esac`).status).not.toBe(0);
    // A failed read for one job is not hidden by a later job's successful read.
    expect(runCheck(`case "$*" in *"/jobs"*) printf '7\\tverify\\n8\\tadmin-build\\n';; *"check-runs/7/"*) exit 1;;
      *) printf 'Node 20 is deprecated\\n';; esac`).status).not.toBe(0);
    // A drop from an earlier attempt still stops a rerun of failed jobs.
    const retained = runCheck(`case "$*" in *"/jobs?filter=all"*) printf '7\\tfirebase-preflight\\n';; *"/jobs"*) exit 1;;
      *) printf "Skip output 'reader_binding' since it may contain secret.\\n";; esac`);
    expect(retained.status).toBe(1);
    expect(retained.stdout).toContain("firebase-preflight.reader_binding");
  });
});
