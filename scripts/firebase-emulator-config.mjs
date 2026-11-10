const DEFAULT_PROJECT = "demo-njpbs";
const MIN_PORT = 1;
const MAX_PORT = 65_535;
const FIREBASE_INTERNAL_PORTS = [
  { name: "Admin preview", port: 4173 },
  { name: "emulator hub", port: 4400 },
  { name: "logging emulator", port: 4500 },
];

function firestorePort(env) {
  const raw = env.FIRESTORE_EMULATOR_PORT;
  if (raw === undefined || String(raw).trim() === "") return null;

  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `FIRESTORE_EMULATOR_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}.`,
    );
  }

  const port = Number(value);
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `FIRESTORE_EMULATOR_PORT must be an integer from ${MIN_PORT} to ${MAX_PORT}.`,
    );
  }
  return port;
}

export function resolveFirebaseEmulatorConfig(config, env = process.env) {
  const port = firestorePort(env);
  if (port === null) return config;

  const declaredPorts = Object.entries(config?.emulators ?? {})
    .filter(([name, value]) => name !== "firestore" && typeof value?.port === "number")
    .map(([name, value]) => ({
      name: `${name[0].toUpperCase()}${name.slice(1)}`,
      port: value.port,
    }));
  const conflict = [...declaredPorts, ...FIREBASE_INTERNAL_PORTS].find(
    (entry) => entry.port === port,
  );
  if (conflict) {
    throw new Error(
      `FIRESTORE_EMULATOR_PORT ${port} conflicts with the ${conflict.name} port.`,
    );
  }

  return {
    ...config,
    emulators: {
      ...config?.emulators,
      firestore: {
        ...config?.emulators?.firestore,
        port,
      },
    },
  };
}

export function shouldForwardEmulatorSignal(platform = process.platform) {
  return platform !== "win32";
}

export function firebaseEmulatorEnv(env = process.env) {
  return {
    ...env,
    // Emulator subprocesses never need Compute Engine metadata. Firebase Admin
    // 14 otherwise probes it on non-GCP hosts, which adds avoidable latency and
    // can push the first emulator assertion past the default test timeout.
    METADATA_SERVER_DETECTION:
      String(env.METADATA_SERVER_DETECTION ?? "").trim() || "none",
  };
}

export function emulatorCliArgs({
  mode,
  only,
  command,
  configPath,
  project = DEFAULT_PROJECT,
}) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new Error("The Firebase emulator config path is required.");
  }
  if (typeof project !== "string" || project.length === 0) {
    throw new Error("The Firebase project id is required.");
  }

  if (mode === "start") {
    return ["emulators:start", "--project", project, "--config", configPath];
  }

  if (mode === "exec") {
    if (typeof only !== "string" || only.length === 0) {
      throw new Error("The emulator list is required for exec mode.");
    }
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("The test command is required for exec mode.");
    }
    return [
      "emulators:exec",
      "--project",
      project,
      "--only",
      only,
      "--config",
      configPath,
      command,
    ];
  }

  throw new Error('The emulator mode must be either "start" or "exec".');
}
