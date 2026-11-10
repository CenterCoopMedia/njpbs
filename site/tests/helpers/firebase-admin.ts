import { deleteApp, getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";

const firestore = Object.assign(getFirestore, { FieldValue, Timestamp });

// Test-only compatibility facade for the loader emulator suite. Production
// code already imports the Admin SDK's modular app/firestore entry points.
const admin = {
  get apps() {
    return getApps().map((app) => ({ delete: () => deleteApp(app) }));
  },
  initializeApp,
  firestore,
};

export default admin;
