export interface FirebaseConfigEnv {
  DEV?: boolean;
  VITE_USE_EMULATORS?: string;
  VITE_FIRESTORE_EMULATOR_PORT?: string;
  VITE_FIREBASE_API_KEY?: string;
  VITE_FIREBASE_AUTH_DOMAIN?: string;
  VITE_FIREBASE_PROJECT_ID?: string;
  VITE_FIREBASE_APP_ID?: string;
  VITE_FIREBASE_EXPECTED_DEV_APP_ID?: string;
  VITE_CMS_DEPLOYMENT_ENVIRONMENT?: string;
}

export interface ResolveFirebaseConfigOptions {
  emulatorMode?: boolean;
}

export interface ResolvedFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

const demoFirebaseConfig: ResolvedFirebaseConfig = {
  apiKey: "demo-api-key",
  authDomain: "demo-njpbs.firebaseapp.com",
  projectId: "demo-njpbs",
  appId: "demo-app-id",
};

const defaultFirestoreEmulatorPort = 8080;

const firebaseEnvKeys = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

function present(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

export function firebaseEmulatorMode(env: FirebaseConfigEnv): boolean {
  return env.DEV === true || env.VITE_USE_EMULATORS === "true";
}

export function resolveFirestoreEmulatorPort(env: FirebaseConfigEnv): number {
  const raw = env.VITE_FIRESTORE_EMULATOR_PORT;
  if (raw === undefined || raw.trim() === "") {
    return defaultFirestoreEmulatorPort;
  }

  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      "VITE_FIRESTORE_EMULATOR_PORT must be an integer from 1 to 65535.",
    );
  }

  const port = Number(raw.trim());
  if (port < 1 || port > 65_535) {
    throw new Error(
      "VITE_FIRESTORE_EMULATOR_PORT must be an integer from 1 to 65535.",
    );
  }
  return port;
}

export function resolveFirebaseConfig(
  env: FirebaseConfigEnv,
  options: ResolveFirebaseConfigOptions = {},
): ResolvedFirebaseConfig {
  const emulatorMode = options.emulatorMode ?? firebaseEmulatorMode(env);
  // config-input: VITE_FIREBASE_API_KEY, VITE_FIREBASE_APP_ID, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID
  const missing = firebaseEnvKeys.filter((key) => present(env[key]) === undefined);

  if (!emulatorMode && missing.length > 0) {
    throw new Error(`Missing Firebase env vars: ${missing.join(", ")}`);
  }

  if (env.VITE_CMS_DEPLOYMENT_ENVIRONMENT === "development" ||
      env.VITE_FIREBASE_PROJECT_ID === "njpbs-site-dev") {
    if (env.VITE_CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
        env.VITE_FIREBASE_PROJECT_ID !== "njpbs-site-dev" ||
        env.VITE_FIREBASE_AUTH_DOMAIN !== "njpbs-site-dev.firebaseapp.com" ||
        !present(env.VITE_FIREBASE_EXPECTED_DEV_APP_ID) ||
        env.VITE_FIREBASE_APP_ID !== env.VITE_FIREBASE_EXPECTED_DEV_APP_ID ||
        env.VITE_USE_EMULATORS !== "false") {
      throw new Error("Dev Firebase build target was refused");
    }
  }

  return {
    apiKey: present(env.VITE_FIREBASE_API_KEY) ?? demoFirebaseConfig.apiKey,
    authDomain:
      present(env.VITE_FIREBASE_AUTH_DOMAIN) ?? demoFirebaseConfig.authDomain,
    projectId:
      present(env.VITE_FIREBASE_PROJECT_ID) ?? demoFirebaseConfig.projectId,
    appId: present(env.VITE_FIREBASE_APP_ID) ?? demoFirebaseConfig.appId,
  };
}
