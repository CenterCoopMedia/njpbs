import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { functionBatches, cloudWakeFunctionPlan, assertCloudWakeRetired, assertCloudWakeSettings, explicitCloudWakeDecision, loadCloudWakeDeployment, assertFunctionsReady, assertSchedulesReady, listPages, deployBatch } from "../../scripts/deploy-cms-function-batches.mjs";
import { meteredOffenders, scanRepositorySourceFiles } from "../../.github/scripts/metered-api-scan.mjs";

describe("CMS function deployment completion", () => {
  it("selects enabled wake exports and requires explicit deletion before an inactive deployment", () => {
    const wakes = ["onNoBuildCloudState", "onNoBuildCloudCandidate", "onNoBuildCloudRelease"];
    const targets = ["health", ...wakes].map((name) => `functions:${name}`).join(",");
    expect(cloudWakeFunctionPlan(targets, { enabled: true }).names).toEqual(["health", ...wakes]);
    const inactive = cloudWakeFunctionPlan(targets, { enabled: false });
    expect(inactive.names).toEqual(["health"]);
    expect(inactive.retired).toEqual(wakes);
    expect(() => assertCloudWakeRetired(inactive.retired, [{ name: `functions/${wakes[0]}`, state: "ACTIVE" }])).toThrow("must be retired");
    expect(() => assertCloudWakeRetired(inactive.retired, [{ name: "functions/health" }])).not.toThrow();
    expect(() => cloudWakeFunctionPlan("functions:health", { enabled: true })).toThrow("missing");
    expect(explicitCloudWakeDecision({
      CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "development",
      CLOUD_PUBLICATION_WAKE_ENABLED: "false",
    })).toEqual({ environment: "development", enabled: false });
    expect(() => explicitCloudWakeDecision({})).toThrow(/explicit cloud wake/i);
    const wakeFunction = (name, patch = {}) => ({
      name: `projects/njpbs-site/locations/us-central1/functions/${name}`,
      state: "ACTIVE",
      serviceConfig: {
        minInstanceCount: 0,
        maxInstanceCount: 2,
        secretEnvironmentVariables: [{ key: "CMS_PUBLICATION_WAKE_TOKEN" }],
        ...patch,
      },
    });
    expect(() => assertCloudWakeSettings(wakes.map((name) => wakeFunction(name)))).not.toThrow();
    expect(() => assertCloudWakeSettings(wakes.map((name, index) => wakeFunction(name, index === 0 ? { maxInstanceCount: 3 } : {})))).toThrow(/settings are invalid/);
    expect(() => assertCloudWakeSettings(wakes.map((name, index) => wakeFunction(name, index === 0 ? { secretEnvironmentVariables: [] } : {})))).toThrow(/settings are invalid/);
  });

  it("requires current configuration and the approved production codebase", async () => {
    await expect(loadCloudWakeDeployment({})).rejects.toThrow("inputs are required");
    const root = mkdtempSync(join(tmpdir(), "cloud-wake-batch-"));
    const readerPath = join(root, "reader.js");
    const preparePath = join(root, "prepare.mjs");
    writeFileSync(readerPath, "");
    writeFileSync(preparePath, "");
    const env = { CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "production", CLOUD_PUBLICATION_WAKE_ENABLED: "true" };
    await expect(loadCloudWakeDeployment({
      env: { CLOUD_PUBLICATION_WAKE_ENVIRONMENT: "development", CLOUD_PUBLICATION_WAKE_ENABLED: "true" },
      readerPath, preparePath, prepare: async () => {}, read: () => ({ enabled: true, environment: "development" }),
    })).rejects.toThrow(/production codebase only/);
    const loaded = await loadCloudWakeDeployment({
      env, readerPath, preparePath,
      prepare: async (decision) => { expect(decision).toEqual({ environment: "production", enabled: true }); },
      read: () => ({ enabled: true, environment: "production" }),
    });
    expect(loaded).toMatchObject({ enabled: true, projectId: "njpbs-site" });
    rmSync(root, { recursive: true, force: true });
  });
  it("scans the staged current helper when the bootstrap checkout is excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "cms-deploy-scan-"));
    try {
      const bootstrap = join(root, ".metered-api-gate/scripts");
      mkdirSync(bootstrap, { recursive: true });
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(bootstrap, "deploy-cms-function-batches.mjs"), `fetch("https://${["api", "openai", "com"].join(".")}/v1/responses");`);
      cpSync(join(bootstrap, "deploy-cms-function-batches.mjs"), join(root, "scripts/cms-function-deploy-runner.mjs"));
      const scanned = scanRepositorySourceFiles(root, [".metered-api-gate"]);
      expect(scanned).toEqual(["scripts/cms-function-deploy-runner.mjs"]);
      expect(meteredOffenders(root, scanned)).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("bounds deployments to ten functions and preserves each target once", () => {
    const names = Array.from({ length: 23 }, (_, i) => `functions:handler${i}`);
    const batches = functionBatches(names.join(","));
    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(batches.flat().map((name) => `functions:${name}`)).toEqual(names);
    for (const invalid of ["", "functions:a,functions:a", "functions:a;exit", "storage", "functions:a,"]) {
      expect(() => functionBatches(invalid)).toThrow();
    }
  });
  it("rejects a missing or non-active function despite successful CLI exit", () => {
    const fn = { name: "projects/njpbs-site/locations/us-central1/functions/onVideoClipTick", state: "ACTIVE", buildConfig: { entryPoint: "onVideoClipTick" } };
    expect(() => assertFunctionsReady(["onVideoClipTick"], [fn])).not.toThrow();
    expect(() => assertFunctionsReady(["onVideoClipTick", "onVideoTranscriptTick"], [fn])).toThrow();
    expect(() => assertFunctionsReady(["onVideoClipTick"], [{ ...fn, state: "FAILED" }])).toThrow();
  });
  it("requires an enabled authenticated minute schedule for each exported video worker", () => {
    const job = { name: "jobs/firebase-schedule-onVideoClipTick-us-central1", state: "ENABLED", timeZone: "UTC", schedule: "* * * * *", httpTarget: { uri: "https://clip.example.invalid", httpMethod: "POST", oidcToken: { serviceAccountEmail: "scheduler@example.invalid" } } };
    const functions = [{ name: "functions/onVideoClipTick", serviceConfig: { uri: "https://clip.example.invalid" } }];
    expect(() => assertSchedulesReady(["onVideoClipTick"], [job], functions)).not.toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick"], [{ ...job, schedule: "every 1 minutes" }], functions)).not.toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick"], [{ ...job, schedule: "every 5 minutes" }], functions)).toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick", "onVideoTranscriptTick"], [job], functions)).toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick"], [{ ...job, state: "PAUSED" }], functions)).toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick"], [{ ...job, httpTarget: {} }], functions)).toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick"], [job], [{ ...functions[0], serviceConfig: { uri: "https://wrong.example.invalid" } }])).toThrow();
    expect(() => assertSchedulesReady(["onVideoClipTick"], [{ ...job, httpTarget: { ...job.httpTarget, uri: "https://us-central1-njpbs-site.cloudfunctions.net/onVideoClipTick" } }], functions)).not.toThrow();
    expect(() => assertSchedulesReady(["health"], [], [])).not.toThrow();
  });
  it("requires the replacement worker's minute scheduler with no retries", () => {
    const require = createRequire(import.meta.url);
    const trigger = require("../../functions/source-video-replacement.js").onSourceVideoReplacementTick.__endpoint.scheduleTrigger;
    expect(trigger).toMatchObject({ schedule: "every 1 minutes", retryConfig: { retryCount: 0 } });
    const name = "onSourceVideoReplacementTick";
    const job = { name: `jobs/firebase-schedule-${name}-us-central1`, state: "ENABLED", timeZone: "UTC", schedule: "* * * * *",
      httpTarget: { uri: "https://replacement.example.invalid", httpMethod: "POST", oidcToken: { serviceAccountEmail: "scheduler@example.invalid" } } };
    const functions = [{ name: `functions/${name}`, serviceConfig: { uri: job.httpTarget.uri } }];
    for (const schedule of ["* * * * *", "every 1 minutes"]) {
      expect(() => assertSchedulesReady([name], [{ ...job, schedule }], functions)).not.toThrow();
    }
    for (const invalid of [undefined, { ...job, state: "PAUSED" }, { ...job, schedule: "every 5 minutes" },
      { ...job, timeZone: "America/New_York" }, { ...job, httpTarget: { ...job.httpTarget, uri: "https://other.example.invalid" } },
      { ...job, retryConfig: { retryCount: 1 } }, { ...job, retryConfig: { retryCount: 0, maxRetryDuration: "60s" } }]) {
      expect(() => assertSchedulesReady([name], invalid ? [invalid] : [], functions)).toThrow();
    }
  });
  it("accepts only an optional root slash on the exact Cloud Run scheduler target", () => {
    const name = "onVideoTranscriptByokTick";
    const serviceUri = "https://onvideotranscriptbyoktick-example-uc.a.run.app";
    const job = { name: `jobs/firebase-schedule-${name}-us-central1`, state: "ENABLED", timeZone: "UTC", schedule: "every 1 minutes", httpTarget: { uri: serviceUri, httpMethod: "POST", oidcToken: { serviceAccountEmail: "scheduler@example.invalid" } } };
    const check = (target, deployed = serviceUri) => assertSchedulesReady([name],
      [{ ...job, httpTarget: { ...job.httpTarget, uri: target } }],
      [{ name: `functions/${name}`, serviceConfig: { uri: deployed } }]);
    for (const deployed of [serviceUri, `${serviceUri}/`]) {
      for (const target of [serviceUri, `${serviceUri}/`]) expect(() => check(target, deployed)).not.toThrow();
    }
    for (const target of [
      `${serviceUri}//`, `${serviceUri}/path`, `${serviceUri}/?q=1`, `${serviceUri}?q=1`,
      `${serviceUri}/#fragment`, `${serviceUri}#fragment`, `${serviceUri}:443/`,
      serviceUri.replace("https:", "http:"), serviceUri.replace("onvideotranscriptbyoktick", "another"),
      serviceUri.replace("https://", "https://user@"), `${serviceUri}.example.invalid/`,
    ]) expect(() => check(target)).toThrow();
    for (const deployed of [`${serviceUri}/path`, `${serviceUri}?q=1`, `${serviceUri}#fragment`,
      "https://other.example.invalid", `https://us-central1-njpbs-site.cloudfunctions.net/${name}`]) {
      expect(() => check(`${deployed}/`, deployed)).toThrow();
    }
  });
  it("checks every inventory page and rejects a repeated token", async () => {
    const request = vi.fn().mockResolvedValueOnce({ functions: [1], nextPageToken: "next" }).mockResolvedValueOnce({ functions: [2] });
    expect(await listPages(request, "https://example.invalid", "functions")).toEqual([1, 2]);
    expect(request.mock.calls[1][1]).toBe("next");
    await expect(listPages(async () => ({ nextPageToken: "same" }), "url", "functions")).rejects.toThrow("Repeated");
  });
  it("rejects silent early exit and nonzero exit, accepts an explicit completion", async () => {
    for (const [code, output, accepted] of [[0, "", false], [1, "Deploy complete!", false], [0, "Deploy complete!", true]]) {
      const launch = () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.emit("close", code); });
        return child;
      };
      const promise = deployBatch(["handler"], launch, "njpbs-site", {
        manifest: [{ name: "handler", region: "us-central1", platform: "gcfv2" }], request: async () => ({}),
      });
      if (accepted) await expect(promise).resolves.toBeUndefined();
      else await expect(promise).rejects.toThrow("did not confirm");
    }
  });
});

describe("CMS function build queue expiry recovery", () => {
  // Synthetic Firebase diagnostics preserve the error format across three
  // attempts, including multiple failures and unrelated progress lines.
  const recordings = [1, 2, 3].map(attempt => readFileSync(new URL(`./fixtures/function-build-expiry/attempt-${attempt}.txt`, import.meta.url), "utf8"));
  const failures = [
    ["exampleFunctionA"],
    ["exampleFunctionB", "exampleFunctionC", "exampleFunctionD"],
    ["exampleFunctionE"],
  ];
  function deployment(outputs, names, request = vi.fn().mockResolvedValue({})) {
    const launch = vi.fn(() => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      const [code, output] = outputs.shift();
      queueMicrotask(() => {
        // Process streams can split both diagnostics and ANSI escapes.
        for (let i = 0; i < output.length; i += 17) child.stderr.emit("data", Buffer.from(output.slice(i, i + 17)));
        child.emit("close", code);
      });
      return child;
    });
    const wait = vi.fn().mockResolvedValue();
    const promise = deployBatch(names, launch, "njpbs-site", {
      manifest: names.map(name => ({ name, region: "us-central1", platform: "gcfv2" })), request, wait,
    });
    const targets = () => launch.mock.calls.map(([, args]) => args[args.indexOf("--only") + 1]);
    return { promise, launch, wait, request, targets };
  }
  it.each([0, 1, 2])("retries only the failed names from recorded attempt %i, then completes", async index => {
    const names = ["health", ...failures[index]];
    const recorded = recordings[index].replaceAll("EXPIRED", "\x1b[31mEXPIRED\x1b[0m");
    const run = deployment([[1, recorded], [0, "Deploy complete!\n"]], names);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual([
      names.map(name => `functions:${name}`).join(","),
      failures[index].map(name => `functions:${name}`).join(","),
    ]);
    expect(run.wait.mock.calls).toEqual([[10_000]]);
  });
  it("retries expired builds of functions that are being created", async () => {
    // Firebase names the operation: "Failed to create function" for a new function.
    const created = recordings[1].replace("Failed to update function exampleFunctionD", "Failed to create function exampleFunctionD");
    const run = deployment([[1, created], [0, "Deploy complete!\n"]], ["health", ...failures[1]]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()[1]).toBe(failures[1].map(name => `functions:${name}`).join(","));
  });
  it("fails after three expired attempts without redeploying successful functions", async () => {
    const run = deployment(Array.from({ length: 3 }, () => [1, recordings[1]]), ["health", ...failures[1]]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.targets()).toEqual([
      "functions:health,functions:exampleFunctionB,functions:exampleFunctionC,functions:exampleFunctionD",
      "functions:exampleFunctionB,functions:exampleFunctionC,functions:exampleFunctionD",
      "functions:exampleFunctionB,functions:exampleFunctionC,functions:exampleFunctionD",
    ]);
    expect(run.wait.mock.calls).toEqual([[10_000], [10_000]]);
  });
  it("narrows the next retry again when some failed functions recover", async () => {
    const remaining = recordings[0].replaceAll("exampleFunctionA", "exampleFunctionB");
    const run = deployment([[1, recordings[1]], [1, remaining], [0, "Deploy complete!\n"]], ["health", ...failures[1]]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual([
      "functions:health,functions:exampleFunctionB,functions:exampleFunctionC,functions:exampleFunctionD",
      "functions:exampleFunctionB,functions:exampleFunctionC,functions:exampleFunctionD",
      "functions:exampleFunctionB",
    ]);
  });
  it("does not retry a non-transient build failure", async () => {
    const run = deployment([[1, recordings[0].replace("EXPIRED", "FAILURE")]], failures[0]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(run.wait).not.toHaveBeenCalled();
  });
  it.each([
    recordings[1].replace("EXPIRED", "FAILURE"),
    `${recordings[1]}Error: Permission denied\n`,
  ])("does not retry mixed transient and non-transient errors", async output => {
    const run = deployment([[1, output]], failures[1]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(run.wait).not.toHaveBeenCalled();
  });
  it.each([
    recordings[0].replace("\texampleFunctionA", "\totherFunction"),
    recordings[0].replace("\texampleFunctionA(us-central1)", "\texampleFunctionA(us-east1)"),
    recordings[0].replace("Functions deploy had errors with the following functions:\n", ""),
    recordings[0].replace("\texampleFunctionA(us-central1)\n", ""),
    recordings[0].replace("\texampleFunctionA(us-central1)\n", "\texampleFunctionA(us-central1)\n\texampleFunctionA(us-central1)\n"),
  ])("does not retry an unknown or incomplete failed-function list", async output => {
    const run = deployment([[1, output]], failures[0]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(run.wait).not.toHaveBeenCalled();
  });
  it("requires explicit deploy completion after an expired attempt", async () => {
    const run = deployment([[1, recordings[0]], [0, ""]], failures[0]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(2);
    expect(run.wait).toHaveBeenCalledTimes(1);
  });
  it("rechecks the live inventory before a retry can force a deployment", async () => {
    // The first attempt reads v1 and v2; the next inventory exposes a
    // same-name Firebase group that --force would delete.
    const request = vi.fn().mockResolvedValue({}).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({ functions: [{
      name: "projects/njpbs-site/locations/us-central1/functions/exampleFunctionA-retired",
    }] });
    const run = deployment([[1, recordings[0]]], failures[0], request);
    await expect(run.promise).rejects.toThrow("delete or rename");
    expect(run.launch).toHaveBeenCalledTimes(1);
  });
  it("retries a function whose invoker policy read was refused after its update", async () => {
    // Synthetic invoker-policy refusal after a function update.
    const refused = readFileSync(new URL("./fixtures/function-invoker-policy/attempt-1.txt", import.meta.url), "utf8");
    const names = ["exampleScheduledA", "exampleScheduledB"];
    const run = deployment([[1, refused], [0, "Deploy complete!\n"]], names);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual([
      "functions:exampleScheduledA,functions:exampleScheduledB",
      "functions:exampleScheduledB",
    ]);
    expect(run.wait.mock.calls).toEqual([[10_000]]);
  });
  it("does not retry a refused invoker policy read that names another service", async () => {
    const refused = readFileSync(new URL("./fixtures/function-invoker-policy/attempt-1.txt", import.meta.url), "utf8")
      .replace("services/examplescheduledb", "services/examplescheduleda");
    const run = deployment([[1, refused]], ["exampleScheduledA", "exampleScheduledB"]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(run.wait).not.toHaveBeenCalled();
  });
});

describe("election results scheduler deployment metadata", () => {
  it("exports the approved twice-daily schedule through the scheduler SDK", () => {
    const require = createRequire(import.meta.url);
    const trigger = require("../../functions/election-results-sources.js").onElectionResultsSourcePoll.__endpoint.scheduleTrigger;
    expect(trigger.schedule).toBe("0 8,20 * * *");
    expect(trigger.timeZone).toBe("America/New_York");
  });
});

describe("cost ledger scheduler verification", () => {
  const name = "onCostLedgerRefresh";
  const functions = [{ name: `functions/${name}`, serviceConfig: { uri: "https://cost.example.invalid" } }];
  const job = { name: `jobs/firebase-schedule-${name}-us-central1`, state: "ENABLED",
    schedule: "0 8 * * 1", timeZone: "America/New_York",
    httpTarget: { uri: "https://cost.example.invalid", httpMethod: "POST", oidcToken: { serviceAccountEmail: "scheduler@example.invalid" } } };
  it("accepts the weekly New York schedule", () => {
    expect(() => assertSchedulesReady([name], [job], functions)).not.toThrow();
  });
  it.each([undefined, { ...job, state: "PAUSED" }, { ...job, schedule: "* * * * *" },
    { ...job, timeZone: "UTC" }, { ...job, httpTarget: { ...job.httpTarget, httpMethod: "GET" } },
    { ...job, httpTarget: { ...job.httpTarget, oidcToken: {} } },
  ])("rejects missing or invalid job metadata", (invalid) => {
    expect(() => assertSchedulesReady([name], invalid ? [invalid] : [], functions)).toThrow();
  });
});

describe("save warmer scheduler verification", () => {
  const name = "onCmsSaveWarmup";
  const functions = [{ name: `functions/${name}`, serviceConfig: { uri: "https://warm.example.invalid" } }];
  const job = { name: `jobs/firebase-schedule-${name}-us-central1`, state: "ENABLED",
    schedule: "*/5 9-20 * * *", timeZone: "America/New_York", retryConfig: { retryCount: 0, maxRetryDuration: "0s" },
    httpTarget: { uri: "https://warm.example.invalid", httpMethod: "POST", oidcToken: { serviceAccountEmail: "scheduler@example.invalid" } } };
  it("accepts the daily Eastern schedule with explicit or omitted zero retry defaults", () => {
    for (const retryConfig of [undefined, {}, job.retryConfig, { retryCount: 0, maxRetryDuration: "0.000000000s" }]) {
      expect(() => assertSchedulesReady([name], [{ ...job, retryConfig }], functions)).not.toThrow();
    }
  });
  it.each([undefined, { ...job, state: "PAUSED" }, { ...job, schedule: "*/5 9-20 * * 1-5" },
    { ...job, timeZone: "UTC" }, { ...job, httpTarget: { ...job.httpTarget, uri: "https://wrong.example.invalid" } },
    { ...job, httpTarget: { ...job.httpTarget, httpMethod: "GET" } },
    { ...job, httpTarget: { ...job.httpTarget, oidcToken: {} } },
    { ...job, retryConfig: { retryCount: 1, maxRetryDuration: "0s" } },
    { ...job, retryConfig: { retryCount: 0, maxRetryDuration: "60s" } },
  ])("rejects missing, paused, misdirected or retrying job metadata", (invalid) => {
    expect(() => assertSchedulesReady([name], invalid ? [invalid] : [], functions)).toThrow();
  });
});
