import { describe, expect, it } from "vitest";
import {
  resolveFirebaseConfig,
  resolveFirestoreEmulatorPort,
  type FirebaseConfigEnv,
} from "../src/lib/firebase-config";

const productionEnv = {
  VITE_FIREBASE_API_KEY: "real-api-key",
  VITE_FIREBASE_AUTH_DOMAIN: "real-project.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "real-project",
  VITE_FIREBASE_APP_ID: "real-app-id",
};

describe("resolveFirebaseConfig", () => {
  it("requires the exact dev project tuple and no emulator fallback", () => {
    const dev = {
      VITE_FIREBASE_API_KEY: "dev-public-key",
      VITE_FIREBASE_AUTH_DOMAIN: "njpbs-site-dev.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "njpbs-site-dev",
      VITE_FIREBASE_APP_ID: "synthetic-dev-app-id",
      VITE_FIREBASE_EXPECTED_DEV_APP_ID: "synthetic-dev-app-id",
      VITE_USE_EMULATORS: "false",
      VITE_CMS_DEPLOYMENT_ENVIRONMENT: "development",
    };
    expect(resolveFirebaseConfig(dev).projectId).toBe("njpbs-site-dev");
    for (const [key, value] of [
      ["VITE_FIREBASE_PROJECT_ID", "njpbs-site"],
      ["VITE_FIREBASE_AUTH_DOMAIN", "njpbs-site.firebaseapp.com"],
      ["VITE_FIREBASE_APP_ID", "production-app"],
      ["VITE_FIREBASE_EXPECTED_DEV_APP_ID", ""],
      ["VITE_FIREBASE_EXPECTED_DEV_APP_ID", "different-app"],
      ["VITE_USE_EMULATORS", "true"],
      ["VITE_CMS_DEPLOYMENT_ENVIRONMENT", "production"],
    ] as const) {
      expect(() => resolveFirebaseConfig({ ...dev, [key]: value })).toThrow(/Dev Firebase build target/);
    }
    const { VITE_FIREBASE_EXPECTED_DEV_APP_ID: _pin, ...missingPin } = dev;
    expect(() => resolveFirebaseConfig(missingPin)).toThrow(/Dev Firebase build target/);
  });
  it("uses demo values when dev mode has no Firebase env", () => {
    expect(resolveFirebaseConfig({ DEV: true }, {})).toEqual({
      apiKey: "demo-api-key",
      authDomain: "demo-njpbs.firebaseapp.com",
      projectId: "demo-njpbs",
      appId: "demo-app-id",
    });
  });

  it("passes through full Firebase env outside emulator mode", () => {
    expect(resolveFirebaseConfig(productionEnv, {})).toEqual({
      apiKey: "real-api-key",
      authDomain: "real-project.firebaseapp.com",
      projectId: "real-project",
      appId: "real-app-id",
    });
  });

  it("throws outside emulator mode when one Firebase key is missing", () => {
    const env: FirebaseConfigEnv = { ...productionEnv };
    delete env.VITE_FIREBASE_APP_ID;

    expect(() => resolveFirebaseConfig(env, {})).toThrow(
      /VITE_FIREBASE_APP_ID/,
    );
    expect(() => resolveFirebaseConfig(env, {})).not.toThrow(
      /VITE_FIREBASE_API_KEY|VITE_FIREBASE_AUTH_DOMAIN|VITE_FIREBASE_PROJECT_ID/,
    );
  });

  it("treats blank Firebase env values as missing outside emulator mode", () => {
    expect(() =>
      resolveFirebaseConfig(
        { ...productionEnv, VITE_FIREBASE_PROJECT_ID: "  " },
        {},
      ),
    ).toThrow(/VITE_FIREBASE_PROJECT_ID/);
  });
});

describe("resolveFirestoreEmulatorPort", () => {
  it("uses the port injected by the shared emulator configuration", () => {
    expect(
      resolveFirestoreEmulatorPort({
        VITE_FIRESTORE_EMULATOR_PORT: "8180",
      }),
    ).toBe(8180);
  });

  it("defaults to 8080 when no override is injected", () => {
    expect(resolveFirestoreEmulatorPort({})).toBe(8080);
  });

  it.each(["0", "65536", "not-a-port"])(
    "rejects an invalid injected port (%s)",
    (port) => {
      expect(() =>
        resolveFirestoreEmulatorPort({
          VITE_FIRESTORE_EMULATOR_PORT: port,
        }),
      ).toThrow(/VITE_FIRESTORE_EMULATOR_PORT/);
    },
  );
});
