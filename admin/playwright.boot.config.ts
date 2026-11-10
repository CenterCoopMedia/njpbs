import { defineConfig } from "@playwright/test";

// Local runs exercise the already-built output, never the Vite dev server.
// The deploy smoke supplies the deployed URL and starts no local server.
const deployedUrl = process.env.ADMIN_BOOT_URL;
const port = 5276;
const baseURL = deployedUrl ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/boot",
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL,
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    launchOptions: { chromiumSandbox: true },
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  webServer: deployedUrl ? undefined : {
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 15_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
