import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";
import {
  MAX_CLOCK_UNCERTAINTY_MS,
  OBSERVED_STATUS_CODES,
  aggregateConfigFingerprint,
  easternTimestamp,
  estimateRemoteClockOffset,
  evaluateAggregateBuildWindow,
  evaluateAggregateProgress,
  evaluatePostProgress,
  matchesAggregateResponse,
  matchesAliasResponse,
  matchesPostResponse,
  sealReceipt,
  validateConfig,
  validateBaselineReceipt,
  writeJsonReceipt,
} from "./probe-core.mjs";
import { nextPollWakeTime, remoteRunnerSource, runBaseline, runProbe } from "./probe.mjs";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/recorded-responses.json", import.meta.url), "utf8"));
const startAtUtc = "2026-10-09T12:00:00.000Z";

function at(sample, index, elapsedMs) {
  return {
    ...sample,
    index,
    atUtc: new Date(Date.parse(startAtUtc) + elapsedMs).toISOString(),
    elapsedMsFromStart: elapsedMs,
  };
}

function repeated(sample, startIndex, firstElapsedMs, count, spacingMs = 1_000) {
  return Array.from({ length: count }, (_, offset) => at(sample, startIndex + offset, firstElapsedMs + offset * spacingMs));
}

function aggregateReceipt(targets) {
  return {
    schemaVersion: 1,
    receiptType: "njpbs-no-build-trial-measurement",
    startAtUtc,
    decisions: { detailPass: true, aggregateConvergencePass: true },
    vantages: [{ name: "local-probe", aggregates: { targets: structuredClone(targets) } }],
  };
}

test("post matching needs the expected operation, version, digest and current bytes", () => {
  const expected = fixtures.expectedPost;
  assert.equal(matchesPostResponse(fixtures.post.currentPlain, expected), true);
  assert.equal(matchesPostResponse(fixtures.post.currentCached, expected), true);
  assert.equal(matchesPostResponse(fixtures.post.staleCached, expected), false);
  assert.equal(matchesPostResponse(fixtures.post.currentBodyMismatch, expected), false);
  assert.equal(matchesPostResponse(fixtures.post.currentJsonReceipt, expected), true);
  assert.equal(matchesPostResponse(fixtures.post.gone, expected), false);
  assert.equal(matchesPostResponse(fixtures.post.unavailable, expected), false);
  assert.deepEqual(OBSERVED_STATUS_CODES, [200, 308, 410, 503]);
});

test("unique-query diagnostics do not replace the first plain response or its confirmations", () => {
  const post = {
    canonical: {
      url: fixtures.post.canonicalUrl,
      samples: [
        at(fixtures.post.staleCached, 0, 3_000),
        at(fixtures.post.currentUniqueQuery, 1, 10_000),
        at(fixtures.post.currentPlain, 2, 15_000),
        at(fixtures.post.currentCached, 3, 16_000),
        ...repeated(fixtures.post.currentCached, 4, 17_000, 2),
      ],
    },
    aliases: [],
  };
  const result = evaluatePostProgress(post, fixtures.expectedPost, 3);
  assert.equal(result.canonical.firstExpectedElapsedMs, 15_000);
  assert.equal(result.canonical.confirmations, 3);
  assert.equal(result.pass, true);
});

test("the next N plain responses must stay current, and the first match must meet 20 seconds", () => {
  const staleAfterMatch = {
    canonical: {
      url: fixtures.post.canonicalUrl,
      samples: [
        at(fixtures.post.currentPlain, 0, 15_000),
        at(fixtures.post.currentPlain, 1, 16_000),
        at(fixtures.post.currentBodyMismatch, 2, 17_000),
      ],
    },
    aliases: [],
  };
  const regressed = evaluatePostProgress(staleAfterMatch, fixtures.expectedPost, 3);
  assert.equal(regressed.canonical.regressions, 1);
  assert.equal(regressed.pass, false);

  const late = {
    canonical: {
      url: fixtures.post.canonicalUrl,
      samples: [
        at(fixtures.post.currentPlain, 0, 21_000),
        ...repeated(fixtures.post.currentPlain, 1, 22_000, 3),
      ],
    },
    aliases: [],
  };
  const lateResult = evaluatePostProgress(late, fixtures.expectedPost, 3);
  assert.equal(lateResult.stablePass, true);
  assert.equal(lateResult.timingPass, false);
  assert.equal(lateResult.pass, false);
});

test("network errors are recorded but do not count as stale responses", () => {
  const post = {
    canonical: {
      url: fixtures.post.canonicalUrl,
      samples: [
        at(fixtures.post.currentPlain, 0, 15_000),
        at(fixtures.post.networkError, 1, 16_500),
        ...repeated(fixtures.post.currentPlain, 2, 17_000, 3),
      ],
    },
    aliases: [],
  };
  const result = evaluatePostProgress(post, fixtures.expectedPost, 3);
  assert.equal(result.canonical.probeErrors, 1);
  assert.equal(result.canonical.confirmations, 3);
  assert.equal(result.canonical.regressions, 0);
  assert.equal(result.pass, true);
});

test("remote clock uncertainty is applied against the 20-second Post limit", () => {
  const post = {
    canonical: {
      url: fixtures.post.canonicalUrl,
      samples: [
        at(fixtures.post.currentPlain, 0, 19_500),
        ...repeated(fixtures.post.currentPlain, 1, 20_500, 3),
      ],
    },
    aliases: [],
  };
  const result = evaluatePostProgress(post, fixtures.expectedPost, 3, 600);
  assert.equal(result.canonical.firstExpectedElapsedMs, 19_500);
  assert.equal(result.conservativeFirstExpectedElapsedMs, 20_100);
  assert.equal(result.stablePass, true);
  assert.equal(result.timingPass, false);
  assert.equal(result.pass, false);
});

test("Post latency uses matching response-header time after the body is verified", () => {
  const first = at(fixtures.post.currentPlain, 0, 25_000);
  first.responseHeadersAtUtc = new Date(Date.parse(startAtUtc) + 19_500).toISOString();
  first.responseHeadersElapsedMsFromStart = 19_500;
  const post = {
    canonical: {
      url: fixtures.post.canonicalUrl,
      samples: [first, ...repeated(fixtures.post.currentPlain, 1, 26_000, 3)],
    },
    aliases: [],
  };
  const result = evaluatePostProgress(post, fixtures.expectedPost, 3);
  assert.equal(result.canonical.firstExpectedAtUtc, first.responseHeadersAtUtc);
  assert.equal(result.canonical.firstExpectedElapsedMs, 19_500);
  assert.equal(result.pass, true);
});

test("aliases must use a direct 308 to the canonical URL", () => {
  const aliasUrl = "https://njpbs.org/posts/old-pilot-slug/";
  assert.equal(matchesAliasResponse(fixtures.post.aliasDirect, fixtures.post.canonicalUrl, aliasUrl), true);
  assert.equal(matchesAliasResponse(fixtures.post.aliasChain, fixtures.post.canonicalUrl, aliasUrl), false);
});

test("recorded aggregate responses measure both inclusion and removal", () => {
  const included = fixtures.aggregates.contains.home;
  const includeResult = evaluateAggregateProgress(included, 3);
  assert.equal(includeResult.firstExpectedAtUtc, "2026-10-09T12:00:21.000Z");
  assert.equal(includeResult.lastNonmatchingAtUtc, "2026-10-09T12:00:02.000Z");
  assert.equal(includeResult.catchUpElapsedMs, 21_000);
  assert.equal(includeResult.pass, true);

  const omitted = fixtures.aggregates.omits.sitemap;
  const stalePresence = omitted.samples[0];
  const currentAbsence = omitted.samples[1];
  assert.equal(matchesAggregateResponse(stalePresence, omitted), false);
  assert.equal(matchesAggregateResponse(currentAbsence, omitted), true);
  assert.equal(evaluateAggregateProgress(omitted, 3).pass, true);
});

test("all four aggregates must catch up by the completed normal site build", () => {
  const targets = Object.fromEntries([
    ["home", fixtures.aggregates.contains.home],
    ["feeds", fixtures.aggregates.contains.feeds],
    ["sitemap", fixtures.aggregates.omits.sitemap],
    ["search", fixtures.aggregates.contains.search],
  ].map(([name, state]) => [name, evaluateAggregateProgress(state, 3)]));
  const receipt = aggregateReceipt(targets);
  const inWindow = evaluateAggregateBuildWindow(receipt, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(inWindow.pass, true);

  const slowBody = aggregateReceipt(targets);
  for (const target of Object.values(slowBody.vantages[0].aggregates.targets)) {
    target.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:18.000Z";
    target.firstExpectedHeadersAtUtc = "2026-10-09T12:00:19.500Z";
    target.firstExpectedAtUtc = "2026-10-09T12:00:19.900Z";
  }
  const headersArriveDuringBuild = evaluateAggregateBuildWindow(slowBody, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:20.000Z",
  });
  assert.equal(headersArriveDuringBuild.pass, true);
  assert.equal(headersArriveDuringBuild.targets.find(target => target.name === "home").catchUpEvidence,
    "observed-during-build");

  const staleRequestBound = aggregateReceipt(targets);
  const staleHome = staleRequestBound.vantages[0].aggregates.targets.home;
  staleHome.lastNonmatchingAtUtc = "2026-10-09T12:00:02.000Z";
  staleHome.lastNonmatchingRequestStartedAtUtc = "2026-10-09T12:00:01.000Z";
  staleHome.firstExpectedHeadersAtUtc = "2026-10-09T12:00:21.000Z";
  const staleBoundWindow = evaluateAggregateBuildWindow(staleRequestBound, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(staleBoundWindow.targets.find(target => target.name === "home").measurementUncertaintyMs,
    20_000);

  const bodyCompletesAfterBuild = aggregateReceipt(targets);
  for (const target of Object.values(bodyCompletesAfterBuild.vantages[0].aggregates.targets)) {
    target.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:18.000Z";
    target.firstExpectedHeadersAtUtc = "2026-10-09T12:00:19.500Z";
    target.firstExpectedAtUtc = "2026-10-09T12:00:20.500Z";
  }
  const bodyAfterBuildWindow = evaluateAggregateBuildWindow(bodyCompletesAfterBuild, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:20.000Z",
  });
  assert.equal(bodyAfterBuildWindow.pass, false);

  for (const target of Object.values(receipt.vantages[0].aggregates.targets)) {
    target.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:18.000Z";
    target.firstExpectedHeadersAtUtc = "2026-10-09T12:00:21.000Z";
  }
  const responseArrivesJustAfterBuild = evaluateAggregateBuildWindow(receipt, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:20.000Z",
  });
  assert.equal(responseArrivesJustAfterBuild.pass, false);
  assert.equal(responseArrivesJustAfterBuild.targets.find(target => target.name === "home").catchUpEvidence,
    "outside-build-deadline");

  const baselineBound = aggregateReceipt(targets);
  baselineBound.vantages[0].polling = { aggregateIntervalMs: 17_000, requestTimeoutMs: 8_000 };
  for (const aggregate of Object.values(baselineBound.vantages[0].aggregates.targets)) {
    delete aggregate.lastNonmatchingAtUtc;
    aggregate.baselineLastObservedAtUtc = "2026-10-09T11:59:59.999Z";
    aggregate.baselineLastObservedRequestStartedAtUtc = "2026-10-09T11:59:59.000Z";
    aggregate.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:18.000Z";
    aggregate.firstExpectedHeadersAtUtc = "2026-10-09T12:00:19.500Z";
    aggregate.firstExpectedAtUtc = "2026-10-09T12:00:19.800Z";
  }
  const baselineWindow = evaluateAggregateBuildWindow(baselineBound, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:20.000Z",
  });
  assert.equal(baselineWindow.pass, true);
  assert.equal(baselineWindow.targets.find(target => target.name === "home").lastNonmatchingSource,
    "pre-operation-baseline");

  const noWindowOverlap = aggregateReceipt(targets);
  noWindowOverlap.vantages[0].aggregates.targets.home.lastNonmatchingAtUtc = "2026-10-09T12:00:20.500Z";
  const outside = evaluateAggregateBuildWindow(noWindowOverlap, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:20.000Z",
  });
  assert.equal(outside.targets.find(target => target.name === "home").caughtUpByBuildCompletion, false);
  assert.equal(outside.pass, false);

  const headersBeforeBuild = aggregateReceipt(targets);
  const home = headersBeforeBuild.vantages[0].aggregates.targets.home;
  home.firstExpectedAtUtc = "2026-10-09T12:00:04.500Z";
  home.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:02.000Z";
  home.firstExpectedHeadersAtUtc = "2026-10-09T12:00:04.000Z";
  home.lastNonmatchingAtUtc = "2026-10-09T12:00:01.000Z";
  home.lastNonmatchingRequestStartedAtUtc = "2026-10-09T12:00:00.500Z";
  const headerBeforeBuild = evaluateAggregateBuildWindow(headersBeforeBuild, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(headerBeforeBuild.targets.find(target => target.name === "home").caughtUpByBuildCompletion, true);
  assert.equal(headerBeforeBuild.targets.find(target => target.name === "home").catchUpEvidence, "observed-before-build");
  assert.equal(headerBeforeBuild.pass, true);

  const clockUncertain = aggregateReceipt(targets);
  clockUncertain.vantages[0].polling = {
    aggregateIntervalMs: 15_000,
    requestTimeoutMs: 8_000,
    clockUncertaintyMs: 1_000,
  };
  const uncertainHome = clockUncertain.vantages[0].aggregates.targets.home;
  uncertainHome.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:29.000Z";
  uncertainHome.firstExpectedHeadersAtUtc = "2026-10-09T12:00:29.500Z";
  uncertainHome.firstExpectedAtUtc = "2026-10-09T12:00:29.750Z";
  const uncertainWindow = evaluateAggregateBuildWindow(clockUncertain, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:20.001Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(uncertainWindow.targets.find(target => target.name === "home").caughtUpByBuildCompletion, false);
  assert.equal(uncertainWindow.pass, false);

  const buildAlreadyRunning = evaluateAggregateBuildWindow(receipt, {
    id: "normal-build-41",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T11:59:00.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(buildAlreadyRunning.pass, false);

  const caughtUpBeforeBuild = aggregateReceipt(targets);
  caughtUpBeforeBuild.vantages[0].aggregates.targets.home.firstExpectedAtUtc = "2026-10-09T12:00:04.000Z";
  caughtUpBeforeBuild.vantages[0].aggregates.targets.home.firstExpectedRequestStartedAtUtc = "2026-10-09T12:00:03.000Z";
  caughtUpBeforeBuild.vantages[0].aggregates.targets.home.firstExpectedHeadersAtUtc = "2026-10-09T12:00:04.000Z";
  const priorCatchup = evaluateAggregateBuildWindow(caughtUpBeforeBuild, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(priorCatchup.targets.find(target => target.name === "home").caughtUpByBuildCompletion, true);
  assert.equal(priorCatchup.targets.find(target => target.name === "home").catchUpEvidence, "observed-before-build");
  assert.equal(priorCatchup.pass, true);
  const missingAggregate = aggregateReceipt(targets);
  delete missingAggregate.vantages[0].aggregates.targets.search;
  const missingResult = evaluateAggregateBuildWindow(missingAggregate, {
    id: "normal-build-42",
    sourceSha: "a".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  });
  assert.equal(missingResult.targets.find(target => target.name === "search").caughtUpByBuildCompletion, false);
  assert.equal(missingResult.pass, false);
  assert.throws(() => evaluateAggregateBuildWindow(receipt, {
    id: "normal-build-42", sourceSha: "short", startedAt: "2026-10-09T12:00:05.000Z", completedAt: "2026-10-09T12:00:30.000Z",
  }), /40-character commit SHA/);
});

test("aggregate baseline must prove the opposite state before the operation", () => {
  const aggregates = [
    ["home", "https://njpbs.org/", "pilot-post-7", "contains"],
    ["feeds", "https://njpbs.org/feeds/news.xml", "pilot-post-7", "contains"],
    ["sitemap", "https://njpbs.org/sitemap-posts.xml", "pilot-post-7", "omits"],
    ["search", "https://njpbs.org/search/meaning-index.json", "pilot-post-7", "contains"],
  ].map(([name, url, needle, presence]) => ({ name, url, needle, presence }));
  const targets = Object.fromEntries(aggregates.map(aggregate => [aggregate.name, {
    name: aggregate.name,
    url: aggregate.url,
    needle: aggregate.needle,
    pass: true,
    complete: true,
    baselinePresence: aggregate.presence === "contains" ? "omits" : "contains",
    baselineLastObservedAtUtc: "2026-10-09T11:59:45.000Z",
    baselineLastObservedRequestStartedAtUtc: "2026-10-09T11:59:44.000Z",
  }]));
  const baseline = {
    schemaVersion: 1,
    receiptType: "njpbs-no-build-aggregate-baseline",
    aggregateConfigSha256: aggregateConfigFingerprint(aggregates),
    finishedAtUtc: "2026-10-09T11:59:50.000Z",
    vantages: [{ name: "local-probe", pass: true, targets }],
    pass: true,
  };
  assert.equal(validateBaselineReceipt(baseline, aggregates, startAtUtc, ["local-probe"]), true);
  assert.throws(() => validateBaselineReceipt({ ...baseline, pass: false }, aggregates, startAtUtc, ["local-probe"]), /did not pass/);
  assert.throws(() => validateBaselineReceipt({
    ...baseline,
    vantages: [{ ...baseline.vantages[0], targets: {
      ...targets,
      home: { ...targets.home, baselinePresence: "contains" },
    } }],
  }, aggregates, startAtUtc, ["local-probe"]), /home omits/);
  assert.throws(() => validateBaselineReceipt(baseline, aggregates, startAtUtc, ["local-probe", "remote-probe"]), /remote-probe/);
  assert.throws(() => validateBaselineReceipt(baseline, aggregates, "2026-10-09T11:59:45.000Z", ["local-probe"]), /finish before startAt/);
  assert.throws(() => validateBaselineReceipt({ ...baseline, finishedAtUtc: "2026-10-09T11:00:00.000Z" }, aggregates, startAtUtc, ["local-probe"]), /no more than 30 minutes/);
  assert.throws(() => validateBaselineReceipt({
    ...baseline,
    vantages: [{ ...baseline.vantages[0], targets: {
      ...targets,
      home: { ...targets.home, baselineLastObservedRequestStartedAtUtc: "2026-10-09T11:59:46.000Z" },
    } }],
  }, aggregates, startAtUtc, ["local-probe"]), /baseline observation times are invalid/);
  const baselineWithRemote = {
    ...baseline,
    vantages: [...baseline.vantages, { ...baseline.vantages[0], name: "remote-probe" }],
  };
  assert.throws(() => validateBaselineReceipt(baselineWithRemote, aggregates, startAtUtc,
    ["local-probe", "remote-probe"], ["remote-probe"]), /valid clock calibration/);
});

test("remote clock calibration records offset and round-trip uncertainty", () => {
  const calibration = estimateRemoteClockOffset(
    Date.parse("2026-10-09T12:00:00.500Z"),
    Date.parse("2026-10-09T12:00:00.000Z"),
    Date.parse("2026-10-09T12:00:01.000Z"),
  );
  assert.equal(calibration.remoteMinusOfficeMs, 0);
  assert.equal(calibration.uncertaintyMs, 500);
  assert.ok(calibration.uncertaintyMs <= MAX_CLOCK_UNCERTAINTY_MS);
  assert.throws(() => estimateRemoteClockOffset(NaN, 0, 1), /invalid/);
});

test("completed poll streams do not keep the loop wake time in the past", () => {
  assert.equal(nextPollWakeTime(true, 0, false, 30, 100), 30);
  assert.equal(nextPollWakeTime(false, 20, true, 0, 100), 20);
  assert.equal(nextPollWakeTime(true, 0, true, 0, 100), 100);
});

test("remote stdin runner has a valid handshake script without network access", () => {
  const source = remoteRunnerSource();
  assert.doesNotThrow(() => new vm.Script(source));
  assert.match(source, /READY\\n/);
  assert.match(source, /pingCount < 3/);
  assert.match(source, /process\.stderr\.write\(message/);
  assert.match(source, /process\.exitCode = 1/);
});

test("a trial receipt can be sealed only once with the first normal build identity", () => {
  const targets = Object.fromEntries([
    ["home", fixtures.aggregates.contains.home],
    ["feeds", fixtures.aggregates.contains.feeds],
    ["sitemap", fixtures.aggregates.omits.sitemap],
    ["search", fixtures.aggregates.contains.search],
  ].map(([name, state]) => [name, evaluateAggregateProgress(state, 3)]));
  const receipt = aggregateReceipt(targets);
  const build = {
    id: "normal-build-42",
    sourceSha: "b".repeat(40),
    startedAt: "2026-10-09T12:00:05.000Z",
    completedAt: "2026-10-09T12:00:30.000Z",
  };
  const sealed = sealReceipt(receipt, build);
  assert.equal(sealed.normalBuild.sourceSha, build.sourceSha);
  assert.equal(sealed.decisions.overallPass, true);
  assert.throws(() => sealReceipt(sealed, build), /already sealed/);
});

test("config requires public HTTPS targets and all aggregate families", () => {
  const config = {
    post: {
      canonicalUrl: "https://njpbs.org/posts/pilot-post-7/",
      aliases: [],
      ...fixtures.expectedPost,
    },
    aggregates: [
      ["home", "https://njpbs.org/"],
      ["feeds", "https://njpbs.org/feeds/news.xml"],
      ["sitemap", "https://njpbs.org/sitemap-index.xml"],
      ["search", "https://njpbs.org/search/meaning-index.json"],
    ].map(([name, url]) => ({ name, url, needle: "/posts/pilot-post-7/", presence: "contains" })),
  };
  assert.equal(validateConfig(config), config);
  assert.throws(() => validateConfig({ ...config, post: { ...config.post, canonicalUrl: "https://user:fixture-password@example.org/posts/pilot/" } }), /without credentials/);
  assert.throws(() => validateConfig({ ...config, aggregates: config.aggregates.slice(0, 3) }), /missing aggregate targets/);
  assert.throws(() => validateConfig({ ...config, aggregates: config.aggregates.map(target => target.name === "home" ? { ...target, url: "https://localhost/" } : target) }), /public internet hostname/);
});

test("Eastern timestamps include the daylight-saving timezone", () => {
  assert.equal(easternTimestamp(Date.parse("2026-10-09T12:00:00.000Z")), "2026-10-09T08:00:00.000 EDT");
});

test("JSON receipts are written atomically with restrictive file mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nobuild-receipt-"));
  try {
    const receiptPath = join(directory, "receipt.json");
    await writeJsonReceipt(receiptPath, { createdAtEastern: "2026-10-09T08:00:00.000 EDT", ok: true });
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.ok, true);
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("takeFlag returns the value after the flag and removes both", async () => {
  const { takeFlag } = await import("./probe.mjs");
  const args = ["--config", "trial.json", "--receipt", "run.json"];
  assert.equal(takeFlag(args, "--config"), "trial.json");
  assert.deepEqual(args, ["--receipt", "run.json"]);
  assert.equal(takeFlag(args, "--missing", "fallback"), "fallback");
  assert.throws(() => takeFlag(["--config", "--receipt"], "--config"), /requires a value/);
});

// The README requires absence on Home and transitions elsewhere.
function pilotAggregates(needle = "/posts/pilot-post-7/", presence = "contains") {
  return [
    ["home", "https://njpbs.org/"],
    ["feeds", "https://njpbs.org/feeds/news.xml"],
    ["sitemap", "https://njpbs.org/sitemap-posts.xml"],
    ["search", "https://njpbs.org/search/meaning-index.json"],
  ].map(([name, url]) => ({
    name, url, needle,
    presence: name === "home" ? "omits" : presence,
    ...(name === "home" ? { expectation: "unchanged" } : {}),
  }));
}

test("unchanged absence is explicit and restricted to Home", () => {
  const aggregates = pilotAggregates();
  const config = { post: { ...fixtures.expectedPost, canonicalUrl: fixtures.post.canonicalUrl, aliases: [] }, aggregates };
  assert.equal(validateConfig(config), config);
  for (const name of ["feeds", "sitemap", "search"]) {
    assert.throws(() => validateConfig({ ...config, aggregates: aggregates.map(target =>
      target.name === name ? { ...target, presence: "omits", expectation: "unchanged" } : target) }), /Only Home/);
  }
  assert.throws(() => validateConfig({ ...config, aggregates: aggregates.map(target =>
    target.name === "home" ? { ...target, presence: "contains" } : target) }), /Only Home/);
  assert.throws(() => validateConfig({ ...config, aggregates: aggregates.map(target =>
    target.name === "home" ? { ...target, expectation: "skip" } : target) }), /Only Home/);
  const transition = aggregates.map(({ expectation, ...target }) => target);
  assert.notEqual(aggregateConfigFingerprint(aggregates), aggregateConfigFingerprint(transition));
});

test("unchanged Home rejects appearance before, during and after absence confirmations", () => {
  const home = pilotAggregates()[0];
  const absent = { requestLabel: "plain", status: 200, containsNeedle: false };
  const samples = repeated(absent, 0, 2_000, 4);
  assert.equal(evaluateAggregateProgress({ ...home, samples }, 3).pass, true);
  assert.equal(evaluateAggregateProgress({ ...home, samples }, 3).catchUpElapsedMs, null);
  for (const index of [0, 2, 4]) {
    const withAppearance = [...samples];
    withAppearance.splice(index, 0, at({ ...absent, containsNeedle: true }, 10 + index, 1_000));
    const result = evaluateAggregateProgress({ ...home, samples: withAppearance }, 3);
    assert.equal(result.pass, false);
    assert.ok(result.regressions > 0);
  }
  assert.equal(evaluateAggregateProgress({ ...home, samples: repeated({ ...absent, status: 503 }, 0, 2_000, 4) }, 3).pass, false);
  assert.equal(evaluateAggregateProgress({ ...home, samples: repeated({ ...absent, requestLabel: "unique-query-diagnostic" }, 0, 2_000, 4) }, 3).pass, false);
});

test("publish and rename receipts retain unchanged Home, aggregate transitions and per-request cache evidence", async t => {
  // Only the clock and network boundaries are replaced. No request can reach production.
  let now = Date.parse(startAtUtc) - 60_000;
  t.mock.method(Date, "now", () => now++);
  const directory = await mkdtemp(join(tmpdir(), "nobuild-pilot-"));
  try {
    for (const operation of ["publish", "rename"]) {
      const needle = operation === "rename" ? "/posts/renamed-pilot-post-7/" : "/posts/pilot-post-7/";
      const aggregates = pilotAggregates(needle);
      const html = `<html><body>Exact pilot Post 7: ${operation}</body></html>`;
      const config = {
        post: { canonicalUrl: `https://njpbs.org${needle}`, aliases: operation === "rename" ? [fixtures.post.canonicalUrl] : [],
          publishedVersion: "7", operationId: "pilot-op-7", htmlSha256: createHash("sha256").update(html).digest("hex") },
        aggregates,
      };
      let phase = "baseline";
      let plainPostRequests = 0;
      t.mock.method(globalThis, "fetch", async input => {
        const url = new URL(input);
        const diagnostic = url.searchParams.has("__nobuild_probe");
        url.search = "";
        const aggregate = aggregates.find(target => target.url === url.href);
        if (aggregate) return new Response(phase === "baseline" || aggregate.name === "home" ? "<html>No pilot Post</html>" : needle);
        if (config.post.aliases.includes(url.href)) return new Response(null, { status: 308, headers: { location: config.post.canonicalUrl } });
        assert.equal(url.href, config.post.canonicalUrl);
        const renderCache = diagnostic ? "BYPASS" : plainPostRequests++ === 0 ? "MISS" : "HIT";
        return new Response(html, { headers: {
          "Content-Type": "text/html", "Cache-Control": "no-store", "X-Njpbs-Render-Cache": renderCache,
          "X-Njpbs-Source-Version": "7", "X-Njpbs-Publication-Operation": "pilot-op-7", "X-Njpbs-Html-Sha256": config.post.htmlSha256,
        } });
      });
      const results = [];
      const baselines = [];
      for (const vantage of ["local-probe", "remote-probe"]) {
        phase = "baseline";
        plainPostRequests = 0;
        now = Date.parse(startAtUtc) - 60_000;
        const baseline = await runBaseline({ aggregates }, { vantage });
        baselines.push(baseline);
        assert.equal(baseline.pass, true);
        assert.equal(baseline.vantages[0].targets.home.baselinePresence, "omits");
        assert.equal(baseline.vantages[0].targets.home.needle, needle);
        assert.equal(baseline.vantages[0].targets.home.samples.length, 3);
        for (const name of ["feeds", "sitemap", "search"]) assert.equal(baseline.vantages[0].targets[name].baselinePresence, "omits");
        assert.equal(validateBaselineReceipt(baseline, aggregates, startAtUtc, [vantage]), true);
        phase = "published";
        now = Date.parse(startAtUtc) + 2_000;
        const receipt = await runProbe(config, startAtUtc, baseline, {
          vantage, confirmations: 3, intervalMs: 1, aggregateIntervalMs: 1, maxDurationMs: 5_000,
        });
        assert.equal(receipt.decisions.detailPass, true);
        assert.equal(receipt.decisions.aggregateConvergencePass, true);
        const sealed = sealReceipt(receipt, {
          id: "first-normal-build", sourceSha: "a".repeat(40),
          startedAt: "2026-10-09T12:00:05.000Z", completedAt: "2026-10-09T12:01:00.000Z",
        });
        assert.equal(sealed.decisions.overallPass, true);
        const home = sealed.normalBuild.targets.find(target => target.name === "home");
        assert.equal(home.catchUpEvidence, "unchanged-home");
        assert.equal(home.caughtUpByBuildCompletion, null);
        assert.equal(home.unchangedByBuildCompletion, true);
        for (const name of ["feeds", "sitemap", "search"]) assert.equal(sealed.normalBuild.targets.find(target => target.name === name).caughtUpByBuildCompletion, true);
        const path = join(directory, `${operation}-${vantage}.json`);
        await writeJsonReceipt(path, sealed);
        const saved = JSON.parse(await readFile(path, "utf8"));
        // Exact HIT/MISS/BYPASS values must survive actual receipt serialization.
        const samples = saved.vantages[0].post.canonical.samples;
        const plain = samples.filter(sample => sample.requestLabel === "plain");
        assert.ok(plain.length >= 4);
        assert.equal(plain[0].headers.renderCache, "MISS");
        assert.ok(plain.slice(1).every(sample => sample.headers.renderCache === "HIT"));
        assert.equal(samples.find(sample => sample.requestLabel === "unique-query-diagnostic").headers.renderCache, "BYPASS");
        assert.ok(samples.every(sample => sample.headers.cacheControl === "no-store"));
        assert.ok(saved.vantages[0].aggregates.targets.home.samples.every(sample => sample.headers.renderCache === null));
        assert.equal(saved.vantages[0].post.canonical.confirmations, 3);
        results.push(saved.vantages[0]);
      }
      assert.deepEqual(results.map(result => result.name), ["local-probe", "remote-probe"]);
      const combinedBaseline = { ...baselines[0], vantages: baselines.flatMap(baseline => baseline.vantages) };
      assert.throws(() => validateBaselineReceipt(combinedBaseline, aggregates, startAtUtc,
        ["local-probe", "remote-probe"], ["remote-probe"]), /valid clock calibration/);
      combinedBaseline.vantages[1].clockCalibration = { remoteMinusOfficeMs: 0, uncertaintyMs: 100 };
      assert.equal(validateBaselineReceipt(combinedBaseline, aggregates, startAtUtc,
        ["local-probe", "remote-probe"], ["remote-probe"]), true);
      assert.throws(() => validateBaselineReceipt(baselines[0], aggregates, startAtUtc,
        ["local-probe", "remote-probe"]), /remote-probe/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unchanged Home does not admit already-present affected aggregates or change withdrawal baselines", async t => {
  const aggregates = pilotAggregates();
  let homeAppears = false;
  t.mock.method(globalThis, "fetch", async input => new Response(
    new URL(input).pathname === "/" && !homeAppears ? "No pilot Post" : "/posts/pilot-post-7/"));
  const alreadyPresent = await runBaseline({ aggregates });
  assert.equal(alreadyPresent.pass, false);
  assert.equal(alreadyPresent.vantages[0].targets.home.pass, true);
  for (const name of ["feeds", "sitemap", "search"]) assert.equal(alreadyPresent.vantages[0].targets[name].pass, false);
  const withdrawal = await runBaseline({ aggregates: pilotAggregates(undefined, "omits") });
  assert.equal(withdrawal.pass, true);
  for (const name of ["feeds", "sitemap", "search"]) assert.equal(withdrawal.vantages[0].targets[name].baselinePresence, "contains");
  homeAppears = true;
  const invalidHome = await runBaseline({ aggregates: pilotAggregates(undefined, "omits") });
  assert.equal(invalidHome.pass, false);
  assert.equal(invalidHome.vantages[0].targets.home.pass, false);
});

test("Home absence must be sampled after delayed aggregate convergence", async t => {
  // The old generation omits the Post, but the normal build may add it.
  for (const homeAppears of [false, true]) await t.test(`Home appears: ${homeAppears}`, async t => {
    let now = Date.parse(startAtUtc) - 60_000;
    t.mock.method(Date, "now", () => now++);
    const aggregates = pilotAggregates();
    const html = "Exact pilot Post";
    const config = {
      post: { ...fixtures.expectedPost, canonicalUrl: fixtures.post.canonicalUrl, aliases: [],
        htmlSha256: createHash("sha256").update(html).digest("hex") },
      aggregates,
    };
    let baselinePhase = true;
    const requests = { feeds: 0, sitemap: 0, search: 0 };
    t.mock.method(globalThis, "fetch", async input => {
      const url = new URL(input);
      const diagnostic = url.searchParams.has("__nobuild_probe");
      url.search = "";
      const aggregate = aggregates.find(target => target.url === url.href);
      if (!aggregate) return new Response(html, { headers: {
        "X-Njpbs-Source-Version": config.post.publishedVersion,
        "X-Njpbs-Publication-Operation": config.post.operationId,
        "X-Njpbs-Html-Sha256": config.post.htmlSha256,
      } });
      if (baselinePhase) return new Response("No pilot Post");
      if (aggregate.name === "home") return new Response(
        homeAppears && requests.search >= 9 ? aggregate.needle : "No pilot Post");
      if (!diagnostic) requests[aggregate.name] += 1;
      return new Response(requests[aggregate.name] > 5 ? aggregate.needle : "No pilot Post");
    });
    const baseline = await runBaseline({ aggregates }, { vantage: "remote-probe" });
    baselinePhase = false;
    now = Date.parse(startAtUtc) + 2_000;
    const receipt = await runProbe(config, startAtUtc, baseline, {
      vantage: "remote-probe", confirmations: 3, intervalMs: 1, aggregateIntervalMs: 1, maxDurationMs: 5_000,
    });
    const build = { id: "first-normal-build", sourceSha: "a".repeat(40),
      startedAt: startAtUtc, completedAt: "2026-10-09T12:01:00.000Z" };
    assert.equal(receipt.decisions.aggregateConvergencePass, !homeAppears);
    assert.equal(sealReceipt(receipt, build).decisions.overallPass, !homeAppears);
    const home = receipt.vantages[0].aggregates.targets.home;
    const convergedAt = Math.max(...["feeds", "sitemap", "search"].flatMap(name =>
      receipt.vantages[0].aggregates.targets[name].samples
        .filter(sample => sample.requestLabel === "plain").map(sample => Date.parse(sample.atUtc))));
    assert.ok(home.samples.some(sample => sample.requestLabel === "plain"
      && Date.parse(sample.requestStartedAtUtc) > convergedAt));
    if (homeAppears) {
      assert.ok(home.regressions > 0);
      return;
    }
    // A saved receipt with only early Home observations must also fail sealing.
    home.samples = home.samples.filter(sample => sample.requestLabel === "plain").slice(0, 4);
    assert.equal(sealReceipt(receipt, build).decisions.overallPass, false);
  });
});

test("unchanged Home still requires both vantages, calibrated clocks and the first build deadline", () => {
  const home = {
    ...evaluateAggregateProgress({ ...pilotAggregates()[0], samples: [
      ...repeated({ requestLabel: "plain", status: 200, containsNeedle: false }, 0, 2_000, 4),
      at({ requestLabel: "plain", status: 200, containsNeedle: false }, 4, 32_000),
    ] }, 3),
    baselinePresence: "omits", baselineLastObservedAtUtc: "2026-10-09T11:59:45.000Z",
    baselineLastObservedRequestStartedAtUtc: "2026-10-09T11:59:44.000Z",
  };
  const targets = { home, ...Object.fromEntries(["feeds", "sitemap", "search"].map(name => [name, evaluateAggregateProgress(name === "sitemap" ? fixtures.aggregates.omits.sitemap : fixtures.aggregates.contains[name], 3)])) };
  const receipt = aggregateReceipt(targets);
  receipt.vantages.push({ ...structuredClone(receipt.vantages[0]), name: "remote-probe", polling: { clockUncertaintyMs: 500 } });
  const build = { id: "first-normal-build", sourceSha: "a".repeat(40), startedAt: "2026-10-09T12:00:05.000Z", completedAt: "2026-10-09T12:00:40.000Z" };
  assert.equal(evaluateAggregateBuildWindow(receipt, build).pass, true);
  const remoteFeed = receipt.vantages[1].aggregates.targets.feeds;
  const feedObservedAt = remoteFeed.firstExpectedAtUtc;
  remoteFeed.firstExpectedAtUtc = "2026-10-09T12:00:41.000Z";
  assert.equal(evaluateAggregateBuildWindow(receipt, build).pass, false);
  remoteFeed.firstExpectedAtUtc = feedObservedAt;
  const remoteHome = receipt.vantages[1].aggregates.targets.home;
  remoteHome.samples.at(-1).atUtc = "2026-10-09T12:00:39.750Z";
  assert.equal(evaluateAggregateBuildWindow(receipt, build).pass, false);
  remoteHome.samples.at(-1).atUtc = "2026-10-09T12:00:32.000Z";
  remoteHome.baselinePresence = "contains";
  assert.equal(evaluateAggregateBuildWindow(receipt, build).pass, false);
  remoteHome.baselinePresence = "omits";
  delete receipt.vantages[1].aggregates.targets.home;
  assert.equal(evaluateAggregateBuildWindow(receipt, build).pass, false);
});
