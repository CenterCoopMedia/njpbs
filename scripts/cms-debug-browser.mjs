#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const SIGN_IN_TIMEOUT_MS = 60_000;
const CREDENTIAL_TIMEOUT_MS = 10_000;
const CREDENTIAL_FD = 3;
const MINIMUM_BROWSER_VERSION = "156.0.8078.73";
const BROWSER_SAFETY_ERRORS = [
  `browser_version_below_${MINIMUM_BROWSER_VERSION}`,
  "browser_sandbox_required",
  "browser_safety_check_failed",
];

export const LAUNCH_OPTIONS = {
  channel: "chrome",
  headless: true,
  chromiumSandbox: true,
  args: [
    // Required for Chrome's Browser.getBrowserCommandLine safety check.
    "--enable-automation",
    "--renderer-process-limit=1",
    "--disable-features=SpareRendererForSitePerProcess",
  ],
};

export async function verifyBrowserSafety(browser) {
  const version = browser.version();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("browser_safety_check_failed");
  }
  const actual = version.split(".").map(Number);
  const minimum = MINIMUM_BROWSER_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] > minimum[index]) break;
    if (actual[index] < minimum[index]) throw new Error(BROWSER_SAFETY_ERRORS[0]);
  }
  let cdp;
  try {
    cdp = await browser.newBrowserCDPSession();
    const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
    if (args.some((arg) => /^--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox)(?:=|$)/.test(arg))) {
      throw new Error("browser_sandbox_required");
    }
  } catch (error) {
    throw new Error(error?.message === "browser_sandbox_required"
      ? error.message : "browser_safety_check_failed");
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

export async function launchCmsBrowser(chromium) {
  if (LAUNCH_OPTIONS.chromiumSandbox !== true) {
    throw new Error("browser_sandbox_required");
  }
  const browser = await chromium.launch(LAUNCH_OPTIONS);
  try {
    await verifyBrowserSafety(browser);
    return browser;
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export function parseBrowserCredential(input) {
  if (
    typeof input !== "string" ||
    Buffer.byteLength(input) > MAX_CREDENTIAL_BYTES
  ) {
    throw new Error("invalid_credential");
  }
  let credential;
  if (input.trimStart().startsWith("{")) {
    try {
      credential = JSON.parse(input);
    } catch {
      throw new Error("invalid_credential");
    }
  } else {
    const [password, ...lines] = input.split(/\r?\n/);
    const emails = lines.filter((line) => /^email:\s*/i.test(line));
    if (emails.length !== 1) throw new Error("invalid_credential");
    credential = {
      password,
      email: emails[0].replace(/^email:\s*/i, "").trim(),
    };
  }
  if (
    typeof credential?.email !== "string" ||
    credential.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credential.email) ||
    typeof credential.password !== "string" ||
    credential.password.length === 0 ||
    credential.password.length > 4096 ||
    /[\r\n\0]/.test(credential.password)
  ) {
    throw new Error("invalid_credential");
  }
  return { email: credential.email, password: credential.password };
}

export async function readBrowserCredential(
  stream,
  timeoutMs = CREDENTIAL_TIMEOUT_MS,
) {
  if (!stream || stream.isTTY) throw new Error("invalid_credential");
  stream.setEncoding("utf8");
  const timeout = setTimeout(
    () => stream.destroy(new Error("credential_timeout")),
    timeoutMs,
  );
  let input = "";
  try {
    for await (const chunk of stream) {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_CREDENTIAL_BYTES) {
        throw new Error("invalid_credential");
      }
    }
    return parseBrowserCredential(input);
  } catch (error) {
    if (
      error?.message === "invalid_credential" ||
      error?.message === "credential_timeout"
    ) {
      throw error;
    }
    throw new Error("invalid_credential");
  } finally {
    clearTimeout(timeout);
    if (!stream.destroyed) stream.destroy();
  }
}

// Keep the before snapshot inside the tool. Never expose a typed password to
// the MCP client, including when submission or the sign-in wait fails.
export async function submitCmsSignIn(page, readCredential, waitForSignIn) {
  await page.getByLabel("Password", { exact: true }).waitFor({ state: "visible" });
  await page.locator("body").ariaSnapshot();
  const password = await page.getByLabel("Password", { exact: true }).elementHandle();
  if (!password) throw new Error("browser_sign_in_failed");
  try {
    const credential = await readCredential();
    await page.getByLabel("Email", { exact: true }).fill(credential.email);
    await password.fill(credential.password);
    const signedIn = waitForSignIn();
    // A failed click must not leave a rejected response waiter unhandled.
    void signedIn.catch(() => {});
    await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
    return await signedIn;
  } finally {
    // This is the original element reference, never a hidden field or a new
    // password input that might have replaced it after navigation.
    try {
      if (await password.evaluate((element) => element.isConnected)) await password.fill("");
    } finally {
      await password.dispose();
    }
  }
}

export async function openAuthenticatedCmsBrowser({
  chromium,
  credential,
  onBrowser = () => {},
  shouldStop = () => false,
}) {
  let browser;
  try {
    browser = await launchCmsBrowser(chromium);
    onBrowser(browser);
    if (shouldStop()) throw new Error("browser_sign_in_failed");
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(SIGN_IN_TIMEOUT_MS);
    await page.goto("https://admin.njpbs.org/", {
      waitUntil: "domcontentloaded",
      timeout: SIGN_IN_TIMEOUT_MS,
    });
    if (new URL(page.url()).origin !== "https://admin.njpbs.org") {
      throw new Error("browser_sign_in_failed");
    }
    await submitCmsSignIn(page, async () => credential, () => page
      .getByRole("button", { name: /^Account menu for / })
      .waitFor({ state: "visible", timeout: SIGN_IN_TIMEOUT_MS }));
    if (new URL(page.url()).origin !== "https://admin.njpbs.org") {
      throw new Error("browser_sign_in_failed");
    }
    const loadedBuild = await page.evaluate(() => {
      const build = globalThis.__njpbsAdminPerf?.receipt?.()?.build;
      return typeof build === "string" && /^[a-f0-9]{7,40}$/.test(build)
        ? build
        : null;
    });
    return { browser, context, page, loadedBuild };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (BROWSER_SAFETY_ERRORS.includes(error?.message)) throw error;
    throw new Error("browser_sign_in_failed");
  }
}

export async function serveDebugBrowser({
  chromium,
  credential,
  createConnection,
  createTransport,
  input = process.stdin,
  signals = process,
  onReady = () => {},
}) {
  let browser;
  let connection;
  let outputDir;
  let stopping = false;
  let finish;
  const stopped = new Promise((resolve) => {
    finish = resolve;
  });
  function stop() {
    if (stopping) return;
    stopping = true;
    finish();
    if (browser) void browser.close().catch(() => {});
  }
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  input.once("end", stop);
  input.once("close", stop);
  if (input.readableEnded || input.destroyed) stop();
  try {
    outputDir = await mkdtemp(join(tmpdir(), "njpbs-cms-browser-"));
    await chmod(outputDir, 0o700);
    if (stopping) return;
    const session = await openAuthenticatedCmsBrowser({
      chromium,
      credential,
      onBrowser(value) {
        browser = value;
        browser.once("disconnected", stop);
        if (stopping) void browser.close().catch(() => {});
      },
      shouldStop: () => stopping,
    });
    credential = undefined;
    if (stopping) return;
    connection = await createConnection(
      {
        capabilities: ["core", "devtools"],
        outputDir,
        saveSession: false,
        webmcp: false,
      },
      async () => session.context,
    );
    if (stopping) return;
    await connection.connect(createTransport());
    if (stopping) return;
    await onReady({
      ready: true,
      loadedBuild: session.loadedBuild,
      signIn: true,
      transport: "stdio",
    });
    await stopped;
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
    input.removeListener("end", stop);
    input.removeListener("close", stop);
    await connection?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (outputDir) await rm(outputDir, { force: true, recursive: true });
  }
}

async function main() {
  try {
    if (process.env.DEBUG || process.env.PWDEBUG) {
      throw new Error("debug_logging_not_allowed");
    }
    if (process.argv.length !== 2) throw new Error("invalid_arguments");
    const credentialStream = createReadStream("", {
      fd: CREDENTIAL_FD,
      autoClose: true,
    });
    let credential = await readBrowserCredential(credentialStream);
    const require = createRequire(new URL("../admin/package.json", import.meta.url));
    const { chromium } = require("@playwright/test");
    const { createConnection } = await import("@playwright/mcp");
    const { StdioServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/stdio.js"
    );
    const serving = serveDebugBrowser({
      chromium,
      credential,
      createConnection,
      createTransport: () => new StdioServerTransport(),
      onReady: (report) =>
        new Promise((resolve) => {
          process.stderr.write(`${JSON.stringify(report)}\n`, resolve);
        }),
    });
    credential = undefined;
    await serving;
  } catch (error) {
    const allowed = [
      "invalid_arguments",
      "invalid_credential",
      "credential_timeout",
      "browser_sign_in_failed",
      "debug_logging_not_allowed",
      ...BROWSER_SAFETY_ERRORS,
    ];
    const code = allowed.includes(error?.message)
      ? error.message
      : "browser_unavailable";
    process.stderr.write(`${JSON.stringify({ ready: false, error: code })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
