import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { FUNCTION_SCHEDULES, functionTargets, cloudWakeFunctionPlan, assertCloudWakeRetired, assertCloudWakeSettings, explicitCloudWakeDecision, loadCloudWakeDeployment, assertFunctionsReady, assertSchedulesReady, listPages, deployFunctionTargets } from "../../scripts/deploy-cms-function-batches.mjs";
import { meteredOffenders, scanRepositorySourceFiles } from "../../.github/scripts/metered-api-scan.mjs";

describe("CMS function deployment completion", () => {
  it("lists every exported scheduled function for the Scheduler check", () => {
    const root = join(import.meta.dirname, "../..");
    const exported = [...readFileSync(join(root, "functions/index.js"), "utf8")
      .matchAll(/^lazyExport\("(\w+)", "\.\/([\w-]+)"(?:, "(\w+)")?/gm)];
    const scheduled = exported.filter(([, name, file, moduleName = name]) =>
      new RegExp(`^const ${moduleName} = onSchedule\\(`, "m").test(readFileSync(join(root, "functions", `${file}.js`), "utf8")))
      .map(([, name]) => name);
    expect(scheduled).toContain("onScheduledPublish");
    expect(scheduled.filter((name) => !FUNCTION_SCHEDULES.some((value) => value.name === name))).toEqual([]);
  });

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
    })).rejects.toThrow(/selected target's codebase only/);
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
  it("keeps every target once, in order, in one list", () => {
    const names = Array.from({ length: 23 }, (_, i) => `functions:handler${i}`);
    expect(functionTargets(names.join(",")).map((name) => `functions:${name}`)).toEqual(names);
    for (const invalid of ["", "functions:a,functions:a", "functions:a;exit", "storage", "functions:a,"]) {
      expect(() => functionTargets(invalid)).toThrow();
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
  it("retries a silent early exit or a nonzero exit until an explicit completion", async () => {
    for (const [code, output] of [[0, ""], [1, "Deploy complete!"]]) {
      const answers = [[code, output], [code, output], [0, "Deploy complete!"]];
      const launch = vi.fn(() => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        const [exit, text] = answers.shift();
        queueMicrotask(() => { child.stdout.emit("data", Buffer.from(text)); child.emit("close", exit); });
        return child;
      });
      const promise = deployFunctionTargets(["handler"], launch, "njpbs-site", {
        manifest: [{ name: "handler", region: "us-central1", platform: "gcfv2" }], request: async () => ({}), wait: async () => {},
      });
      await expect(promise).resolves.toBeUndefined();
      expect(launch).toHaveBeenCalledTimes(3);
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
    const promise = deployFunctionTargets(names, launch, "njpbs-site", {
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
    expect(run.wait.mock.calls).toEqual([[60_000]]);
  });
  it("retries expired builds of functions that are being created", async () => {
    // Firebase names the operation: "Failed to create function" for a new function.
    const created = recordings[1].replace("Failed to update function exampleFunctionD", "Failed to create function exampleFunctionD");
    const run = deployment([[1, created], [0, "Deploy complete!\n"]], ["health", ...failures[1]]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()[1]).toBe(failures[1].map(name => `functions:${name}`).join(","));
  });
  it("keeps deploying only the failed functions, paced to 5 min, until they complete", async () => {
    const run = deployment([...Array.from({ length: 5 }, () => [1, recordings[1]]), [0, "Deploy complete!\n"]], ["health", ...failures[1]]);
    await expect(run.promise).resolves.toBeUndefined();
    const failed = "functions:exampleFunctionB,functions:exampleFunctionC,functions:exampleFunctionD";
    expect(run.targets()).toEqual([`functions:health,${failed}`, ...Array(5).fill(failed)]);
    expect(run.wait.mock.calls).toEqual([[60_000], [120_000], [240_000], [300_000], [300_000]]);
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
  // One invocation carries the full set. Firebase updates every target, then
  // prints one failed-name summary for the whole set.
  const fullSet = [...Array.from({ length: 185 }, (_, i) => `handler${i}`), ...failures[1]];
  it("retries only the expired names after a full-set deployment", async () => {
    const run = deployment([[1, recordings[1]], [0, "Deploy complete!\n"]], fullSet);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual([
      fullSet.map(name => `functions:${name}`).join(","),
      failures[1].map(name => `functions:${name}`).join(","),
    ]);
  });
  it("fails closed once on a non-transient failure in a full-set deployment", async () => {
    const run = deployment([[1, recordings[1].replace("EXPIRED", "FAILURE")]], fullSet);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.targets()).toEqual([fullSet.map(name => `functions:${name}`).join(",")]);
    expect(run.wait).not.toHaveBeenCalled();
  });
  // Recorded from dev run 45429859229 (Nov. 24, 2026): Secret Manager answered 503 while Firebase
  // prepared the deploy, before any function was updated.
  const providerOutage = "i  functions: Loading and analyzing source code for codebase dev to determine what to deploy\n" +
    "\u2b22  extensions: Failed to fetch the list of extensions. Assuming for now that there are no existing extensions.\n" +
    "i  functions: Loaded environment variables from functions/.env.example-project\n\n" +
    "Error: Request to https://secretmanager.googleapis.com/v1/projects/example-project/secrets/EXAMPLE_SECRET " +
    "had HTTP Error: 503, Authentication backend unavailable.\n";
  it("deploys the same targets again after a Google API 5xx before any function result", async () => {
    const run = deployment([[1, providerOutage], [0, "Deploy complete!\n"]], fullSet);
    await expect(run.promise).resolves.toBeUndefined();
    const all = fullSet.map(name => `functions:${name}`).join(",");
    expect(run.targets()).toEqual([all, all]);
    expect(run.wait.mock.calls).toEqual([[60_000]]);
  });
  it("names what it waits for on each provider 5xx and never stops on one", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = deployment([...Array.from({ length: 3 }, () => [1, providerOutage]), [0, "Deploy complete!\n"]], fullSet);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.launch).toHaveBeenCalledTimes(4);
    expect(logs).toHaveBeenCalledWith(expect.stringMatching(
      /^Waiting 240 s for the provider, then deploying again \(attempt 4\): .*; last provider line: Error: Request to https:\/\/secretmanager\.googleapis\.com\/.* HTTP Error: 503, Authentication backend unavailable/));
    logs.mockRestore();
  });
  // Recorded from dev run 45504015954 (Nov. 24, 2026): seven Cloud Run services
  // failed on the regional CPU allocation while the mass update started revisions.
  it.each([
    "Could not create or update Cloud Run service videotranscriptworkerclaim, Container Healthcheck failed. Quota exceeded for total allowable CPU per project per region.\n",
    "Could not create or update Cloud Run service onvideosearchassetwrite, Container Healthcheck failed. Quota exceeded for total allowable memory per project per region.\n",
    "Error: Quota exceeded for a quota this test has never seen.\n",
    // Google's quota message format for the Cloud Run read and write limits the
    // same deploys exceeded (run.googleapis.com read_regional and write_regional).
    "Error: HTTP Error: 429, Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per region' of service 'run.googleapis.com'\n",
    "Error: HTTP Error: 429, Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per region' of service 'run.googleapis.com'\n",
  ])("retries a capacity, rate or unknown quota until the functions deploy: %s", async output => {
    const run = deployment([[1, output], [1, output], [0, "Deploy complete!\n"]], fullSet);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.launch).toHaveBeenCalledTimes(3);
    expect(run.wait.mock.calls).toEqual([[60_000], [120_000]]);
  });
  it("bounds both Functions deploy steps inside the firebase job's timeout", () => {
    // The retry has no count; the step timeouts are its ceiling, and a timed-out step fails
    // so the recovery steps run. 3 minutes cover the steps before and after (measured).
    const job = parse(readFileSync(new URL("../../.github/workflows/cms-staging-deploy.yml", import.meta.url), "utf8")).jobs.firebase;
    const steps = ["Deploy ordinary Functions before the preview pause", "Deploy Firebase rules, indexes, and functions"]
      .map(name => job.steps.find(item => item.name === name)["timeout-minutes"]);
    expect(steps.every(Number.isInteger)).toBe(true);
    expect(steps[0] + steps[1] + 3).toBeLessThanOrEqual(job["timeout-minutes"]);
  });
  it("retries a rate quota, which clears by itself", async () => {
    const rate = "Error: HTTP Error: 429, Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute'\n";
    const run = deployment([[1, rate], [0, "Deploy complete!\n"]], fullSet);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.launch).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["build", "functions: Finished running predeploy script.\nsrc/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n" +
      "Error: functions predeploy error: Command terminated with non-zero exit code 2\n"],
    ["build", recordings[1].replace("EXPIRED", "FAILURE")],
    ["config", "Error: Failed to load function definition from source: FirebaseError: Functions codebase could not be analyzed successfully.\n"],
    ["permission", providerOutage.replace("HTTP Error: 503, Authentication backend unavailable", "HTTP Error: 403, Permission denied")],
    ["permission", `${recordings[1]}Error: Permission denied\n`],
    ["quota", "Error: HTTP Error: 429, Quota exceeded for quota metric 'Functions' and limit 'Functions per project'\n"],
  ])("does not retry a permanent %s failure, and names it", async (kind, output) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = deployment([[1, output]], fullSet);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(run.wait).not.toHaveBeenCalled();
    expect(errors).toHaveBeenLastCalledWith(expect.stringContaining(`class ${kind}, attempt 1, last provider line: `));
    errors.mockRestore();
  });
  // Recorded from dev run 45562533334 (Nov. 25, 2026): 186 of 187 functions updated. One update was answered
  // without its service, and Cloud Scheduler then refused the empty URL that Firebase sent for it.
  const incompleteAnswer = readFileSync(new URL("./fixtures/function-incomplete-answer/attempt-1.txt", import.meta.url), "utf8");
  it("deploys the failed function again after the provider answers an update without its service", async () => {
    const run = deployment([[1, incompleteAnswer], [0, "Deploy complete!\n"]], ["onNavigationShareOwnerWrite", "onNoBuildPostConfirmationRecovery"]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual([
      "functions:onNavigationShareOwnerWrite,functions:onNoBuildPostConfirmationRecovery",
      "functions:onNoBuildPostConfirmationRecovery",
    ]);
    expect(run.wait.mock.calls).toEqual([[60_000]]);
  });
  it("ends when the same function's schedule URL is empty again after its retry", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = deployment([[1, incompleteAnswer], [1, incompleteAnswer]], ["onNavigationShareOwnerWrite", "onNoBuildPostConfirmationRecovery"]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenLastCalledWith(expect.stringContaining("class config, attempt 2, "));
    errors.mockRestore();
  });
  it("ends on an empty schedule URL of a function that the summary does not name", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = incompleteAnswer.replace("\tonNoBuildPostConfirmationRecovery(", "\tonNavigationShareOwnerWrite(");
    const run = deployment([[1, other]], ["onNavigationShareOwnerWrite", "onNoBuildPostConfirmationRecovery"]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
  it("ends on a refused request when no answer was incomplete, and names its line", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = incompleteAnswer.split("\n").filter(line => !line.includes("please re-deploy")).join("\n");
    const run = deployment([[1, refused]], ["onNavigationShareOwnerWrite", "onNoBuildPostConfirmationRecovery"]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenLastCalledWith(expect.stringMatching(/class config, .*; class from: Request to https:\/\/cloudscheduler\.googleapis\.com\//));
    errors.mockRestore();
  });
  it.each([
    ["config", "Error: Failed to load function definition from source: FirebaseError: Functions codebase could not be analyzed successfully.\n"],
    ["config", "Request to https://cloudfunctions.googleapis.com/v2/projects/njpbs-site/locations/us-central1/functions/onNoBuildPostConfirmationRecovery had HTTP Error: 400, Invalid value\n"],
    ["config", "Request to https://cloudscheduler.googleapis.com/v1/projects/njpbs-site/locations/us-central1/jobs/firebase-schedule-onNavigationShareOwnerWrite-us-central1 had HTTP Error: 400, Schedule or time zone is invalid.\n"],
    ["permission", "Error: Permission denied\n"],
  ])("keeps a permanent %s failure final beside an incomplete answer", async (kind, line) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = deployment([[1, incompleteAnswer + line]], ["onNavigationShareOwnerWrite", "onNoBuildPostConfirmationRecovery"]);
    await expect(run.promise).rejects.toThrow("did not confirm completion");
    expect(run.launch).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenLastCalledWith(expect.stringContaining(`class ${kind}, attempt 1, `));
    errors.mockRestore();
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
  ])("retries the whole attempt after an unknown or incomplete failed-function list", async output => {
    const run = deployment([[1, output], [0, "Deploy complete!\n"]], failures[0]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual(Array(2).fill(failures[0].map(name => `functions:${name}`).join(",")));
    expect(run.wait.mock.calls).toEqual([[60_000]]);
  });
  it("requires explicit deploy completion after an expired attempt", async () => {
    const run = deployment([[1, recordings[0]], [0, ""], [0, "Deploy complete!\n"]], failures[0]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.launch).toHaveBeenCalledTimes(3);
    expect(run.wait).toHaveBeenCalledTimes(2);
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
    expect(run.wait.mock.calls).toEqual([[60_000]]);
  });
  it("retries a refused invoker policy read that names another service, narrowed to the failed function", async () => {
    const refused = readFileSync(new URL("./fixtures/function-invoker-policy/attempt-1.txt", import.meta.url), "utf8")
      .replace("services/examplescheduledb", "services/examplescheduleda");
    const run = deployment([[1, refused], [0, "Deploy complete!\n"]], ["exampleScheduledA", "exampleScheduledB"]);
    await expect(run.promise).resolves.toBeUndefined();
    expect(run.targets()).toEqual(["functions:exampleScheduledA,functions:exampleScheduledB", "functions:exampleScheduledB"]);
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
