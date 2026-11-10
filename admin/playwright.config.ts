import { defineConfig, devices } from "@playwright/test";

// The visual regression harness for the admin design gallery (#1036, criterion 7).
//
// It drives the gallery's existing `gallery.html?embed=<id>` seam, which renders one
// specimen alone from the real components with mock props, and compares the result with a
// committed baseline. Nothing here touches the admin build: the gallery is dev-only and
// vite never emits it.
//
// Determinism comes from four places, and all four matter:
//   * one browser (Chromium) and one device scale factor, pinned below;
//   * a pinned locale and time zone, so every rendered date reads the same;
//   * a frozen clock, installed per test, so fixtures that say "60 seconds ago" do not
//     drift between runs;
//   * a fonts-ready gate plus generated-id normalization before each capture, in the spec.

const PORT = Number(process.env.ADMIN_GALLERY_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
if (!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  throw new Error("Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to the approved headless shell; see docs/cms/admin-editorial-coverage.md");
}

export default defineConfig({
  testDir: "./tests/visual",
  // One worker: the specimens share one vite dev server, and serialized runs keep the
  // capture timing -- and so the baselines -- reproducible.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 60_000,
  expect: {
    toHaveScreenshot: {
      // Antialiasing budget. `threshold` is the per-pixel YIQ distance that still counts as
      // the same color. The absolute cap absorbs isolated subpixel text differences but
      // cannot hide even one missing 44-by-44 control, regardless of screenshot height.
      threshold: 0.2,
      maxDiffPixels: 500,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  // Baselines live beside the suite, one flat directory, named by specimen, presentation
  // and width. Flat and predictable so a reviewer can scan the diff of a PR.
  snapshotPathTemplate: "{testDir}/baselines/{arg}{ext}",
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    timezoneId: "America/New_York",
    colorScheme: "light",
    deviceScaleFactor: 1,
    // Captures should show the resting state, not a transition mid-flight.
    contextOptions: { reducedMotion: "reduce" },
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        // CI and local runs select the approved headless shell for unchanged goldens.
        launchOptions: {
          chromiumSandbox: true,
          ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
            : {}),
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `${BASE_URL}/gallery.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
