import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  LAUNCH_OPTIONS,
  openAuthenticatedCmsBrowser,
  parseBrowserCredential,
  readBrowserCredential,
  serveDebugBrowser,
  submitCmsSignIn,
} from "../../scripts/cms-debug-browser.mjs";

const credential = {
  email: "dev@example.org",
  password: "private-fixture-password",
};

function fakeBrowser() {
  const browser = new EventEmitter();
  const locator = { fill: vi.fn(), click: vi.fn(), waitFor: vi.fn(async () => {}),
    evaluate: vi.fn(async () => true), dispose: vi.fn() };
  locator.elementHandle = vi.fn(async () => locator);
  const ariaSnapshot = vi.fn(async () => "private before snapshot");
  const page = {
    setDefaultTimeout: vi.fn(),
    goto: vi.fn(),
    url: () => "https://admin.njpbs.org/",
    getByLabel: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    evaluate: vi.fn(() => "a".repeat(40)),
  };
  page.locator = vi.fn((selector) => selector === "body" ? { ariaSnapshot } : page);
  const context = { newPage: vi.fn(async () => page) };
  browser.newContext = vi.fn(async () => context);
  browser.close = vi.fn(async () => browser.emit("disconnected"));
  browser.version = () => "156.0.8078.73";
  browser.newBrowserCDPSession = async () => ({
    send: async () => ({ arguments: ["/opt/google/chrome/chrome", "--enable-automation"] }),
    detach: async () => {},
  });
  return {
    browser,
    context,
    page,
    locator,
    ariaSnapshot,
    chromium: { launch: vi.fn(async () => browser) },
  };
}

describe("CMS debug browser", () => {
  it.each(["156.0.8078.73", "156.0.8078.79", "156.0.8079.0", "157.0.0.0"])("accepts supported browser %s", async (version) => {
    const fake = fakeBrowser();
    fake.browser.version = () => version;
    const session = await openAuthenticatedCmsBrowser({ ...fake, credential });
    await session.browser.close();
  });

  it.each(["151.0.7922.34", "156.0.8078.72", "156.0.8077.99"])("refuses old browser %s before any CMS request", async (version) => {
    const fake = fakeBrowser();
    fake.browser.version = () => version;
    await expect(openAuthenticatedCmsBrowser({ ...fake, credential }))
      .rejects.toThrow(/^browser_version_below_156\.0\.8078\.73$/);
    expect(fake.browser.newContext).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it.each(["--no-sandbox", "--no-sandbox=true", "--disable-setuid-sandbox", "--disable-namespace-sandbox", "--disable-seccomp-filter-sandbox"])("refuses browser sandbox switch %s before any CMS request", async (flag) => {
    const fake = fakeBrowser();
    fake.browser.newBrowserCDPSession = async () => ({
      send: async () => ({ arguments: ["/opt/google/chrome/chrome", flag] }),
      detach: async () => {},
    });
    await expect(openAuthenticatedCmsBrowser({ ...fake, credential }))
      .rejects.toThrow(/^browser_sandbox_required$/);
    expect(fake.browser.newContext).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("refuses unverifiable browser safety without leaking the raw error", async () => {
    const fake = fakeBrowser();
    fake.browser.newBrowserCDPSession = async () => { throw new Error(credential.password); };
    await expect(openAuthenticatedCmsBrowser({ ...fake, credential }))
      .rejects.toThrow(/^browser_safety_check_failed$/);
    expect(fake.locator.fill).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("refuses an unknown browser version before any CMS request", async () => {
    const fake = fakeBrowser();
    fake.browser.version = () => "unknown";
    await expect(openAuthenticatedCmsBrowser({ ...fake, credential }))
      .rejects.toThrow(/^browser_safety_check_failed$/);
    expect(fake.browser.newContext).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("refuses a disabled sandbox before launch", async () => {
    const fake = fakeBrowser();
    LAUNCH_OPTIONS.chromiumSandbox = false;
    try {
      await expect(openAuthenticatedCmsBrowser({ ...fake, credential }))
        .rejects.toThrow(/^browser_sandbox_required$/);
      expect(fake.chromium.launch).not.toHaveBeenCalled();
    } finally {
      LAUNCH_OPTIONS.chromiumSandbox = true;
    }
  });

  it("accepts the dedicated pass format or JSON and returns only email/password", () => {
    expect(
      parseBrowserCredential(
        `${credential.password}\nemail: ${credential.email}\nurl: https://unused.invalid\n`,
      ),
    ).toEqual(credential);
    expect(
      parseBrowserCredential(JSON.stringify({ ...credential, token: "discard" })),
    ).toEqual(credential);
  });

  it("reads the credential from a separate stream", async () => {
    const stream = Readable.from([
      `${credential.password}\nemail: ${credential.email}\n`,
    ]);
    stream.isTTY = false;
    await expect(readBrowserCredential(stream)).resolves.toEqual(credential);
  });

  it("rejects malformed and oversized credentials with fixed errors", () => {
    for (const input of [
      "",
      "{bad",
      "password\nemail: bad",
      "password\nemail: dev@example.org\nemail: other@example.org",
      JSON.stringify({ ...credential, password: "bad\nvalue" }),
      "a".repeat(16385),
    ]) {
      expect(() => parseBrowserCredential(input)).toThrow("invalid_credential");
    }
  });

  it("signs in through the normal form and returns the owned context", async () => {
    const fake = fakeBrowser();
    const session = await openAuthenticatedCmsBrowser({
      ...fake,
      credential,
    });
    expect(fake.chromium.launch).toHaveBeenCalledWith(LAUNCH_OPTIONS);
    expect(LAUNCH_OPTIONS.chromiumSandbox).toBe(true);
    expect(JSON.stringify(LAUNCH_OPTIONS)).not.toContain("--no-sandbox");
    expect(JSON.stringify(LAUNCH_OPTIONS)).not.toContain("--remote-debugging");
    expect(fake.page.goto).toHaveBeenCalledWith(
      "https://admin.njpbs.org/",
      expect.any(Object),
    );
    expect(fake.page.getByLabel.mock.calls).toEqual([
      ["Password", { exact: true }],
      ["Password", { exact: true }],
      ["Email", { exact: true }],
    ]);
    expect(fake.ariaSnapshot.mock.invocationCallOrder[0]).toBeLessThan(fake.locator.fill.mock.invocationCallOrder[0]);
    expect(fake.locator.fill.mock.calls).toEqual([[credential.email], [credential.password], [""]]);
    expect(fake.page.getByRole).toHaveBeenCalledWith("button", {
      name: /^Account menu for /,
    });
    expect(session).toMatchObject({
      browser: fake.browser,
      context: fake.context,
      page: fake.page,
      loadedBuild: "a".repeat(40),
    });
    await session.browser.close();
  });

  it("serves the authenticated context only over stdio and closes on signal", async () => {
    const fake = fakeBrowser();
    const signals = new EventEmitter();
    const input = new EventEmitter();
    const connection = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    let outputMode;
    const createConnection = vi.fn(async (config) => {
      outputMode = (await stat(config.outputDir)).mode & 0o777;
      return connection;
    });
    const transport = { kind: "stdio" };
    const reports = [];
    await serveDebugBrowser({
      ...fake,
      credential,
      signals,
      input,
      createConnection,
      createTransport: () => transport,
      onReady: (report) => {
        reports.push(report);
        signals.emit("SIGTERM");
      },
    });
    expect(createConnection).toHaveBeenCalledWith(
      {
        capabilities: ["core", "devtools"],
        outputDir: expect.stringMatching(/njpbs-cms-browser-[^/]+$/),
        saveSession: false,
        webmcp: false,
      },
      expect.any(Function),
    );
    const contextGetter = createConnection.mock.calls[0][1];
    const outputDir = createConnection.mock.calls[0][0].outputDir;
    await expect(contextGetter()).resolves.toBe(fake.context);
    expect(outputMode).toBe(0o700);
    expect(connection.connect).toHaveBeenCalledWith(transport);
    expect(reports).toEqual([
      {
        ready: true,
        loadedBuild: "a".repeat(40),
        signIn: true,
        transport: "stdio",
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain(credential.password);
    expect(connection.close).toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
    await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes without signing in when interrupted during launch", async () => {
    const fake = fakeBrowser();
    const signals = new EventEmitter();
    const input = new EventEmitter();
    let finishLaunch;
    fake.chromium.launch = vi.fn(
      () =>
        new Promise((resolve) => {
          finishLaunch = () => resolve(fake.browser);
        }),
    );
    const createConnection = vi.fn();
    const run = serveDebugBrowser({
      ...fake,
      credential,
      signals,
      input,
      createConnection,
      createTransport: vi.fn(),
    });
    await vi.waitFor(() => expect(fake.chromium.launch).toHaveBeenCalled());
    signals.emit("SIGTERM");
    finishLaunch();
    await run;
    expect(fake.browser.newContext).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("sanitizes the actual receipt build inside the browser evaluation", async () => {
    try {
      for (const [build, expected] of [
        ["0f6c738", "0f6c738"],
        ["a".repeat(40), "a".repeat(40)],
        ["private-token@example.org", null],
        ["abc123", null],
      ]) {
        const fake = fakeBrowser();
        globalThis.__njpbsAdminPerf = { receipt: () => ({ build }) };
        fake.page.evaluate = vi.fn((callback) => callback());
        const session = await openAuthenticatedCmsBrowser({
          ...fake,
          credential,
        });
        expect(session.loadedBuild).toBe(expected);
        await session.browser.close();
      }
    } finally {
      delete globalThis.__njpbsAdminPerf;
    }
  });

  it("closes on sign-in failure and discards raw Playwright errors", async () => {
    const fake = fakeBrowser();
    fake.locator.waitFor.mockRejectedValue(new Error(credential.password));
    await expect(
      openAuthenticatedCmsBrowser({ ...fake, credential }),
    ).rejects.toThrow(/^browser_sign_in_failed$/);
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("does not fill credentials after a cross-origin redirect", async () => {
    const fake = fakeBrowser();
    fake.page.url = () => "https://other.invalid";
    await expect(
      openAuthenticatedCmsBrowser({ ...fake, credential }),
    ).rejects.toThrow("browser_sign_in_failed");
    expect(fake.locator.fill).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("does not expose a context that leaves the CMS during sign-in", async () => {
    const fake = fakeBrowser();
    fake.page.url = vi
      .fn()
      .mockReturnValueOnce("https://admin.njpbs.org/")
      .mockReturnValue("https://other.invalid/");
    await expect(
      openAuthenticatedCmsBrowser({ ...fake, credential }),
    ).rejects.toThrow("browser_sign_in_failed");
    expect(fake.locator.fill).toHaveBeenCalledTimes(3);
    expect(fake.browser.close).toHaveBeenCalled();
  });

  it("keeps the benchmark in the owned authenticated browser", async () => {
    const source = await readFile(
      new URL("../../scripts/benchmark-cms-readonly.cjs", import.meta.url),
      "utf8",
    );
    expect(source).toContain("openAuthenticatedCmsBrowser");
    expect(source).toContain('"Media library": "/media/images"');
    expect(source).not.toContain("connectOverCDP");
    expect(source).not.toContain("127.0.0.1:9333");
  });

  it.each(["click", "sign-in"])("clears the original typed field after %s failure before returning control", async (failure) => {
    const fake = fakeBrowser();
    const afterSubmit = vi.fn(async () => {
      if (failure === "sign-in") throw new Error(credential.password);
    });
    if (failure === "click") fake.locator.click.mockRejectedValue(new Error(credential.password));
    await expect(submitCmsSignIn(fake.page, async () => credential, afterSubmit)).rejects.toThrow();
    expect(fake.locator.fill.mock.calls).toEqual([[credential.email], [credential.password], [""]]);
    expect(fake.locator.dispose).toHaveBeenCalledOnce();
    expect(fake.ariaSnapshot).toHaveBeenCalledOnce();
  });

  it("does not touch a replacement password field after the typed reference detaches", async () => {
    const fake = fakeBrowser();
    fake.locator.evaluate.mockResolvedValue(false);
    await submitCmsSignIn(fake.page, async () => credential, async () => {});
    expect(fake.locator.fill.mock.calls).toEqual([[credential.email], [credential.password]]);
    expect(fake.locator.dispose).toHaveBeenCalledOnce();
  });

  it("keeps MCP stdio separate from the credential pipe", async () => {
    const source = await readFile(
      new URL("../../scripts/cms-debug-browser.sh", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      '3< <(pass show -- "$CMS_DEBUG_BROWSER_CREDENTIAL_REF" </dev/null)',
    );
    expect(source).not.toContain("3<&0");
    expect(source).not.toContain("--no-sandbox");
    const directory = await mkdtemp(join(tmpdir(), "cms-browser-stdio-"));
    try {
      const calls = join(directory, "pass-calls");
      await writeFile(calls, "");
      await writeFile(join(directory, "pass"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == show && "$2" == -- && "$3" == example/service/credential ]]
if IFS= read -r line; then exit 9; fi
printf read >> "$FIXTURE_PASS_CALLS"
printf '%s' '{"email":"editor@example.org","password":"synthetic-test-password"}'
`, { mode: 0o755 });
      await writeFile(join(directory, "node"), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == scripts/cms-debug-browser.mjs ]]
[[ "$(cat <&3)" == '{"email":"editor@example.org","password":"synthetic-test-password"}' ]]
[[ "$(cat)" == '{"jsonrpc":"2.0","method":"initialize"}' ]]
printf 'separate streams\\n'
`, { mode: 0o755 });
      const env = { PATH: `${directory}:/usr/bin:/bin`, FIXTURE_PASS_CALLS: calls };
      const run = extra => spawnSync("bash", ["scripts/cms-debug-browser.sh"], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        input: '{"jsonrpc":"2.0","method":"initialize"}\n', encoding: "utf8", env: { ...env, ...extra },
      });
      const admitted = run({ CMS_DEBUG_BROWSER_CREDENTIAL_REF: "example/service/credential" });
      expect(admitted.status, admitted.stderr).toBe(0);
      expect(admitted.stdout).toBe("separate streams\n");
      expect(await readFile(calls, "utf8")).toBe("read");
      for (const extra of [{}, { CMS_DEBUG_BROWSER_CREDENTIAL_REF: "" },
        { CMS_DEBUG_BROWSER_CREDENTIAL_REF: "REPLACE_ME" }]) {
        const refused = run(extra);
        expect(refused.status).not.toBe(0);
        expect(refused.stdout).toBe("");
        expect(await readFile(calls, "utf8")).toBe("read");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
