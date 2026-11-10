import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERF_PROFILE,
  cpuThrottling,
  journeySource,
  networkConditions,
  scenario,
  scenarioIds,
  scenarioPath,
  surfaceLandingPath,
} from "../../scripts/lib/admin-perf-profile.mjs";

describe("Admin benchmark profile", () => {
  it("fixes the #1017 network conditions in CDP units", () => {
    expect(ADMIN_PERF_PROFILE.network).toMatchObject({
      latencyMs: 150,
      downloadKbps: 1600,
      uploadKbps: 750,
    });
    expect(networkConditions()).toEqual({
      offline: false,
      latency: 150,
      downloadThroughput: 200_000,
      uploadThroughput: 93_750,
    });
  });

  it("names a modest-device CPU class so a fast machine cannot pass alone", () => {
    expect(ADMIN_PERF_PROFILE.cpu.name).toBe("modest-desktop-4x");
    expect(cpuThrottling()).toEqual({ rate: 4 });
  });

  it("fixes both review viewports", () => {
    expect(
      ADMIN_PERF_PROFILE.viewports.map((viewport) => [
        viewport.name,
        viewport.width,
      ]),
    ).toEqual([
      ["desktop-1440", 1440],
      ["mobile-390", 390],
    ]);
  });

  it("covers every scenario the baseline has to separate", () => {
    expect(scenarioIds()).toEqual([
      "dashboard",
      "content-library",
      "page-editor",
      "post-editor",
      "media-library",
      "activity",
      "publish-queue",
      "reports",
      "admin-settings",
      "account-settings",
      "account-profile",
      "author-profiles",
      "staff-access",
      "save-normal",
      "save-restore",
    ]);
    expect(scenario("page-editor")).toMatchObject({
      route: "content",
      kind: "read",
      heading: null,
    });
  });

  it("keeps profile ids when an optional command-line id is empty", () => {
    expect(scenarioPath(scenario("page-editor"), { pageId: "" })).toEqual({
      path: "/content/pages/home/edit",
      missing: [],
    });
    expect(scenarioPath(scenario("post-editor"), { postId: "" })).toEqual({
      path: "/content/post/{postId}/edit",
      missing: ["postId"],
    });
  });

  it("keeps each read visit distinct", () => {
    expect(ADMIN_PERF_PROFILE.readVisits).toEqual([
      "first-signed-in-load",
      "refresh",
      "return-visit",
      "in-app-navigation",
      "history-back",
      "history-forward",
    ]);
  });

  // Clicking a save control on a page nobody edited measures a disabled button, and clicking
  // restore without inspecting a revision measures nothing at all. Each save scenario has to
  // name the real sequence it performs.
  it("makes each save scenario name the mutation it performs", () => {
    expect(scenario("save-normal")).toMatchObject({
      kind: "save",
      action: "edit-and-save",
      path: "/content/post/{postId}/edit",
      requires: ["postId"],
    });
    expect(scenario("save-restore")).toMatchObject({
      kind: "save",
      action: "inspect-restore-confirm",
      path: "/content/post/{postId}/edit",
      requires: ["postId"],
    });
  });

  it("drives real edits and the full restore sequence in the harness", () => {
    const harness = readFileSync(
      resolve(process.cwd(), "../scripts/admin-perf-baseline.mjs"),
      "utf8",
    );

    // A real dirty edit before the save, and inspect -> restore -> confirm for the restore.
    expect(harness).toContain("edit-and-save");
    expect(harness).toContain("inspect-restore-confirm");
    expect(harness).toContain("Inspect version");
    expect(harness).toContain("Confirm restore of version");
    // The cold sample signs in inside its own first navigation instead of pre-warming the
    // cache and the module graph on an earlier page.
    expect(harness).toContain("signInOnThisPage");
    // A sample never settles while an operation it started has not finished.
    expect(harness).toContain("counts.open === 0");
    expect(harness).toContain('measure.detail.outcome === "ok"');
    expect(harness).not.toContain("receipt.counts.save >");
    // Browser journeys and aggregate resource evidence are separate. The output does not
    // persist a URL, route id, or resource name.
    expect(harness).toContain('visit: "refresh"');
    expect(harness).toContain('visit: "return-visit"');
    expect(harness).toContain('visit: "in-app-navigation"');
    expect(harness).toContain('visit: "history-back"');
    expect(harness).toContain('visit: "history-forward"');
    expect(harness).not.toContain("entry: { ...entry, heading: source.heading }");
    expect(harness).toContain("leaveEditorIfNeeded");
    expect(harness).toContain("closeJourneyPage");
    expect(harness).toContain("action: () => refreshDocument(page, path)");
    expect(harness).toContain("releaseEditorLease");
    expect(harness).toContain("await page.reload");
    expect(harness).toContain("resourceSummary");
    expect(harness).toContain("cacheHits");

    const readJourneys = harness.slice(
      harness.indexOf("async function captureReadJourneys"),
      harness.indexOf("async function main"),
    );
    const historyJourneys = harness.slice(
      harness.indexOf("async function captureHistoryJourneys"),
      harness.indexOf("async function captureReadJourneys"),
    );
    expect(historyJourneys.match(/page\.goto\(/g)).toHaveLength(1);
    expect(readJourneys.indexOf("captureHistoryJourneys")).toBeLessThan(
      readJourneys.indexOf("captureDocumentJourneys"),
    );
    expect(readJourneys).toContain("ADMIN_PERF_PROFILE.readVisits.map");
  });

  it("ships the repeatable capture script the profile belongs to", () => {
    expect(
      existsSync(resolve(process.cwd(), "../scripts/admin-perf-baseline.mjs")),
    ).toBe(true);
  });

  it("refuses a foreign benchmark host before checking credentials or starting a browser", () => {
    const result = spawnSync(process.execPath, [
      resolve(process.cwd(), "../scripts/admin-perf-baseline.mjs"),
      "--base-url", "https://example.invalid",
    ], {
      encoding: "utf8",
      env: { ...process.env, ADMIN_PERF_EMAIL: "", ADMIN_PERF_PASSWORD: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Non-loopback host; use --allow-untrusted-host to opt in.\n");
  });

  it("opens Media from its /media rail link and waits on the /media/images landing path", () => {
    const media = scenario("media-library");
    expect(media).toMatchObject({ path: "/media", landingPath: "/media/images" });
    expect(surfaceLandingPath(media)).toBe("/media/images");
  });

  it("lands every other scenario on its own path", () => {
    for (const entry of ADMIN_PERF_PROFILE.scenarios) {
      if (entry.id === "media-library") continue;
      const { path } = scenarioPath(entry, { postId: "post-1" });
      expect(surfaceLandingPath(entry, path)).toBe(path);
    }
  });

  it("starts the Reports journey from Media and waits on /media/images", () => {
    expect(journeySource("/reports")).toEqual({
      path: "/media",
      landingPath: "/media/images",
      heading: "Media library",
    });
    expect(journeySource("/")).toEqual({ path: "/content/library", landingPath: "/content/library", heading: null });
    expect(journeySource("/content/pages/home/edit")).toEqual({ path: "/content", landingPath: "/content", heading: null });
    expect(journeySource("/content/post/post-1/edit")).toEqual({ path: "/content/post", landingPath: "/content/post", heading: null });
    expect(journeySource("/media")).toEqual({ path: "/reports", landingPath: "/reports", heading: "Reports" });
  });

  it("waits on the landing path in the capture script, never the link path alone", () => {
    const script = readFileSync(resolve(process.cwd(), "../scripts/admin-perf-baseline.mjs"), "utf8");
    expect(script).not.toMatch(/function navigationSource/);
    expect(script).toContain("journeySource(path)");
    expect(script).not.toMatch(/waitForSurface\(page, source\.path/);
    expect(script).toContain("surfaceLandingPath(entry, path)");
  });
});
