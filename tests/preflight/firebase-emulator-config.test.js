import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  emulatorCliArgs,
  firebaseEmulatorEnv,
  resolveFirebaseEmulatorConfig,
  shouldForwardEmulatorSignal,
} from "../../scripts/firebase-emulator-config.mjs";
import { classifyPath } from "../../.github/scripts/ci-classifier.mjs";

const FIREBASE_CI_WORKFLOW = readFileSync(
  new URL("../../.github/workflows/firebase-ci.yml", import.meta.url),
  "utf8",
);
const ROOT_PACKAGE_LOCK = JSON.parse(
  readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);
const ADMIN_VITE_CONFIG = readFileSync(
  new URL("../../admin/vite.config.ts", import.meta.url),
  "utf8",
);
const ADMIN_FIREBASE_CLIENT = readFileSync(
  new URL("../../admin/src/lib/firebase.ts", import.meta.url),
  "utf8",
);
const FIRESTORE_INDEXES = JSON.parse(
  readFileSync(new URL("../../firestore.indexes.json", import.meta.url), "utf8"),
);

const BASE_CONFIG = {
  firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" },
  functions: { source: "functions" },
  emulators: {
    singleProjectMode: true,
    auth: { port: 9099 },
    firestore: { port: 8080 },
    functions: { port: 5001 },
    storage: { port: 9199 },
  },
};

describe("Firebase emulator config", () => {
  it("keeps firebase.json defaults when no Firestore override is supplied", () => {
    expect(resolveFirebaseEmulatorConfig(BASE_CONFIG, {})).toEqual(BASE_CONFIG);
  });

  it("overrides only the Firestore port without mutating firebase.json data", () => {
    const resolved = resolveFirebaseEmulatorConfig(BASE_CONFIG, {
      FIRESTORE_EMULATOR_PORT: "8180",
    });

    expect(resolved.emulators.firestore.port).toBe(8180);
    expect(resolved.emulators.auth.port).toBe(9099);
    expect(resolved.functions.source).toBe("functions");
    expect(BASE_CONFIG.emulators.firestore.port).toBe(8080);
  });

  it.each(["0", "65536", "3.5", "not-a-port"])(
    "rejects an invalid Firestore override before Firebase starts: %s",
    (port) => {
      expect(() =>
        resolveFirebaseEmulatorConfig(BASE_CONFIG, {
          FIRESTORE_EMULATOR_PORT: port,
        }),
      ).toThrow(/FIRESTORE_EMULATOR_PORT.*1.*65535/i);
    },
  );

  it.each([
    ["Admin preview", "4173"],
    ["Auth", "9099"],
    ["Functions", "5001"],
    ["Storage", "9199"],
    ["emulator hub", "4400"],
    ["logging emulator", "4500"],
  ])("rejects a Firestore port reserved by %s (%s)", (service, port) => {
    expect(() =>
      resolveFirebaseEmulatorConfig(BASE_CONFIG, {
        FIRESTORE_EMULATOR_PORT: port,
      }),
    ).toThrow(new RegExp(`FIRESTORE_EMULATOR_PORT.*${port}.*${service}`, "i"));
  });
});

describe("Firestore index manifest", () => {
  it.each(["nextAttemptAt", "leaseUntil"])(
    "supports the external bug report autofix worker ordered by %s",
    (orderedField) => {
      expect(FIRESTORE_INDEXES.indexes).toContainEqual({
        collectionGroup: "bugReportAutofixOutbox",
        queryScope: "COLLECTION",
        fields: [
          { fieldPath: "state", order: "ASCENDING" },
          { fieldPath: orderedField, order: "ASCENDING" },
        ],
      });
    },
  );
});

describe("Firebase emulator CLI arguments", () => {
  it("starts the full interactive suite with the derived config", () => {
    expect(
      emulatorCliArgs({
        mode: "start",
        configPath: "/repo/firebase.emulator.json",
      }),
    ).toEqual([
      "emulators:start",
      "--project",
      "demo-njpbs",
      "--config",
      "/repo/firebase.emulator.json",
    ]);
  });

  it("passes one test command and the requested emulator set to emulators:exec", () => {
    expect(
      emulatorCliArgs({
        mode: "exec",
        only: "auth,firestore,functions",
        command: "vitest run tests/functions",
        configPath: "/repo/firebase.emulator.json",
      }),
    ).toEqual([
      "emulators:exec",
      "--project",
      "demo-njpbs",
      "--only",
      "auth,firestore,functions",
      "--config",
      "/repo/firebase.emulator.json",
      "vitest run tests/functions",
    ]);
  });
});

describe("Firebase emulator process handling", () => {
  it("disables GCP metadata probes for emulator subprocesses", () => {
    expect(firebaseEmulatorEnv({ PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
      METADATA_SERVER_DETECTION: "none",
    });
    expect(
      firebaseEmulatorEnv({ METADATA_SERVER_DETECTION: "ping-only" }),
    ).toMatchObject({ METADATA_SERVER_DETECTION: "ping-only" });
  });

  it("lets the inherited Windows console signal reach Firebase without force-killing it", () => {
    expect(shouldForwardEmulatorSignal("win32")).toBe(false);
    expect(shouldForwardEmulatorSignal("linux")).toBe(true);
  });

  it.each([
    "scripts/firebase-emulator-config.mjs",
    "scripts/run-firebase-emulators.mjs",
  ])("runs Firebase CI when %s changes", (path) => {
    expect(classifyPath(path)?.firebase).toBe(true);
  });

  it("keys the emulator cache to the installed Firebase CLI version", () => {
    const firebaseToolsVersion =
      ROOT_PACKAGE_LOCK.packages["node_modules/firebase-tools"].version;

    expect(FIREBASE_CI_WORKFLOW).toContain(
      `-firebase-emulators-${firebaseToolsVersion}`,
    );
  });

  it("passes the shared Firestore override into the interactive admin client", () => {
    expect(ADMIN_VITE_CONFIG).toContain("resolveFirebaseEmulatorConfig");
    expect(ADMIN_VITE_CONFIG).toContain("VITE_FIRESTORE_EMULATOR_PORT");
    expect(ADMIN_FIREBASE_CLIENT).toContain("resolveFirestoreEmulatorPort");
    expect(ADMIN_FIREBASE_CLIENT).not.toContain(
      'connectFirestoreEmulator(db, "127.0.0.1", 8080)',
    );
  });

  it.each([
    "firebase.json",
    "scripts/firebase-emulator-config.mjs",
    "scripts/firebase-emulator-config.d.mts",
    "site/src/styles/design-tokens.css",
  ])("runs Admin CI when %s changes", (path) => {
    expect(classifyPath(path)?.admin).toBe(true);
  });
});
