import { initializeApp, getApps } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  getToken as getAppCheckTokenValue,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from "firebase/app-check";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import {
  firebaseEmulatorMode,
  resolveFirebaseConfig,
  resolveFirestoreEmulatorPort,
  type FirebaseConfigEnv,
} from "./firebase-config";

declare global {
  var __njpbsAdminEmulatorsConnected: boolean | undefined;
}

// Enumerate the public build inputs rather than passing import.meta.env through
// wholesale. Vite serializes every VITE_* key when the whole object is used,
// including retired values that may remain in a shell or gitignored env file.
const firebaseEnv = {
  DEV: import.meta.env.DEV,
  VITE_USE_EMULATORS: import.meta.env.VITE_USE_EMULATORS,
  VITE_FIRESTORE_EMULATOR_PORT:
    import.meta.env.VITE_FIRESTORE_EMULATOR_PORT,
  VITE_FIREBASE_API_KEY: import.meta.env.VITE_FIREBASE_API_KEY,
  VITE_FIREBASE_AUTH_DOMAIN: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  VITE_FIREBASE_PROJECT_ID: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  VITE_FIREBASE_APP_ID: import.meta.env.VITE_FIREBASE_APP_ID,
  VITE_FIREBASE_EXPECTED_DEV_APP_ID: import.meta.env.VITE_FIREBASE_EXPECTED_DEV_APP_ID,
  VITE_CMS_DEPLOYMENT_ENVIRONMENT: import.meta.env.VITE_CMS_DEPLOYMENT_ENVIRONMENT,
} satisfies FirebaseConfigEnv;

export const emulatorMode = firebaseEmulatorMode(firebaseEnv);

export const firebaseConfig = resolveFirebaseConfig(firebaseEnv, {
  emulatorMode,
});

export const app = getApps()[0] ?? initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const firestoreRestOrigin = emulatorMode
  ? `http://127.0.0.1:${resolveFirestoreEmulatorPort(firebaseEnv)}`
  : "https://firestore.googleapis.com";

const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY?.trim();
export let appCheck: AppCheck | null = null;

export function ensureAppCheck(): AppCheck | null {
  if (emulatorMode) return null;
  if (appCheck) return appCheck;
  if (!appCheckSiteKey) return null;
  appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
  return appCheck;
}

export async function getRequiredAppCheckToken(): Promise<string | null> {
  if (emulatorMode) return null;
  const instance = ensureAppCheck();
  if (!instance) {
    throw new Error("Account-request protection is not configured");
  }
  return (await getAppCheckTokenValue(instance)).token;
}

if (emulatorMode && !globalThis.__njpbsAdminEmulatorsConnected) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", {
    disableWarnings: true,
  });
  connectFirestoreEmulator(
    db,
    "127.0.0.1",
    resolveFirestoreEmulatorPort(firebaseEnv),
  );
  globalThis.__njpbsAdminEmulatorsConnected = true;
}
