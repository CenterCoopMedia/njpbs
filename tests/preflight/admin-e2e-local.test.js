import {
  mkdirSync,
  mkdtempSync,
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_E2E_PROJECT_ID,
  assertEmulatorEnvironment,
  assertFunctionsEmulatorEnvContract,
  assertFunctionsSecretOverride,
  assertIsolatedEmulatorOutput,
  assertLoopbackHttpUrl,
  assertProductionEndpointsAbsent,
  assertSafeHostEnvironment,
  cleanupFunctionsSecretOverride,
  createFunctionsSecretOverride,
  productionBuildFindings,
  sanitizedSubprocessEnv,
} from "../../scripts/lib/admin-e2e-guard.mjs";
import {
  ADMIN_E2E_IDENTITIES,
  ADMIN_E2E_REVISION_FIXTURE,
  resetFixtureProject,
} from "../../scripts/lib/admin-e2e-fixtures.mjs";
import {
  agentBrowserArgs,
  assertEditorTitleValue,
  assertHomeSnapshot,
  assertRefOnlyActions,
  assertRevisionComparisonSnapshot,
  assertRevisionComparisonText,
  assertRevisionEditorSnapshot,
  clickNamedCommand,
  scopedTreeRef,
  signInEmailCommand,
  signInPasswordCommand,
  signInSnapshotCommands,
  signInSubmitCommand,
  runAgentBrowserBatch,
} from "../../scripts/lib/admin-e2e-browser.mjs";
import {
  createStreamOutputGuard,
  forwardSignalAndWait,
  waitForOwnedPreview,
} from "../../scripts/lib/admin-e2e-process.mjs";

const temporaryDirectories = [];
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "admin-e2e-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function emulatorEnvFixture(body = "SAFE_VALUE=loopback-only\n") {
  const root = temporaryDirectory();
  const functionsDirectory = join(root, "functions");
  mkdirSync(functionsDirectory);
  writeFileSync(join(functionsDirectory, ".env.example"), "# inert template\n");
  writeFileSync(join(functionsDirectory, ".env.local"), body);
  return {
    body,
    functionsDirectory,
    root,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function emulatorEnvironment(overrides = {}) {
  return {
    GCLOUD_PROJECT: ADMIN_E2E_PROJECT_ID,
    GOOGLE_CLOUD_PROJECT: ADMIN_E2E_PROJECT_ID,
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8180",
    FIRESTORE_EMULATOR_PORT: "8180",
    FUNCTIONS_EMULATOR: "true",
    FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5001",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Admin E2E fail-closed guard", () => {
  it("accepts only exact loopback HTTP origins", () => {
    expect(assertLoopbackHttpUrl("http://127.0.0.1:4173", "Admin", 4173)).toBe(
      "http://127.0.0.1:4173",
    );
    for (const value of [
      "https://127.0.0.1:4173",
      "http://localhost:4173",
      "http://0.0.0.0:4173",
      "http://127.0.0.1:4174",
      "http://person:secret@127.0.0.1:4173",
      "http://127.0.0.1:4173/admin",
    ]) {
      expect(() => assertLoopbackHttpUrl(value, "Admin", 4173)).toThrow();
    }
  });

  it("refuses ADC, production config, and pre-existing emulator routing", () => {
    expect(() =>
      assertSafeHostEnvironment({
        PATH: "/usr/bin",
        GOOGLE_APPLICATION_CREDENTIALS: "/not/read.json",
      }),
    ).toThrow(/credential environment keys/);
    expect(() =>
      assertSafeHostEnvironment({
        PATH: "/usr/bin",
        VITE_FIREBASE_PROJECT_ID: "njpbs-site",
      }),
    ).toThrow(/production-config environment keys/);
    expect(() =>
      assertSafeHostEnvironment({
        PATH: "/usr/bin",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      }),
    ).toThrow(/pre-existing emulator environment keys/);
    expect(() =>
      assertSafeHostEnvironment({
        PATH: "/usr/bin",
        GOOGLE_CLOUD_PROJECT: "njpbs-site",
      }),
    ).toThrow(/project selection/);
  });

  it("requires the fixed demo project and exact loopback emulator hosts", () => {
    expect(assertEmulatorEnvironment(emulatorEnvironment())).toEqual({
      firestorePort: 8180,
    });
    expect(() =>
      assertEmulatorEnvironment(
        emulatorEnvironment({ GOOGLE_CLOUD_PROJECT: "njpbs-site" }),
      ),
    ).toThrow(/requires project demo-njpbs/);
    expect(() =>
      assertEmulatorEnvironment(
        emulatorEnvironment({ FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }),
      ),
    ).toThrow(/Auth emulator must be exactly/);
    expect(() =>
      assertEmulatorEnvironment(
        emulatorEnvironment({ FIRESTORE_EMULATOR_HOST: "10.0.0.1:8180" }),
      ),
    ).toThrow(/Firestore emulator must be exactly/);
    expect(() =>
      assertEmulatorEnvironment(
        emulatorEnvironment({ FUNCTIONS_EMULATOR_HOST: "10.0.0.1:5001" }),
      ),
    ).toThrow(/Functions emulator must be exactly/);
  });

  it("builds a minimal subprocess environment without tokens or production inputs", () => {
    const safe = sanitizedSubprocessEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp/example-home",
        FIREBASE_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        VITE_FUNCTIONS_BASE_URL: "https://api.example.org",
        GOOGLE_APPLICATION_CREDENTIALS: "/not/read.json",
      },
      { firestorePort: 8180, runtimeDirectory: "/tmp/admin-e2e-runtime" },
    );
    expect(safe).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/tmp/example-home",
      FIRESTORE_EMULATOR_PORT: "8180",
      ADMIN_E2E_RUNTIME_DIR: "/tmp/admin-e2e-runtime",
      CMS_EDGE_ORIGIN_SECRET: "local-cms-edge-only",
      METADATA_SERVER_DETECTION: "none",
    });
    for (const key of [
      "FIREBASE_TOKEN",
      "GITHUB_TOKEN",
      "VITE_FUNCTIONS_BASE_URL",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]) {
      expect(safe).not.toHaveProperty(key);
    }
  });

  it("allows only approved dispatch repository values while retaining production endpoint refusal", () => {
    const original = readFileSync(join(repoRoot, "scripts/fixtures/functions-emulator.env.example"), "utf8");
    for (const repository of ["CenterCoopMedia/njpbs", "other/repo"]) {
      const body = original.replace("CMS_PUBLISH_GITHUB_REPOSITORY=CenterCoopMedia/njpbs", `CMS_PUBLISH_GITHUB_REPOSITORY=${repository}`);
      const fixture = emulatorEnvFixture(body);
      const check = () => assertFunctionsEmulatorEnvContract(fixture.root, { approvedSha256: fixture.sha256 });
      if (repository === "other/repo") expect(check).toThrow(/unsafe emulator environment content/);
      else expect(check).not.toThrow();
    }
    const fixture = emulatorEnvFixture(original + "UNRELATED_TARGET=https://admin.njpbs.org\n");
    expect(() => assertFunctionsEmulatorEnvContract(fixture.root, { approvedSha256: fixture.sha256 }))
      .toThrow(/unsafe emulator environment content/);
  });

  it("requires the exact tracked emulator dotenv contract", () => {
    const approved = emulatorEnvFixture(readFileSync(join(repoRoot, "scripts/fixtures/functions-emulator.env.example"), "utf8"));
    expect(() => assertFunctionsEmulatorEnvContract(approved.root)).not.toThrow();

    const fixture = emulatorEnvFixture();
    expect(() =>
      assertFunctionsEmulatorEnvContract(fixture.root, {
        approvedSha256: fixture.sha256,
      }),
    ).not.toThrow();
    writeFileSync(
      join(fixture.functionsDirectory, ".env.local"),
      `${fixture.body}ANOTHER_SAFE_VALUE=changed\n`,
    );
    expect(() =>
      assertFunctionsEmulatorEnvContract(fixture.root, {
        approvedSha256: fixture.sha256,
      }),
    ).toThrow(/modified emulator environment content/);
  });

  it("refuses the retired GitHub preview environment with the default approval", () => {
    const body = readFileSync(join(repoRoot, "scripts/fixtures/functions-emulator.env.example"), "utf8");
    const fixture = emulatorEnvFixture(body);
    expect(() => assertFunctionsEmulatorEnvContract(fixture.root)).not.toThrow();

    writeFileSync(
      join(fixture.functionsDirectory, ".env.local"),
      body.replace(
        "CMS_PREVIEW_TRANSPORT=serializer\n",
        "CMS_PREVIEW_WRITEBACK_CONFIGURED=true\nCMS_PREVIEW_TRANSPORT=github\n",
      ),
    );
    expect(() => assertFunctionsEmulatorEnvContract(fixture.root)).toThrow(
      /modified emulator environment content/,
    );
  });

  it("refuses alternate dotenv files and symlinks before Firebase starts", () => {
    const alternate = emulatorEnvFixture();
    writeFileSync(join(alternate.functionsDirectory, ".env.demo-njpbs"), "");
    expect(() =>
      assertFunctionsEmulatorEnvContract(alternate.root, {
        approvedSha256: alternate.sha256,
      }),
    ).toThrow(/unexpected Functions environment files/);

    const linked = emulatorEnvFixture();
    rmSync(join(linked.functionsDirectory, ".env.local"));
    symlinkSync(".env.example", join(linked.functionsDirectory, ".env.local"));
    expect(() =>
      assertFunctionsEmulatorEnvContract(linked.root, {
        approvedSha256: linked.sha256,
      }),
    ).toThrow(/unsafe Functions environment file/);
  });

  it("creates and removes one verified inert Functions secret override", () => {
    const fixture = emulatorEnvFixture();
    const receipt = createFunctionsSecretOverride(fixture.root);
    expect(receipt.removed).toBe(false);
    expect(() => assertFunctionsSecretOverride(receipt)).not.toThrow();
    expect(readFileSync(receipt.path, "utf8")).toContain(
      "CMS_PUBLISH_GITHUB_TOKEN=local-emulator-publish-token-value\n",
    );
    expect(readFileSync(receipt.path, "utf8")).toContain(
      "CMS_STAFF_EMAIL_API_TOKEN=local-emulator-staff-email-api-token-value\n",
    );
    cleanupFunctionsSecretOverride(receipt);
    expect(receipt.removed).toBe(true);
    const secondReceipt = createFunctionsSecretOverride(fixture.root);
    cleanupFunctionsSecretOverride(secondReceipt);
  });

  it("resolves private video mounts offline through the real Firebase secret resolver", async () => {
    const require = createRequire(import.meta.url);
    const secretManager = require("firebase-tools/lib/gcp/secretManager");
    const network = vi.spyOn(secretManager, "accessSecretVersion")
      .mockRejectedValue(new Error("External secret access is refused in this test"));
    const { FunctionsEmulator } = require("firebase-tools/lib/emulator/functionsEmulator");
    const fixture = emulatorEnvFixture();
    const receipt = createFunctionsSecretOverride(fixture.root);
    // These names are the approved private-delivery secret contract (#3760).
    const keys = ["CMS_PRIVATE_VIDEO_R2_READ_ACCESS_KEY_ID", "CMS_PRIVATE_VIDEO_R2_READ_SECRET_ACCESS_KEY",
      "CMS_PRIVATE_VIDEO_R2_WRITE_ACCESS_KEY_ID", "CMS_PRIVATE_VIDEO_R2_WRITE_SECRET_ACCESS_KEY"];
    try {
      await FunctionsEmulator.prototype.resolveSecretEnvs.call({
        args: { projectDir: fixture.root }, getProjectId: () => ADMIN_E2E_PROJECT_ID,
        logger: { logLabeled() {} },
      }, { functionsDir: fixture.functionsDirectory }, {
        secretEnvironmentVariables: keys.map(key => ({ key, secret: key })),
      });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      cleanupFunctionsSecretOverride(receipt);
    }
  });

  it("refuses a pre-existing Functions secret entry or symlink", () => {
    const existing = emulatorEnvFixture();
    writeFileSync(
      join(existing.functionsDirectory, ".secret.local"),
      "CMS_EDGE_ORIGIN_SECRET=local-cms-edge-only\n",
    );
    expect(() => createFunctionsSecretOverride(existing.root)).toThrow(
      /pre-existing Functions secret file/,
    );

    const linked = emulatorEnvFixture();
    symlinkSync(
      ".env.example",
      join(linked.functionsDirectory, ".secret.local"),
    );
    expect(() => createFunctionsSecretOverride(linked.root)).toThrow(
      /pre-existing Functions secret file/,
    );
  });

  it("refuses unsafe secret replacement, mode, key, content, and production values", () => {
    const mutations = [
      (path) => chmodSync(path, 0o644),
      (path) => writeFileSync(path, "OTHER_KEY=loopback-only\n"),
      (path) =>
        writeFileSync(
          path,
          "CMS_EDGE_ORIGIN_SECRET=https://api.example.org\n",
        ),
      (path) => {
        const replacement = `${path}.replacement`;
        writeFileSync(
          replacement,
          "CMS_EDGE_ORIGIN_SECRET=local-cms-edge-only\n",
          { mode: 0o600 },
        );
        renameSync(replacement, path);
      },
    ];
    for (const mutate of mutations) {
      const fixture = emulatorEnvFixture();
      const receipt = createFunctionsSecretOverride(fixture.root);
      mutate(receipt.path);
      expect(() => assertFunctionsSecretOverride(receipt)).toThrow(
        /unsafe Functions secret override/,
      );
      expect(() => cleanupFunctionsSecretOverride(receipt)).toThrow(
        /unsafe Functions secret override/,
      );
      expect(receipt.removed).toBe(false);
    }
  });

  it("refuses ambiguous, credential-shaped, and production dotenv content", () => {
    for (const body of [
      "SAFE_VALUE=one\nSAFE_VALUE=two\n",
      "export SAFE_VALUE=loopback-only\n",
      "CMS_EDGE_ORIGIN_SECRET=not-a-production-secret\n",
      "CMS_TRANSCRIPTION_CREDENTIAL_KEY_VERSION=1\n",
      "CMS_TRANSCRIPTION_CREDENTIAL_KEY=\n",
      "SAFE_VALUE=github_pat_exampleonly\n",
      "SAFE_VALUE=https://api.example.org\n",
      "SAFE_VALUE=njpbs-site\n",
    ]) {
      const fixture = emulatorEnvFixture(body);
      expect(() =>
        assertFunctionsEmulatorEnvContract(fixture.root, {
          approvedSha256: fixture.sha256,
        }),
      ).toThrow(/ambiguous|unsafe emulator environment content/);
    }
  });

  it("fails closed on secret resolution, auth attempts, and production endpoints", () => {
    expect(() =>
      assertIsolatedEmulatorOutput(
        "Functions health probe: loopback response received.",
      ),
    ).not.toThrow();
    for (const output of [
      "Trying to access secret CMS_EDGE_ORIGIN_SECRET@latest",
      "Unable to access secret environment variables",
      "Google Cloud Secret Manager request",
      "Unable to refresh auth: not yet authenticated",
      "request https://api.example.org/health",
      "request https://admin.njpbs.org/",
    ]) {
      expect(() => assertIsolatedEmulatorOutput(output)).toThrow(
        /external secret resolution or a production endpoint/,
      );
    }
  });

  it("keeps forbidden-output tails independent across stdout and stderr", () => {
    const inspect = createStreamOutputGuard(assertIsolatedEmulatorOutput);
    inspect("stdout", "Trying to access se");
    inspect("stderr", "an unrelated local warning");
    expect(() =>
      inspect("stdout", "cret CMS_EDGE_ORIGIN_SECRET@latest"),
    ).toThrow(/external secret resolution/);
  });

  it("forwards a termination signal and waits for the child exit", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    let exited = false;
    child.kill = vi.fn((signal) => {
      setTimeout(() => {
        exited = true;
        child.signalCode = signal;
        child.emit("exit", null, signal);
      }, 5);
      return true;
    });
    await forwardSignalAndWait(child, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(exited).toBe(true);
  });

  it("requires spawned-preview readiness and exact build-specific bytes", async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "exact-build-status\n",
    }));
    const ready = waitForOwnedPreview({
      child,
      origin: "http://127.0.0.1:4173",
      expectedStatusBody: "exact-build-status\n",
      fetchFn,
      timeoutMs: 100,
    });
    child.stdout.write("Local: http://127.0.0.1:4173/\n");
    await expect(ready).resolves.toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const foreign = new EventEmitter();
    foreign.pid = 5678;
    foreign.exitCode = null;
    foreign.signalCode = null;
    foreign.stdout = new PassThrough();
    const notCalled = vi.fn();
    const refused = waitForOwnedPreview({
      child: foreign,
      origin: "http://127.0.0.1:4173",
      expectedStatusBody: "exact-build-status\n",
      fetchFn: notCalled,
      timeoutMs: 100,
    });
    foreign.exitCode = 1;
    foreign.emit("exit", 1, null);
    await expect(refused).rejects.toThrow(/exited before readiness/);
    expect(notCalled).not.toHaveBeenCalled();
  });

  it("terminates and awaits an agent-browser command that exceeds its deadline", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let exited = false;
    child.kill = vi.fn((signal) => {
      setTimeout(() => {
        exited = true;
        child.signalCode = signal;
        child.emit("exit", null, signal);
      }, 5);
      return true;
    });
    await expect(
      runAgentBrowserBatch([["snapshot", "-c"]], {
        env: {},
        session: "timeout-test",
        spawnFn: () => child,
        timeoutMs: 1,
        terminateGraceMs: 50,
      }),
    ).rejects.toThrow(/timed out/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(exited).toBe(true);
  });

  it("fails a built artifact that contains a production service endpoint", () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<main>loopback only</main>");
    writeFileSync(
      join(directory, "assets", "app.js"),
      'fetch("https://api.example.org/cmsListContent")',
    );
    expect(productionBuildFindings(directory)).toEqual([
      { file: "assets/app.js", marker: "api.example.org" },
    ]);
    expect(() => assertProductionEndpointsAbsent(directory)).toThrow(
      /assets\/app.js/,
    );
  });

  it("permits only the inert canonical Admin Open Graph metadata", () => {
    const directory = temporaryDirectory();
    mkdirSync(join(directory, "assets"));
    writeFileSync(
      join(directory, "index.html"),
      '<meta property="og:url" content="https://admin.njpbs.org/" />',
    );
    writeFileSync(join(directory, "assets", "app.js"), "console.log('local')");
    expect(() => assertProductionEndpointsAbsent(directory)).not.toThrow();

    writeFileSync(
      join(directory, "assets", "app.js"),
      'fetch("https://admin.njpbs.org/")',
    );
    expect(() => assertProductionEndpointsAbsent(directory)).toThrow(
      /assets\/app.js/,
    );
  });
});

describe("Admin E2E fixture and browser contracts", () => {
  it("uses deterministic reserved identities across the minimal role matrix", () => {
    expect(ADMIN_E2E_IDENTITIES.map((identity) => identity.uid)).toEqual([
      "admin-e2e-super-admin",
      "admin-e2e-section-editor",
      "admin-e2e-pending",
    ]);
    expect(
      ADMIN_E2E_IDENTITIES.every((identity) =>
        identity.email.endsWith(".invalid"),
      ),
    ).toBe(true);
    expect(
      ADMIN_E2E_IDENTITIES.map((identity) => identity.profile?.role ?? null),
    ).toEqual(["super_admin", null, null]);
    expect(ADMIN_E2E_IDENTITIES[1].profile.grants).toEqual([
      { role: "editor", sections: ["watch"] },
    ]);
    expect(ADMIN_E2E_IDENTITIES[2].profile).toBeNull();
  });

  it("keeps the revision proof on one deterministic disposable record", () => {
    expect(ADMIN_E2E_REVISION_FIXTURE).toEqual({
      collection: "cmsPosts",
      documentId: "admin-e2e-draft",
      route: "/content/post/admin-e2e-draft/edit",
      currentTitle: "Loopback newsroom fixture",
      historicalTitle: "Archived newsroom draft",
      historicalRevisionId: "admin-e2e-revision-v1",
      currentRevisionId: "admin-e2e-revision-v3",
      historicalVersion: 1,
      currentVersion: 3,
      finalVersion: 5,
    });
    expect(
      ADMIN_E2E_REVISION_FIXTURE.currentTitle.includes(
        ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
      ),
    ).toBe(false);
    expect(
      ADMIN_E2E_REVISION_FIXTURE.historicalTitle.includes(
        ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      ),
    ).toBe(false);
  });

  it("resets only the fixed demo project on the supplied loopback hosts", async () => {
    const requests = [];
    const fetchFn = vi.fn(async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    });
    await resetFixtureProject({
      authHost: "127.0.0.1:9099",
      firestoreHost: "127.0.0.1:8180",
      fetchFn,
    });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8180/emulator/v1/projects/demo-njpbs/databases/(default)/documents",
        options: { method: "DELETE" },
      },
      {
        url: "http://127.0.0.1:9099/emulator/v1/projects/demo-njpbs/accounts",
        options: { method: "DELETE" },
      },
    ]);
  });

  it("builds sign-in actions only from snapshot refs and keeps the secret off argv", () => {
    const secret = "random-in-memory-password";
    const snapshot = {
      refs: {
        e0: { role: "button", name: "Sign in" },
        e1: { role: "textbox", name: "Email" },
        e2: { role: "textbox", name: "Password" },
        e3: { role: "button", name: "Sign in" },
      },
      snapshot:
        '- textbox "Email" [required, ref=e1]\n- textbox "Password" [required, ref=e2]\n- button "Sign in" [ref=e3]',
    };
    const commands = [
      signInEmailCommand(snapshot, "super-admin@admin-e2e.njpbs.invalid"),
      signInPasswordCommand(snapshot, secret),
      signInSubmitCommand(snapshot),
    ];
    expect(() => assertRefOnlyActions(commands)).not.toThrow();
    expect(commands.map((command) => command[1])).toEqual([
      "@e1",
      "@e2",
      "@e3",
    ]);
    expect(agentBrowserArgs("admin-e2e-session").join(" ")).not.toContain(
      secret,
    );
    expect(() => assertRefOnlyActions([["click", "#sign-in"]])).toThrow(
      /snapshot element refs/,
    );
    expect(scopedTreeRef(snapshot, "button", "Sign in")).toBe("@e3");
  });

  it("builds revision actions from named snapshot refs", () => {
    const snapshot = {
      snapshot:
        '- link "Loopback newsroom fixture" [ref=e11]\n' +
        '- button "Inspect version 3" [ref=e12]\n' +
        '- button "Restore version 1" [ref=e13]\n' +
        '- button "Restore version 1" [ref=e13]',
    };
    const commands = [
      clickNamedCommand(snapshot, "link", "Loopback newsroom fixture"),
      clickNamedCommand(snapshot, "button", "Inspect version 3"),
      clickNamedCommand(snapshot, "button", "Restore version 1"),
    ];
    expect(commands).toEqual([
      ["click", "@e11"],
      ["click", "@e12"],
      ["click", "@e13"],
    ]);
    expect(() => assertRefOnlyActions(commands)).not.toThrow();
    expect(() =>
      scopedTreeRef(
        {
          snapshot:
            '- button "Restore version 1" [ref=e13]\n' +
            '- button "Restore version 1" [ref=e14]',
        },
        "button",
        "Restore version 1",
      ),
    ).toThrow(/exactly one required control/);
    expect(() =>
      clickNamedCommand(
        {
          snapshot:
            '- button "Restore version 1" [disabled, ref=e15]\n' +
            '- button "Restore version 1" [disabled, ref=e15]',
        },
        "button",
        "Restore version 1",
      ),
    ).toThrow(/disabled/);
    expect(() =>
      clickNamedCommand(
        {
          snapshot:
            '- button "Restore version 1" [aria-disabled=true, ref=e16]',
        },
        "button",
        "Restore version 1",
      ),
    ).toThrow(/disabled/);
  });

  it("keeps navigation waits separate from ref-only DOM actions", () => {
    expect(signInSnapshotCommands("http://127.0.0.1:4173")).toEqual([
      ["open", "http://127.0.0.1:4173"],
      ["wait", "--text", "Sign in to NJ PBS Admin"],
      ["snapshot", "-i", "-s", ".auth-form"],
    ]);
    expect(() =>
      assertRefOnlyActions([["wait", "--text", "Sign in to NJ PBS Admin"]]),
    ).toThrow(/permits only fill and click/);
  });

  it("can re-resolve each controlled-input action from a new scoped snapshot", () => {
    const initial = {
      refs: {
        e7: { role: "textbox", name: "Email" },
        e8: { role: "textbox", name: "Password" },
        e9: { role: "button", name: "Sign in" },
      },
      snapshot:
        '- textbox "Email" [required, ref=e7]\n- textbox "Password" [required, ref=e8]\n- button "Sign in" [ref=e9]',
    };
    const afterEmail = {
      refs: {
        e20: { role: "textbox", name: "Email" },
        e21: { role: "textbox", name: "Password" },
        e22: { role: "button", name: "Sign in" },
      },
      snapshot:
        '- textbox "Email" [disabled, required, ref=e20]: super-admin@admin-e2e.njpbs.invalid\n- textbox "Password" [required, ref=e21]\n- button "Sign in" [ref=e22]',
    };
    const afterPassword = {
      snapshot:
        '- textbox "Email" [required, ref=e30]: super-admin@admin-e2e.njpbs.invalid\n- textbox "Password" [required, ref=e31]: random-in-memory-password\n- button "Sign in" [ref=e32]',
    };
    expect(signInEmailCommand(initial, "address.invalid")[1]).toBe("@e7");
    expect(signInPasswordCommand(afterEmail, "secret")[1]).toBe("@e21");
    expect(signInSubmitCommand(afterPassword)[1]).toBe("@e32");
  });

  it("ignores a session-wide duplicate that is absent from the scoped tree", () => {
    const snapshot = {
      refs: {
        e1: { role: "button", name: "Sign in" },
        e2: { role: "button", name: "Sign in" },
        e3: { role: "textbox", name: "Email" },
        e4: { role: "textbox", name: "Password" },
      },
      snapshot:
        '- textbox "Email" [ref=e3]\n- textbox "Password" [ref=e4]\n- button "Sign in" [ref=e2]',
    };
    expect(scopedTreeRef(snapshot, "button", "Sign in")).toBe("@e2");
  });

  it("accepts the native serializer's supported ref attribute orders", () => {
    expect(
      scopedTreeRef(
        { snapshot: '- textbox "Email" [required, ref=e31]' },
        "textbox",
        "Email",
      ),
    ).toBe("@e31");
    expect(
      scopedTreeRef(
        { snapshot: '- textbox "Email" [ref=e32, required]' },
        "textbox",
        "Email",
      ),
    ).toBe("@e32");
    expect(
      scopedTreeRef(
        { snapshot: '- textbox "Email" [disabled, required, ref=e33]' },
        "textbox",
        "Email",
      ),
    ).toBe("@e33");
  });

  it("accepts filled email and password value suffixes without returning them", () => {
    const secret = "never-return-this-secret";
    expect(
      scopedTreeRef(
        {
          snapshot:
            '- textbox "Email" [required, ref=e41]: super-admin@admin-e2e.njpbs.invalid',
        },
        "textbox",
        "Email",
      ),
    ).toBe("@e41");
    expect(
      scopedTreeRef(
        { snapshot: `- textbox "Password" [required, ref=e42]: ${secret}` },
        "textbox",
        "Password",
      ),
    ).toBe("@e42");
  });

  it("rejects missing, malformed, duplicated, or ambiguous scoped-tree refs", () => {
    for (const tree of [
      '- textbox "Email" [required]',
      '- textbox "Email" [required, ref=x1]',
      '- textbox "Email" [required, ref=e1x]',
      '- textbox "Email" [ref=e1, required, ref=e2]',
    ]) {
      expect(() =>
        scopedTreeRef({ snapshot: tree }, "textbox", "Email"),
      ).toThrow(/invalid scoped-tree ref/);
    }
    expect(() =>
      scopedTreeRef(
        {
          snapshot:
            '- textbox "Email" [required, ref=e1]\n- textbox "Email" [required, ref=e2]',
        },
        "textbox",
        "Email",
      ),
    ).toThrow(/exactly one required control/);
  });

  it("keeps every parser and ref-action failure free of tree values", () => {
    const secret = "never-log-this-parser-secret";
    const failures = [
      () => scopedTreeRef(null, "textbox", "Email"),
      () => scopedTreeRef({ value: secret }, "textbox", "Email"),
      () =>
        scopedTreeRef(
          { snapshot: `- textbox "Other" [ref=e1]: ${secret}` },
          "textbox",
          "Email",
        ),
      () =>
        scopedTreeRef(
          { snapshot: `- textbox "Email" [required, ref=bad]: ${secret}` },
          "textbox",
          "Email",
        ),
      () =>
        scopedTreeRef(
          {
            snapshot:
              `- textbox "Email" [ref=e1]: ${secret}\n` +
              `- textbox "Email" [ref=e2]: ${secret}`,
          },
          "textbox",
          "Email",
        ),
      () => assertRefOnlyActions([["press", "@e1", secret]]),
      () => assertRefOnlyActions([["fill", "#email", secret]]),
    ];
    for (const fail of failures) {
      let message = "";
      try {
        fail();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });

  it("requires the representative content record in the Home snapshot", () => {
    expect(() =>
      assertHomeSnapshot({
        origin: "http://127.0.0.1:4173",
        snapshot:
          'heading "Newsroom home"\nregion "Newsroom banner"\ntext "Loopback newsroom fixture"',
      }),
    ).not.toThrow();
    expect(() =>
      assertHomeSnapshot(
        {
          origin: "http://127.0.0.1:4173",
          snapshot: 'text "Archived newsroom draft"',
        },
        ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
      ),
    ).not.toThrow();
    expect(() =>
      assertHomeSnapshot({
        origin: "http://127.0.0.1:4173",
        snapshot: 'heading "Newsroom home"',
      }),
    ).toThrow(/fixture record/);
    expect(() =>
      assertHomeSnapshot({
        origin: "https://admin.njpbs.org",
        snapshot: 'region "Newsroom banner"\ntext "Loopback newsroom fixture"',
      }),
    ).toThrow(/loopback Home origin/);
  });

  it("requires the exact revision editor route, title, and comparison evidence", () => {
    const editorSnapshot = {
      origin: "http://127.0.0.1:4173/content/post/admin-e2e-draft/edit",
      snapshot:
        '- textbox "Post title" [ref=e1]: Loopback newsroom fixture\n' +
        '- heading "Revision history" [level=3, ref=e2]',
    };
    expect(() =>
      assertRevisionEditorSnapshot(editorSnapshot, {
        route: ADMIN_E2E_REVISION_FIXTURE.route,
      }),
    ).not.toThrow();
    expect(() =>
      assertRevisionEditorSnapshot(
        { ...editorSnapshot, origin: "https://admin.njpbs.org/" },
        {
          route: ADMIN_E2E_REVISION_FIXTURE.route,
        },
      ),
    ).toThrow(/loopback revision editor route/);
    expect(() =>
      assertEditorTitleValue(
        { value: ADMIN_E2E_REVISION_FIXTURE.currentTitle },
        ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      ),
    ).not.toThrow();
    expect(() =>
      assertEditorTitleValue(
        { value: ADMIN_E2E_REVISION_FIXTURE.historicalTitle },
        ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      ),
    ).toThrow(/unexpected title/);

    const comparisonSnapshot = {
      snapshot:
        'heading "Changes in version 3"\n' +
        "Archived newsroom draft\n" +
        "Loopback newsroom fixture",
    };
    expect(() =>
      assertRevisionComparisonSnapshot(comparisonSnapshot, {
        version: 3,
      }),
    ).not.toThrow();
    expect(() =>
      assertRevisionComparisonText(
        {
          text:
            `${ADMIN_E2E_REVISION_FIXTURE.historicalTitle}\n` +
            ADMIN_E2E_REVISION_FIXTURE.currentTitle,
        },
        {
          beforeTitle: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
          afterTitle: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertRevisionComparisonSnapshot(
        { snapshot: 'heading "Changes in version 3"' },
        {
          version: 1,
        },
      ),
    ).toThrow(/comparison snapshot/);
    expect(() =>
      assertRevisionComparisonText(
        { text: ADMIN_E2E_REVISION_FIXTURE.currentTitle },
        {
          beforeTitle: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
          afterTitle: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
        },
      ),
    ).toThrow(/comparison text/);
  });
});
