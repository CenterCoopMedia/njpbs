import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { relative } from "node:path";

const counters = [
  "cpu.max", "cpu.stat", "cpu.pressure", "io.pressure",
  "memory.current", "memory.peak", "memory.events", "memory.pressure",
];

function snapshot(phase, details = {}) {
  const cgroup = {};
  for (const counter of counters) {
    try {
      cgroup[counter] = readFileSync(`/sys/fs/cgroup/${counter}`, "utf8").trim();
    } catch (error) {
      // Hosted runners and local checks may not expose every cgroup v2 counter.
      cgroup[counter] = { unavailable: error.code };
    }
  }
  console.log(`Site resources: ${JSON.stringify({
    phase, at: new Date().toISOString(), ...details, cgroup,
  })}`);
}

// Opted into by Site CI only. No sampler, subprocess, or test-setting changes.
export default class SiteResourceReporter {
  slowest = [];

  onTestRunStart(specifications) {
    this.slowest = [];
    const project = specifications[0]?.project;
    const parallelism = availableParallelism();
    snapshot("start", {
      node: process.version,
      vitest: project?.vitest.version,
      hostLogicalCpus: cpus().length,
      availableParallelism: parallelism,
      configuredMaxWorkers: project?.config.maxWorkers ?? null,
      // The pinned Vitest 4.1.8 run-mode default; retain the version above.
      defaultRunWorkersEstimate: Math.max(parallelism - 1, 1),
      fileParallelism: project?.config.fileParallelism,
      files: specifications.length,
    });
  }

  onTestCaseResult(test) {
    const diagnostic = test.diagnostic();
    if (!diagnostic) return;
    const result = {
      file: relative(process.cwd(), test.module.moduleId),
      test: test.fullName,
      state: test.result().state,
      durationMs: diagnostic.duration,
    };
    this.slowest.push(result);
    this.slowest.sort((a, b) => b.durationMs - a.durationMs);
    this.slowest.length = Math.min(this.slowest.length, 10);
    if (result.state === "failed") snapshot("failure", result);
  }

  onTestRunEnd(_modules, errors, reason) {
    snapshot("end", { reason, unhandledErrors: errors.length, slowest: this.slowest });
  }
}
