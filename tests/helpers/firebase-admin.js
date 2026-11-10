import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

const firestore = Object.assign((app) => getFirestore(app), {
  FieldValue,
  Timestamp,
});

// Test-only compatibility facade. It keeps the emulator suites readable while
// exercising firebase-admin v14 exclusively through its modular entry points.
const admin = {
  get apps() {
    return getApps().map((app) => ({ delete: () => deleteApp(app) }));
  },
  initializeApp,
  firestore,
  auth: (app) => getAuth(app),
};

export default admin;
