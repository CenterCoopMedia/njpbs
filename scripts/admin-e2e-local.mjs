#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { prepareEmulatorEnv } from "./prepare-emulator-env.mjs";
import {
  ADMIN_E2E_ENDPOINTS,
  assertEmulatorEnvironment,
  assertFunctionsEmulatorEnvContract,
  assertIsolatedEmulatorOutput,
  assertProductionEndpointsAbsent,
  assertSafeHostEnvironment,
  cleanupFunctionsSecretOverride,
  createFunctionsSecretOverride,
  parsePort,
  sanitizedSubprocessEnv,
} from "./lib/admin-e2e-guard.mjs";
import {
  ADMIN_E2E_REVISION_FIXTURE,
  ADMIN_E2E_IDENTITIES,
  closeFixtureClients,
  createFixtureClients,
  proveRevisionBrowserFlow,
  proveFixtureProjectEmpty,
  resetFixtureProject,
  seedFixtureProject,
} from "./lib/admin-e2e-fixtures.mjs";
import {
  assertEditorTitleValue,
  assertHomeSnapshot,
  assertRefOnlyActions,
  assertRevisionComparisonSnapshot,
  assertRevisionComparisonText,
  assertRevisionEditorSnapshot,
  clickNamedCommand,
  jsonSnapshot,
  runAgentBrowserBatch,
  scopedTreeRef,
  signInEmailCommand,
  signInPasswordCommand,
  signInSnapshotCommands,
  signInSubmitCommand,
} from "./lib/admin-e2e-browser.mjs";
import {
  AdminE2ETerminationError,
  createStreamOutputGuard,
  forwardSignalAndWait,
  waitForOwnedPreview,
} from "./lib/admin-e2e-process.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adminRoot = join(repoRoot, "admin");
const adminDist = join(adminRoot, "dist");
const emulatorWrapper = join(repoRoot, "scripts", "run-firebase-emulators.mjs");
const viteEntry = join(repoRoot, "node_modules", "vite", "bin", "vite.js");
const INSIDE_FLAG = "--inside-emulators";
const HEALTH_PROBE_FLAG = "--health-probe";
const INSIDE_HEALTH_PROBE_FLAG = "--inside-health-probe";

function childExit(child, label) {
  return once(child, "exit").then(([status, signal]) => {
    if (status !== 0 || signal) {
      throw new Error(`${label} failed.`);
    }
  });
}

async function runInherited(
  executable,
  args,
  options,
  label,
  timeoutMs = null,
) {
  const child = spawn(executable, args, { ...options, stdio: "inherit" });
  if (timeoutMs === null) {
    await childExit(child, label);
    return;
  }
  let timer;
  const outcome = await Promise.race([
    childExit(child, label).then(() => "exit"),
    new Promise((resolveWait) => {
      timer = setTimeout(() => resolveWait("timeout"), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    await stopChild(child);
    throw new Error(`${label} timed out.`);
  }
}

async function runGuardedInherited(executable, args, options, label) {
  const child = spawn(executable, args, {
    ...options,
    stdio: ["inherit", "pipe", "pipe"],
  });
  let guardError = null;
  let termination = null;
  const inspectOutput = createStreamOutputGuard(assertIsolatedEmulatorOutput);
  const inspect = (stream, chunk, destination) => {
    destination.write(chunk);
    if (guardError) return;
    try {
      inspectOutput(stream, chunk);
    } catch (error) {
      guardError = error;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", (chunk) => inspect("stdout", chunk, process.stdout));
  child.stderr.on("data", (chunk) => inspect("stderr", chunk, process.stderr));
  const forward = (signal) => {
    if (termination) return;
    termination = { signal, wait: forwardSignalAndWait(child, signal) };
  };
  const forwardSigint = () => forward("SIGINT");
  const forwardSigterm = () => forward("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  try {
    const [status, signal] = await once(child, "exit");
    if (termination) {
      await termination.wait;
      throw new AdminE2ETerminationError(termination.signal);
    }
    if (guardError) throw guardError;
    if (status !== 0 || signal) throw new Error(`${label} failed.`);
  } finally {
    process.removeListener("SIGINT", forwardSigint);
    process.removeListener("SIGTERM", forwardSigterm);
  }
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      // The loopback preview has not bound its port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Admin E2E preview did not become ready.");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function browserStage(label, action) {
  try {
    return await action();
  } catch {
    // Stage only. Browser values, command input, and captured output can include
    // the in-memory password and must never enter an error or log.
    throw new Error(`Admin E2E browser stage failed: ${label}.`);
  }
}

async function browserActivate({ label, snapshot, role, name, env, session }) {
  const refCommand = await browserStage(`${label} ref parse`, () =>
    clickNamedCommand(snapshot, role, name),
  );
  await browserActivateCommand({ label, refCommand, env, session });
}

async function browserActivateCommand({ label, refCommand, env, session }) {
  assertRefOnlyActions([refCommand]);
  await browserStage(label, () =>
    runAgentBrowserBatch(
      [
        ["focus", refCommand[1]],
        ["press", "Enter"],
        ["wait", "500"],
      ],
      {
        env,
        session,
        timeoutMs: 90_000,
      },
    ),
  );
}

async function waitForBrowserSnapshot({
  label,
  text,
  env,
  session,
  selector = null,
}) {
  return browserStage(label, () =>
    jsonSnapshot(
      [
        ["wait", "--text", text],
        ["snapshot", "-c", ...(selector ? ["-s", selector] : [])],
      ],
      { env, session, timeoutMs: 90_000 },
    ),
  );
}

async function waitForStableBrowserSnapshot({
  label,
  text,
  env,
  session,
  selector = null,
}) {
  return browserStage(label, async () => {
    const deadline = Date.now() + 90_000;
    let previousTree = null;
    let stableCount = 0;
    while (Date.now() < deadline) {
      const snapshot = await jsonSnapshot(
        [
          ["wait", "500"],
          ["snapshot", "-c", ...(selector ? ["-s", selector] : [])],
        ],
        { env, session, timeoutMs: 90_000 },
      );
      const tree = snapshot?.snapshot;
      if (typeof tree !== "string" || !tree.includes(text)) {
        previousTree = null;
        stableCount = 0;
        continue;
      }
      if (tree === previousTree) {
        stableCount += 1;
      } else {
        previousTree = tree;
        stableCount = 1;
      }
      // Re-resolve the action from a snapshot that stayed unchanged across a
      // full second. Home completes several independent calls after its record
      // list appears, and any of those React commits invalidates earlier refs.
      if (stableCount >= 3) return snapshot;
    }
    throw new Error("The browser surface did not become stable.");
  });
}

async function waitForNamedControlSnapshot({
  label,
  role,
  name,
  env,
  session,
  selector = null,
}) {
  return browserStage(label, async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const snapshot = await jsonSnapshot(
        [
          ["wait", "500"],
          ["snapshot", "-c", ...(selector ? ["-s", selector] : [])],
        ],
        { env, session, timeoutMs: 90_000 },
      );
      if (typeof snapshot?.snapshot !== "string") continue;
      try {
        clickNamedCommand(snapshot, role, name);
        return snapshot;
      } catch {
        // The editor lock or a preceding React commit can leave a visible
        // control disabled or its ref stale for one snapshot. Re-snapshot
        // until the exact named control has a current actionable ref.
      }
    }
    throw new Error("The required browser control did not become actionable.");
  });
}

async function waitForRevisionEditorState({
  label,
  title,
  version,
  env,
  session,
}) {
  return browserStage(label, async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const snapshot = await jsonSnapshot(
        [
          ["wait", "500"],
          ["snapshot", "-c"],
        ],
        { env, session, timeoutMs: 90_000 },
      );
      try {
        assertRevisionEditorSnapshot(snapshot, {
          route: ADMIN_E2E_REVISION_FIXTURE.route,
        });
        clickNamedCommand(snapshot, "button", `Inspect version ${version}`);
        const titleRef = scopedTreeRef(snapshot, "textbox", "Post title");
        const value = await jsonSnapshot([["get", "value", titleRef]], {
          env,
          session,
          timeoutMs: 90_000,
        });
        assertEditorTitleValue(value, title);
        return snapshot;
      } catch {
        // A completed restore first re-reads the record and then refreshes the
        // revision list. Wait until both parts of that editor state agree.
      }
    }
    throw new Error("The restored editor state did not become ready.");
  });
}

async function openRevisionEditor({ title, version, env, session }) {
  await browserStage("revision editor open", () =>
    runAgentBrowserBatch(
      [
        [
          "open",
          `${ADMIN_E2E_ENDPOINTS.admin}${ADMIN_E2E_REVISION_FIXTURE.route}`,
        ],
        ["wait", "500"],
      ],
      {
        env,
        session,
        timeoutMs: 90_000,
      },
    ),
  );
  return waitForRevisionEditorState({
    label: "revision editor open wait",
    title,
    version,
    env,
    session,
  });
}

async function assertRevisionEditorTitle({ snapshot, title, env, session }) {
  const titleRef = await browserStage("revision title ref parse", () =>
    scopedTreeRef(snapshot, "textbox", "Post title"),
  );
  const value = await browserStage("revision title read", () =>
    jsonSnapshot([["get", "value", titleRef]], {
      env,
      session,
      timeoutMs: 90_000,
    }),
  );
  assertEditorTitleValue(value, title);
}

async function signInBrowser({ env, password, session, homeTitle }) {
  const signInSnapshot = await browserStage("initial form snapshot", () =>
    jsonSnapshot(signInSnapshotCommands(ADMIN_E2E_ENDPOINTS.admin), {
      env,
      session,
    }),
  );
  const superAdmin = ADMIN_E2E_IDENTITIES.find(
    (identity) => identity.id === "superAdmin",
  );
  const emailCommand = await browserStage("initial form ref parse", () =>
    signInEmailCommand(signInSnapshot, superAdmin.email),
  );
  assertRefOnlyActions([emailCommand]);
  // Each fill updates a controlled React input and changes the DOM. Follow the
  // current browser guide: act through one current ref, then take a new scoped
  // snapshot before the next action. The password subprocess receives only one
  // JSON command on stdin, never argv, and its output is discarded.
  await browserStage("email fill", () =>
    runAgentBrowserBatch([emailCommand], { env, session }),
  );
  const afterEmail = await browserStage("post-email form snapshot", () =>
    jsonSnapshot([["snapshot", "-i", "-s", ".auth-form"]], {
      env,
      session,
    }),
  );
  const passwordCommand = await browserStage("password ref parse", () =>
    signInPasswordCommand(afterEmail, password),
  );
  assertRefOnlyActions([passwordCommand]);
  await browserStage("password fill", () =>
    runAgentBrowserBatch([passwordCommand], { env, session }),
  );
  const afterPassword = await browserStage("post-password form snapshot", () =>
    jsonSnapshot([["snapshot", "-i", "-s", ".auth-form"]], {
      env,
      session,
    }),
  );
  const submitCommand = await browserStage("submit ref parse", () =>
    signInSubmitCommand(afterPassword),
  );
  assertRefOnlyActions([submitCommand]);
  await browserStage("form submit", () =>
    runAgentBrowserBatch([submitCommand], { env, session }),
  );

  return browserStage("Home wait", async () => {
    const snapshot = await waitForStableBrowserSnapshot({
      label: "stable Home wait",
      text: homeTitle,
      env,
      session,
    });
    assertHomeSnapshot(snapshot, homeTitle);
    return snapshot;
  });
}

async function waitForEditorLockRelease(firestore) {
  const deadline = Date.now() + 30_000;
  const lock = firestore
    .collection("cmsEditorLocks")
    .doc(`cmsPosts:${ADMIN_E2E_REVISION_FIXTURE.documentId}`);
  while (Date.now() < deadline) {
    const snapshot = await lock.get();
    if (snapshot.exists && snapshot.data()?.releasedAt !== undefined) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("The first browser did not release its editor lock.");
}

async function runBrowserSmoke({ env, firestore, password }) {
  let session = `njpbs-admin-e2e-${process.pid}-${randomUUID()}`;
  const openedSessions = new Set();
  try {
    await runInherited(
      "agent-browser",
      ["doctor", "--offline", "--quick"],
      { cwd: repoRoot, env },
      "agent-browser doctor",
      30_000,
    );
    // Closing a session that never opened is harmless. Mark it before the
    // combined open/wait/snapshot batch so a later command failure still gets
    // a best-effort browser cleanup.
    openedSessions.add(session);
    const homeSnapshot = await signInBrowser({
      env,
      password,
      session,
      homeTitle: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
    });
    console.log(
      "Browser smoke: signed in through snapshot refs and opened Home.",
    );

    const fixtureLink = await browserStage("fixture link ref parse", () =>
      clickNamedCommand(
        homeSnapshot,
        "link",
        ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      ),
    );
    assertRefOnlyActions([fixtureLink]);
    await browserActivateCommand({
      label: "fixture link activation",
      refCommand: fixtureLink,
      env,
      session,
    });
    const editorSnapshot = await waitForRevisionEditorState({
      label: "fixture link editor wait",
      title: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      version: ADMIN_E2E_REVISION_FIXTURE.currentVersion,
      env,
      session,
    });
    assertRevisionEditorSnapshot(editorSnapshot, {
      route: ADMIN_E2E_REVISION_FIXTURE.route,
    });
    await assertRevisionEditorTitle({
      snapshot: editorSnapshot,
      title: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      env,
      session,
    });

    await browserActivate({
      label: "current revision inspect",
      snapshot: editorSnapshot,
      role: "button",
      name: `Inspect version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      env,
      session,
    });
    const comparisonSnapshot = await waitForBrowserSnapshot({
      label: "revision comparison wait",
      text: `Changes in version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      selector: ".revision-history",
      env,
      session,
    });
    assertRevisionComparisonSnapshot(comparisonSnapshot, {
      version: ADMIN_E2E_REVISION_FIXTURE.currentVersion,
    });
    const comparisonText = await browserStage("revision comparison text", () =>
      jsonSnapshot([["get", "text", ".revision-detail"]], {
        env,
        session,
        timeoutMs: 90_000,
      }),
    );
    assertRevisionComparisonText(comparisonText, {
      beforeTitle: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
      afterTitle: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
    });

    await browserActivate({
      label: "historical revision inspect",
      snapshot: comparisonSnapshot,
      role: "button",
      name: `Inspect version ${ADMIN_E2E_REVISION_FIXTURE.historicalVersion}`,
      env,
      session,
    });
    const historicalSnapshot = await waitForNamedControlSnapshot({
      label: "historical revision wait",
      role: "button",
      name: `Restore version ${ADMIN_E2E_REVISION_FIXTURE.historicalVersion}`,
      selector: ".revision-history",
      env,
      session,
    });
    await browserActivate({
      label: "historical restore confirmation open",
      snapshot: historicalSnapshot,
      role: "button",
      name: `Restore version ${ADMIN_E2E_REVISION_FIXTURE.historicalVersion}`,
      env,
      session,
    });
    const historicalConfirmation = await waitForNamedControlSnapshot({
      label: "historical restore confirmation wait",
      role: "button",
      name: `Confirm restore of version ${ADMIN_E2E_REVISION_FIXTURE.historicalVersion}`,
      selector: ".revision-history",
      env,
      session,
    });
    await browserActivate({
      label: "historical restore",
      snapshot: historicalConfirmation,
      role: "button",
      name: `Confirm restore of version ${ADMIN_E2E_REVISION_FIXTURE.historicalVersion}`,
      env,
      session,
    });
    const settledHistoricalEditor = await waitForRevisionEditorState({
      label: "historical restore settle",
      title: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
      version: ADMIN_E2E_REVISION_FIXTURE.currentVersion + 1,
      env,
      session,
    });
    assertRevisionEditorSnapshot(settledHistoricalEditor, {
      route: ADMIN_E2E_REVISION_FIXTURE.route,
    });
    const backSnapshot = await waitForNamedControlSnapshot({
      label: "restored editor back-link wait",
      role: "link",
      name: "Back to newsroom home",
      selector: ".editor-back",
      env,
      session,
    });
    await browserActivate({
      label: "leave restored editor",
      snapshot: backSnapshot,
      role: "link",
      name: "Back to newsroom home",
      env,
      session,
    });
    await waitForEditorLockRelease(firestore);
    await browserStage("close browser before cold reload", () =>
      runAgentBrowserBatch([["close"]], { env, session }),
    );
    openedSessions.delete(session);
    session = `njpbs-admin-e2e-reload-${process.pid}-${randomUUID()}`;
    openedSessions.add(session);
    await signInBrowser({
      env,
      password,
      session,
      homeTitle: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
    });
    const historicalEditor = await openRevisionEditor({
      title: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
      version: ADMIN_E2E_REVISION_FIXTURE.currentVersion + 1,
      env,
      session,
    });
    assertRevisionEditorSnapshot(historicalEditor, {
      route: ADMIN_E2E_REVISION_FIXTURE.route,
    });
    await assertRevisionEditorTitle({
      snapshot: historicalEditor,
      title: ADMIN_E2E_REVISION_FIXTURE.historicalTitle,
      env,
      session,
    });

    await browserActivate({
      label: "undo revision inspect",
      snapshot: historicalEditor,
      role: "button",
      name: `Inspect version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      env,
      session,
    });
    const undoRevisionSnapshot = await waitForNamedControlSnapshot({
      label: "undo revision wait",
      role: "button",
      name: `Restore version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      selector: ".revision-history",
      env,
      session,
    });
    await browserActivate({
      label: "undo restore confirmation open",
      snapshot: undoRevisionSnapshot,
      role: "button",
      name: `Restore version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      env,
      session,
    });
    const undoConfirmation = await waitForNamedControlSnapshot({
      label: "undo restore confirmation wait",
      role: "button",
      name: `Confirm restore of version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      selector: ".revision-history",
      env,
      session,
    });
    await browserActivate({
      label: "undo restore",
      snapshot: undoConfirmation,
      role: "button",
      name: `Confirm restore of version ${ADMIN_E2E_REVISION_FIXTURE.currentVersion}`,
      env,
      session,
    });
    const restoredCurrentEditor = await waitForRevisionEditorState({
      label: "undo restore settle",
      title: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      version: ADMIN_E2E_REVISION_FIXTURE.finalVersion,
      env,
      session,
    });
    assertRevisionEditorSnapshot(restoredCurrentEditor, {
      route: ADMIN_E2E_REVISION_FIXTURE.route,
    });
    await assertRevisionEditorTitle({
      snapshot: restoredCurrentEditor,
      title: ADMIN_E2E_REVISION_FIXTURE.currentTitle,
      env,
      session,
    });
    console.log(
      "Browser revision proof: compared, restored, cold-reloaded, and restored forward.",
    );
  } finally {
    for (const openedSession of openedSessions) {
      await runAgentBrowserBatch([["close"]], {
        env,
        session: openedSession,
      }).catch(() => {});
    }
  }
}

async function insideEmulators() {
  const { firestorePort } = assertEmulatorEnvironment(process.env);
  const runtimeDirectory = process.env.ADMIN_E2E_RUNTIME_DIR;
  if (!runtimeDirectory) {
    throw new Error("Admin E2E runtime directory is missing.");
  }
  const childEnv = sanitizedSubprocessEnv(process.env, {
    firestorePort,
    runtimeDirectory,
  });
  const buildEnv = {
    ...childEnv,
    VITE_USE_EMULATORS: "true",
  };
  const clients = createFixtureClients();
  const password = randomBytes(32).toString("base64url");
  let preview = null;
  let primaryError = null;
  let cleanupProof = null;

  try {
    await waitForHttp(
      `${ADMIN_E2E_ENDPOINTS.functions}/demo-njpbs/us-central1/health`,
    );
    await resetFixtureProject();
    console.log("Initial reset: Auth and Firestore emulator data cleared.");
    const seeded = await seedFixtureProject({
      auth: clients.auth,
      firestore: clients.firestore,
      password,
    });
    console.log(
      `Fixtures: ${seeded.authUsers} Auth users, ${seeded.approvedProfiles} approved profiles, ` +
        `${seeded.pendingProfiles} pending profile, ${seeded.sections} sections, ` +
        `${seeded.contentRecords} content record, and ` +
        `${seeded.versionHistoryRecords} revision rows.`,
    );

    await runInherited(
      "npm",
      ["run", "admin:build"],
      { cwd: repoRoot, env: buildEnv },
      "Admin E2E build",
    );
    assertProductionEndpointsAbsent(adminDist);
    console.log(
      "Build scan: no production Admin, API, Firebase, or Functions endpoint.",
    );

    preview = spawn(
      process.execPath,
      [
        viteEntry,
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        "4173",
        "--strictPort",
      ],
      { cwd: adminRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    preview.stderr.resume();
    await waitForOwnedPreview({
      child: preview,
      origin: ADMIN_E2E_ENDPOINTS.admin,
      expectedStatusBody: readFileSync(
        join(adminDist, "admin-status.json"),
        "utf8",
      ),
    });
    await runBrowserSmoke({
      env: childEnv,
      firestore: clients.firestore,
      password,
    });
    const revisionProof = await proveRevisionBrowserFlow({
      firestore: clients.firestore,
    });
    console.log(
      `Revision receipts: version ${revisionProof.contentVersion}, ` +
        `${revisionProof.versionHistoryRecords} history rows, ` +
        `${revisionProof.restoreAuditRecords} restore audit rows.`,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    await stopChild(preview);
    try {
      await resetFixtureProject();
      cleanupProof = await proveFixtureProjectEmpty(clients);
      console.log(
        `Cleanup proof: ${cleanupProof.authUsers} Auth users and ` +
          `${cleanupProof.firestoreDocuments} Firestore documents remain.`,
      );
    } catch (cleanupError) {
      primaryError = primaryError
        ? new AggregateError(
            [primaryError, cleanupError],
            "Admin E2E run and cleanup failed.",
          )
        : cleanupError;
    }
    await closeFixtureClients(clients);
  }

  if (primaryError) throw primaryError;
  if (!cleanupProof) throw new Error("Admin E2E cleanup proof is missing.");
}

async function insideHealthProbe() {
  assertEmulatorEnvironment(process.env);
  await waitForHttp(
    `${ADMIN_E2E_ENDPOINTS.functions}/demo-njpbs/us-central1/health`,
  );
  console.log("Functions health probe: loopback response received.");
}

async function outsideEmulators({ healthProbe = false } = {}) {
  assertSafeHostEnvironment(process.env);
  prepareEmulatorEnv(repoRoot);
  assertFunctionsEmulatorEnvContract(repoRoot);
  const firestorePort = parsePort(
    process.env.FIRESTORE_EMULATOR_PORT ?? "8080",
    "FIRESTORE_EMULATOR_PORT",
  );
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "njpbs-admin-e2e-"));
  chmodSync(runtimeDirectory, 0o700);
  mkdirSync(join(runtimeDirectory, "config"), { mode: 0o700 });
  const env = sanitizedSubprocessEnv(process.env, {
    firestorePort,
    runtimeDirectory,
  });
  // Firebase CLI resolves declared Functions secrets only from this exact
  // source-relative file. It contains one public emulator handshake value,
  // never a credential, and must not exist before or after this process.
  let secretOverride;
  try {
    secretOverride = createFunctionsSecretOverride(repoRoot);
  } catch (error) {
    rmSync(runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
  let runError = null;
  let cleanupError = null;
  try {
    await runGuardedInherited(
      process.execPath,
      [
        emulatorWrapper,
        "exec",
        "auth,firestore,functions",
        healthProbe
          ? `node scripts/admin-e2e-local.mjs ${INSIDE_HEALTH_PROBE_FLAG}`
          : `node scripts/admin-e2e-local.mjs ${INSIDE_FLAG}`,
      ],
      { cwd: repoRoot, env },
      "Admin E2E emulator suite",
    );
  } catch (error) {
    runError = error;
  } finally {
    try {
      cleanupFunctionsSecretOverride(secretOverride);
    } catch (error) {
      cleanupError = error;
    } finally {
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  }
  if (runError && cleanupError) {
    throw new AggregateError(
      [runError, cleanupError],
      "Admin E2E run and secret cleanup failed.",
    );
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
}

const args = process.argv.slice(2);
const supportedFlags = new Set([
  INSIDE_FLAG,
  HEALTH_PROBE_FLAG,
  INSIDE_HEALTH_PROBE_FLAG,
]);
if (args.length > 1 || (args.length === 1 && !supportedFlags.has(args[0]))) {
  console.error("Usage: npm run admin:e2e:local [-- --health-probe]");
  process.exitCode = 1;
} else {
  try {
    if (args[0] === INSIDE_FLAG) await insideEmulators();
    else if (args[0] === INSIDE_HEALTH_PROBE_FLAG) await insideHealthProbe();
    else await outsideEmulators({ healthProbe: args[0] === HEALTH_PROBE_FLAG });
  } catch (error) {
    if (error instanceof AdminE2ETerminationError) {
      process.exitCode = error.signal === "SIGINT" ? 130 : 143;
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
