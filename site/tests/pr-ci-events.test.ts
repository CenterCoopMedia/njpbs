// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ci = parse(
  readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);

// Replay GitHub's event and job admission contract from the actual workflow.
// Missing changes.base is false, as with absent GitHub context properties.
// https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request
function eventContext(
  action: string,
  changes: object = { body: { from: "Summary" } },
) {
  return {
    ref: "refs/pull/2743/merge",
    sha: "merge-sha",
    run_id: "run-2743",
    event_name: "pull_request",
    event: {
      action,
      pull_request: {
        number: 2743,
        head: { sha: "654f88d7" },
        base: { sha: "new-base", ref: "main" },
      },
      changes,
    },
  };
}

function expression(source: string | boolean, github: object, context: object = {}) {
  if (typeof source === "boolean") return source;
  return runInNewContext(source.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), {
    github,
    always: () => true,
    cancelled: () => false,
    ...context,
  });
}

function group(github: object, workflow = ci) {
  return workflow.concurrency.group.replace(
    /\$\{\{(.*?)\}\}/g,
    (_: string, source: string) => expression(source, github),
  );
}

function codeAdmitted(github: ReturnType<typeof eventContext>) {
  return (
    ci.on.pull_request.types.includes(github.event.action) &&
    (!ci.jobs.policy.if || Boolean(expression(ci.jobs.policy.if, github)))
  );
}

function admittedRuns(actions: string[]) {
  return actions
    .map((action) => eventContext(action))
    .filter(codeAdmitted)
    .map((github) => ({ action: github.event.action, group: group(github) }));
}

describe("PR events at the Actions workflow boundary", () => {
  it("keeps a push followed by body edits to one code run on the same head", () => {
    expect(admittedRuns(["synchronize", "edited", "edited"])).toEqual([
      { action: "synchronize", group: "ci-refs/pull/2743/merge" },
    ]);
  });

  it("admits opened, reopened and updated code while retaining cancellation of superseded code", () => {
    expect(admittedRuns(["opened", "reopened", "synchronize"])).toEqual([
      { action: "opened", group: "ci-refs/pull/2743/merge" },
      { action: "reopened", group: "ci-refs/pull/2743/merge" },
      { action: "synchronize", group: "ci-refs/pull/2743/merge" },
    ]);
    expect(expression(ci.concurrency["cancel-in-progress"], eventContext("synchronize"))).toBe(true);
    expect(ci.on.push.branches).toContain("main");
    expect(ci.on).toHaveProperty("workflow_dispatch");
  });
});

describe("Merge queue events at the Actions workflow boundary", () => {
  const workflows = [
    ci,
    ...["pages-fallback-safety", "admin-ci", "firebase-ci"].map((name) =>
      parse(
        readFileSync(
          new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  ];
  const queue = (entry = "2743") => ({
    event_name: "merge_group",
    ref: `refs/heads/gh-readonly-queue/main/pr-${entry}-queue-sha`,
    sha: "queue-head-sha",
    event: {
      action: "checks_requested",
      merge_group: { base_sha: "queue-base-sha", head_sha: "queue-head-sha" },
    },
  });

  it("runs PR and queue safety in required CI without a duplicate promotion run", () => {
    expect(ci.on.merge_group).toEqual({ types: ["checks_requested"] });
    expect(ci.on.pull_request).not.toHaveProperty("paths");
    expect(ci.on.pull_request).not.toHaveProperty("paths-ignore");
    expect(workflows[1].on).not.toHaveProperty("pull_request");
    expect(workflows[1].on).not.toHaveProperty("merge_group");
    const guard = ci.jobs.policy.steps.find((step: { name?: string }) =>
      step.name === "Require the non-reserving Pages runtime");
    expect(guard.run).toBe("node .github/scripts/pages-fallback-safety.mjs");
    expect(guard.if).toBeUndefined();
    expect(guard["continue-on-error"]).toBeUndefined();
    for (const [index, consumer] of ["admin", "firebase"].entries()) {
      expect(ci.jobs[consumer].uses).toBe(
        `./.github/workflows/${consumer}-ci.yml`,
      );
      expect(Object.keys(workflows[index + 2].on)).toEqual(["workflow_call"]);
    }
  });

  it("isolates queue entries from each other, PRs, main and other workflows", () => {
    const contexts = [
      queue(),
      queue("2744"),
      eventContext("synchronize"),
      {
        ...queue(),
        event_name: "push",
        ref: "refs/heads/main",
      },
    ];
    const gateWorkflows = [ci, ...workflows.slice(2)];
    const groups = gateWorkflows.flatMap((workflow) =>
      contexts.map((github) => group(github, workflow)),
    );
    expect(new Set(groups).size).toBe(groups.length);
    for (const workflow of gateWorkflows) {
      expect(group(queue(), workflow)).toContain(queue().ref);
      const cancellation = workflow.concurrency["cancel-in-progress"];
      expect(typeof cancellation === "boolean" ? cancellation : expression(cancellation, queue())).toBe(true);
    }
  });

  it("reports required Policy and ci for the combined queue head without PR metadata", () => {
    expect(Boolean(expression(ci.jobs.policy.if, queue()))).toBe(true);
    expect(ci.jobs.policy.name).toBe("Policy");
    expect(Boolean(expression(ci.jobs.ci.if, queue()))).toBe(true);
    expect(expression(ci.jobs.ci.name, queue())).toBe("ci");
  });

  it.each(["main", "production-candidate/release"])(
    "preserves the Pages promotion check for each pushed commit on %s",
    (branch) => {
      const safety = workflows[1].jobs["pages-fallback-safety"];
      expect(safety.name).toBe("Pages fallback safety");
      expect(safety.if).toBeUndefined();
      const contexts = ["first-sha", "second-sha", "third-sha"].map((sha) => ({
        event_name: "push",
        ref: `refs/heads/${branch}`,
        sha,
      }));
      const groups = contexts.map((github) => group(github, workflows[1]));
      // Different groups also prevent replacement of pending runs.
      expect(new Set(groups).size).toBe(3);
    },
  );

  it("selects every consumer even when the classifier would skip it", () => {
    const outputs = Object.fromEntries(
      ["docs", "site", "admin", "firebase"].map((consumer) => {
        const selected = expression(ci.jobs.policy.outputs[consumer], queue(), {
          steps: { changes: { outputs: { [consumer]: "false" } } },
        });
        expect(selected).toBe("true");
        return [consumer, selected];
      }),
    );
    for (const consumer of Object.keys(outputs)) {
      expect(
        Boolean(
          expression(ci.jobs[consumer].if, queue(), {
            needs: {
              policy: {
                result: "success",
                outputs: { ...outputs, classifier_result: "success" },
              },
            },
          }),
        ),
      ).toBe(true);
      expect(ci.jobs.ci.needs).toContain(consumer);
    }
    expect(ci.jobs.ci.needs).toContain("policy");
  });

  it("pins classifier and aggregate code to the queue event base and tests the queue head", () => {
    const classifier = ci.jobs.policy.steps.find(
      (step: { id?: string }) => step.id === "changes",
    );
    expect(expression(classifier.env.BASE_SHA, queue())).toBe("queue-base-sha");
    expect(expression(classifier.env.TRUSTED_SHA, queue())).toBe(
      "queue-base-sha",
    );
    expect(expression(classifier.env.HEAD_REF, queue())).toBe("queue-head-sha");
    expect(expression(ci.jobs.ci.steps[0].with.ref, queue())).toBe(
      "queue-base-sha",
    );
  });
});

describe("Edited PR event contracts", () => {
  it.each([
    { title: { from: "Old title" } },
    { body: { from: "Old body" } },
    { title: { from: "Old title" }, body: { from: "Old body" } },
  ])(
    "isolates metadata edits without publishing the required ci check: %j",
    (changes) => {
      const github = eventContext("edited", changes);
      expect(ci.on.pull_request.types).toContain("edited");
      expect(codeAdmitted(github)).toBe(false);
      expect(group(github)).not.toBe(group(eventContext("synchronize")));
      expect(Boolean(expression(ci.jobs.ci.if, github))).toBe(false);
      expect(expression(ci.jobs.ci.name, github)).not.toBe("ci");
    },
  );

  it.each([
    { base: { ref: { from: "old-target" }, sha: { from: "old-base" } } },
    { base: { ref: { from: "old-target" } }, body: { from: "Old body" } },
  ])(
    "automatically admits base edits to code concurrency and the required gate: %j",
    (changes) => {
      const github = eventContext("edited", changes);
      expect(codeAdmitted(github)).toBe(true);
      expect(group(github)).toBe("ci-refs/pull/2743/merge");
      expect(Boolean(expression(ci.jobs.ci.if, github))).toBe(true);
      expect(expression(ci.jobs.ci.name, github)).toBe("ci");
    },
  );

  it.each(["push", "workflow_dispatch"])(
    "retains code admission and the ci name for %s",
    (eventName) => {
      const github = eventContext("");
      github.event_name = eventName;
      github.ref = "refs/heads/main";
      expect(Boolean(expression(ci.jobs.policy.if, github))).toBe(true);
      expect(Boolean(expression(ci.jobs.ci.if, github))).toBe(true);
      expect(expression(ci.jobs.ci.name, github)).toBe("ci");
      expect(group(github)).toBe(eventName === "workflow_dispatch" ? "ci-run-2743" : "ci-refs/heads/main");
    },
  );

  it("classifies the new event base with its trusted script in a real process", () => {
    const directory = mkdtempSync(join(tmpdir(), "njpbs-ci-base-edit-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    try {
      git("init", "-q");
      git("config", "user.name", "Fixture Author");
      git("config", "user.email", "fixture-author@example.org");
      mkdirSync(join(directory, ".github/scripts"), { recursive: true });
      const script = join(directory, ".github/scripts/ci-classifier.mjs");
      writeFileSync(
        script,
        readFileSync(
          new URL("../../.github/scripts/ci-classifier.mjs", import.meta.url),
        ),
      );
      git("add", ".");
      git("commit", "-qm", "Old base");
      const oldBase = git("rev-parse", "HEAD");
      mkdirSync(join(directory, "admin"));
      writeFileSync(join(directory, "admin/app.ts"), "export {};\n");
      git("add", ".");
      git("commit", "-qm", "New base contains Admin change");
      const newBase = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", newBase);
      writeFileSync(join(directory, "README.md"), "Docs change\n");
      git("add", ".");
      git("commit", "-qm", "PR docs change");
      const github = eventContext("edited", {
        base: { ref: { from: "old-target" }, sha: { from: oldBase } },
      });
      github.event.pull_request.base.sha = newBase;
      const prHead = git("rev-parse", "HEAD");
      github.event.pull_request.head = { sha: prHead };
      git("checkout", "-q", "--detach", newBase);
      git("merge", "-q", "--no-ff", prHead, "-m", "Tested merge");
      github.sha = git("rev-parse", "HEAD");
      expect(codeAdmitted(github)).toBe(true);
      // The checkout cannot replace the trusted classifier read from the new base.
      writeFileSync(
        script,
        'throw new Error("Untrusted checkout classifier executed");\n',
      );
      const step = ci.jobs.policy.steps.find(
        (item: { id?: string }) => item.id === "changes",
      );
      const outputPath = join(directory, "output.txt");
      const env = Object.fromEntries(
        Object.entries(step.env).map(([key, value]) => [
          key,
          expression(String(value), github),
        ]),
      );
      expect(env.BASE_SHA).toBe(newBase);
      expect(env.TRUSTED_SHA).toBe(newBase);
      expect(env.HEAD_REF).toBe(github.sha);
      expect(env.PR_HEAD_SHA).toBe(prHead);
      expect(env.PR_BASE_REF).toBe("main");
      const result = spawnSync("bash", ["-e", "-c", step.run], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          GITHUB_EVENT_NAME: "pull_request",
          RUNNER_TEMP: directory,
          GITHUB_WORKSPACE: directory,
          GITHUB_OUTPUT: outputPath,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(
        Object.fromEntries(
          readFileSync(outputPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.split("=")),
        ),
      ).toEqual({
        docs: "true",
        site: "false",
        admin: "false",
        firebase: "false",
        classification: "exact",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe("Main cancellation and identical-tree admission", () => {
  const main = { ...eventContext(""), event_name: "push", ref: "refs/heads/main" };
  const needsFor = (reused: string) => ({ policy: { result: "success", outputs: {
    reused, classifier_result: "success", docs: "true", site: "true", admin: "true", firebase: "true",
  } } });

  it("finishes active main proof and cancels superseded PR and queue runs", () => {
    for (const name of ["ci", "admin-ci", "firebase-ci"]) {
      const workflow = parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
      expect(expression(workflow.concurrency["cancel-in-progress"], main)).toBe(false);
      expect(expression(workflow.concurrency["cancel-in-progress"], eventContext("synchronize"))).toBe(true);
      expect(expression(workflow.concurrency["cancel-in-progress"], {
        event_name: "merge_group", ref: "refs/heads/gh-readonly-queue/main/a",
      })).toBe(true);
      expect(expression(workflow.concurrency["cancel-in-progress"], {
        ...main, event_name: "workflow_dispatch",
      })).toBe(true);
      expect(workflow.concurrency.queue).toBeUndefined();
    }
  });

  it("skips consumers only on a verified reuse result, and always reports ci on main", () => {
    for (const reused of ["true", "false", ""]) {
      const needs = needsFor(reused);
      for (const name of ["docs", "site", "admin", "firebase"]) {
        expect(Boolean(expression(ci.jobs[name].if, main, { needs }))).toBe(reused !== "true");
      }
      expect(Boolean(expression(ci.jobs.ci.if, main, { needs }))).toBe(true);
      expect(expression(ci.jobs.ci.name, main)).toBe("ci");
      const aggregate = ci.jobs.ci.steps.find((step: { name?: string }) => step.name === "Require every selected CI gate");
      expect(Boolean(expression(aggregate.if, main, { needs }))).toBe(reused !== "true");
    }
  });

  it("runs source scans before reuse lookup and gates all expensive policy steps on a miss", () => {
    const steps = ci.jobs.policy.steps;
    const reuseIndex = steps.findIndex((step: { id?: string }) => step.id === "reuse");
    expect(reuseIndex).toBeGreaterThan(steps.findIndex((step: { name?: string }) => step.name?.startsWith("Metered-API source scan")));
    expect(ci.jobs.policy.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    for (const step of steps.slice(reuseIndex + 1)) {
      expect(Boolean(expression(step.if, main, { steps: { reuse: { outputs: { reused: "true" } } } }))).toBe(false);
      expect(Boolean(expression(step.if, main, { steps: { reuse: { outputs: { reused: "false" } } } }))).toBe(true);
    }
  });

  it("requires successful policy, a main push and skipped consumers before reused ci passes", () => {
    const step = ci.jobs.ci.steps.find((item: { name?: string }) => item.name === "Report identical-tree CI success on this main SHA");
    const env = { ...process.env, EVENT: "push", REF: "refs/heads/main", POLICY: "success", DOCS: "skipped", SITE: "skipped", ADMIN: "skipped", FIREBASE: "skipped", SOURCE_RUN: "123" };
    const run = (patch: object) => spawnSync("bash", ["-e", "-c", step.run], { env: { ...env, ...patch }, encoding: "utf8" });
    expect(run({}).status).toBe(0);
    for (const patch of [{ EVENT: "pull_request" }, { REF: "refs/heads/develop" }, { POLICY: "failure" }, { SITE: "failure" }, { ADMIN: "cancelled" }]) {
      expect(run(patch).status).not.toBe(0);
    }
  });
});


describe("CI variable identity and manual isolation", () => {
  const main = { ...eventContext(""), event_name: "push", ref: "refs/heads/main" };

  it("isolates each manual run from main and from other manual runs, including reusable consumers", () => {
    for (const name of ["ci", "admin-ci", "firebase-ci"]) {
      const workflow = parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
      const manual = { ...main, event_name: "workflow_dispatch" };
      expect(group(manual, workflow)).not.toBe(group(main, workflow));
      expect(group(manual, workflow)).not.toBe(group({ ...manual, run_id: "other-run" }, workflow));
    }
  });

  it("captures a canonical digest of all variables before checkout and records only its digest as native proof", () => {
    const step = ci.jobs.policy.steps.find((item: { id?: string }) => item.id === "inputs");
    expect(step.env).toEqual({ CI_VARIABLES: "${{ toJSON(vars) }}" });
    const index = ci.jobs.policy.steps.indexOf(step);
    expect(index).toBeLessThan(ci.jobs.policy.steps.findIndex((item: { uses?: string }) => item.uses?.startsWith("actions/checkout@")));
    const directory = mkdtempSync(join(tmpdir(), "ci-input-identity-"));
    try {
      const hashes = [{ B: "two", A: "one" }, { A: "one", B: "two" }, { A: "changed", B: "two" }, { A: "one" }].map((variables, n) => {
        const output = join(directory, `out-${n}`);
        const result = spawnSync("bash", ["-e", "-c", step.run], { env: { ...process.env, CI_VARIABLES: JSON.stringify(variables), GITHUB_OUTPUT: output }, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("");
        const line = readFileSync(output, "utf8").trim();
        expect(line).toMatch(/^hash=[a-f0-9]{64}$/);
        return line;
      });
      expect(hashes[0]).toBe(hashes[1]);
      expect(hashes[0]).not.toBe(hashes[2]);
      expect(hashes[0]).not.toBe(hashes[3]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    const marker = ci.jobs.ci.steps.find((item: { name?: string }) => item.name?.startsWith("Full CI inputs "));
    expect(marker.name).toBe("Full CI inputs ${{ needs.policy.outputs.inputs_hash }}");
    for (const reused of ["false", "true"]) {
      const needs = { policy: { outputs: { reused } }, docs: { result: "success" }, site: { result: "success" }, admin: { result: "success" }, firebase: { result: "success" } };
      expect(Boolean(expression(marker.if, main, { needs }))).toBe(reused === "false");
      needs.site.result = "skipped";
      expect(Boolean(expression(marker.if, main, { needs }))).toBe(false);
    }
  });
});


describe("Admin boundary admission", () => {
  it("runs the boundary tests once and requires their shard before visual completion", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/admin-ci.yml", import.meta.url), "utf8"));
    const job = workflow.jobs["admin-visual"];
    const boundary = job.steps.find((step: { name?: string }) => step.name === "Admin boundary tests");
    const complete = job.steps.find((step: { id?: string }) => step.id === "complete");
    const admitted = job.strategy.matrix.shard.filter((shard: number) =>
      !boundary.if || expression(boundary.if, {}, { matrix: { shard } }));
    expect(admitted).toEqual([1]);
    expect(boundary.run).toContain("tests/preflight/admin-env-boundary.test.js");
    expect(boundary.run).toContain("tests/preflight/admin-e2e-local.test.js");
    expect(boundary.run).toContain("tests/preflight/admin-status-manifest.test.js");
    expect(job.steps.indexOf(boundary)).toBeLessThan(job.steps.indexOf(complete));
    expect(complete.if).toBeUndefined();
    const aggregate = workflow.jobs["admin-visual-complete"];
    expect(aggregate.needs).toContain("admin-visual");
    const requireShards = aggregate.steps[0];
    for (const [result, firstShard, status] of [
      ["success", "success", 0],
      ["failure", "success", 1],
      ["success", "failure", 1],
      ["success", "", 1],
    ] as const) {
      const outcome = spawnSync("bash", ["-e", "-c", requireShards.run], {
        encoding: "utf8",
        env: { ...process.env, RESULT: result, SHARD_1: firstShard, SHARD_2: "success", SHARD_3: "success", SHARD_4: "success" },
      });
      expect(outcome.status).toBe(status);
    }
  });
});

describe("Firebase preflight admission", () => {
  it("runs preflight once across the Functions shards and suppresses their lifecycle hooks", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/firebase-ci.yml", import.meta.url), "utf8"));
    const job = workflow.jobs.functions;
    const preflight = job.steps.find((step: { run?: string }) => step.run === "npm run test:preflight");
    const functions = job.steps.find((step: { name?: string }) => step.name === "Functions tests");
    const admitted = job.strategy.matrix.include.filter((matrix: { shard: number }) =>
      !preflight.if || expression(preflight.if, {}, { matrix })).map((matrix: { shard: number }) => matrix.shard);
    expect(admitted).toEqual([1]);
    expect(job.steps.indexOf(preflight)).toBeLessThan(job.steps.indexOf(functions));
    expect(functions.if).toBeUndefined();
    expect(functions.run).toContain("npm run --ignore-scripts test:functions");
    expect(functions.env.FUNCTIONS_JOB_PARTS).toBe("${{ matrix.parts }}");
    expect(job.name).toBe("functions (${{ matrix.shard }})");
    const workspace = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(workspace.scripts["pretest:functions"]).toBe("npm run test:preflight");
  });

  it("runs every part once and stops a job when its first part fails", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/firebase-ci.yml", import.meta.url), "utf8"));
    const job = workflow.jobs.functions;
    const functions = job.steps.find((step: { name?: string }) => step.name === "Functions tests");
    const command = `npm() {
      printf '%s %s\\n' "$VITEST_SHARD_ARGS" "$*"
      if [ "$VITEST_SHARD_ARGS" = "$FAIL_SHARD" ]; then return 23; fi
    }
    ${functions.run}`;
    const parts = job.strategy.matrix.include.flatMap((matrix: { shard: number; parts: string }) => {
      const run = (fail = "") => spawnSync("bash", ["-e", "-c", command], {
        env: { ...process.env, FAIL_SHARD: fail, FUNCTIONS_JOB_PARTS: String(expression(functions.env.FUNCTIONS_JOB_PARTS, {}, { matrix })) },
        encoding: "utf8",
      });
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stdout.trim().split("\n");
      const failed = run(lines[0].split(" ")[0]);
      expect(failed.status).toBe(23);
      expect(failed.stdout.trim()).toBe(lines[0]);
      return lines;
    });
    expect(parts.sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map(part => `--shard=${part}/8 run --ignore-scripts test:functions`));
  });
});
