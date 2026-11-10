const { createRequire } = require("node:module");
const adminRequire = createRequire(require.resolve("../admin/package.json"));
const fs = require("node:fs");
const { createCmsNetworkCapture } = require("./lib/cms-network-capture.cjs");
const path = require("node:path");
const output = process.argv[2];
const width = Number(process.argv[3] || 1280);
const expectedBuild = process.env.BENCH_BUILD;
const routePaths = {
  Home: "/",
  Pages: "/content",
  "All content": "/content/library",
  "Media library": "/media",
};
// The rail link can redirect: /media opens the Images tab. Samples wait on and check the
// landing path, while the link check still proves the rail points where it should.
const landingPaths = {
  "Media library": "/media/images",
};
const routes = process.env.BENCH_ROUTES
  ? process.env.BENCH_ROUTES.split(",")
  : ["Home", "Pages", "All content", "Media library"];
const repeats = Number(process.env.BENCH_REPEATS || 3);
const caches = process.env.BENCH_CACHE
  ? [process.env.BENCH_CACHE]
  : ["cold-browser-cache", "warm-browser-cache"];
if (
  !output ||
  !expectedBuild ||
  !/^[a-f0-9]{7,40}$/.test(expectedBuild) ||
  process.argv.length > 4 ||
  ![1280, 390].includes(width) ||
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 5 ||
  routes.some(
    (r) => !["Home", "Pages", "All content", "Media library"].includes(r),
  ) ||
  caches.some((c) => !["cold-browser-cache", "warm-browser-cache"].includes(c))
) {
  console.error(
    "Usage: BENCH_BUILD=SOURCE_SHA node scripts/benchmark-cms-readonly.cjs NEW_OUTPUT.json [1280|390]",
  );
  process.exit(1);
}
// Refuse overwrites. A partial receipt remains available if the run fails.
const file = path.resolve(output);
fs.writeFileSync(
  file,
  JSON.stringify({ schemaVersion: 1, complete: false, samples: [] }),
  { flag: "wx", mode: 0o600 },
);
let phase = "authenticate";

(async () => {
  const { chromium } = adminRequire("@playwright/test");
  const { openAuthenticatedCmsBrowser, readBrowserCredential } = await import(
    "./cms-debug-browser.mjs"
  );
  let credential = await readBrowserCredential(process.stdin);
  const session = await openAuthenticatedCmsBrowser({ chromium, credential });
  credential = undefined;
  const { browser, context, page } = session;
  try {
    phase = "prepare";
    await page.setViewportSize({ width, height: 900 });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const samples = [];
    const network = createCmsNetworkCapture(page);
    let active = false;
    let build = expectedBuild;
    let pageErrors = 0;
    page.on("pageerror", () => {
      if (active) pageErrors++;
    });

    for (const route of routes) {
      phase = "navigate";
      if (width < 600)
        await page
          .getByRole("button", { name: /^Open (?:menu|navigation)$/ })
          .click();
      const link = page
        .getByRole("navigation", { name: "Primary", exact: true })
        .getByRole("link", { name: route, exact: true });
      const expectedPath = routePaths[route];
      if ((await link.getAttribute("href")) !== expectedPath)
        throw new Error("Unexpected route target");
      const landingPath = landingPaths[route] ?? expectedPath;
      await link.click();
      await page.waitForURL((u) => u.pathname === landingPath, {
        timeout: 60000,
      });
      await page.waitForFunction(
        () => globalThis.__njpbsAdminPerf?.receipt?.()?.counts.open === 0,
        {},
        { timeout: 60000 },
      );
      for (let i = 0; i < repeats; i++)
        for (const cache of caches) {
          if (route === "Pages") await page.waitForTimeout(12000);
          if (cache === "cold-browser-cache")
            await cdp.send("Network.clearBrowserCache");
          phase = "sample";
          network.start();
          pageErrors = 0;
          active = true;
          const startedAt = new Date().toISOString();
          const start = performance.now();
          await page.reload({ waitUntil: "domcontentloaded" });
          if (width < 600)
            await page.waitForFunction(
              () =>
                globalThis.__njpbsAdminPerf
                  ?.receipt?.()
                  ?.marks.some(
                    (m) => m.name === "njpbs.admin.profile-confirmed",
                  ),
              {},
              { timeout: 60000 },
            );
          else
            await page
              .getByRole("button", { name: /^Account menu for / })
              .waitFor({ timeout: 60000 });
          await page.waitForFunction(
            () => globalThis.__njpbsAdminPerf?.receipt?.()?.counts.open === 0,
            {},
            { timeout: 60000 },
          );
          let last = -1,
            stable = 0;
          for (let n = 0; n < 120; n++) {
            const count = await page.evaluate(() => {
              const r = globalThis.__njpbsAdminPerf?.receipt?.();
              return r && r.counts.open === 0 ? r.measures.length : -1;
            });
            stable = count >= 0 && count === last ? stable + 1 : 0;
            last = count;
            if (stable >= 3) break;
            await page.waitForTimeout(250);
          }
          active = false;
          const capture = await network.finish();
          const { calls } = capture;
          const elapsedMs = Math.round(performance.now() - start);
          const data = await page.evaluate(() => {
            const r = globalThis.__njpbsAdminPerf?.receipt?.();
            const n = performance.getEntriesByType("navigation")[0];
            const resources = performance.getEntriesByType("resource");
            return {
              path: location.pathname,
              receipt: r,
              domContentLoadedMs: n.domContentLoadedEventEnd,
              ttfbMs: n.responseStart,
              resourceCount: resources.length,
              transferBytes: resources.reduce((s, x) => s + x.transferSize, 0),
              css: resources
                .filter((x) => /\.css(?:\?|$)/.test(x.name))
                .map((x) => ({
                  file: new URL(x.name).pathname.split("/").pop(),
                  bytes: x.encodedBodySize,
                })),
              publicPolls: resources.filter((x) =>
                x.name.startsWith("https://njpbs.org/_publication"),
              ).length,
              recaptchaRequests: resources.filter((x) =>
                /recaptcha/.test(x.name),
              ).length,
              layout: {
                width: innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
              },
            };
          });
          if (data.path !== landingPath)
            throw new Error("Wrong benchmark route");
          const view = await page.evaluate((route) => {
            const visible = (selector) =>
              [...document.querySelectorAll(selector)].some(
                (el) => el.getClientRects().length > 0,
              );
            const readySelectors = {
              Home: ".recent-work-list, .recent-work-panel .empty-state",
              Pages: 'table[aria-label="Live site pages"]',
              "All content":
                'table[aria-label="All content results"], .content-library .empty-state',
              "Media library": '.media-result-bar [role="status"]',
            };
            const errors = visible(
              '[role="alert"], .inline-message-error, .newsroom-status-retry',
            );
            const loading = visible('.loading-indicator, [aria-busy="true"]');
            return { ready: visible(readySelectors[route]), errors, loading };
          }, route);
          const valid = Boolean(
            view.ready &&
            !view.errors &&
            !view.loading &&
            stable >= 3 &&
            pageErrors === 0 &&
            typeof data.receipt?.build === "string" &&
            build.startsWith(data.receipt.build) &&
            data.receipt?.counts.open === 0 &&
            data.receipt?.build &&
            calls.length > 0 &&
            calls.every((c) => c.status >= 200 && c.status < 400) &&
            data.layout.scrollWidth <= data.layout.width &&
            data.receipt.marks.length > 0,
          );
          const sample = {
            valid,
            pageErrors,
            view,
            route,
            cache,
            iteration: i + 1,
            startedAt,
            elapsedMs,
            appWorkFinishedMs: Math.max(
              0,
              ...(data.receipt?.marks ?? []).map((m) => m.startTime),
            ),
            ...data,
            ...capture,
          };
          samples.push(sample);
          fs.writeFileSync(
            file,
            JSON.stringify(
              {
                schemaVersion: 1,
                complete:
                  samples.length === routes.length * repeats * caches.length &&
                  samples.every((sample) => sample.valid),
                profile: {
                  build,
                  routes,
                  repeats,
                  caches,
                  viewport: `${width}x900`,
                  cpu: "native",
                  network: "native operator connection",
                  auth: "authenticated user",
                  note: "Browser cache only; backend cold starts are uncontrolled.",
                },
                samples,
              },
              null,
              2,
            ),
          );
          console.log(
            JSON.stringify({
              route,
              cache,
              iteration: i + 1,
              elapsedMs,
              build: data.receipt?.build,
              apiCalls: calls.length,
              open: data.receipt?.counts.open,
              valid,
            }),
          );
          if (!valid) throw new Error("Invalid sample");
        }
    }
    await cdp.detach();
  } finally {
    await browser.close();
  }
})().catch((e) => {
  const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    file,
    JSON.stringify(
      { ...receipt, complete: false, failure: { phase, type: e.name } },
      null,
      2,
    ),
  );
  console.error(
    JSON.stringify({
      error: e.name,
      message: "Benchmark incomplete; inspect saved samples.",
    }),
  );
  process.exit(1);
});
