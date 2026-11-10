import { createRequire } from "node:module";

const requireFunctionsModule = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const appModule = requireFunctionsModule(
  "firebase-admin/app",
) as typeof import("firebase-admin/app");
const firestoreModule = requireFunctionsModule(
  "firebase-admin/firestore",
) as typeof import("firebase-admin/firestore");

// Firestore rejects sentinel values created by another installed Admin SDK.
// Production operators use the Functions package because every persisted
// publishing module resolves its sentinels from that package boundary.
export const firebaseAdminRuntime = Object.freeze({
  FirebaseError: appModule.FirebaseError,
  FieldValue: firestoreModule.FieldValue,
  Timestamp: firestoreModule.Timestamp,
  applicationDefault: appModule.applicationDefault,
  cert: appModule.cert,
  deleteApp: appModule.deleteApp,
  getFirestore: firestoreModule.getFirestore,
  initializeApp: appModule.initializeApp,
});
