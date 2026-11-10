import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyBrowserSafety } from "../../scripts/cms-debug-browser.mjs";

// Chromium runtime group from Playwright v1.62.1, nativeDeps.ts, ubuntu24.04-x64:
// https://github.com/microsoft/playwright/blob/v1.62.1/packages/playwright-core/src/server/registry/nativeDeps.ts
// Panel flows are headless contracts, so they do not need the optional font/Xvfb
// tool bundle. These are system browser libraries, independent of the JS client.
const chromiumRuntimePackages = [
  "libasound2t64", "libatk-bridge2.0-0t64", "libatk1.0-0t64", "libatspi2.0-0t64",
  "libcairo2", "libcups2t64", "libdbus-1-3", "libdrm2", "libgbm1", "libglib2.0-0t64",
  "libnspr4", "libnss3", "libpango-1.0-0", "libx11-6", "libxcb1", "libxcomposite1",
  "libxdamage1", "libxext6", "libxfixes3", "libxkbcommon0", "libxrandr2",
];

export function ensureRuntimeDependencies(packages, run = spawnSync, log = console.log) {
  if (!Array.isArray(packages) || !packages.length || packages.some((name) => !/^[a-z0-9][a-z0-9+.-]*$/.test(name))) {
    throw new Error("Invalid Chromium runtime dependency plan");
  }
  const missing = [];
  for (const name of new Set(packages)) {
    const result = run("dpkg-query", ["-W", "-f=${Status}", `${name}:amd64`], { encoding: "utf8" });
    if (result.error || ![0, 1].includes(result.status)) throw new Error(`Cannot inspect dependency ${name}`);
    if (result.status !== 0 || !/^\S+ ok installed$/.test(result.stdout.trim())) missing.push(name);
  }
  if (!missing.length) {
    log("Chromium runtime dependencies are already installed");
    return missing;
  }
  for (const args of [
    ["apt-get", "-o", "Acquire::Retries=0", "update"],
    ["apt-get", "-o", "Acquire::Retries=0", "install", "-y", "--no-install-recommends", ...missing],
  ]) {
    const result = run("sudo", args, { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error("Chromium dependency installation failed");
  }
  return missing;
}

async function main() {
  const rootRequire = createRequire(import.meta.url);
  const os = readFileSync("/etc/os-release", "utf8");
  if (process.platform !== "linux" || process.arch !== "x64" || !/^ID=ubuntu$/m.test(os) || !/^VERSION_ID="24\.04"$/m.test(os)) {
    throw new Error("Panel dependency installation requires Ubuntu 24.04 x64");
  }
  ensureRuntimeDependencies(chromiumRuntimePackages);
  const { chromium } = rootRequire("playwright");
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ["--enable-automation"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : { channel: "chrome" }),
  });
  try {
    await verifyBrowserSafety(browser);
    const session = await browser.newBrowserCDPSession();
    const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
    console.log(JSON.stringify({ version: browser.version(), executable: args[0], sandbox: true }));
    await session.detach();
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
