#!/usr/bin/env node
// Repeatable Admin performance baseline capture (#1064).
//
// Drives a real Chromium against a running Admin build under the fixed benchmark profile in
// scripts/lib/admin-perf-profile.mjs (150 ms latency, 1.6 Mbps down, 750 Kbps up, 4x CPU
// throttle) at 1440 px and 390 px. Read surfaces record the first signed-in load, refresh,
// return visit, in-app navigation, and history restoration. Save surfaces keep their focused
// cold/warm mutation samples. The output combines the app's privacy-safe User Timing receipt
// with aggregate browser Resource Timing counts; no URL or record id is written.
//
// It records evidence. It signs in through the ordinary Admin form, so identity, admission,
// the confirmed profile, authorization, and every server boundary run exactly as they do for
// a person; nothing here bypasses or caches any of them.
//
// Usage:
//   node scripts/admin-perf-baseline.mjs \
//     --base-url http://127.0.0.1:5173 \
//     --email <emulator staff address> --password <emulator password> \
//     --scenarios dashboard,content-library,page-editor \
//     --out proof/admin-perf-baseline.json
//
// Credentials may also come from ADMIN_PERF_EMAIL and ADMIN_PERF_PASSWORD. Use emulator
// identities only: this script must never be pointed at production with a real credential.
// Non-loopback hosts require --allow-untrusted-host; the destination is printed and checked
// again before sign-in.
//
// Use installed Google Chrome 156.0.8078.73 or later with its sandbox enabled.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ADMIN_PERF_PROFILE,
  cpuThrottling,
  journeySource,
  networkConditions,
  scenarioIds,
  scenarioPath,
  surfaceLandingPath,
} from "./lib/admin-perf-profile.mjs";

const RECEIPT_SCHEMA_VERSION = 2;
const NAV_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 90_000;
const NAV_INTENT_SETTLE_MS = 150;
const SETTLE_POLL_MS = 250;
const EDITOR_LEASE_CLEANUP_MS = 5_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function assertCredentialDestination(value, allowUntrustedHost) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Base URL must be an HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Base URL must be an HTTP(S) URL without credentials.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    if (!allowUntrustedHost) {
      throw new Error("Non-loopback host; use --allow-untrusted-host to opt in.");
    }
    console.error(`Credential target host: ${url.hostname}`);
  }
}

function parseArguments(argv) {
  const options = {
    baseUrl: process.env.ADMIN_PERF_BASE_URL ?? "http://127.0.0.1:5173",
    email: process.env.ADMIN_PERF_EMAIL ?? "",
    password: process.env.ADMIN_PERF_PASSWORD ?? "",
    scenarios: scenarioIds(),
    viewports: ADMIN_PERF_PROFILE.viewports.map((viewport) => viewport.name),
    out: "",
    label: "",
    pageId: "",
    postId: "",
    headed: false,
    allowUntrustedHost: false,
    // Capture only the signed-out entry boundary: bootstrap through the resolved Firebase
    // auth state. Useful where no approved emulator identity is available, and honest about
    // what it is -- it is not a substitute for the authenticated scenarios.
    bootstrapOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--base-url":
        options.baseUrl = value;
        index += 1;
        break;
      case "--email":
        options.email = value;
        index += 1;
        break;
      case "--password":
        options.password = value;
        index += 1;
        break;
      case "--scenarios":
        options.scenarios = value.split(",").map((entry) => entry.trim());
        index += 1;
        break;
      case "--viewports":
        options.viewports = value.split(",").map((entry) => entry.trim());
        index += 1;
        break;
      case "--out":
        options.out = value;
        index += 1;
        break;
      case "--label":
        options.label = value;
        index += 1;
        break;
      case "--page-id":
        options.pageId = value;
        index += 1;
        break;
      case "--post-id":
        options.postId = value;
        index += 1;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--allow-untrusted-host":
        options.allowUntrustedHost = true;
        break;
      case "--bootstrap-only":
        options.bootstrapOnly = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

// Playwright ships CommonJS, so a global install imported by path can arrive under
// `default`. Normalise both shapes rather than failing on `chromium is undefined`.
function playwrightExports(module) {
  return module?.chromium ? module : module?.default;
}

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_MODULE;
  if (explicit) {
    return playwrightExports(await import(pathToFileURL(resolve(explicit)).href));
  }
  try {
    return playwrightExports(await import("playwright"));
  } catch {
    const globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
    }).trim();
    return playwrightExports(
      await import(pathToFileURL(resolve(globalRoot, "playwright/index.js")).href),
    );
  }
}

// The scanner from the app's own privacy contract, restated here so a captured receipt is
// checked again on the way out to disk. A receipt that trips it is not written.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSAFE = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /eyJ[A-Za-z0-9_-]{4,}/,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /\s/,
  /[A-Za-z0-9_-]{16,}/,
  /[/<]/,
];
const SAFE_NAME = /^njpbs\.admin\.[a-z.-]+$/;
const SAFE_RECEIPT_VALUES = new Set(
  ADMIN_PERF_PROFILE.scenarios.map((entry) => entry.route),
);

function unsafeValues(value, path = "") {
  if (typeof value === "string") {
    if (
      UUID.test(value) ||
      SAFE_NAME.test(value) ||
      SAFE_RECEIPT_VALUES.has(value)
    ) {
      return [];
    }
    return UNSAFE.some((pattern) => pattern.test(value)) ? [path] : [];
  }
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      unsafeValues(entry, path ? `${path}.${index}` : String(index)),
    );
  }
  return Object.entries(value).flatMap(([key, entry]) =>
    unsafeValues(entry, path ? `${path}.${key}` : key),
  );
}

async function readReceipt(page) {
  return page.evaluate(() => {
    const probe = window.__njpbsAdminPerf;
    return probe ? probe.receipt() : null;
  });
}

// Read the receipt once the app has stopped emitting, rather than after a fixed sleep, so a
// sample is not cut short on a slow profile or padded on a fast one.
//
// Quiet is not enough on its own. An operation that started and has not finished is exactly
// the slow-request regression this harness exists to expose, and a quiet interval in the
// middle of one would otherwise write a truncated receipt that looks fast. So a sample settles
// only when the app is quiet AND nothing it started is still outstanding; a run that never
// reaches that state says so instead of pretending it did.
async function settledReceipt(page) {
  let previous = null;
  let stable = 0;
  const attempts = Math.ceil(READY_TIMEOUT_MS / SETTLE_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await readReceipt(page);
    const unchanged =
      previous &&
      current &&
      previous.marks.length === current.marks.length &&
      previous.measures.length === current.measures.length;
    stable = unchanged ? stable + 1 : 0;
    if (stable >= 3 && current && current.counts.open === 0) {
      return { receipt: current, settled: true };
    }
    previous = current;
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  const receipt = await readReceipt(page);
  return { receipt, settled: Boolean(receipt) && receipt.counts.open === 0 };
}

// Wait for the app's own receipt to show that something happened, rather than for a control to
// look a particular way. Returns false on timeout so a scenario can report what it could not
// complete instead of writing a sample that measured nothing.
async function waitForReceipt(page, predicate, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await readReceipt(page);
    if (receipt && predicate(receipt)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Sign in on the page that is already open, without navigating first. A cold sample has to be
// one uncached document: signing in on a separate earlier page would pre-warm the entry, the
// Firebase chunk, the shared modules and the addressed route, and the sample labeled "cold"
// would then measure a warm cache under a cold label.
async function signInOnThisPage(page, options) {
  const emailField = page.locator("#auth-email");
  await emailField.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
  if (new URL(page.url()).origin !== new URL(options.baseUrl).origin) {
    throw new Error("Sign-in redirected to another origin.");
  }
  await emailField.fill(options.email);
  await page.locator("#auth-password").fill(options.password);
  await page.locator("form").getByRole("button", { name: /^sign in$/i }).click();
  await page
    .locator("#auth-email")
    .waitFor({ state: "detached", timeout: READY_TIMEOUT_MS });
}

function successfulTransportCount(receipt, operation) {
  return receipt.measures.filter(
    (measure) =>
      measure.name.endsWith("measure.cms-transport") &&
      measure.detail.operation === operation &&
      measure.detail.outcome === "ok",
  ).length;
}

// Make the page genuinely dirty, then save it. Without the edit the save control is disabled
// or the save short-circuits as "already saved", and the scenario would time a no-op.
async function editAndSave(page) {
  const before = await readReceipt(page);
  const beforeWrites = successfulTransportCount(
    before ?? { measures: [] },
    "content-write",
  );
  const field = page.getByRole("textbox", {
    name: "Post title",
    exact: true,
  });
  try {
    await field.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
    await field.click();
    await page.keyboard.type(" benchmark");
  } catch {
    return { ok: false, reason: "the Post title did not become editable" };
  }

  const save = page.getByRole("button", { name: /^(save|update)$/i }).first();
  try {
    await save.click({ timeout: READY_TIMEOUT_MS });
  } catch {
    return { ok: false, reason: "save control did not become available" };
  }

  const committed = await waitForReceipt(
    page,
    (receipt) =>
      successfulTransportCount(receipt, "content-write") > beforeWrites &&
      receipt.counts.open === 0,
  );
  return committed
    ? { ok: true }
    : { ok: false, reason: "the save transaction did not commit in time" };
}

// The restore a person actually performs: open a revision, ask to restore it, confirm the
// warning. Clicking a bare "restore" control without inspecting a revision restores nothing.
async function inspectRestoreConfirm(page) {
  const before = await readReceipt(page);
  const inspect = page
    .getByRole("button", { name: /^Inspect version \d+$/ })
    .nth(1);
  try {
    await inspect.click({ timeout: READY_TIMEOUT_MS });
  } catch {
    return { ok: false, reason: "no revision available to inspect" };
  }

  const restore = page
    .getByRole("button", { name: /^Restore version \d+$/ })
    .first();
  try {
    await restore.click({ timeout: READY_TIMEOUT_MS });
    await page
      .getByRole("button", { name: /^Confirm restore of version \d+$/ })
      .first()
      .click({ timeout: READY_TIMEOUT_MS });
  } catch {
    return { ok: false, reason: "this revision cannot be restored from here" };
  }

  const restored = await waitForReceipt(
    page,
    (receipt) =>
      successfulTransportCount(receipt, "revision-write") >
        successfulTransportCount(
          before ?? { measures: [] },
          "revision-write",
        ) &&
      receipt.counts.open === 0,
  );
  return restored
    ? { ok: true }
    : { ok: false, reason: "the restore did not commit in time" };
}

const SCENARIO_ACTIONS = {
  "edit-and-save": editAndSave,
  "inspect-restore-confirm": inspectRestoreConfirm,
};

async function applyProfile(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", networkConditions());
  await session.send("Emulation.setCPUThrottlingRate", cpuThrottling());
  return session;
}

async function leaveEditor(page) {
  const back = page.locator("a.editor-back");
  await back.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
  await back.click();
  await page.waitForURL(
    (current) => !current.pathname.endsWith("/edit"),
    { timeout: READY_TIMEOUT_MS },
  );
  // The editor releases its Firestore courtesy lease after the route unmounts. Keep the live
  // page available for that bounded local write before closing the tab.
  await page.waitForTimeout(EDITOR_LEASE_CLEANUP_MS);
}

async function leaveEditorIfNeeded(page) {
  if (!page.isClosed() && new URL(page.url()).pathname.endsWith("/edit")) {
    await leaveEditor(page);
  }
}

async function closeJourneyPage(page, session) {
  try {
    await leaveEditorIfNeeded(page);
  } catch {
    console.warn(
      "Admin perf warning: the editor courtesy lease was not released before tab close.",
    );
  } finally {
    await session.detach().catch(() => undefined);
    if (!page.isClosed()) await page.close();
  }
}

async function captureScenario(context, entry, options, temperature, needsSignIn) {
  const { path, missing } = scenarioPath(entry, {
    pageId: options.pageId,
    postId: options.postId,
  });
  if (missing.length > 0) {
    return {
      scenario: entry.id,
      temperature,
      status: "not-captured",
      reason: `missing id: ${missing.join(", ")}`,
    };
  }

  const page = await context.newPage();
  const session = await applyProfile(context, page);
  try {
    await page.goto(`${options.baseUrl}${path}`, {
      waitUntil: "load",
      timeout: NAV_TIMEOUT_MS,
    });
    // The cold sample authenticates inside this same first navigation, so bootstrap,
    // authentication, the session, admission, the confirmed profile, the route download and
    // the editor all belong to one uncached document.
    if (needsSignIn) {
      await signInOnThisPage(page, options);
    }

    const action = SCENARIO_ACTIONS[entry.action];
    if (action) {
      const outcome = await action(page);
      if (!outcome.ok) {
        return {
          scenario: entry.id,
          temperature,
          status: "not-captured",
          reason: outcome.reason,
        };
      }
    }

    const { receipt, settled } = await settledReceipt(page);
    return {
      scenario: entry.id,
      temperature,
      status: !receipt
        ? "no-receipt"
        : settled
          ? "captured"
          : "incomplete-open-operations",
      receipt,
    };
  } finally {
    await closeJourneyPage(page, session);
  }
}

function subtractRecord(after = {}, before = {}) {
  return Object.fromEntries(
    Object.entries(after)
      .map(([key, value]) => [key, value - (before[key] ?? 0)])
      .filter(([, value]) => value !== 0),
  );
}

function receiptDelta(receipt, before) {
  if (!receipt) return null;
  if (!before) return receipt;
  const markOffset = before.marks.length;
  const measureOffset = before.measures.length;
  return {
    schemaVersion: receipt.schemaVersion,
    build: receipt.build,
    marks: receipt.marks.slice(markOffset),
    measures: receipt.measures.slice(measureOffset),
    counts: {
      marks: receipt.marks.length - markOffset,
      open: receipt.counts.open,
      routeLoad: receipt.counts.routeLoad - before.counts.routeLoad,
      cmsRequest: receipt.counts.cmsRequest - before.counts.cmsRequest,
      save: receipt.counts.save - before.counts.save,
      byOperation: subtractRecord(
        receipt.counts.byOperation,
        before.counts.byOperation,
      ),
      byRoute: subtractRecord(receipt.counts.byRoute, before.counts.byRoute),
    },
  };
}

async function browserTimingState(page) {
  return page.evaluate(() => ({
    now: performance.now(),
    resources: performance.getEntriesByType("resource").map((entry) => ({
      duration: entry.duration,
      encodedBodySize: entry.encodedBodySize,
      initiatorType: entry.initiatorType,
      name: entry.name,
      transferSize: entry.transferSize,
    })),
  }));
}

function resourceSummary(resources) {
  const javascript = resources.filter((entry) => {
    try {
      return new URL(entry.name).pathname.endsWith(".js");
    } catch {
      return false;
    }
  });
  const aggregate = (entries) => ({
    requests: entries.length,
    transferredBytes: entries.reduce(
      (total, entry) => total + entry.transferSize,
      0,
    ),
    encodedBytes: entries.reduce(
      (total, entry) => total + entry.encodedBodySize,
      0,
    ),
    cacheHits: entries.filter(
      (entry) => entry.transferSize === 0 && entry.encodedBodySize > 0,
    ).length,
    durationMs: Math.round(
      entries.reduce((total, entry) => total + entry.duration, 0) * 10,
    ) / 10,
  });
  return {
    all: aggregate(resources),
    javascript: aggregate(javascript),
  };
}

function latestActivityMs(receipt, startTime) {
  if (!receipt) return 0;
  return receipt.marks.reduce(
    (latest, mark) => Math.max(latest, mark.startTime - startTime),
    0,
  );
}

async function waitForSurface(page, path, heading) {
  const expected = new URL(path, "http://127.0.0.1");
  await page.waitForURL(
    (current) =>
      current.pathname === expected.pathname && current.search === expected.search,
    { timeout: READY_TIMEOUT_MS },
  );
  const title =
    typeof heading === "string"
      ? page.getByRole("heading", { level: 1, name: heading, exact: true })
      : page.locator("#page-title");
  await title.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
  await page
    .locator(".route-loading")
    .waitFor({ state: "hidden", timeout: READY_TIMEOUT_MS });
}

async function finishJourneySample({
  page,
  before,
  beforeTiming,
  entry,
  path,
  visit,
  documentStart = false,
}) {
  try {
    await waitForSurface(page, surfaceLandingPath(entry, path), entry.heading);
  } catch {
    return {
      scenario: entry.id,
      visit,
      status: "not-captured",
      reason: "the Admin surface did not become ready",
    };
  }
  const surfaceTiming = await browserTimingState(page);
  const { receipt, settled } = await settledReceipt(page);
  const afterTiming = await browserTimingState(page);
  const startTime = documentStart ? 0 : beforeTiming.now;
  const surfaceReadyMs = Math.max(0, surfaceTiming.now - startTime);
  const activityReadyMs = Math.max(
    0,
    latestActivityMs(receiptDelta(receipt, before), startTime),
  );
  return {
    scenario: entry.id,
    visit,
    status: !receipt
      ? "no-receipt"
      : settled
        ? "captured"
        : "incomplete-open-operations",
    readyMs: {
      surface: Math.round(surfaceReadyMs * 10) / 10,
      settledActivity:
        Math.round(Math.max(surfaceReadyMs, activityReadyMs) * 10) / 10,
    },
    resources: resourceSummary(
      afterTiming.resources.slice(documentStart ? 0 : beforeTiming.resources.length),
    ),
    receipt: receiptDelta(receipt, before),
  };
}

async function captureDocumentVisit({
  page,
  entry,
  path,
  visit,
  action,
}) {
  try {
    await action();
  } catch {
    return {
      scenario: entry.id,
      visit,
      status: "not-captured",
      reason: "the document journey action did not complete",
    };
  }
  return finishJourneySample({
    page,
    before: null,
    beforeTiming: { now: 0, resources: [] },
    entry,
    path,
    visit,
    documentStart: true,
  });
}

async function captureSameDocumentVisit({
  page,
  entry,
  path,
  visit,
  action,
}) {
  const before = await readReceipt(page);
  const beforeTiming = await browserTimingState(page);
  await action();
  return finishJourneySample({
    page,
    before,
    beforeTiming,
    entry,
    path,
    visit,
  });
}

async function clickPath(page, path) {
  const link = page.locator(`a[href=${JSON.stringify(path)}]`).first();
  if (!(await link.isVisible())) {
    const menu = page.locator(".menu-toggle");
    if (await menu.isVisible()) await menu.click();
  }
  if (!(await link.isVisible())) {
    const group = link.locator(
      "xpath=ancestor::div[contains(@class, 'nav-destination-group')]",
    );
    const toggle = group.locator(".nav-destination-toggle");
    if (await toggle.isVisible()) await toggle.click();
  }
  if (!(await link.isVisible())) {
    const account = page.locator('button[aria-haspopup="menu"]').first();
    if (await account.isVisible()) await account.click();
  }
  await link.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
  await link.hover();
  await page.waitForTimeout(NAV_INTENT_SETTLE_MS);
  await link.click();
}

async function releaseEditorLease(page) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const released = await page.evaluate(async () => {
      const release = window.__njpbsAdminPerf?.releaseEditorLease;
      return release ? release() : false;
    });
    if (released) return;
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  throw new Error("The editor courtesy lease did not become releasable.");
}

async function refreshDocument(page, path) {
  if (path.endsWith("/edit")) {
    // Release and await this mounted visit's lease while its document is still alive. The yielded
    // editor cannot reclaim it in the gap before the real browser reload starts a new session.
    await releaseEditorLease(page);
  }
  await page.reload({ waitUntil: "load", timeout: NAV_TIMEOUT_MS });
}

async function captureDocumentJourneys(context, entry, options, path) {
  let page = await context.newPage();
  let session = await applyProfile(context, page);
  const samples = [];
  try {
    const firstVisit = await captureDocumentVisit({
      page,
      entry,
      path,
      visit: "first-signed-in-load",
      action: async () => {
        await page.goto(`${options.baseUrl}${path}`, {
          waitUntil: "load",
          timeout: NAV_TIMEOUT_MS,
        });
        await signInOnThisPage(page, options);
      },
    });
    samples.push(firstVisit);
    if (firstVisit.status === "not-captured") {
      return [
        firstVisit,
        ...ADMIN_PERF_PROFILE.readVisits.slice(1, 3).map((visit) => ({
          scenario: entry.id,
          visit,
          status: "not-captured",
          reason: "the first signed-in surface did not become ready",
        })),
      ];
    }
    samples.push(
      await captureDocumentVisit({
        page,
        entry,
        path,
        visit: "refresh",
        action: () => refreshDocument(page, path),
      }),
    );

    await closeJourneyPage(page, session);
    page = await context.newPage();
    session = await applyProfile(context, page);
    samples.push(
      await captureDocumentVisit({
        page,
        entry,
        path,
        visit: "return-visit",
        action: () =>
          page.goto(`${options.baseUrl}${path}`, {
            waitUntil: "load",
            timeout: NAV_TIMEOUT_MS,
          }),
      }),
    );

    return samples;
  } finally {
    await closeJourneyPage(page, session);
  }
}

async function captureHistoryJourneys(context, entry, options, path) {
  const page = await context.newPage();
  const session = await applyProfile(context, page);
  const samples = [];
  try {
    const source = journeySource(path);
    try {
      await page.goto(`${options.baseUrl}${source.path}`, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
      await signInOnThisPage(page, options);
      await waitForSurface(page, source.landingPath, source.heading);
      await settledReceipt(page);
      samples.push(
        await captureSameDocumentVisit({
          page,
          entry,
          path,
          visit: "in-app-navigation",
          action: () => clickPath(page, path),
        }),
      );
    } catch {
      for (const visit of [
        "in-app-navigation",
        "history-back",
        "history-forward",
      ]) {
        samples.push({
          scenario: entry.id,
          visit,
          status: "not-captured",
          reason: "the Admin has no reachable link for this journey",
        });
      }
      return samples;
    }
    let historyForward;
    try {
      await page.goBack({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS });
      await waitForSurface(page, source.landingPath, source.heading);
      await settledReceipt(page);
      if (path.endsWith("/edit")) {
        // Back unmounted the editor and started its asynchronous lease cleanup. Keep the source
        // document alive for the same bounded interval used by an explicit in-app editor exit.
        await page.waitForTimeout(EDITOR_LEASE_CLEANUP_MS);
      }
      historyForward = await captureSameDocumentVisit({
        page,
        entry,
        path,
        visit: "history-forward",
        action: () =>
          page.goForward({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS }),
      });
    } catch {
      for (const visit of ["history-back", "history-forward"]) {
        samples.push({
          scenario: entry.id,
          visit,
          status: "not-captured",
          reason: "the browser history journey did not complete",
        });
      }
      return samples;
    }
    try {
      // Build target -> source through the Admin so Back returns to the named scenario.
      // An editor's contextual Back link also gives its courtesy lease time to release.
      if (new URL(page.url()).pathname.endsWith("/edit")) {
        await leaveEditor(page);
      } else {
        await clickPath(page, source.path);
      }
      await waitForSurface(page, source.landingPath, source.heading);
      await settledReceipt(page);
      const historyBack = await captureSameDocumentVisit({
        page,
        entry,
        path,
        visit: "history-back",
        action: () =>
          page.goBack({ waitUntil: "commit", timeout: NAV_TIMEOUT_MS }),
      });
      samples.push(historyBack, historyForward);
    } catch {
      samples.push(
        {
          scenario: entry.id,
          visit: "history-back",
          status: "not-captured",
          reason: "the browser history journey did not complete",
        },
        historyForward,
      );
    }
    return samples;
  } finally {
    await closeJourneyPage(page, session);
  }
}

async function captureReadJourneys(browser, entry, options, viewport) {
  const { path, missing } = scenarioPath(entry, {
    pageId: options.pageId,
    postId: options.postId,
  });
  if (missing.length > 0) {
    return ADMIN_PERF_PROFILE.readVisits.map((visit) => ({
      scenario: entry.id,
      visit,
      status: "not-captured",
      reason: `missing id: ${missing.join(", ")}`,
    }));
  }

  // Measure the source-to-destination journey before any context visits the destination.
  // A separate context then captures direct loads so neither sample warms the other.
  const historyContext = await browser.newContext({ viewport });
  let historySamples;
  try {
    historySamples = await captureHistoryJourneys(
      historyContext,
      entry,
      options,
      path,
    );
  } finally {
    await historyContext.close();
  }

  const documentContext = await browser.newContext({ viewport });
  let documentSamples;
  try {
    documentSamples = await captureDocumentJourneys(
      documentContext,
      entry,
      options,
      path,
    );
  } finally {
    await documentContext.close();
  }

  return [...documentSamples, ...historySamples];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertCredentialDestination(options.baseUrl, options.allowUntrustedHost);
  if (options.bootstrapOnly) {
    options.scenarios = [];
  } else if (!options.email || !options.password) {
    throw new Error(
      "An emulator staff email and password are required (--email/--password or ADMIN_PERF_EMAIL/ADMIN_PERF_PASSWORD).",
    );
  }
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome", headless: !options.headed, chromiumSandbox: true });
  const run = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    label: options.label || null,
    profile: ADMIN_PERF_PROFILE.id,
    conditions: {
      network: { ...ADMIN_PERF_PROFILE.network, cdp: networkConditions() },
      cpu: ADMIN_PERF_PROFILE.cpu,
    },
    samples: [],
  };

  try {
    for (const viewportName of options.viewports) {
      const viewport = ADMIN_PERF_PROFILE.viewports.find(
        (entry) => entry.name === viewportName,
      );
      if (!viewport) throw new Error(`Unknown viewport: ${viewportName}`);

      if (options.bootstrapOnly) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          const page = await context.newPage();
          const session = await applyProfile(context, page);
          for (const visit of ["first-load", "refresh"]) {
            if (visit === "refresh") {
              await page.reload({
                waitUntil: "load",
                timeout: NAV_TIMEOUT_MS,
              });
            } else {
              await page.goto(options.baseUrl, {
                waitUntil: "load",
                timeout: NAV_TIMEOUT_MS,
              });
            }
            await page
              .locator("#auth-email")
              .waitFor({ state: "visible", timeout: READY_TIMEOUT_MS });
            const { receipt, settled } = await settledReceipt(page);
            run.samples.push({
              viewport: viewport.name,
              scenario: "bootstrap",
              visit,
              status: !receipt
                ? "no-receipt"
                : settled
                  ? "captured"
                  : "incomplete-open-operations",
              receipt,
            });
          }
          await session.detach().catch(() => undefined);
        } finally {
          await context.close();
        }
        continue;
      }

      for (const scenarioId of options.scenarios) {
        const entry = ADMIN_PERF_PROFILE.scenarios.find(
          (candidate) => candidate.id === scenarioId,
        );
        if (!entry) throw new Error(`Unknown scenario: ${scenarioId}`);
        if (entry.kind === "read") {
          const samples = await captureReadJourneys(browser, entry, options, {
            width: viewport.width,
            height: viewport.height,
          });
          run.samples.push(
            ...samples.map((sample) => ({ viewport: viewport.name, ...sample })),
          );
          continue;
        }
        // Cold: a brand-new context, so the HTTP cache, storage, and the session all start
        // empty, and the sign-in happens inside the sample's own first navigation rather than
        // on an earlier page that would have warmed the cache first.
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          const cold = await captureScenario(
            context,
            entry,
            options,
            "cold",
            true,
          );
          // Warm: the same context, so the cache and the restored session are what a working
          // editor actually has by their second navigation.
          const warm = await captureScenario(
            context,
            entry,
            options,
            "warm",
            false,
          );
          run.samples.push(
            { viewport: viewport.name, ...cold },
            { viewport: viewport.name, ...warm },
          );
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Scan what the app produced, not the fixed profile labels this script wrote itself.
  const violations = run.samples.flatMap((sample) =>
    unsafeValues(
      sample.receipt ?? null,
      `${sample.viewport}.${sample.scenario}.${sample.visit ?? sample.temperature}`,
    ),
  );
  if (violations.length > 0) {
    throw new Error(
      `Captured receipt failed the privacy scan at: ${violations.join(", ")}`,
    );
  }

  const serialized = `${JSON.stringify(run, null, 2)}\n`;
  if (options.out) {
    const target = resolve(process.cwd(), options.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, serialized);
    process.stdout.write(`Wrote ${options.out}\n`);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
