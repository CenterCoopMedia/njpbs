import { spawn } from "node:child_process";

function commandResult(output, commandIndex = 0) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("agent-browser returned invalid JSON.");
  }
  const result = parsed?.[commandIndex];
  if (!result?.success) {
    throw new Error("agent-browser did not complete the requested command.");
  }
  return result.result;
}

function scopedTree(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("agent-browser returned an invalid snapshot.");
  }
  if (typeof snapshot.snapshot !== "string") {
    throw new Error("agent-browser snapshot did not include its scoped tree.");
  }
  return snapshot.snapshot;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scopedTreeRef(
  snapshot,
  role,
  name,
  { requireEnabled = false } = {},
) {
  const tree = scopedTree(snapshot);
  const linePattern = new RegExp(
    `^\\s*-\\s*${escapePattern(role)}\\s+${escapePattern(JSON.stringify(name))}` +
      `\\s+\\[([^\\]\\n]*)\\](?:\\s*:[^\\n]*)?\\s*$`,
    "gm",
  );
  const matches = [...tree.matchAll(linePattern)];
  if (matches.length === 0) {
    throw new Error(
      "The scoped tree must contain exactly one required control.",
    );
  }

  // agent-browser serializes state properties before or after ref=eN in one
  // comma-separated attribute block. Treat ref as a token, not as the first
  // attribute. A selector-scoped snapshot can repeat one control in both its
  // semantic subtree and its flattened selector matches. Accept those lines
  // only when every match resolves to the same valid ref. Two different refs
  // remain ambiguous and fail closed.
  const refs = matches.map((match) => {
    const attributes = match[1]
      .split(",")
      .map((attribute) => attribute.trim())
      .filter(Boolean);
    const refTokens = attributes.filter((attribute) =>
      attribute.startsWith("ref="),
    );
    if (refTokens.length !== 1 || !/^ref=e\d+$/.test(refTokens[0])) {
      throw new Error("The required control has an invalid scoped-tree ref.");
    }
    if (
      requireEnabled &&
      attributes.some((attribute) =>
        ["disabled", "aria-disabled=true", 'aria-disabled="true"'].includes(
          attribute.toLowerCase(),
        ),
      )
    ) {
      throw new Error("The required control is disabled.");
    }
    return refTokens[0].slice("ref=".length);
  });
  if (new Set(refs).size !== 1) {
    throw new Error(
      "The scoped tree must contain exactly one required control.",
    );
  }
  return `@${refs[0]}`;
}

export function signInEmailCommand(snapshot, email) {
  return ["fill", scopedTreeRef(snapshot, "textbox", "Email"), email];
}

export function signInPasswordCommand(snapshot, password) {
  return ["fill", scopedTreeRef(snapshot, "textbox", "Password"), password];
}

export function signInSubmitCommand(snapshot) {
  // The caller scopes this snapshot to .auth-form, so this is the form's one
  // Sign in button, never the identically named account-mode switch outside.
  return ["click", scopedTreeRef(snapshot, "button", "Sign in")];
}

export function clickNamedCommand(snapshot, role, name) {
  return [
    "click",
    scopedTreeRef(snapshot, role, name, { requireEnabled: true }),
  ];
}

export function signInSnapshotCommands(adminOrigin) {
  return [
    ["open", adminOrigin],
    ["wait", "--text", "Sign in to NJ PBS Admin"],
    ["snapshot", "-i", "-s", ".auth-form"],
  ];
}

export function assertRefOnlyActions(commands) {
  for (const command of commands) {
    if (!["fill", "click"].includes(command[0])) {
      throw new Error("Admin E2E permits only fill and click actions.");
    }
    if (!/^@e\d+$/.test(command[1] ?? "")) {
      throw new Error("Admin E2E actions must use snapshot element refs.");
    }
  }
}

export function assertHomeSnapshot(
  snapshot,
  expectedTitle = "Loopback newsroom fixture",
) {
  const text = snapshot?.snapshot;
  if (typeof text !== "string") {
    throw new Error("agent-browser returned an invalid Home snapshot.");
  }
  let currentUrl;
  try {
    currentUrl = new URL(snapshot.origin);
  } catch {
    throw new Error("Admin E2E Home snapshot has an invalid origin.");
  }
  if (
    currentUrl.origin !== "http://127.0.0.1:4173" ||
    currentUrl.pathname !== "/" ||
    currentUrl.search !== "" ||
    currentUrl.hash !== ""
  ) {
    throw new Error("Admin E2E did not stay on the loopback Home origin.");
  }
  // Compact accessibility snapshots can omit structural headings and labelled
  // regions. The exact root URL plus this Home-only seeded record are stable
  // evidence that the signed-in dashboard route, not only its shell, loaded.
  if (!text.includes(expectedTitle)) {
    throw new Error("Admin E2E Home snapshot is missing its fixture record.");
  }
}

function assertLoopbackRoute(snapshot, pathname, label) {
  let currentUrl;
  try {
    currentUrl = new URL(snapshot?.origin);
  } catch {
    throw new Error(`Admin E2E ${label} snapshot has an invalid origin.`);
  }
  if (
    currentUrl.origin !== "http://127.0.0.1:4173" ||
    currentUrl.pathname !== pathname ||
    currentUrl.search !== "" ||
    currentUrl.hash !== ""
  ) {
    throw new Error(`Admin E2E did not stay on the loopback ${label} route.`);
  }
}

export function assertRevisionEditorSnapshot(snapshot, { route }) {
  assertLoopbackRoute(snapshot, route, "revision editor");
  const text = snapshot?.snapshot;
  if (
    typeof text !== "string" ||
    !text.includes('textbox "Post title"') ||
    !text.includes("Revision history")
  ) {
    throw new Error("Admin E2E revision editor snapshot is incomplete.");
  }
}

export function assertEditorTitleValue(value, expected) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.value !== expected
  ) {
    throw new Error("Admin E2E revision editor has an unexpected title.");
  }
}

export function assertRevisionComparisonSnapshot(snapshot, { version }) {
  const text = snapshot?.snapshot;
  if (
    typeof text !== "string" ||
    !text.includes(`Changes in version ${version}`)
  ) {
    throw new Error("Admin E2E revision comparison snapshot is incomplete.");
  }
}

export function assertRevisionComparisonText(
  value,
  { beforeTitle, afterTitle },
) {
  const text = value?.text;
  if (
    typeof text !== "string" ||
    !text.includes(beforeTitle) ||
    !text.includes(afterTitle)
  ) {
    throw new Error("Admin E2E revision comparison text is incomplete.");
  }
}

export function agentBrowserArgs(session, json = false) {
  return ["--session", session, "batch", "--bail", ...(json ? ["--json"] : [])];
}

export function runAgentBrowserBatch(
  commands,
  {
    env,
    session,
    json = false,
    spawnFn = spawn,
    timeoutMs = 30_000,
    terminateGraceMs = 5_000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawnFn("agent-browser", agentBrowserArgs(session, json), {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    let terminationTimer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(commandTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      if (error) reject(error);
      else resolve(result);
    };
    const onExit = (status, signal) => {
      if (status !== 0 || signal) {
        finish(new Error("agent-browser command failed."));
        return;
      }
      finish(null, { stdout, stderr });
    };
    child.once("error", () =>
      finish(new Error("agent-browser could not start.")),
    );
    child.once("exit", onExit);
    const commandTimer = setTimeout(() => {
      if (settled) return;
      child.removeListener("exit", onExit);
      const rejectAfterExit = () =>
        finish(new Error("agent-browser command timed out."));
      child.once("exit", rejectAfterExit);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      terminationTimer = setTimeout(() => {
        if (settled) return;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, terminateGraceMs);
    }, timeoutMs);
    child.stdin.end(JSON.stringify(commands));
  });
}

export async function jsonSnapshot(commands, options) {
  const { stdout } = await runAgentBrowserBatch(commands, {
    ...options,
    json: true,
  });
  return commandResult(stdout, commands.length - 1);
}
